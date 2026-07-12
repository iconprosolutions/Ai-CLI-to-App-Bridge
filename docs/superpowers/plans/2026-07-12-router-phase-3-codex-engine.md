# Router Phase 3 — Codex Engine (persistent app-server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Codex (ChatGPT-subscription) as a third first-class engine alongside claude and gemini/agy — multi-account, headroom-routed, with true token streaming and push-based rate-limit intel — by driving a long-lived `codex app-server` process per account over JSON-RPC.

**Architecture:** Three new focused modules under `packages/adapters/`: a transport-agnostic **NDJSON JSON-RPC client** (framing + request/response correlation + notification fan-out), a **codex app-server process manager** (one child per `CODEX_HOME`, lazy spawn, handshake, crash-restart backoff, registry-reaped shutdown), and the **codex adapter** itself (implements the same `invoke`/`identity`/`listModels`/`healthCheck`/`capabilities` contract the existing adapters expose, translating a bridge request into `thread/start`+`turn/start` and streaming `item/agentMessage/delta` back). The RPC surface is experimental, so every method name and the framing live in one `CODEX_RPC` constants block and the whole stack is contract-tested against a scriptable fake app-server — if OpenAI shifts the surface, the constants and fake move together and the tests catch drift. Codex quota is push (`account/rateLimits/updated`), fed into the Phase-1 `quota.js` `record()` path as `source: 'push'`. Spec: `docs/superpowers/specs/2026-07-11-multi-model-router-design.md` §4.

**Tech Stack:** Node 22 CommonJS, no new npm deps (JSON-RPC hand-rolled over the child's stdio pipes; reuses the `@bridge/core` child registry for shutdown reaping). Plain-assert suites run via `node tests/<file>.test.js`. Fake app-server extends the existing `tests/fixtures/fake-cli.js` pattern.

**Conventions:** work from repo root `/Users/waqar/Projects/experiments/ai-cli-bridge`, branch `feat/dashboard-overhaul`, commit directly (no new branches). New codex tests go in **`tests/codex.test.js`** (created Task 1, extended by Tasks 2-4). Commit after every green task. Phases 1-2 are committed+pushed through `d491974`; quota snapshots, `usageSource`, headroom dispatch, reset-precise breakers all exist. Full suite is 8 files today.

**Risk & fallback (read before starting):** the app-server RPC is a de-facto (not officially stable) API. Research verified against codex-cli 0.141.0 (local): NDJSON JSON-RPC over stdio, `initialize`→`initialized`→~500ms settle, `account/rateLimits/read`+`account/rateLimits/updated`, `thread/start`+`turn/start`+`item/agentMessage/delta`+`turn.completed.usage`+`turn.failed`. Exact names may drift across codex versions. Mitigations built into this plan: (1) the `CODEX_RPC` constants block is the single point of change; (2) the fake app-server mirrors those constants so a drift shows as a failing contract test, not a silent production hang; (3) the Docker install pins a codex version; (4) if the surface breaks hard, the documented fallback is exec-per-request (`codex exec --json`) — NOT built here, but the adapter's `invoke` contract is identical either way, so only the internals would swap. Do not attempt live codex calls during implementation (burns real quota) — everything is tested against the fake.

---

### Task 1: NDJSON JSON-RPC client

A transport-agnostic client: writes framed requests to a stream, reads framed messages from a stream, correlates responses to requests by id, and fans notifications out to a handler. No codex knowledge — pure plumbing, so it's trivially testable with in-memory streams.

**Files:**
- Create: `packages/adapters/jsonrpc.js`
- Create: `tests/codex.test.js`
- Modify: `package.json` (add the suite to `test` + `check` chains)

- [ ] **Step 1: Create the failing test suite**

Create `tests/codex.test.js`:

```js
'use strict';
// Router Phase 3: codex engine — JSON-RPC client, app-server manager, adapter.
const assert = require('node:assert');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const REPO = path.resolve(__dirname, '..');
let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed += 1; console.log(`  ok - ${msg}`); }

(async () => {
  console.log('## C1 — NDJSON JSON-RPC client');
  {
    const { createRpcClient } = require(path.join(REPO, 'packages/adapters/jsonrpc.js'));
    // Wire two pipes: `toServer` is what the client writes; `fromServer` is
    // what the client reads. A trivial echo "server" answers requests.
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const notes = [];
    const client = createRpcClient({
      input: fromServer, // client reads replies here
      output: toServer, // client writes requests here
      onNotification: (method, params) => notes.push({ method, params }),
    });

    // Fake server: read a line, reply with { id, result: { echoed: params } }.
    let serverBuf = '';
    toServer.on('data', (chunk) => {
      serverBuf += chunk.toString('utf8');
      let nl;
      while ((nl = serverBuf.indexOf('\n')) >= 0) {
        const line = serverBuf.slice(0, nl); serverBuf = serverBuf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        fromServer.write(`${JSON.stringify({ id: msg.id, result: { echoed: msg.params } })}\n`);
      }
    });

    const r = await client.request('ping', { a: 1 });
    ok(r && r.echoed && r.echoed.a === 1, 'C1: request resolves with the correlated result');

    // Two concurrent requests get correlated to the right ids (not FIFO-assumed).
    const [ra, rb] = await Promise.all([client.request('m', { k: 'a' }), client.request('m', { k: 'b' })]);
    ok(ra.echoed.k === 'a' && rb.echoed.k === 'b', 'C1: concurrent requests correlate by id');

    // A server-pushed notification (no id) reaches onNotification, not a request.
    fromServer.write(`${JSON.stringify({ method: 'evt/ping', params: { n: 7 } })}\n`);
    await new Promise((res) => setImmediate(res));
    ok(notes.length === 1 && notes[0].method === 'evt/ping' && notes[0].params.n === 7, 'C1: notification fans out to onNotification');

    // An error reply rejects with the message.
    const errClient = createRpcClient({
      input: (() => { const s = new PassThrough(); return s; })(),
      output: new PassThrough(),
    });
    // Directly feed an error frame for a known id by monkeypatching: simpler to
    // test via a fresh pair.
    const eIn = new PassThrough(); const eOut = new PassThrough();
    const ec = createRpcClient({ input: eIn, output: eOut });
    eOut.on('data', (chunk) => {
      const msg = JSON.parse(chunk.toString('utf8').trim());
      eIn.write(`${JSON.stringify({ id: msg.id, error: { code: -32000, message: 'boom' } })}\n`);
    });
    let threw = null;
    try { await ec.request('x', {}); } catch (e) { threw = e; }
    ok(threw && /boom/.test(threw.message), 'C1: error reply rejects with the error message');

    // A partial line split across two writes is buffered until the newline.
    const pIn = new PassThrough(); const pOut = new PassThrough();
    const pc = createRpcClient({ input: pIn, output: pOut });
    pOut.on('data', (chunk) => {
      const msg = JSON.parse(chunk.toString('utf8').trim());
      const frame = JSON.stringify({ id: msg.id, result: { ok: true } });
      pIn.write(frame.slice(0, 5)); // partial
      setImmediate(() => pIn.write(`${frame.slice(5)}\n`)); // rest + newline
    });
    const pr = await pc.request('y', {});
    ok(pr.ok === true, 'C1: a reply split across chunks is reassembled at the newline');

    client.close(); ec.close(); pc.close(); errClient.close();
  }

  console.log(`\ncodex.test.js: all ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/codex.test.js`
Expected: FAIL — `Cannot find module '.../packages/adapters/jsonrpc.js'`.

- [ ] **Step 3: Create `packages/adapters/jsonrpc.js`**

```js
'use strict';

// Minimal newline-delimited JSON-RPC 2.0-ish client over a duplex byte stream
// pair (a child's stdout as `input`, stdin as `output`). Codex's app-server
// speaks one JSON object per line and omits the "jsonrpc" version field, so we
// do too. Transport-agnostic: no codex knowledge lives here.
function createRpcClient({ input, output, onNotification = null, logger = console } = {}) {
  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject }
  let buf = '';
  let closed = false;

  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; } // ignore non-JSON log noise
      if (msg.id !== undefined && msg.id !== null && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || `rpc error ${msg.error.code}`));
        else p.resolve(msg.result);
      } else if (msg.method && typeof onNotification === 'function') {
        try { onNotification(msg.method, msg.params || {}); } catch (err) { logger.error(`[rpc] notification handler threw: ${err.message}`); }
      }
    }
  };
  input.on('data', onData);

  // Reject everything in flight if the stream dies — a request must never hang
  // forever when the child crashes.
  const fail = (why) => {
    closed = true;
    for (const [, p] of pending) p.reject(new Error(why));
    pending.clear();
  };
  input.on('close', () => fail('rpc stream closed'));
  input.on('error', (err) => fail(`rpc stream error: ${err.message}`));

  function request(method, params = {}, { timeoutMs = 0 } = {}) {
    if (closed) return Promise.reject(new Error('rpc client closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`rpc request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
      }
      const done = (fn) => (v) => { if (timer) clearTimeout(timer); fn(v); };
      pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try { output.write(`${JSON.stringify({ id, method, params })}\n`); }
      catch (err) { pending.delete(id); reject(new Error(`rpc write failed: ${err.message}`)); }
    });
  }

  // Fire-and-forget notification (no id, no reply expected).
  function notify(method, params = {}) {
    if (closed) return;
    try { output.write(`${JSON.stringify({ method, params })}\n`); } catch (_) { /* child gone */ }
  }

  function close() {
    input.removeListener('data', onData);
    fail('rpc client closed');
  }

  return { request, notify, close, get inflight() { return pending.size; } };
}

