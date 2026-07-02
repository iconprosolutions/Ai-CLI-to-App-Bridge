# Server Edition Phase A — Multi-Account Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** N named Claude/Gemini accounts per bridge with per-account breakers and parallel lanes, round-robin rotation, one-shot transparent failover on quota/auth failure, and route-level pinning — with zero-config backward compatibility.

**Architecture:** A new `packages/provider/accounts.js` owns the account registry (`accounts.json`, hot-reloadable) and per-account breaker+semaphore state. Adapters gain an `env` pass-through so each spawn points at its account's credential dir (`CLAUDE_CONFIG_DIR` for claude, `HOME` for agy — both verified live 2026-07-02). `server.js` swaps its per-engine breaker/semaphore maps for the pool. A new `auth` BridgeError kind marks logged-out accounts (claude: `result` line with `is_error` + "Not logged in"; agy: `Error: authentication failed` **with exit 0** — a latent bug today).

**Tech Stack:** Node.js (zero new dependencies), existing fake-CLI test harness.

**Verified facts this plan relies on (Spike A0, 2026-07-02):**
- `CLAUDE_CONFIG_DIR=<empty dir> claude -p …` → stream-json `result` line: `{"type":"result","is_error":true,"result":"Not logged in · Please run /login", ...}`, exit 0.
- `HOME=<empty dir> agy --print …` → stdout `Error: authentication failed or timed out`, exit 0.
- `runCli` already accepts `env` (packages/core/cli-runner.js:67,80) but it **replaces** the child env — callers must spread `process.env`.

---

### Task 1: `auth` error kind

**Files:**
- Modify: `packages/core/errors.js`
- Test: `tests/core.test.js`

- [ ] **Step 1: Write failing tests** — append to the errors section of `tests/core.test.js`:

```js
{
  const authErr = new BridgeError('auth', 'account logged out');
  assert(authErr.kind === 'auth', 'auth is a valid BridgeError kind');
  const m = httpFor(authErr);
  assert(m.status === 503 && m.type === 'engine_auth_error', 'auth maps to 503 engine_auth_error');
}
```

- [ ] **Step 2: Run** `node tests/core.test.js` — expect FAIL (`Unknown BridgeError kind: auth`).

- [ ] **Step 3: Implement** — in `packages/core/errors.js` add to `KINDS` after `'invalid_request'`:

```js
  'auth', // the CLI account is logged out / credentials expired — needs operator action
```

and in `httpFor` add before the `default` group:

```js
    case 'auth':
      return { status: 503, type: 'engine_auth_error', param: null, retryAfterSec: null };
```

- [ ] **Step 4: Run** `node tests/core.test.js` — expect PASS (all existing + 2 new).
- [ ] **Step 5: Commit** `git add packages/core/errors.js tests/core.test.js && git commit -m "feat(core): auth error kind for logged-out CLI accounts"`

### Task 2: fake-cli env logging

**Files:**
- Modify: `tests/fixtures/fake-cli.js` (next to the existing `FAKE_CLI_LOG` block, ~line 32)

- [ ] **Step 1: Add** (non-breaking — separate file from `FAKE_CLI_LOG`, whose lines existing tests parse as plain argv arrays):

```js
  if (process.env.FAKE_CLI_ENV_LOG) {
    require('fs').appendFileSync(process.env.FAKE_CLI_ENV_LOG, `${JSON.stringify({
      argv: simArgs,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
      HOME: process.env.HOME || null,
    })}\n`);
  }
```

- [ ] **Step 2: Verify no regression:** `node tests/provider2.test.js` — expect PASS (93 assertions).
- [ ] **Step 3: Commit** `git add tests/fixtures/fake-cli.js && git commit -m "test: fake-cli env logging for account-pool assertions"`

### Task 3: account pool module

**Files:**
- Create: `packages/provider/accounts.js`
- Test: `tests/provider2.test.js` (new unit section, before the HTTP boots)