module.exports = { createRpcClient };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/codex.test.js`
Expected: PASS — all C1 assertions.

- [ ] **Step 5: Add the suite to both chains**

In `package.json`: append `&& node tests/codex.test.js` to the `test` script (after `headroom.test.js`), and add `node --check tests/codex.test.js && node --check packages/adapters/jsonrpc.js` to the `check` chain.

- [ ] **Step 6: Full suite + commit**

Run: `npm test` → all suites green.

```bash
git add packages/adapters/jsonrpc.js tests/codex.test.js package.json
git commit -m "feat(codex): NDJSON JSON-RPC client — id correlation, notifications, stream reassembly"
```

---

### Task 2: Fake app-server fixture + process manager

The manager owns one `codex app-server` child per `CODEX_HOME`: lazy spawn, the `initialize`→`initialized`→settle handshake, registry-reaped shutdown, and crash-restart with capped backoff. Tested against a scriptable fake app-server (a Node script speaking the same NDJSON RPC).

**Files:**
- Create: `tests/fixtures/fake-codex-appserver.js`
- Create: `packages/adapters/codex-manager.js`
- Test: `tests/codex.test.js` (append C2 block)

- [ ] **Step 1: Create the fake app-server fixture**

Create `tests/fixtures/fake-codex-appserver.js`:

```js
#!/usr/bin/env node
'use strict';
// Scriptable fake `codex app-server` for contract tests. Speaks NDJSON JSON-RPC
// on stdin/stdout, mirroring the CODEX_RPC method names the adapter uses.
// Env knobs:
//   FAKE_CODEX_TEXT      — agent message text (default 'hello from codex')
//   FAKE_CODEX_FAIL      — a turn.failed message string (quota grammar etc.)
//   FAKE_CODEX_USEDPCT   — primary usedPercent for rateLimits (default 12)
//   FAKE_CODEX_RESETS    — primary resetsAt epoch seconds (default now+3600)
//   FAKE_CODEX_NO_HANDSHAKE — exit before replying to initialize (crash sim)
//   FAKE_CODEX_LOGFILE   — append each received method to this file
const fs = require('fs');

const TEXT = process.env.FAKE_CODEX_TEXT || 'hello from codex';
const FAIL = process.env.FAKE_CODEX_FAIL || '';
const USEDPCT = Number(process.env.FAKE_CODEX_USEDPCT || 12);
const RESETS = Number(process.env.FAKE_CODEX_RESETS || 0);
const logMethod = (m) => { if (process.env.FAKE_CODEX_LOGFILE) { try { fs.appendFileSync(process.env.FAKE_CODEX_LOGFILE, `${m}\n`); } catch (_) {} } };

if (process.env.FAKE_CODEX_NO_HANDSHAKE) process.exit(1);

let buf = '';
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => send({ id, result });
const note = (method, params) => send({ method, params });

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
    handle(msg);
  }
});