- [ ] **Step 1: Write failing unit tests** — add a `testAccountPool()` section exercising, against a temp `accounts.json`:
  1. missing file → implicit `default` account per engine, `envFor` → `null`;
  2. two claude accounts → `select` round-robins (a, b, a);
  3. `feedback` with two quota errors on `a` → `a`'s breaker opens → `select` returns only `b`; both open → `{ok:false, status:429, retryInSec>0}`;
  4. `feedback` with `auth` error → account `needsLogin`, excluded; `snapshot()` shows it;
  5. `select` with `pin:'a'` while `a` is open → `{ok:false}` and never returns `b`;
  6. `select` with `exclude:'a'` skips `a`;
  7. `envFor` returns `{CLAUDE_CONFIG_DIR: <abs>}` for claude and `{HOME: <abs>}` for gemini;
  8. `validateAccounts` throws on duplicate names and bad name characters.

```js
const { createAccountPool, validateAccounts } = require('../packages/provider/accounts');

async function testAccountPool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
  const file = path.join(dir, 'accounts.json');

  // (1) missing file → implicit defaults
  {
    const pool = createAccountPool({ file, baseDir: dir, engines: ['claude', 'gemini'], watch: false });
    const sel = pool.select('claude');
    assert(sel.ok && sel.account.name === 'default' && sel.account.implicit, 'implicit default account when no accounts.json');
    assert(pool.envFor('claude', sel.account) === null, 'implicit default leaves env untouched');
  }

  fs.writeFileSync(file, JSON.stringify({
    claude: [{ name: 'a', dir: 'accounts/claude/a' }, { name: 'b', dir: 'accounts/claude/b' }],
    gemini: [{ name: 'g', dir: 'accounts/gemini/g' }],
  }));
  const pool = createAccountPool({
    file, baseDir: dir, engines: ['claude', 'gemini'], watch: false,
    breakerOpts: { quotaThreshold: 2, quotaCooldownMs: 60000 },
  });

  // (2) round-robin
  const s1 = pool.select('claude'); const s2 = pool.select('claude'); const s3 = pool.select('claude');
  assert(s1.account.name === 'a' && s2.account.name === 'b' && s3.account.name === 'a', 'round-robin rotation');

  // (7) env mapping
  assert(pool.envFor('claude', s1.account).CLAUDE_CONFIG_DIR === path.join(dir, 'accounts/claude/a'), 'claude env → CLAUDE_CONFIG_DIR');
  const g = pool.select('gemini');
  assert(pool.envFor('gemini', g.account).HOME === path.join(dir, 'accounts/gemini/g'), 'gemini env → HOME');

  // (3) quota opens a's breaker → rotation avoids it; both open → 429 shape
  const quotaErr = new BridgeError('quota', 'limit');
  pool.feedback('claude', s1.account, quotaErr); pool.feedback('claude', s1.account, quotaErr);
  for (let i = 0; i < 4; i += 1) {
    const s = pool.select('claude');
    assert(s.ok && s.account.name === 'b', 'open breaker excluded from rotation');
  }
  pool.feedback('claude', s2.account, quotaErr); pool.feedback('claude', s2.account, quotaErr);
  const exhausted = pool.select('claude');
  assert(!exhausted.ok && exhausted.status === 429 && exhausted.retryInSec > 0, 'all accounts open → 429 + retry hint');

  // (4) auth → needs-login exclusion
  pool.resetBreakers('claude');
  pool.feedback('claude', s1.account, new BridgeError('auth', 'Not logged in'));
  assert(pool.select('claude').account.name === 'b', 'needs-login account excluded');
  const snap = pool.snapshot();
  assert(snap.claude.find((x) => x.name === 'a').needsLogin === true, 'snapshot reports needsLogin');

  // (5) pin never rotates
  const pinned = pool.select('claude', { pin: 'a' });
  assert(!pinned.ok && pinned.status === 503, 'pinned needs-login account fails loud, no rotation');
  assert(pool.select('claude', { pin: 'nope' }).status === 400, 'unknown pin → 400');

  // (6) exclude
  pool.clearNeedsLogin('claude', 'a');
  assert(pool.select('claude', { exclude: 'a' }).account.name === 'b', 'exclude skips the named account');

  // (8) validation
  assert.throws(() => validateAccounts({ claude: [{ name: 'x' }, { name: 'x' }] }), /duplicate/, 'duplicate names rejected');
  assert.throws(() => validateAccounts({ claude: [{ name: 'bad name!' }] }), /name/, 'bad name characters rejected');
  console.log('✓ account pool unit tests');
}
```

- [ ] **Step 2: Run** `node tests/provider2.test.js` — expect FAIL (module not found).

- [ ] **Step 3: Implement `packages/provider/accounts.js`:**

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { createBreaker } = require('./breaker');
const { createSemaphore } = require('./semaphore');

const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Validate a parsed accounts.json: { claude: [{name, dir, enabled?}], gemini: [...] }.
// Same philosophy as routes.json — throw precisely at boot, keep last good on reload.
function validateAccounts(data) {
  if (!data || typeof data !== 'object') throw new Error('accounts.json: root must be an object');
  for (const [engine, list] of Object.entries(data)) {
    if (!Array.isArray(list)) throw new Error(`accounts.json: "${engine}" must be an array`);
    const seen = new Set();
    for (const a of list) {
      if (!a || typeof a.name !== 'string' || !NAME_RE.test(a.name)) {
        throw new Error(`accounts.json: every ${engine} account needs a name matching ${NAME_RE}`);
      }
      if (seen.has(a.name)) throw new Error(`accounts.json: duplicate ${engine} account name "${a.name}"`);
      seen.add(a.name);
      if (typeof a.dir !== 'string' || !a.dir) throw new Error(`accounts.json: ${engine}/${a.name} needs a "dir"`);
    }
  }
  return data;
}