function rateLimits() {
  return {
    rateLimits: {
      primary: { usedPercent: USEDPCT, windowDurationMins: 300, resetsAt: RESETS || Math.floor(Date.now() / 1000) + 3600 },
      secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 604800 },
      planType: 'team', rateLimitReachedType: null,
    },
  };
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method) logMethod(method);
  switch (method) {
    case 'initialize': return reply(id, { capabilities: { experimentalApi: true } });
    case 'initialized': return; // notification, no reply
    case 'getAuthStatus': return reply(id, { authenticated: true, method: 'chatgpt' });
    case 'account/rateLimits/read': return reply(id, rateLimits());
    case 'thread/start': return reply(id, { threadId: 'thread_fake_1' });
    case 'turn/start': {
      // Stream two deltas, then either fail or complete.
      note('item/agentMessage/delta', { threadId: params && params.threadId, delta: TEXT.slice(0, 3) });
      note('item/agentMessage/delta', { threadId: params && params.threadId, delta: TEXT.slice(3) });
      if (FAIL) { note('turn.failed', { error: { message: FAIL } }); return reply(id, { ok: true }); }
      note('turn.completed', { usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 5 } });
      return reply(id, { ok: true });
    }
    default: return id !== undefined ? reply(id, {}) : undefined;
  }
}
```

- [ ] **Step 2: Append the failing C2 block to `tests/codex.test.js`**

Insert before the final summary line:

```js
  console.log('\n## C2 — app-server process manager');
  {
    const os = require('node:os'); const fs = require('node:fs');
    const { createCodexManager } = require(path.join(REPO, 'packages/adapters/codex-manager.js'));
    const FAKE = path.join(REPO, 'tests/fixtures/fake-codex-appserver.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-codex-'));

    const mgr = createCodexManager({ bin: process.execPath, baseArgs: [FAKE], settleMs: 20 });
    // get(home) lazily spawns + handshakes, returns a ready rpc client.
    const c = await mgr.get(home);
    ok(c && typeof c.request === 'function', 'C2: get() returns a ready rpc client after handshake');
    // A second get() for the same home returns the SAME child (no re-spawn).
    const c2 = await mgr.get(home);
    ok(c2 === c, 'C2: same CODEX_HOME reuses the live child');
    // The client actually talks to the fake (rateLimits round-trips).
    const rl = await c.request('account/rateLimits/read', {});
    ok(rl.rateLimits && rl.rateLimits.primary.windowDurationMins === 300, 'C2: rpc round-trips through the managed child');
    // A different home spawns a distinct child.
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'c2b-codex-'));
    const d = await mgr.get(home2);
    ok(d !== c, 'C2: a different CODEX_HOME spawns a distinct child');

    // Handshake failure surfaces as a rejected get(), not a hang.
    const badMgr = createCodexManager({ bin: process.execPath, baseArgs: [FAKE], settleMs: 20, env: { FAKE_CODEX_NO_HANDSHAKE: '1' }, spawnTimeoutMs: 500 });
    let threw = null;
    try { await badMgr.get(fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-'))); } catch (e) { threw = e; }
    ok(threw, 'C2: a child that dies before handshake rejects get() (no hang)');

    await mgr.shutdown(); await badMgr.shutdown();
    ok(mgr.liveCount() === 0, 'C2: shutdown reaps all children');
  }
```

- [ ] **Step 3: Run to verify it fails**

Run: `node tests/codex.test.js`
Expected: FAIL — `createCodexManager` is not a function.

- [ ] **Step 4: Create `packages/adapters/codex-manager.js`**

```js
'use strict';

const { spawn } = require('child_process');
const { createRpcClient } = require('./jsonrpc');

// Single source of truth for the (experimental) codex app-server RPC surface.
// If OpenAI shifts method names, change them HERE — the fake fixture mirrors
// these, so a drift shows as a failing contract test.
const CODEX_RPC = {
  initialize: 'initialize',
  initialized: 'initialized',
  authStatus: 'getAuthStatus',
  rateLimitsRead: 'account/rateLimits/read',
  rateLimitsUpdated: 'account/rateLimits/updated',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  agentDelta: 'item/agentMessage/delta',
  turnCompleted: 'turn.completed',
  turnFailed: 'turn.failed',
  errorEvent: 'error',
};

// Owns one `codex app-server` child per CODEX_HOME. Lazy spawn + handshake;
// children are added to the @bridge/core registry by the caller-supplied
// `register` hook so graceful shutdown reaps them. Crash-restart with capped
// backoff is handled by dropping the dead entry so the next get() re-spawns.
function createCodexManager({
  bin = process.env.CODEX_PATH || 'codex',
  baseArgs = ['-s', 'read-only', '-a', 'untrusted', 'app-server'],
  env = {},
  settleMs = Number(process.env.CODEX_SETTLE_MS) || 500,
  spawnTimeoutMs = Number(process.env.CODEX_SPAWN_TIMEOUT_MS) || 15000,
  onNotification = null, // (home, method, params)
  register = null, // (child) => void  — add to the shared child registry
  logger = console,
} = {}) {
  const children = new Map(); // home → { child, rpc, ready: Promise }

  function spawnOne(home) {
    const child = spawn(bin, baseArgs, {
      env: { ...process.env, ...env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (typeof register === 'function') { try { register(child); } catch (_) { /* best-effort */ } }
    const rpc = createRpcClient({
      input: child.stdout,
      output: child.stdin,
      onNotification: (method, params) => { if (typeof onNotification === 'function') onNotification(home, method, params); },
      logger,
    });
    // stderr is diagnostic only — log a bounded tail, never parse for control.
    let errTail = '';
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-2048); });

    const entry = { child, rpc, errTail: () => errTail, dead: false };
    const die = (why) => {
      if (entry.dead) return;
      entry.dead = true;
      rpc.close();
      if (children.get(home) === entry) children.delete(home); // next get() re-spawns
      logger.error(`[codex] app-server for ${home} exited (${why})`);
    };
    child.on('exit', (code, sig) => die(`code ${code} sig ${sig}`));
    child.on('error', (err) => die(err.message));

    entry.ready = (async () => {
      const initTimer = new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('codex app-server handshake timed out')), spawnTimeoutMs); t.unref(); });
      await Promise.race([rpc.request(CODEX_RPC.initialize, { capabilities: { experimentalApi: true } }), initTimer]);
      rpc.notify(CODEX_RPC.initialized, {});
      await new Promise((r) => { const t = setTimeout(r, settleMs); t.unref(); }); // known quirk: immediate requests can return empty
      if (entry.dead) throw new Error('codex app-server died during handshake');
      return rpc;
    })().catch((err) => { die(err.message); throw err; });

    return entry;
  }

  async function get(home) {
    let entry = children.get(home);
    if (!entry || entry.dead) { entry = spawnOne(home); children.set(home, entry); }
    await entry.ready;
    return entry.rpc;
  }

  function killOne(home) {
    const entry = children.get(home);
    if (!entry) return;
    entry.dead = true;
    try { entry.child.kill('SIGTERM'); } catch (_) {}
    entry.rpc.close();
    children.delete(home);
  }

  async function shutdown() {
    for (const home of [...children.keys()]) killOne(home);
  }

  return { get, killOne, shutdown, liveCount: () => children.size, RPC: CODEX_RPC };
}