// Live multi-account pool: per-account breaker + semaphore, round-robin
// selection, needs-login exclusion, hot reload preserving state by name.
// No accounts.json (or an engine absent from it) → one implicit "default"
// account that leaves the CLI environment untouched — the zero-config path.
function createAccountPool({
  file,
  baseDir,
  engines,
  watch = true,
  logger = console,
  breakerOpts = {},
  semaphoreOpts = {},
  onChange = null,
} = {}) {
  const state = {}; // engine → { accounts: [], cursor: 0 }

  const emit = (event) => { if (typeof onChange === 'function') onChange(event); };

  const makeAccount = (engine, def) => {
    const acct = {
      engine,
      name: def.name,
      dir: def.dir ? path.resolve(baseDir, def.dir) : null,
      enabled: def.enabled !== false,
      implicit: Boolean(def.implicit),
      needsLogin: false,
      breaker: createBreaker({
        engine: `${engine}:${def.name}`,
        ...breakerOpts,
        onChange: (s) => emit({ kind: 'breaker', engine, account: def.name, breaker: s }),
      }),
      semaphore: createSemaphore(semaphoreOpts),
    };
    if (acct.dir) { try { fs.mkdirSync(acct.dir, { recursive: true }); } catch (_) { /* surfaces at spawn */ } }
    return acct;
  };

  const build = (data) => {
    for (const engine of engines) {
      const defs = (data && Array.isArray(data[engine]) && data[engine].length > 0)
        ? data[engine]
        : [{ name: 'default', dir: null, implicit: true }];
      const prev = state[engine] ? state[engine].accounts : [];
      state[engine] = {
        cursor: state[engine] ? state[engine].cursor : 0,
        accounts: defs.map((def) => {
          const old = prev.find((p) => p.name === def.name && p.dir === (def.dir ? path.resolve(baseDir, def.dir) : null));
          if (old) { old.enabled = def.enabled !== false; return old; } // keep breaker/needsLogin state
          return makeAccount(engine, def);
        }),
      };
    }
  };

  const load = () => {
    if (!fs.existsSync(file)) { build(null); return; }
    build(validateAccounts(JSON.parse(fs.readFileSync(file, 'utf8'))));
  };
  load();

  if (watch && fs.existsSync(file)) {
    let timer = null;
    try {
      fs.watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try { load(); logger.log(`[accounts] reloaded from ${file}`); emit({ kind: 'reload' }); }
          catch (err) { logger.error(`[accounts] reload rejected, keeping previous config: ${err.message}`); }
        }, 300);
        timer.unref();
      });
    } catch (_) { /* best-effort, as with routes.json */ }
  }

  const eligible = (a) => a.enabled && !a.needsLogin;

  function select(engine, { pin = null, exclude = null } = {}) {
    const eng = state[engine];
    if (!eng) return { ok: false, status: 400, message: `Unknown engine "${engine}"` };

    if (pin) {
      const acct = eng.accounts.find((a) => a.name === pin);
      if (!acct) return { ok: false, status: 400, message: `Unknown ${engine} account "${pin}"` };
      if (!acct.enabled) return { ok: false, status: 503, message: `Account "${engine}:${pin}" is disabled.` };
      if (acct.needsLogin) return { ok: false, status: 503, message: `Account "${engine}:${pin}" needs login. Run the account login step, then probe it from the dashboard.` };
      const gate = acct.breaker.allow();
      if (!gate.allowed) {
        return { ok: false, status: 429, message: `Account "${engine}:${pin}" circuit is open (${gate.reason || 'capacity'}).`, retryInSec: gate.retryInSec || 5 };
      }
      return { ok: true, account: acct, trial: Boolean(gate.trial) };
    }

    const n = eng.accounts.length;
    let soonest = null;
    for (let i = 0; i < n; i += 1) {
      const acct = eng.accounts[(eng.cursor + i) % n];
      if (!eligible(acct) || acct.name === exclude) continue;
      const gate = acct.breaker.allow();
      if (gate.allowed) {
        eng.cursor = (eng.cursor + i + 1) % n;
        return { ok: true, account: acct, trial: Boolean(gate.trial) };
      }
      if (gate.retryInSec && (soonest === null || gate.retryInSec < soonest)) soonest = gate.retryInSec;
    }
    if (soonest !== null) {
      return { ok: false, status: 429, message: `All ${engine} accounts are cooling down. Retry in ~${soonest}s.`, retryInSec: soonest };
    }
    return { ok: false, status: 503, message: `No usable ${engine} account (all disabled or logged out).` };
  }

  function envFor(engine, account) {
    if (!account || !account.dir) return null;
    return engine === 'claude' ? { CLAUDE_CONFIG_DIR: account.dir } : { HOME: account.dir };
  }

  function feedback(engine, account, err) {
    if (!account) return;
    if (!err) {
      account.needsLogin = false;
      account.breaker.recordSuccess();
      return;
    }
    if (err.kind === 'aborted') return; // says nothing about the account
    if (err.kind === 'auth') {
      if (!account.needsLogin) {
        account.needsLogin = true;
        emit({ kind: 'needs-login', engine, account: account.name });
      }
      return;
    }
    account.breaker.recordFailure(err.kind);
  }

  function clearNeedsLogin(engine, name) {
    const acct = state[engine] && state[engine].accounts.find((a) => a.name === name);
    if (acct) acct.needsLogin = false;
    return acct || null;
  }

  function resetBreakers(engine) {
    for (const a of (state[engine] ? state[engine].accounts : [])) a.breaker.reset();
  }

  // Engine-level aggregate kept for the existing dashboard/status contract:
  // closed while any account can take traffic; open (min retry) when none can.
  function engineBreakerStatus(engine) {
    const accounts = state[engine] ? state[engine].accounts : [];
    const usable = accounts.filter(eligible);
    const statuses = usable.map((a) => a.breaker.status());
    if (statuses.some((s) => s.state !== 'open')) {
      return { engine, state: 'closed', reason: null, openedAt: null, retryInSec: 0 };
    }
    const min = statuses.reduce((m, s) => (m === null || s.retryInSec < m.retryInSec ? s : m), null);
    return min ? { ...min, engine } : { engine, state: 'open', reason: 'auth', openedAt: null, retryInSec: 0 };
  }

  const sums = (engine, prop) => (state[engine] ? state[engine].accounts : []).reduce((t, a) => t + a.semaphore[prop], 0);

  function snapshot() {
    const out = {};
    for (const engine of engines) {
      out[engine] = state[engine].accounts.map((a) => ({
        engine,
        name: a.name,
        dir: a.dir,
        implicit: a.implicit,
        enabled: a.enabled,
        needsLogin: a.needsLogin,
        breaker: a.breaker.status(),
        inflight: a.semaphore.active,
        queued: a.semaphore.queued,
      }));
    }
    return out;
  }

  return {
    select, envFor, feedback, clearNeedsLogin, resetBreakers, engineBreakerStatus, snapshot,
    inflight: (engine) => sums(engine, 'active'),
    queued: (engine) => sums(engine, 'queued'),
    accounts: (engine) => (state[engine] ? state[engine].accounts.slice() : []),
    reload: () => { load(); },
    file,
  };
}

module.exports = { createAccountPool, validateAccounts };
```

- [ ] **Step 4: Run** `node tests/provider2.test.js` — account-pool unit section PASS (existing HTTP sections unaffected).
- [ ] **Step 5: Commit** `git add packages/provider/accounts.js tests/provider2.test.js && git commit -m "feat(provider): account pool — per-account breakers, rotation, pinning, needs-login"`

### Task 4: adapters — env pass-through + auth classification

**Files:**
- Modify: `packages/adapters/claude.js`, `packages/adapters/agy.js`
- Test: `tests/provider2.test.js` (unit additions; HTTP coverage lands in Task 7)

- [ ] **Step 1: claude.js changes.**
  - `invokeStreamJson({ prompt, model, signal, onDelta, env })` and `invokeText({ ... , env })`; both `runCli` calls gain `env: env ? { ...process.env, ...env } : undefined` (runCli replaces the child env wholesale, so spread process.env).
  - `invoke({ prompt, model, signal, onDelta, env } = {})` threads `env` to both paths.
  - In `invokeStreamJson`, replace the `is_error` block with:

```js
    if (resultLine.is_error) {
      const msg = String(resultLine.result || resultLine.subtype || 'Claude request failed');
      let kind = 'bad_output';
      if (/usage limit|limit reached|rate limit/i.test(msg)) kind = 'quota';
      else if (/not logged in|please run \/login|authentication_failed|oauth token (?:expired|revoked)|invalid api key/i.test(msg)) kind = 'auth';
      throw new BridgeError(kind, msg);
    }
```

- [ ] **Step 2: agy.js changes.**
  - `invoke({ prompt, model, signal, onDelta, env } = {})`; `runCli` gains the same `env: env ? { ...process.env, ...env } : undefined`.
  - In `classifyError`, before the quota check:

```js
  if (/authentication failed|please sign in|not signed in|sign in to continue/i.test(text)) {
    return new BridgeError('auth', 'Antigravity is not signed in for this account. Complete the account login, then retry.', { detail: text.slice(0, 300) });
  }
```

  - **Latent-bug fix** — agy prints auth failures with exit 0, so classifyError never fires. After `runCli` returns, before building the result:

```js
      const finalText = collapseCarriageReturns(stripAnsi(run.text)).trim();
      const authErr = classifyError('', finalText);
      if (authErr && authErr.kind === 'auth' && finalText.length < 200) throw authErr;
      return { text: finalText, usage: null, stopReason: 'end_turn' };
```

  (Length guard: a long real answer that merely *mentions* sign-in must not be swallowed; the genuine failure is a single short line.)

- [ ] **Step 3: Run** `node tests/provider2.test.js && node tests/provider.test.js && node tests/security.test.js` — all PASS (no behavior change without `env`; auth classification exercised in Task 7).
- [ ] **Step 4: Commit** `git add packages/adapters && git commit -m "feat(adapters): per-invocation env + auth classification (incl. agy exit-0 auth bug)"`

### Task 5: routes.js — optional `account` pin field

**Files:**
- Modify: `packages/provider/routes.js` (inside the per-route loop of `validateRoutes`)

- [ ] **Step 1: Add validation** after the aliases check:

```js
    if (r.account !== undefined && (typeof r.account !== 'string' || !/^[A-Za-z0-9._-]+$/.test(r.account))) {
      throw new Error(`routes.json: "account" must be a simple account name on ${r.id}`);
    }