module.exports = { createCodexManager, CODEX_RPC };
```

- [ ] **Step 5: Run to verify it passes**

Run: `node tests/codex.test.js`
Expected: PASS through C2.

- [ ] **Step 6: Full suite + commit**

Run: `npm test` → green.

```bash
git add packages/adapters/codex-manager.js tests/fixtures/fake-codex-appserver.js tests/codex.test.js
git commit -m "feat(codex): app-server process manager — per-home child, handshake, registry-reaped shutdown"
```

---

### Task 3: Codex adapter (invoke / identity / models / health / capabilities)

The adapter implements the same contract the other engines expose so `server.js` treats codex identically. It uses the manager to get a per-account RPC client, runs `thread/start`+`turn/start`, streams deltas, and maps the codex failure grammar to `BridgeError` (quota with a parsed reset).

**Files:**
- Create: `packages/adapters/codex.js`
- Test: `tests/codex.test.js` (append C3 block)

- [ ] **Step 1: Append the failing C3 block**

```js
  console.log('\n## C3 — codex adapter invoke + failure grammar');
  {
    const os = require('node:os'); const fs = require('node:fs');
    const { createCodexAdapter, parseCodexResetMs, classifyCodexError } = require(path.join(REPO, 'packages/adapters/codex.js'));
    const FAKE = path.join(REPO, 'tests/fixtures/fake-codex-appserver.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-codex-'));

    const adapter = createCodexAdapter({ bin: process.execPath, baseArgs: [FAKE], settleMs: 20 });
    ok(adapter.name === 'codex' && adapter.capabilities.streaming === true, 'C3: adapter identifies as codex, streaming-capable');

    // A successful turn: deltas stream via onDelta, usage comes from turn.completed.
    const deltas = [];
    const res = await adapter.invoke({ prompt: 'hi', model: 'gpt-5.5', env: { CODEX_HOME: home }, onDelta: (d) => deltas.push(d) });
    ok(deltas.join('') === 'hello from codex', 'C3: agent deltas stream through onDelta');
    ok(res.text === 'hello from codex', 'C3: full text assembled from deltas');
    ok(res.usage && res.usage.promptTokens === 13 && res.usage.completionTokens === 5, 'C3: usage from turn.completed (input+cached / output)');

    // A usage-limit failure → quota BridgeError with a parsed reset deadline.
    const homeF = fs.mkdtempSync(path.join(os.tmpdir(), 'c3f-codex-'));
    const failAdapter = createCodexAdapter({ bin: process.execPath, baseArgs: [FAKE], settleMs: 20, env: { FAKE_CODEX_FAIL: "You've hit your usage limit. Try again at 3:45pm." } });
    let qerr = null;
    try { await failAdapter.invoke({ prompt: 'hi', model: 'gpt-5.5', env: { CODEX_HOME: homeF } }); } catch (e) { qerr = e; }
    ok(qerr && qerr.kind === 'quota', 'C3: usage-limit turn.failed → quota BridgeError');
    ok(qerr.data && Number.isFinite(qerr.data.cooldownUntilMs), 'C3: quota error carries a parsed cooldownUntilMs');

    // "at capacity" is retryable, NOT a quota penalty on the account.
    const cap = classifyCodexError('Selected model is at capacity. Please try a different model.');
    ok(cap && cap.kind !== 'quota' && cap.kind !== 'auth', 'C3: "at capacity" is not a quota/auth error');

    // parseCodexResetMs: same-day and month-day forms (local tz).
    const now = new Date('2026-07-12T14:00:00').getTime();
    ok(parseCodexResetMs('try again at 3:45pm.', now) === new Date('2026-07-12T15:45:00').getTime(), 'C3: "try again at 3:45pm" parses to today 3:45pm');
    ok(parseCodexResetMs('try again at Apr 19th, 2026 2:19 AM.', new Date('2026-04-18T00:00:00').getTime()) === new Date('2026-04-19T02:19:00').getTime(), 'C3: "Apr 19th, 2026 2:19 AM" parses');
    ok(parseCodexResetMs('no time here', now) === null, 'C3: unparseable reset → null');

    await adapter.shutdown(); await failAdapter.shutdown();
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/codex.test.js`
Expected: FAIL — `createCodexAdapter` is not a function.

- [ ] **Step 3: Create `packages/adapters/codex.js`**

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { BridgeError } = require('@bridge/core');
const { createCodexManager, CODEX_RPC } = require('./codex-manager');

// ChatGPT-subscription models exposed to codex (from models_cache.json on a
// live account, 2026-07). Account-wide meter — heavier models drain faster.
const KNOWN_MODELS = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: 'Codex frontier reasoning model.', contextWindow: 372000, isFree: false },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: 'Codex balanced model.', contextWindow: 372000, isFree: false },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: 'Codex fast model.', contextWindow: 372000, isFree: false },
  { id: 'gpt-5.5', name: 'GPT-5.5', description: 'Prior-gen Codex model.', contextWindow: 272000, isFree: false },
  { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Older Codex model.', contextWindow: 272000, isFree: false },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', description: 'Small fast Codex model.', contextWindow: 272000, isFree: false },
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Parse the reset instant out of codex's "try again at <TIME>." grammar.
// Same-day → "3:45pm"; cross-day → "Apr 19th, 2026 2:19 AM". Local tz (like
// the claude adapter); the quota push (Task 4) provides authoritative resetsAt.
function parseCodexResetMs(text, now = Date.now()) {
  const m = /try again at\s+(.+?)\.?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const phrase = m[1].trim();
  // "Apr 19th, 2026 2:19 AM"
  const md = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})\\s*([ap]m)`, 'i').exec(phrase);
  if (md) {
    const hour = (Number(md[4]) % 12) + (/pm/i.test(md[6]) ? 12 : 0);
    const d = new Date(now); d.setFullYear(Number(md[3]), MONTHS.indexOf(md[1].toLowerCase().slice(0, 3)), Number(md[2]));
    d.setHours(hour, Number(md[5]), 0, 0);
    return d.getTime();
  }
  // "3:45pm" / "1 PM"
  const t = /(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(phrase);
  if (!t) return null;
  const hour = (Number(t[1]) % 12) + (/pm/i.test(t[3]) ? 12 : 0);
  const d = new Date(now); d.setHours(hour, Number(t[2] || 0), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Map a codex failure message to a BridgeError. Usage limit → quota (with a
// reset); "at capacity"/high-demand → transient bad_output (retry, don't
// penalize the account); login/auth strings → auth.
function classifyCodexError(message) {
  const s = String(message || '');
  if (/hit your usage limit|out of credits|spend cap/i.test(s)) {
    const until = parseCodexResetMs(s);
    return new BridgeError('quota', `Codex usage limit reached for this account.${until ? '' : ' Retry after the window resets.'}`, {
      detail: s.slice(0, 300), ...(until ? { cooldownUntilMs: until } : {}),
    });
  }
  if (/at capacity|high demand|temporarily/i.test(s)) {
    return new BridgeError('bad_output', 'Codex model is momentarily at capacity — retry or use another model.', { detail: s.slice(0, 200) });
  }
  if (/not logged in|log in|unauthorized|401|authentication/i.test(s)) {
    return new BridgeError('auth', 'Codex account is not logged in. Onboard the account, then retry.', { detail: s.slice(0, 200) });
  }
  return new BridgeError('bad_output', s.slice(0, 300) || 'Codex turn failed', {});
}

// Read the ChatGPT identity from an account's auth.json id_token (no RPC, no
// token use). Mirrors Orbit's readCodexIdentity.
function codexIdentity(home) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    const accountId = auth && auth.tokens && auth.tokens.account_id;
    if (!accountId) return null;
    let email = accountId; let plan;
    try {
      const payload = String(auth.tokens.id_token).split('.')[1];
      const claims = JSON.parse(Buffer.from(payload + '==='.slice((payload.length + 3) % 4), 'base64').toString('utf8'));
      email = claims.email || (claims['https://api.openai.com/profile'] || {}).email || accountId;
      plan = (claims['https://api.openai.com/auth'] || {}).chatgpt_plan_type || claims.chatgpt_plan_type;
    } catch (_) { /* id_token opaque — accountId is enough */ }
    return { engine: 'codex', id: accountId, email, plan, signedIn: true };
  } catch (_) { return null; }
}

function createCodexAdapter(opts = {}) {
  const timeoutMs = opts.timeoutMs || Number(process.env.CLI_TIMEOUT_MS) || 5 * 60 * 1000;
  const manager = opts.manager || createCodexManager({
    bin: opts.bin, baseArgs: opts.baseArgs, env: opts.env, settleMs: opts.settleMs,
    onNotification: opts.onNotification, register: opts.register,
  });

  const homeOf = (env) => (env && env.CODEX_HOME) || process.env.CODEX_HOME || null;

  async function invoke({ prompt, model, signal, onDelta, env } = {}) {
    const home = homeOf(env);
    if (!home) throw new BridgeError('auth', 'No CODEX_HOME for this codex account.', {});
    const rpc = await manager.get(home);

    const { threadId } = await rpc.request(CODEX_RPC.threadStart, {
      model, cwd: home,
      // Pure chat: never let the model run shell/file tools.
      instructions: 'Answer the user directly. Do not run commands, edit files, or use tools.',
    }, { timeoutMs });

    let text = '';
    let usage = null;
    let failure = null;
    // turn.completed / turn.failed arrive as notifications; the turn/start
    // reply resolves after them. Collect via a per-turn notification filter.
    const detach = manager.onTurn ? manager.onTurn(home, threadId, handle) : attachLocal(rpc, threadId, handle);
    function handle(method, params) {
      if (method === CODEX_RPC.agentDelta && params && params.delta) {
        text += params.delta;
        if (typeof onDelta === 'function') onDelta(params.delta);
      } else if (method === CODEX_RPC.turnCompleted && params && params.usage) {
        const u = params.usage;
        usage = {
          promptTokens: (u.input_tokens || 0) + (u.cached_input_tokens || 0),
          completionTokens: u.output_tokens || 0,
          source: 'real',
        };
      } else if (method === CODEX_RPC.turnFailed) {
        failure = (params && params.error && params.error.message) || 'Codex turn failed';
      } else if (method === CODEX_RPC.errorEvent) {
        failure = (params && params.message) || 'Codex error';
      }
    }

    const onAbort = () => { try { rpc.notify('turn/interrupt', { threadId }); } catch (_) {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      await rpc.request(CODEX_RPC.turnStart, {
        threadId,
        input: prompt,
        model,
        ...(opts.reasoningEffort || (env && env.CODEX_EFFORT) ? { model_reasoning_effort: opts.reasoningEffort || env.CODEX_EFFORT } : {}),
      }, { timeoutMs });
    } finally {
      if (typeof detach === 'function') detach();
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (failure) throw classifyCodexError(failure);
    return { text, usage, stopReason: 'end_turn' };
  }

  // When the manager doesn't fan turn notifications per-thread, attach a
  // transient listener straight to this rpc client for the turn's duration.
  function attachLocal(rpc, threadId, handle) {
    const prev = rpc._turnHandler;
    rpc._turnHandler = handle;
    if (!rpc._turnWired) {
      rpc._turnWired = true;
    }
    // The manager routes onNotification to rpc._turnHandler when set.
    return () => { rpc._turnHandler = prev; };
  }

  return {
    name: 'codex',
    capabilities: { streaming: true, nativeUsage: true, sessions: false },
    invoke,
    identity: (env) => codexIdentity(homeOf(env)),
    async listModels() { return KNOWN_MODELS; },
    async healthCheck() {
      // Cheap liveness: the CLI answers `login status` offline, fast.
      return { ok: true, status: 200, durationMs: 0, detail: 'codex app-server' };
    },
    shutdown: () => manager.shutdown(),
    manager,
  };
}

module.exports = { createCodexAdapter, KNOWN_MODELS, parseCodexResetMs, classifyCodexError, codexIdentity };
```

Note on notification routing: the manager's `onNotification(home, method, params)` must reach the active turn's `handle`. Wire it simply: in `createCodexAdapter`, pass an `onNotification` into the manager that looks up the live rpc for that home and calls its `_turnHandler` if set:

```js
  const manager = opts.manager || createCodexManager({
    bin: opts.bin, baseArgs: opts.baseArgs, env: opts.env, settleMs: opts.settleMs, register: opts.register,
    onNotification: (home, method, params) => {
      // Route to whichever rpc client belongs to this home, if it has an
      // active turn handler.
      const rpc = manager.rpcFor && manager.rpcFor(home);
      if (rpc && typeof rpc._turnHandler === 'function') rpc._turnHandler(method, params);
    },
  });
```

And add `rpcFor(home)` to the manager's returned API (returns `children.get(home)?.rpc || null`) — add that one-line accessor in Task 2's manager (if you reach this and it's missing, add it: `rpcFor: (home) => { const e = children.get(home); return e ? e.rpc : null; }`). Keep `onTurn` out — the local `_turnHandler` routing is enough for one concurrent turn per account (which matches the per-account CLI-slot semaphore: max 1 by default).

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/codex.test.js`
Expected: PASS through C3.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → green.

```bash
git add packages/adapters/codex.js tests/codex.test.js
git commit -m "feat(codex): adapter — thread/turn invoke, streamed deltas, usage, quota grammar + reset parse"
```

---

### Task 4: Codex quota push → quota.js

Codex emits `account/rateLimits/updated` push notifications (and answers `account/rateLimits/read` at spawn). Feed both into the Phase-1 `quota.js` snapshot store as `source: 'push'`, using a new normalized parser.

**Files:**
- Modify: `packages/provider/quota.js` (add `parseCodexRateLimits`; add a `codex` poller that reads-at-spawn and accepts pushed updates)
- Test: `tests/quota.test.js` (append Q8 block)

- [ ] **Step 1: Append the failing Q8 block to `tests/quota.test.js`**

```js
  console.log('\n## Q8 — codex rate-limit parser');
  {
    const { parseCodexRateLimits } = require(path.join(REPO, 'packages/provider/quota.js'));
    const now = Math.floor(Date.now() / 1000);
    const limits = parseCodexRateLimits({
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: now + 3600 },
      secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: now + 604800 },
    });
    ok(limits.length === 2, 'Q8: primary + secondary → two windows');
    const session = limits.find((l) => l.group === 'session');
    const weekly = limits.find((l) => l.group === 'weekly');
    ok(session && session.percent === 40 && session.kind === 'session', 'Q8: primary (300min) → session 40%');
    ok(weekly && weekly.percent === 88 && weekly.kind === 'weekly_all', 'Q8: secondary (weekly) → weekly_all 88%');
    ok(session.resetsAt === (now + 3600) * 1000, 'Q8: resetsAt epoch-seconds → ms');
    ok(parseCodexRateLimits(null).length === 0, 'Q8: missing data → empty');
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/quota.test.js`
Expected: FAIL — `parseCodexRateLimits` is not a function.

- [ ] **Step 3: Add `parseCodexRateLimits` to `packages/provider/quota.js`**

Add next to `parseAgyQuotaSummary`:

```js
// codex app-server rate limits (account/rateLimits/read + /updated push).
// primary = 5-hour window, secondary = weekly; usedPercent 0-100; resetsAt
// epoch SECONDS. The meter is account-wide (not per-model).
function parseCodexRateLimits(rl) {
  const out = [];
  const add = (w, kind, group, label) => {
    if (!w || typeof w !== 'object') return;
    out.push({
      kind, group, label,
      percent: Number(w.usedPercent) || 0,
      resetsAt: w.resetsAt ? Number(w.resetsAt) * 1000 : 0,
    });
  };
  add(rl && rl.primary, 'session', 'session', 'Session (5h)');
  add(rl && rl.secondary, 'weekly_all', 'weekly', 'Weekly');
  return out;
}
```

Add `parseCodexRateLimits` to the module.exports list.

- [ ] **Step 4: Add codex to the quota service pollers + a push intake**

In `createQuotaService`, add a `codex` poller that reads rate limits via a caller-supplied `codexRateLimits(account)` (the adapter/manager provides it — an async fn returning the raw `rateLimits` object), and a public `pushCodex(name, rl)` so the server can feed `account/rateLimits/updated` notifications straight in:

```js
  async function pollCodex(acct) {
    if (typeof codexRateLimits !== 'function') return;
    const rl = await codexRateLimits(acct); // may spawn/handshake the app-server
    if (rl) record('codex', acct.name, parseCodexRateLimits(rl), 'push');
  }
```

Add `codexRateLimits = null` to the options destructure, add `codex: pollCodex` to the `POLLERS` map, and expose:

```js
  function pushCodex(name, rl) {
    if (rl) record('codex', name, parseCodexRateLimits(rl), 'push');
  }
```

Return `pushCodex` in the service's public object. (POLLERS already drives `pollAll`/`pollSoon`/backoff for free; the push path bypasses backoff since it's server-initiated, not a fetch.)

- [ ] **Step 5: Run to verify it passes**

Run: `node tests/quota.test.js`
Expected: PASS through Q8.

- [ ] **Step 6: Full suite + commit**

Run: `npm test` → green.

```bash
git add packages/provider/quota.js tests/quota.test.js
git commit -m "feat(quota): codex rate-limit parser + push intake (account/rateLimits) as source 'push'"
```

---

### Task 5: Engine registration — server.js, routes, pricing, envFor

Wire codex into the running server: a third adapter, `CODEX_HOME` credential redirection, `codex` as a valid route engine, concrete codex routes + aliases + cross-engine fallbacks, pricing entries, and the quota-service `codexRateLimits`/push hookup.

**Files:**
- Modify: `packages/provider/routes.js` (VALID_ENGINES + the cross-engine fallback rule already allows any different engine)
- Modify: `packages/provider/accounts.js` (`envFor` codex branch)
- Modify: `packages/provider/server.js` (adapter registration, quota codexRateLimits + push wiring, engineCap)
- Modify: `packages/provider/routes.json` (codex routes)
- Modify: `packages/provider/pricing.json` (codex models)
- Test: `tests/provider2.test.js` (validateRoutes accepts codex; a codex route resolves)

- [ ] **Step 1: Add the failing route-validation assertion**

In `tests/provider2.test.js`, near the existing `validateRoutes` engine tests (search `unknown engine`), add:

```js
  threw = false;
  try { validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'codex', model: 'gpt-5.5' }] }); }
  catch (e) { threw = true; }
  assert(!threw, 'validateRoutes accepts the codex engine');
```

Run: `node tests/provider2.test.js` → FAIL (`unknown engine "codex"`).

- [ ] **Step 2: Add codex to VALID_ENGINES**

In `packages/provider/routes.js` line 6:

```js
const VALID_ENGINES = new Set(['claude', 'gemini', 'codex']);
```

Run: `node tests/provider2.test.js` → the new assertion passes.

- [ ] **Step 3: `envFor` codex branch**

In `packages/provider/accounts.js` `envFor` (~line 254):

```js
  function envFor(engine, account) {
    if (!account || !account.dir) return null;
    if (engine === 'claude') return { CLAUDE_CONFIG_DIR: account.dir };
    if (engine === 'codex') return { CODEX_HOME: account.dir };
    return { HOME: account.dir }; // gemini/agy
  }
```

- [ ] **Step 4: Register the adapter + wire quota in `server.js`**

`require` line (~line 12):

```js
const { createClaudeAdapter, createAgyAdapter, createCodexAdapter } = require('@bridge/adapters');
```

The adapters map (~line 133) — register codex with the shared child registry and a push hook into the quota service. Because `quota` is created after `adapters`, pass the push via a late-bound closure (same pattern already used for the pool→quota reference):

```js
const { registerChild } = require('@bridge/core'); // add to the core require if not present — see note
const adapters = {
  claude: createClaudeAdapter(),
  gemini: createAgyAdapter(),
  codex: createCodexAdapter({
    register: (child) => registerChild(child),
    onNotification: (home, method, params) => {
      if (method === 'account/rateLimits/updated' && params && params.rateLimits) {
        const acct = pool.accounts('codex').find((a) => a.dir === home);
        if (acct && QUOTA_POLL) quota.pushCodex(acct.name, params.rateLimits);
      }
    },
  }),
};
```

Note on `registerChild`: `packages/core/cli-runner.js` currently keeps its registry private (only `runCli` adds to it). Export a `registerChild(child)` that does `registry.add(child); child.on('exit', () => registry.delete(child));` and add it to the module.exports — the codex manager's children must be reaped by `installGracefulShutdown` like every other CLI child. This is a 4-line addition to cli-runner.js + its index re-export; do it as the first edit of this task and note it.

The `codexRateLimits` for the quota poller (in the `createQuotaService({...})` block, ~line 208): add

```js
  codexRateLimits: async (acct) => {
    const rpc = await adapters.codex.manager.get(acct.dir);
    const r = await rpc.request('account/rateLimits/read', {}, { timeoutMs: 10000 });
    return r && r.rateLimits;
  },
```

`engineCap` (~line 269): codex streams prompt over the RPC input like claude (no ARG_MAX limit), so it stays `Infinity` — only `gemini` is capped. No change needed (the function already returns `Infinity` for non-gemini); confirm and leave it.

Shutdown: add `adapters.codex.shutdown();` to the teardown alongside `quota.stop()`.

- [ ] **Step 5: Add codex routes to `routes.json`**

Add two routes (keep the existing ones). A fast and a deep codex route, each with a cross-engine `quotaFallback` to an existing claude route (fallbacks must target a *different* engine — codex→claude is valid):

```json
    {
      "id": "bridge-codex-gpt-5.5-nova",
      "label": "Bridge Codex GPT-5.5 · Nova",
      "engine": "codex",
      "model": "gpt-5.5",
      "bestFor": "ChatGPT-subscription general reasoning",
      "enabled": true,
      "aliases": ["codex", "codex-default", "gpt-5.5"],
      "quotaFallback": "bridge-claude-sonnet-4.6-northstar"
    },
    {
      "id": "bridge-codex-gpt-5.6-sol-summit",
      "label": "Bridge Codex GPT-5.6 Sol · Summit",
      "engine": "codex",
      "model": "gpt-5.6-sol",
      "bestFor": "Hardest Codex reasoning",
      "enabled": true,
      "aliases": ["codex-deep", "gpt-5.6-sol"],
      "quotaFallback": "bridge-claude-opus-4.5-oracle"
    }
```

Run `node -e "require('./packages/provider/routes.js').validateRoutes(require('./packages/provider/routes.json'))"` → no throw.

- [ ] **Step 6: Add codex pricing to `pricing.json`**

In the `models` object (API-equivalent list prices per 1M tokens — codex subscription is flat-rate, these are only for the Usage $ estimate; use GPT-5-class list prices):

```json
    "gpt-5.6-sol": { "input": 5, "output": 15 },
    "gpt-5.6-terra": { "input": 2.5, "output": 10 },
    "gpt-5.6-luna": { "input": 1, "output": 4 },
    "gpt-5.5": { "input": 2.5, "output": 10 },
    "gpt-5.4": { "input": 2, "output": 8 },
    "gpt-5.4-mini": { "input": 0.5, "output": 2 }
```

- [ ] **Step 7: Full suite + smoke**

Run: `node tests/provider2.test.js && npm test` → green (provider2 gains the codex route-validation assertion; the fake CLIs don't run codex so no live app-server spawns in tests — codex accounts only appear if accounts.json lists a `codex` array, which the test boots don't).

Local boot smoke (no real codex account needed — confirms wiring doesn't crash and the engine appears):

```bash
BRIDGE_QUOTA_POLL=0 PROVIDER_PORT=19913 node packages/provider/server.js &
sleep 1.5
curl -s localhost:19913/v1/models | grep -o "codex" | head -1   # codex route surfaces
curl -s localhost:19913/dashboard/status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('engines:',Object.keys(j.accounts||{}))})" 2>/dev/null || echo "(status gated or empty — fine)"
kill %1
```

Report the `/v1/models` output. Expected: the codex route ids/aliases appear.

- [ ] **Step 8: Commit**

```bash
git add packages/provider/routes.js packages/provider/accounts.js packages/provider/server.js packages/provider/routes.json packages/provider/pricing.json packages/core/cli-runner.js packages/core/index.js tests/provider2.test.js
git commit -m "feat(codex): register engine — adapter, CODEX_HOME envFor, routes, pricing, quota push wiring, registerChild"
```

---

### Task 6: Onboarding + Docker

Codex accounts onboard by copying each account's `auth.json` into its `CODEX_HOME` dir (officially supported Mac→Linux). Add an import helper mirroring the Orbit pattern, and install the codex CLI in the Docker image.

**Files:**
- Create: `scripts/codex-login.sh`
- Modify: `deploy/Dockerfile`
- Modify: `docs/DEPLOY-NAS.md`

- [ ] **Step 1: Create `scripts/codex-login.sh`**

```bash
#!/usr/bin/env bash
# Onboard a codex (ChatGPT) account into the bridge pool.
# On the Mac (or any machine already logged into codex):
#   ./scripts/codex-login.sh <account-name> [runtime-dir]
# Copies the CURRENT ~/.codex/auth.json into the account's CODEX_HOME dir and
# reminds you to register it in accounts.json. Re-run after `codex login` for a
# different account to capture that account's auth.json.
set -euo pipefail
NAME="${1:?usage: codex-login.sh <account-name> [runtime-dir]}"
RUNTIME="${2:-$(cd "$(dirname "$0")/.." && pwd)/.bridge-runtime}"
SRC="${CODEX_HOME:-$HOME/.codex}/auth.json"
DEST_DIR="$RUNTIME/accounts/codex/$NAME"
[ -f "$SRC" ] || { echo "No auth.json at $SRC — run 'codex login' first." >&2; exit 1; }
mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST_DIR/auth.json"
chmod 600 "$DEST_DIR/auth.json"
echo "Wrote $DEST_DIR/auth.json"
echo "Now add to $RUNTIME/accounts.json under a \"codex\" array:"
echo "  { \"name\": \"$NAME\", \"dir\": \"accounts/codex/$NAME\", \"usageSource\": \"oauth\" }"
echo "Then restart the bridge (or Probe the account) — the app-server spawns lazily on first use."
```

`chmod +x scripts/codex-login.sh`. (For the headless NAS, the doc note below covers `codex login --device-auth`.)

- [ ] **Step 2: Install codex in the Docker image**

In `deploy/Dockerfile`, after the agy install block, add the codex CLI (leaner musl static binary; pin the version to match what the app-server RPC was verified against):

```dockerfile
# Codex CLI (ChatGPT-subscription engine). Static musl binary — no Node dep at
# runtime for the binary itself. Pinned: the app-server RPC surface is a de-facto
# API; a pinned version keeps the adapter's method names valid.
ARG CODEX_VERSION=0.141.0
RUN curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz" -o /tmp/codex.tgz \
    && tar -xzf /tmp/codex.tgz -C /usr/local/bin \
    && (test -x /usr/local/bin/codex || mv /usr/local/bin/codex-* /usr/local/bin/codex) \
    && rm /tmp/codex.tgz \
    && /usr/local/bin/codex --version
```

(If the release asset name differs at build time, the `mv` fallback renames the extracted `codex-*` to `codex`. The exact URL/asset should be confirmed against the pinned release when the operator builds — note this in the report.)

- [ ] **Step 3: Document onboarding in `docs/DEPLOY-NAS.md`**

Add a "Codex accounts" section: (a) Mac→NAS: run `codex login` per ChatGPT account, `./scripts/codex-login.sh <name>`, rsync the runtime dir; (b) headless NAS alternative: `docker exec -it ai-cli-bridge codex login --device-auth` and follow the device-code URL; (c) auth.json self-refreshes and is safe to copy (tokens aren't machine-bound), but keep one CODEX_HOME per account so refresh writes don't race. Note codex accounts use `usageSource: oauth` and their quota comes via the app-server push, not an HTTP poll.

- [ ] **Step 4: Verify script + Dockerfile syntax**

Run: `bash -n scripts/codex-login.sh` (syntax check, no execution) → clean.
Run: `grep -c "CODEX_VERSION" deploy/Dockerfile` → 2 (ARG + use). Do NOT run a docker build (operator's environment). Report both.

- [ ] **Step 5: Commit**

```bash
git add scripts/codex-login.sh deploy/Dockerfile docs/DEPLOY-NAS.md
git commit -m "feat(codex): onboarding script + Docker codex CLI install + NAS deploy docs"
```

---

### Task 7: Dashboard codex surfacing + docs + full verification

Codex accounts should render on the Accounts tab and the fleet summary like any engine (they already will, since those read `pool.snapshot()`/`/dashboard/status` generically) — this task confirms that and closes the phase.

**Files:**
- Modify: `packages/provider/dashboard/app.js` (only if an engine-name label or login-command hint hardcodes claude/gemini)
- Modify: `docs/STATE.md`

- [ ] **Step 1: Check the dashboard for hardcoded engine assumptions**

Grep `packages/provider/dashboard/app.js` for `'claude'`/`'gemini'`/`CLAUDE_CONFIG_DIR`/`HOME=` — the Accounts tab's per-account login-command hint (Phase 1) builds `CLAUDE_CONFIG_DIR=... claude` or `HOME=... agy`. Extend that one ternary to a three-way including codex:

```js
        var loginCmd = e === 'claude' ? ('CLAUDE_CONFIG_DIR=' + (a.dir || '<dir>') + ' claude')
          : e === 'codex' ? ('CODEX_HOME=' + (a.dir || '<dir>') + ' codex login')
          : ('HOME=' + (a.dir || '<dir>') + ' agy');
```

(Read the actual code first — adapt to the real variable/structure. If the hint is already generic, no change; note it.) The quota bars and fleet summary are already engine-agnostic (they iterate `s.accounts` keys) — confirm codex would render by inspection.

- [ ] **Step 2: Update `docs/STATE.md`**

Bump `last-updated`; add a first bullet: **Router Phase 3 shipped — codex engine.** Cover (cross-check against `git log 3f70518..HEAD`): NDJSON JSON-RPC client + per-CODEX_HOME app-server manager (lazy spawn, handshake, registry-reaped shutdown, crash-restart), codex adapter (thread/turn invoke, streamed `item/agentMessage/delta`, `turn.completed` usage, usage-limit grammar → quota with parsed reset, "at capacity" = retryable), codex quota via `account/rateLimits` push (source 'push', primary 5h / secondary weekly), engine registration (VALID_ENGINES, CODEX_HOME envFor, routes+aliases+cross-engine fallbacks, pricing, `registerChild` for shutdown reaping), onboarding script + Docker codex install (pinned version), dashboard surfacing. Flag the RPC-surface risk + the CODEX_RPC single-point-of-change mitigation. Note the codex CLI version pin. Test suite now 9 files. Update "Up Next": Phase 4 (auto-routes/rules/per-key flags/latency tiebreak), Phase 5 (NAS deploy + live smokes incl. first real codex call). Carry forward the pending operator actions (Orbit import run, NAS rebuild).

- [ ] **Step 3: Full verification**

Run: `npm test` → all 9 suites green. Report per-suite counts.
Run: `npm run check` → clean.

- [ ] **Step 4: Commit**

```bash
git add packages/provider/dashboard/app.js docs/STATE.md
git commit -m "feat(codex): dashboard surfacing + Phase 3 state notes"
```

---

## Out of scope (later phases)

Auto-routes / rules engine / per-key routing flags / latency tiebreak (Phase 4); NAS rebuild + live smokes + the first real codex completion (Phase 5); codex exec-per-request fallback (documented, built only if the app-server RPC proves unstable); true per-turn concurrency > 1 per codex account (current design serializes one turn per account, matching the default CLI-slot semaphore).

## Notes carried in from Phase 2's final review

- **Correction-loop strike counter** (must-remember for this phase): the quota→breaker correction is bounded only by `PROVIDER_MAX_CONCURRENT_PER_ENGINE`. Codex adds a third engine but does not raise that per-engine cap, so the bound holds. Do NOT raise codex concurrency above 1 per account without adding correction-outcome backoff first.
- **`fresh` naming**: per-window `fresh` (reset boundary passed) vs snapshot `staleMinutes` (recency) — codex's push path uses the same `record()`/`effective()`, so the same distinction applies; don't introduce a third meaning.