```

- [ ] **Step 2: Test** — in the routes section of `tests/provider2.test.js`: `validateRoutes` accepts a route with `account: 'work'` and rejects `account: 'bad name!'`. Run: PASS.
- [ ] **Step 3: Commit** `git add packages/provider/routes.js tests/provider2.test.js && git commit -m "feat(provider): routes may pin an account"`

### Task 6: server.js — pool integration + failover

**Files:**
- Modify: `packages/provider/server.js`, `packages/provider/admin.js`

- [ ] **Step 1: Construction swap** (server.js:61–81). Keep `enginesDisabled`; delete the `breakers`/`semaphores` maps and their loop; add:

```js
const { createAccountPool } = require('./accounts');
// ...
const pool = createAccountPool({
  file: process.env.BRIDGE_ACCOUNTS_FILE || path.resolve(__dirname, '../../.bridge-runtime/accounts.json'),
  baseDir: path.resolve(__dirname, '../../.bridge-runtime'),
  engines: ENGINE_NAMES,
  breakerOpts: {
    quotaCooldownMs: intEnv('BREAKER_QUOTA_COOLDOWN_MS', 15 * 60 * 1000),
    timeoutCooldownMs: intEnv('BREAKER_TIMEOUT_COOLDOWN_MS', 2 * 60 * 1000),
  },
  semaphoreOpts: {
    max: MAX_CONCURRENT_PER_ENGINE,
    queueDepth: intEnv('PROVIDER_QUEUE_DEPTH', 4),
    queueTimeoutMs: intEnv('PROVIDER_QUEUE_TIMEOUT_MS', 30000),
  },
  onChange: (ev) => {
    if (ev.kind === 'breaker') console.log(`[breaker] ${ev.engine}:${ev.account} → ${ev.breaker.state}${ev.breaker.reason ? ` (${ev.breaker.reason})` : ''}`);
    if (ev.kind === 'needs-login') console.warn(`[accounts] ${ev.engine}:${ev.account} needs login`);
    events.emit('account.change', ev);
  },
});
```

- [ ] **Step 2: Status endpoints.** In `/dashboard/status`: `inflight`/`queue` use `pool.inflight(e)`/`pool.queued(e)`; `breakers` uses `pool.engineBreakerStatus(e)`; add `accounts: pool.snapshot(),`. In `/health`: `inflightClaude: pool.inflight('claude'), inflightGemini: pool.inflight('gemini')`.

- [ ] **Step 3: Request path** (replaces the breaker-gate block at server.js:322–335 and the acquire at 362–374):

```js
  // Account selection honors the route pin; pinned requests fail loud rather
  // than silently switching accounts.
  let sel = pool.select(route.engine, { pin: route.account || null });
  if (!sel.ok) {
    record(sel.status);
    return sendError(res, sel.status, sel.message, sel.status === 429 ? 'rate_limit_error' : 'engine_auth_error', null, sel.retryInSec);
  }
```

then (acquire — same error handling as today, account-scoped):

```js
  let release;
  try {
    release = await sel.account.semaphore.acquire(ac.signal);
  } catch (err) { /* unchanged busy/aborted handling */ }
```

- [ ] **Step 4: Failover wrapper** — insert after `breakerFeedback` (which becomes `pool.feedback(route.engine, sel.account, err)`); `active.account = sel.account.name` for observability:

```js
    // One-shot transparent failover: a quota/auth/spawn failure on a pooled
    // (un-pinned) account moves the SAME request to the next healthy account
    // — but never after bytes have reached the client.
    const FAILOVER_KINDS = new Set(['quota', 'auth', 'spawn_failed']);
    const invokeArgsFor = () => ({ model: route.model, signal: ac.signal });
    const invokeWithFailover = async (prompt, onDelta, canFailover) => {
      try {
        return await adapter.invoke({ prompt, onDelta, env: pool.envFor(route.engine, sel.account), ...invokeArgsFor() });
      } catch (err) {
        const kind = err instanceof BridgeError ? err.kind : null;
        if (!route.account && FAILOVER_KINDS.has(kind) && canFailover() && !clientAborted) {
          pool.feedback(route.engine, sel.account, err);
          const next = pool.select(route.engine, { exclude: sel.account.name });
          if (next.ok) {
            release(); release = await next.account.semaphore.acquire(ac.signal);
            sel = next;
            active.account = sel.account.name;
            return adapter.invoke({ prompt, onDelta, env: pool.envFor(route.engine, sel.account), ...invokeArgsFor() });
          }
        }
        throw err;
      }
    };
```

  - **Streaming path:** track `let streamedBytes = false;` set inside the pacer write callback; the hold-back `feed` state must reset on failover, so `canFailover = () => !streamedBytes` and inside the failover branch reset `held = ''; holding = toolsProvided;` (achieved by hoisting `held`/`holding` with `let` above the wrapper — they already are). First invoke becomes `invokeWithFailover(prompt, feed, () => !streamedBytes)`.
  - **Non-stream path:** first invoke becomes `invokeWithFailover(prompt, markFirstByte, () => true)`. The `enforceJson` retry, tool_choice retry keep plain `adapter.invoke` **plus** `env: pool.envFor(route.engine, sel.account)` (same account as the answer being corrected).
  - All `breakers[route.engine].recordX` / `breakerFeedback` uses become `pool.feedback(route.engine, sel.account, err?)`.
  - `record()` gains `account: active.account || null` in both `telemetry.record` and `ledger.append` payloads (additive fields).

- [ ] **Step 5: admin.js** — signature gains `pool` (keep the rest): `createAdminRouter({ apiKey, registry, pool, adapters, ... })`; breaker reset becomes:

```js
  router.post('/breakers/:engine/reset', (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine) return undefined;
    pool.resetBreakers(engine);
    return res.json({ engine, breaker: pool.engineBreakerStatus(engine) });
  });
```

  and a per-account probe used by the Accounts tab later (clears needs-login on success):

```js
  router.post('/accounts/:engine/:name/probe', async (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine) return undefined;
    const acct = pool.accounts(engine).find((a) => a.name === req.params.name);
    if (!acct) return res.status(404).json({ error: `Unknown account "${engine}:${req.params.name}"` });
    try {
      const out = await adapters[engine].invoke({ prompt: 'Reply with exactly: OK', env: pool.envFor(engine, acct) });
      pool.clearNeedsLogin(engine, acct.name);
      pool.feedback(engine, acct, null);
      return res.json({ engine, account: acct.name, ok: true, sample: String(out.text).slice(0, 40) });
    } catch (err) {
      pool.feedback(engine, acct, err);
      return res.status(502).json({ engine, account: acct.name, ok: false, error: err.message, kind: err.kind || null });
    }
  });
```

  Server passes `pool` into `createAdminRouter`.

- [ ] **Step 6: Run all suites** — `node tests/core.test.js && node tests/pacer.test.js && node tests/provider2.test.js && node tests/provider.test.js && node tests/security.test.js`. Expect PASS: with no `BRIDGE_ACCOUNTS_FILE` and no accounts.json in the isolated runtime, every engine has one implicit `default` account — aggregate breaker/queue behavior is exactly today's.
- [ ] **Step 7: Commit** `git add packages/provider tests && git commit -m "feat(provider): account pool wired into request path with one-shot failover"`

### Task 7: integration tests (fake CLIs, isolated accounts.json)

**Files:**
- Test: `tests/provider2.test.js` — new `testAccounts(port)` boot. Write `accounts.json` into TMP, set `process.env.BRIDGE_ACCOUNTS_FILE` in `bootProvider` env (and delete after, like the other isolation vars).

- [ ] **Step 1: Write the boot + assertions:**

```js
async function testAccounts(port) {
  const ENVLOG = path.join(TMP, 'env.log');
  const ACCTS = path.join(TMP, 'accounts.json');
  fs.writeFileSync(ACCTS, JSON.stringify({
    claude: [
      { name: 'w1', dir: 'acct/claude/w1' },
      { name: 'w2', dir: 'acct/claude/w2' },
    ],
  }));
  const CLAUDE_ACCT = writeStub('claude-acct.sh', 'claude-sim', { FAKE_CLI_ENV_LOG: ENVLOG });
  const srv = await bootProvider(port, {
    CLAUDE_PATH: CLAUDE_ACCT, GEMINI_PATH: CLAUDE_ACCT,
    BRIDGE_ACCOUNTS_FILE: ACCTS, PROVIDER_API_KEY: 'k',
  });
  const call = (model) => post(port, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer k' });

  // Rotation: two calls land on different CLAUDE_CONFIG_DIRs.
  await call('bridge-claude-haiku-4.5-spark');
  await call('bridge-claude-haiku-4.5-spark');
  const envLines = fs.readFileSync(ENVLOG, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((l) => l.argv.includes('-p'));
  const dirs = new Set(envLines.map((l) => l.CLAUDE_CONFIG_DIR).filter(Boolean));
  assert(dirs.size === 2 && [...dirs].every((d) => /acct\/claude\/w[12]$/.test(d)), 'rotation spans both account config dirs');

  // /dashboard/status exposes the pool.
  const status = await get(port, '/dashboard/status');
  assert(Array.isArray(status.body.accounts.claude) && status.body.accounts.claude.length === 2, 'status lists both claude accounts');
  await srv.close();
}
```

- [ ] **Step 2: Failover + exhaustion boot** (quota stub as account w1's first hit; uses `FAKE_CLI_STATE_FILE`-style scripting): a `claude-sim` stub with `FAKE_CLI_STDERR: 'Claude usage limit reached...'` + `FAKE_CLI_MODE=stderr-fail` makes *every* call fail — so instead assert the coarser behaviors, which the unit tests already cover finely:
  - boot with the always-quota stub and two accounts → first call still answers 429 **only after** both accounts were attempted: `FAKE_CLI_ENV_LOG` shows two `-p` invocations with the two different dirs for that single request (failover proof);
  - second call → 429 with `Retry-After` (both breakers open — requires 2 failures each, so issue three calls total and assert the last is 429 with `retry-after` header).
  - auth stub (`claude-sim` + `FAKE_CLI_TEXT` result `Not logged in · Please run /login`, `is_error:true` — extend fake-cli claude-sim: when `FAKE_CLI_AUTH_FAIL=1`, emit the verified logged-out result line) → response 503 `engine_auth_error` after failover attempt; `/dashboard/status` shows `needsLogin: true` on both accounts.
  - pinned route: `POST /admin/routes` add `{id:'pin-test', label:'t', engine:'claude', model:'x', account:'w1'}` (admin key) → with w1 needing login → 503, and env log shows **no** new spawn (fails before spawning).
- [ ] **Step 3: Run** `node tests/provider2.test.js` — all PASS.
- [ ] **Step 4: Commit** `git add tests && git commit -m "test(provider): account rotation, failover, exhaustion, needs-login, pinning"`

### Task 8: full verification + docs touch

- [ ] **Step 1:** `for t in core pacer provider2 provider security; do node tests/$t.test.js || break; done` — all green.
- [ ] **Step 2:** Live smoke on the Mac (implicit default account — proves zero-config compat): restart provider, one real `/v1/chat/completions` call, check `/dashboard/status` shows `accounts.claude[0].name === 'default'`.
- [ ] **Step 3:** Update `docs/HOW-IT-WORKS.md` (accounts section: file format, selection precedence, failover semantics, env vars `BRIDGE_ACCOUNTS_FILE`) and `docs/STATE.md` (Phase A done).
- [ ] **Step 4:** Commit `git add docs && git commit -m "docs: multi-account pool (server edition phase A)"`
