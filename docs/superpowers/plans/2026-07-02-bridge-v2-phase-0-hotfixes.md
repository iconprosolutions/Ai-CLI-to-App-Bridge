# Bridge v2 Phase 0 — Hotfixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the nine verified correctness/security bugs on the current tree (spec §8 Phase 0) without restructuring, each behind a regression test.

**Architecture:** Surgical diffs to `provider-bridge/server.js`, `claude-bridge/server.js`, `gemini-bridge/server.js`, `scripts/bridge.js`, plus one extracted module (`provider-bridge/pacer.js`) so the pacer becomes unit-testable. Tests extend the existing zero-dependency harnesses (`tests/security.test.js`, `tests/provider.test.js`) and add `tests/pacer.test.js`.

**Tech Stack:** Node core only (http, child_process, string_decoder, fs). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-02-bridge-v2-design.md`

**Verified facts the plan relies on:**
- `'a|b'.match(/\s+|-|[^\s|-]+/g).join('') === 'ab'` — current pacer drops `|`.
- macOS `ARG_MAX` = 1,048,576 — 2 MB argv prompt fails `E2BIG`.
- `claude -p` reads the prompt from stdin when no positional prompt is given.
- `agy models` prints one model name per line, instantly, without spending quota. `agy --print <prompt>` takes the prompt as a flag value (argv); stdin support unverified, so gemini keeps argv + a size guard until Phase 2.

---

### Task 1: Extract and fix the pacer (`provider-bridge/pacer.js`)

**Files:**
- Create: `provider-bridge/pacer.js`
- Create: `tests/pacer.test.js`
- Modify: `provider-bridge/server.js` (delete inline `createSmoothPacer`, lines ~298-328; add require)
- Modify: `package.json` (test + check scripts)

- [ ] **Step 1: Write the failing test**

Create `tests/pacer.test.js`:

```js
// Unit tests for the smooth streaming pacer. Run: node tests/pacer.test.js
const { createSmoothPacer } = require('../provider-bridge/pacer');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  PASS  ${msg}`); }
  else { failed += 1; console.error(`  FAIL  ${msg}`); }
}

async function main() {
  console.log('# Pacer — verification');

  // 1. Lossless tokenization: emitted tokens re-join to the exact input,
  //    including pipes, hyphens, and unicode (the v1 regex ate `|`).
  {
    let out = '';
    const p = createSmoothPacer((t) => { out += t; }, { delayMs: 0 });
    const input = 'col A | col B | col-C\nrow1  | x | 😀 — done';
    p.push(input);
    await p.drain();
    assert(out === input, `lossless tokens (got ${JSON.stringify(out.slice(0, 40))}…)`);
  }

  // 2. stop() halts emission immediately and drain() unblocks.
  {
    let count = 0;
    const p = createSmoothPacer(() => { count += 1; }, { delayMs: 5 });
    p.push('one two three four five six seven eight nine ten');
    await new Promise((r) => setTimeout(r, 12));
    p.stop();
    const atStop = count;
    await p.drain();
    await new Promise((r) => setTimeout(r, 30));
    assert(count === atStop && count < 10, `stop() halts emission (emitted ${count})`);
  }

  // 3. Adaptive delay: a huge flush must finish within the total budget,
  //    not at 10ms/token (v1 would take ~100s for 10k tokens).
  {
    let out = '';
    const p = createSmoothPacer((t) => { out += t; }, { delayMs: 10, maxTotalDelayMs: 500 });
    const big = 'word '.repeat(10000);
    const t0 = Date.now();
    p.push(big);
    await p.drain();
    const took = Date.now() - t0;
    assert(out === big, 'big flush is lossless');
    assert(took < 2000, `big flush drains within budget (${took}ms, budget 500ms + overhead)`);
  }

  // 4. push() after stop() is a no-op.
  {
    let out = '';
    const p = createSmoothPacer((t) => { out += t; }, { delayMs: 0 });
    p.stop();
    p.push('nope');
    await p.drain();
    assert(out === '', 'push after stop is dropped');
  }

  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/pacer.test.js`
Expected: FAIL with `Cannot find module '../provider-bridge/pacer'`

- [ ] **Step 3: Write the module**

Create `provider-bridge/pacer.js`:

```js
'use strict';

// Smooth token pacer: splits upstream text flushes into word-ish tokens and
// emits them on a short interval so chunky CLI paragraph flushes stream
// naturally. Invariants:
//   - Lossless: the concatenation of emitted tokens equals the pushed text.
//   - Bounded: total added delay per response never exceeds maxTotalDelayMs,
//     however large the flush (delay adapts down as the queue grows).
//   - Stoppable: stop() drops the queue and unblocks drain() — wired to
//     client aborts so we never keep writing to a dead response.
function createSmoothPacer(onToken, opts = {}) {
  const delayMs = opts.delayMs === undefined ? 10 : opts.delayMs;
  const maxTotalDelayMs = opts.maxTotalDelayMs === undefined ? 2000 : opts.maxTotalDelayMs;
  const queue = [];
  let processing = false;
  let stopped = false;

  const currentDelay = () =>
    (delayMs <= 0 || queue.length === 0
      ? 0
      : Math.min(delayMs, Math.floor(maxTotalDelayMs / queue.length)));

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    while (queue.length > 0 && !stopped) {
      onToken(queue.shift());
      const d = currentDelay();
      if (d > 0 && queue.length > 0) {
        await new Promise((r) => setTimeout(r, d));
      }
    }
    if (stopped) queue.length = 0;
    processing = false;
  };

  return {
    push(text) {
      if (!text || stopped) return;
      // Every char is either \s or \S, so this can never drop characters.
      const tokens = String(text).match(/\s+|\S+/g) || [String(text)];
      queue.push(...tokens);
      processQueue();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
    async drain() {
      while (!stopped && (processing || queue.length > 0)) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

module.exports = { createSmoothPacer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/pacer.test.js`
Expected: `# Result: 5 passed, 0 failed`

- [ ] **Step 5: Wire into the provider**

In `provider-bridge/server.js`:
- Add after the other requires (line ~4): `const { createSmoothPacer } = require('./pacer');`
- Delete the entire inline `function createSmoothPacer(...) {...}` (lines ~298-328).
- The call site `createSmoothPacer((deltaText) => {...}, 10)` becomes `createSmoothPacer((deltaText) => {...}, { delayMs: 10 })`.

In `package.json`, update scripts:

```json
"test": "node tests/security.test.js && node tests/provider.test.js && node tests/pacer.test.js",
"check": "node --check claude-bridge/server.js && node --check gemini-bridge/server.js && node --check provider-bridge/server.js && node --check provider-bridge/pacer.js && node --check scripts/bridge.js && node --check tests/security.test.js && node --check tests/provider.test.js && node --check tests/pacer.test.js"
```

- [ ] **Step 6: Run full suite**

Run: `npm test && npm run check`
Expected: all pass (existing suites unaffected; streaming test in provider.test.js still green).

- [ ] **Step 7: Commit**

```bash
git add provider-bridge/pacer.js provider-bridge/server.js tests/pacer.test.js package.json
git commit -m "fix(provider): pacer no longer drops chars; bounded delay; stoppable"
```

---

### Task 2: Client abort — stop pacer, record 499, never poison engine health

**Files:**
- Modify: `provider-bridge/server.js` (`classForStatus`, `record`, streaming path)
- Modify: `tests/provider.test.js` (extend `startFakeBridge`, add abort section)

- [ ] **Step 1: Extend the fake bridge to support a stalling stream and forced text**

In `tests/provider.test.js`, inside `startFakeBridge`'s `reply()` — replace the `const text = ...` line and the stream branch:

```js
const text = opts.text !== undefined
  ? opts.text
  : `[${name}] replied to "${parsed && parsed.prompt ? parsed.prompt.slice(0, 24) : ''}"`;
if (parsed && parsed.stream) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  res.write(JSON.stringify({ event: 'delta', text }) + '\n');
  if (opts.streamStall) return; // first delta, then hang — used by abort tests
  res.write(JSON.stringify({ event: 'done', text }) + '\n');
  res.end();
  return;
}
```

- [ ] **Step 2: Write the failing test**

Add to `tests/provider.test.js` `main()`, before the final Result line:

```js
console.log('\n## Client abort mid-stream → 499, engine health not poisoned');
const ABORT_PORT = 19390;
const stallClaude = await startFakeBridge('claude-stall', { streamStall: true });
await bootProvider(ABORT_PORT, {
  PROVIDER_API_KEY: '',
  CLAUDE_BRIDGE_URL: `http://127.0.0.1:${stallClaude.port}`,
  GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
});
await new Promise((resolve) => {
  const abortReq = http.request(
    { port: ABORT_PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    (res) => {
      res.once('data', () => {
        abortReq.destroy(); // client walks away after the first byte
        setTimeout(resolve, 400); // give the provider time to record
      });
    },
  );
  abortReq.on('error', () => {});
  abortReq.end(JSON.stringify({ model: 'bridge-smart', stream: true, messages: [{ role: 'user', content: 'x' }] }));
});
r = await request(ABORT_PORT, { path: '/dashboard/status' });
const abortStatus = JSON.parse(r.body || '{}');
const abortEntry = (abortStatus.recentRequests || []).find((rr) => rr.engine === 'claude');
assert(abortEntry && abortEntry.status === 499 && abortEntry.statusClass === 'aborted',
  `client abort recorded as 499/aborted (got ${abortEntry && abortEntry.status}/${abortEntry && abortEntry.statusClass})`);
assert(!(abortStatus.engines.claude.history || []).some((h) => h.source === 'traffic' && h.ok === false),
  'client abort leaves no failed traffic health sample');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node tests/provider.test.js`
Expected: the two new assertions FAIL (current code records 502 and a failed traffic sample).

- [ ] **Step 4: Implement**

In `provider-bridge/server.js`:

`classForStatus` gains a branch (before the 4xx check):

```js
function classForStatus(status) {
  if (status === 200) return 'success';
  if (status === 429) return 'rejected';
  if (status === 499) return 'aborted';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'error';
}
```

In `record()` (inside the POST /v1/chat/completions handler), the health-sample line becomes:

```js
const cls = classForStatus(status);
if (route && cls !== 'aborted') recordHealthSample(route.engine, cls === 'success', 'traffic');
```

(keep the `statusClass: classForStatus(status)` field as-is or reuse `cls`).

In the handler, replace the current close-hook block:

```js
let activeUpstreamReq = null;
let activePacer = null;
let clientAborted = false;
res.on('close', () => {
  if (!res.writableEnded) {
    clientAborted = true;
    if (activePacer) activePacer.stop();
    if (activeUpstreamReq) {
      try { activeUpstreamReq.destroy(); } catch (_) {}
    }
  }
});
```

In the streaming branch, after creating the pacer: `activePacer = pacer;`
Both streaming `record(502)` calls become `record(clientAborted ? 499 : 502)`, and the non-streaming catch's `record(502)` likewise.

- [ ] **Step 5: Run tests**

Run: `node tests/provider.test.js && node tests/pacer.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add provider-bridge/server.js tests/provider.test.js
git commit -m "fix(provider): client aborts stop the pacer, record 499, skip health samples"
```

---

### Task 3: Tool-call detection only when tools were sent; indexed streaming deltas

**Files:**
- Modify: `provider-bridge/server.js` (both completion paths)
- Modify: `tests/provider.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/provider.test.js` `main()`:

```js
console.log('\n## Tool-call parsing gated on request tools');
const TOOLTXT = JSON.stringify({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] });
const TOOL_PORT = 19395;
const toolClaude = await startFakeBridge('claude-tools', { text: '```json\n' + TOOLTXT + '\n```' });
await bootProvider(TOOL_PORT, {
  PROVIDER_API_KEY: '',
  CLAUDE_BRIDGE_URL: `http://127.0.0.1:${toolClaude.port}`,
  GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
});
// Without tools: the JSON is ordinary content, NOT hijacked into tool_calls.
r = await request(TOOL_PORT, {
  path: '/v1/chat/completions', method: 'POST',
  body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'show me an example payload' }] },
});
let toolResp = JSON.parse(r.body || '{}');
assert(typeof toolResp.choices[0].message.content === 'string' && toolResp.choices[0].message.content.includes('tool_calls'),
  'tool-shaped reply without request tools stays plain content');
assert(toolResp.choices[0].finish_reason === 'stop', 'finish_reason stays stop without request tools');
// With tools: parsed into tool_calls.
r = await request(TOOL_PORT, {
  path: '/v1/chat/completions', method: 'POST',
  body: {
    model: 'bridge-smart',
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    messages: [{ role: 'user', content: 'read a' }],
  },
});
toolResp = JSON.parse(r.body || '{}');
assert(toolResp.choices[0].finish_reason === 'tool_calls' && toolResp.choices[0].message.content === null,
  'tool-shaped reply with request tools becomes tool_calls');
assert(toolResp.choices[0].message.tool_calls[0].function.name === 'read_file', 'tool call name preserved');
// Streaming with tools: the tool_calls delta carries per-entry index.
r = await request(TOOL_PORT, {
  path: '/v1/chat/completions', method: 'POST',
  body: {
    model: 'bridge-smart', stream: true,
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    messages: [{ role: 'user', content: 'read a' }],
  },
});
const toolChunks = (r.body || '').split('\n\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
  .map((l) => { try { return JSON.parse(l.slice(6)); } catch (_) { return null; } }).filter(Boolean);
const tcDelta = toolChunks.find((c) => c.choices && c.choices[0].delta && c.choices[0].delta.tool_calls);
assert(tcDelta && tcDelta.choices[0].delta.tool_calls[0].index === 0,
  'streaming tool_calls delta carries index 0');
assert(tcDelta && tcDelta.choices[0].finish_reason === 'tool_calls', 'streaming finish_reason tool_calls');
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node tests/provider.test.js`
Expected: "stays plain content" and "carries index 0" FAIL; the middle pair may already pass.

- [ ] **Step 3: Implement**

In `provider-bridge/server.js` POST handler, after `const toolsList = body.tools || body.functions;` add:

```js
const toolsProvided = Array.isArray(toolsList) && toolsList.length > 0;
```

Streaming path — the detection block becomes:

```js
const detectedTools = toolsProvided ? parseToolCallsFromText(text) : null;
if (detectedTools) {
  res.write(`data: ${JSON.stringify({
    ...chunkBase,
    choices: [{
      index: 0,
      delta: { tool_calls: detectedTools.map((tc, i) => ({ index: i, ...tc })) },
      finish_reason: 'tool_calls',
    }],
  })}\n\n`);
} else {
  res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
}
```

Non-streaming path: `const detectedTools = toolsProvided ? parseToolCallsFromText(text) : null;` (rest unchanged).

- [ ] **Step 4: Run tests**

Run: `node tests/provider.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add provider-bridge/server.js tests/provider.test.js
git commit -m "fix(provider): gate tool-call parsing on request tools; index streamed deltas"
```

---

### Task 4: Claude prompt via stdin (fixes E2BIG + ps leakage)

**Files:**
- Modify: `claude-bridge/server.js` (`runClaude`)
- Modify: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

In `tests/security.test.js`, add a stub near the other stubs:

```js
// Echoes stdin back — proves the prompt arrives via stdin, not argv.
const STDIN_ECHO_CLI = writeFakeCli('stdin-echo-cli.sh', 'cat -');
```

Add to `main()` after the `testBridge` loop:

```js
console.log('\n## claude-bridge — prompt delivered via stdin');
const claudeBridge = BRIDGES[0];
await bootBridge(claudeBridge.server, 19150, { BRIDGE_API_KEY: '', CLAUDE_PATH: STDIN_ECHO_CLI });
let sr = await request(19150, { path: '/api/chat', method: 'POST', body: { prompt: 'stdin-marker-123' } });
let sp = {};
try { sp = JSON.parse(sr.body || '{}'); } catch (_) {}
assert(sr.status === 200 && typeof sp.text === 'string' && sp.text.includes('stdin-marker-123'),
  '[claude] prompt reaches the CLI via stdin');
// A 2MB prompt exceeds ARG_MAX as argv but must work via stdin.
const bigPrompt = 'x'.repeat(2 * 1024 * 1024);
sr = await request(19150, { path: '/api/chat', method: 'POST', body: { prompt: bigPrompt } });
try { sp = JSON.parse(sr.body || '{}'); } catch (_) { sp = {}; }
assert(sr.status === 200 && sp.success === true && (sp.text || '').length >= 2 * 1024 * 1024,
  `[claude] 2MB prompt survives (argv would E2BIG) — got status ${sr.status}, len ${(sp.text || '').length}`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/security.test.js`
Expected: both new assertions FAIL (stdin is `'ignore'` today, so `cat -` returns empty; 2 MB argv errors).

- [ ] **Step 3: Implement**

In `claude-bridge/server.js` `runClaude`, replace argument construction and spawn:

```js
// -p: print mode reading the prompt from STDIN (never argv: argv is capped by
// ARG_MAX ≈1MB and is visible to every local user via `ps`).
const args = ['-p'];
if (selectedModel) {
  args.push('--model', selectedModel);
}

const child = spawn(CLAUDE_PATH, args, {
  cwd: __dirname,
  env: { ...process.env, HOME: process.env.HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.on('error', () => {}); // CLI may exit before reading; EPIPE is fine
child.stdin.end(prompt);
```

- [ ] **Step 4: Run tests**

Run: `node tests/security.test.js`
Expected: all pass, including the pre-existing timeout/cap tests (their stubs ignore stdin; `sh` tolerates the piped stdin).

- [ ] **Step 5: Commit**

```bash
git add claude-bridge/server.js tests/security.test.js
git commit -m "fix(claude-bridge): deliver prompt via stdin (E2BIG + ps exposure)"
```

---

### Task 5: Gemini prompt size guard (argv stays until Phase 2)

**Files:**
- Modify: `gemini-bridge/server.js` (`runGemini`, `/api/chat`, `/api/process` catch)
- Modify: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/security.test.js` `main()`:

```js
console.log('\n## gemini-bridge — oversized prompt rejected clearly (argv limit)');
const geminiBridge = BRIDGES[1];
await bootBridge(geminiBridge.server, 19151, { BRIDGE_API_KEY: '', GEMINI_PATH: STDIN_ECHO_CLI });
sr = await request(19151, { path: '/api/chat', method: 'POST', body: { prompt: 'y'.repeat(300 * 1024) } });
assert(sr.status === 413 && (sr.body || '').includes('too large'),
  `[gemini] 300KB prompt rejected 413 with clear message (got ${sr.status})`);
sr = await request(19151, { path: '/api/chat', method: 'POST', body: { prompt: 'small is fine' } });
assert(sr.status === 200, '[gemini] small prompt still works');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/security.test.js`
Expected: first new assertion FAILs (today a 300 KB prompt is passed straight to argv).

- [ ] **Step 3: Implement**

In `gemini-bridge/server.js`, add near `MAX_CLI_OUTPUT_BYTES`:

```js
// agy takes the prompt as a --print flag value (argv), which the OS caps at
// ARG_MAX (~1MB total on macOS). Reject earlier with a clear error; Phase 2
// moves agy to stdin/temp-file delivery in the adapter.
const MAX_PROMPT_BYTES = Number(process.env.MAX_PROMPT_BYTES) || 200 * 1024;
```

At the top of `runGemini`'s Promise body (before building args):

```js
const promptBytes = Buffer.byteLength(prompt || '', 'utf8');
if (promptBytes > MAX_PROMPT_BYTES) {
  const err = new Error(`Prompt too large for the Antigravity CLI (${promptBytes} bytes; limit ${MAX_PROMPT_BYTES}). Trim the conversation history.`);
  err.statusCode = 413;
  return reject(err);
}
```

In `/api/chat`'s catch and `/api/process`'s catch, the 500 lines become:

```js
return res.status(err.statusCode || 500).json({ success: false, error: err.message });
```
(and `res.status(err.statusCode || 500).json(...)` respectively).

- [ ] **Step 4: Run tests**

Run: `node tests/security.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add gemini-bridge/server.js tests/security.test.js
git commit -m "fix(gemini-bridge): reject prompts over argv budget with a clear 413"
```

---

### Task 6: StringDecoder in both bridges (UTF-8 split, byte-accurate caps)

**Files:**
- Modify: `claude-bridge/server.js` (`runClaude` output handlers)
- Modify: `gemini-bridge/server.js` (`runGemini` output handlers)
- Modify: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Add a stub (uses octal escapes; 😀 = F0 9F 98 80 split across two writes):

```js
const UTF8_SPLIT_CLI = writeFakeCli('utf8-split-cli.sh', "printf '\\360\\237\\230'; sleep 0.2; printf '\\200\\n'");
```

Add to `main()` (runs against both bridges):

```js
console.log('\n## Streaming UTF-8 split across chunks stays intact');
for (let i = 0; i < BRIDGES.length; i += 1) {
  const b = BRIDGES[i];
  const port = 19160 + i;
  await bootBridge(b.server, port, { BRIDGE_API_KEY: '', [b.pathEnv]: UTF8_SPLIT_CLI });
  const sres = await request(port, { path: '/api/chat', method: 'POST', body: { prompt: 'x', stream: true } });
  const deltas = (sres.body || '').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter((e) => e && e.event === 'delta').map((e) => e.text).join('');
  assert(deltas.includes('😀') && !deltas.includes('�'),
    `[${b.name}] split multibyte char decodes cleanly in stream deltas (got ${JSON.stringify(deltas)})`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/security.test.js`
Expected: both bridges FAIL with `�` replacement chars in deltas.

- [ ] **Step 3: Implement in claude-bridge**

In `claude-bridge/server.js`: add `const { StringDecoder } = require('string_decoder');` to the requires. In `runClaude`, replace the stdout/stderr handlers and close handler:

```js
let stdout = '';
let stderr = '';
let stdoutBytes = 0;
let stderrBytes = 0;
const outDecoder = new StringDecoder('utf8');
const errDecoder = new StringDecoder('utf8');
let settled = false;
let truncated = false;
```

```js
child.stdout.on('data', (data) => {
  const room = MAX_CLI_OUTPUT_BYTES - stdoutBytes;
  if (room <= 0) return;
  const slice = data.length > room ? data.subarray(0, room) : data;
  stdoutBytes += slice.length;
  const str = outDecoder.write(slice); // holds incomplete multibyte tails
  if (str) {
    stdout += str;
    if (typeof onChunk === 'function') onChunk(str);
  }
  if (stdoutBytes >= MAX_CLI_OUTPUT_BYTES && !truncated) {
    truncated = true;
    child.kill('SIGTERM');
  }
});
child.stderr.on('data', (data) => {
  const room = MAX_CLI_OUTPUT_BYTES - stderrBytes;
  if (room <= 0) return;
  const slice = data.length > room ? data.subarray(0, room) : data;
  stderrBytes += slice.length;
  stderr += errDecoder.write(slice);
});

child.on('close', (code) => {
  stdout += outDecoder.end();
  stderr += errDecoder.end();
  if (truncated) return settle(false, stdout.trim());
  if (code === 0) settle(false, stdout.trim());
  else settle(true, new Error(summarizeClaudeError(stderr, stdout, selectedModel)));
});
```

- [ ] **Step 4: Implement in gemini-bridge**

Same pattern in `gemini-bridge/server.js` `runGemini` (add the require too). Differences from claude: the stdout handler pipes through `stripAnsi` for the chunk callback, and the stderr handler keeps its early-fail checks:

```js
child.stdout.on('data', (data) => {
  const room = MAX_CLI_OUTPUT_BYTES - stdoutBytes;
  if (room <= 0) return;
  const slice = data.length > room ? data.subarray(0, room) : data;
  stdoutBytes += slice.length;
  const str = outDecoder.write(slice);
  if (str) {
    stdout += str;
    if (typeof onChunk === 'function') {
      const cleaned = stripAnsi(str);
      if (cleaned) onChunk(cleaned);
    }
  }
  if (stdoutBytes >= MAX_CLI_OUTPUT_BYTES && !truncated) {
    truncated = true;
    child.kill('SIGTERM');
  }
});
child.stderr.on('data', (data) => {
  const room = MAX_CLI_OUTPUT_BYTES - stderrBytes;
  if (room <= 0) return;
  const slice = data.length > room ? data.subarray(0, room) : data;
  stderrBytes += slice.length;
  stderr += errDecoder.write(slice);
  if (stderr.includes('You have exhausted your capacity on this model')) {
    settle(true, new Error(`The Gemini model "${selectedModel}" is temporarily unavailable — quota exceeded. Try again later or use Gemini 3.5 Flash.`));
  } else if (stderr.includes('Requested entity was not found')) {
    settle(true, new Error(`The Gemini model "${selectedModel}" is not available in this CLI session.`));
  }
});
```

and the same `close` handler flushes both decoders before settling.

- [ ] **Step 5: Run tests**

Run: `node tests/security.test.js`
Expected: all pass — including the output-cap tests, which now measure bytes (`stdoutBytes`) instead of UTF-16 length; the stubs are ASCII so the cap assertions are unchanged.

- [ ] **Step 6: Commit**

```bash
git add claude-bridge/server.js gemini-bridge/server.js tests/security.test.js
git commit -m "fix(bridges): decode CLI output with StringDecoder; byte-accurate caps"
```

---

### Task 7: `/models` on gemini uses free `agy models` — delete the quota-burning probe

**Files:**
- Modify: `gemini-bridge/server.js` (delete `probeOneModel`/`probeAllModels`/`probeRunning`/`probeLastRan`, rewrite `/models`)
- Modify: `scripts/bridge.js` (probe comment)
- Modify: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Add stubs and a section to `main()`:

```js
// agy-style stub: answers `models` with a fixed list, logs every invocation,
// and fails loudly if asked for a completion (--print) — proving /models
// never spends quota.
const AGY_LOG = path.join(TMP, 'agy-calls.log');
const AGY_MODELS_CLI = path.join(TMP, 'agy-models-cli.sh');
fs.writeFileSync(AGY_MODELS_CLI, `#!/bin/sh
echo "$@" >> "${AGY_LOG}"
if [ "$1" = "--version" ]; then echo "fake-agy 0.0.0"; exit 0; fi
if [ "$1" = "models" ]; then printf 'Model Alpha\\nModel Beta\\n'; exit 0; fi
echo "completion attempted" >&2; exit 1
`, { mode: 0o755 });
```

```js
console.log('\n## gemini-bridge — /models uses free `agy models`, never a completion');
await bootBridge(BRIDGES[1].server, 19170, { BRIDGE_API_KEY: '', GEMINI_PATH: AGY_MODELS_CLI });
sr = await request(19170, { path: '/models' });
let models = [];
try { models = JSON.parse(sr.body || '[]'); } catch (_) {}
assert(sr.status === 200 && models.length === 2 && models[0].id === 'Model Alpha' && models[1].id === 'Model Beta',
  `[gemini] /models returns the agy models list (got ${models.map((m) => m.id).join(',')})`);
const agyCalls = fs.readFileSync(AGY_LOG, 'utf8');
assert(!agyCalls.includes('--print'), '[gemini] listing models spends no completions');
// Fallback: when the CLI cannot list, serve the static candidates.
await bootBridge(BRIDGES[1].server, 19171, { BRIDGE_API_KEY: '', GEMINI_PATH: 'false' });
sr = await request(19171, { path: '/models' });
try { models = JSON.parse(sr.body || '[]'); } catch (_) { models = []; }
assert(sr.status === 200 && models.length >= 5, '[gemini] /models falls back to candidates when CLI listing fails');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/security.test.js`
Expected: first assertion FAILs (current code returns the 5 candidates and kicks off a probe that calls `--print` — the log check may also fail).

- [ ] **Step 3: Implement**

In `gemini-bridge/server.js`:
- Add `execFile` to the child_process require: `const { spawn, execFile, execFileSync } = require('child_process');`
- Delete `probeOneModel`, `probeAllModels`, `probeRunning`, `probeLastRan` entirely.
- Replace the model-cache block and `/models` route with:

```js
// Model discovery via `agy models` — a free listing call (no completion, no
// quota). Cached for PROBE_CACHE_MS; ?refresh=true forces a re-list.
const PROBE_CACHE_MS = 60 * 60 * 1000;
let modelCache = null;
let modelCacheAt = 0;
let listingPromise = null;

function listAgyModels() {
  if (listingPromise) return listingPromise;
  listingPromise = new Promise((resolve) => {
    execFile(GEMINI_PATH, ['models'], { encoding: 'utf8', timeout: 10000 }, (err, stdoutRaw) => {
      listingPromise = null;
      if (err || !stdoutRaw) return resolve(null);
      const names = stripAnsi(String(stdoutRaw)).split('\n').map((s) => s.trim()).filter(Boolean);
      if (!names.length) return resolve(null);
      resolve(names.map((id) => {
        const known = CANDIDATE_MODELS.find((m) => m.id === id);
        return known || { id, name: id, description: 'Reported by `agy models`.', contextWindow: 1000000, isFree: false };
      }));
    });
  });
  return listingPromise;
}

app.get('/models', async (req, res) => {
  const force = req.query.refresh === 'true';
  if (!force && modelCache && (Date.now() - modelCacheAt) < PROBE_CACHE_MS) {
    return res.json(modelCache);
  }
  const listed = await listAgyModels();
  if (listed) {
    modelCache = listed;
    modelCacheAt = Date.now();
    return res.json(listed);
  }
  res.json(modelCache || CANDIDATE_MODELS.map(({ ...m }) => m));
});
```

Note: `stripAnsi` and `CANDIDATE_MODELS` are defined below this point in the file today — `stripAnsi` is a hoisted function declaration and `CANDIDATE_MODELS` a const above the routes, so keep this block **after** both definitions (place it where the old probe block sat, below `CANDIDATE_MODELS`).

In `scripts/bridge.js`, fix the `probe()` doc comment:

```js
// Print available model routes + each engine's reported model catalogue.
// Read-only and quota-free: the gemini bridge lists models via `agy models`
// and the claude bridge serves a static catalogue — no completion is run.
```

- [ ] **Step 4: Run tests**

Run: `node tests/security.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add gemini-bridge/server.js scripts/bridge.js tests/security.test.js
git commit -m "fix(gemini-bridge): model discovery via free 'agy models', drop completion probe"
```

---

### Task 8: BIND_HOST wiring, docker-compose, activeChild hoist

**Files:**
- Modify: `claude-bridge/server.js` (move dead const, use it; hoist activeChild)
- Modify: `gemini-bridge/server.js` (add const, use it; hoist activeChild)
- Modify: `docker-compose.yml` (explicit `BIND_HOST: 0.0.0.0` per service)

- [ ] **Step 1: Implement claude-bridge**

- Delete the stray `const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';` at line ~233 (mid-file).
- Add near the PORT const at the top: `const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';`
- `app.listen(PORT, '0.0.0.0', () => {` becomes `app.listen(PORT, BIND_HOST, () => {` and the first log line becomes:

```js
console.log(`Claude CLI Bridge running on ${BIND_HOST}:${PORT}`);
```

- In `/api/chat`, move `let activeChild = null;` from inside the `try {` block to just above it (the `catch` assigns to it; inside-try `let` makes that an implicit global).

- [ ] **Step 2: Implement gemini-bridge**

Same three changes in `gemini-bridge/server.js` (it has no BIND_HOST const at all today — add it near PORT).

- [ ] **Step 3: docker-compose**

In `docker-compose.yml`, add to each of the three services' `environment:` blocks (containers must accept connections from the docker network):

```yaml
      BIND_HOST: 0.0.0.0
```

- [ ] **Step 4: Run tests + manual bind check**

Run: `npm test`
Expected: all pass (tests connect via localhost).

Manual: `node claude-bridge/server.js & sleep 1 && lsof -iTCP:9002 -sTCP:LISTEN -n -P | grep 127.0.0.1 && kill %1`
Expected: listener shows `127.0.0.1:9002`, not `*:9002`. (Requires claude-bridge deps: run with `NODE_PATH=claude-bridge/node_modules`.)

- [ ] **Step 5: Commit**

```bash
git add claude-bridge/server.js gemini-bridge/server.js docker-compose.yml
git commit -m "fix(bridges): default to loopback binding; hoist activeChild out of try scope"
```

---

### Task 9: Credentials written 0600

**Files:**
- Modify: `scripts/bridge.js` (`resolveKey`, `connect`)

- [ ] **Step 1: Implement**

In `resolveKey()`: after a successful read of a persisted key, tighten the mode of pre-existing files; and create new files with `mode`:

```js
try {
  const saved = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
  if (saved && saved.apiKey) {
    try { fs.chmodSync(CRED_FILE, 0o600); } catch (_) { /* best effort */ }
    return { key: saved.apiKey, source: 'persisted' };
  }
} catch (_) { /* not generated yet */ }
const key = crypto.randomBytes(24).toString('hex');
fs.writeFileSync(CRED_FILE, `${JSON.stringify({ apiKey: key, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
```

In `connect()`: `fs.writeFileSync(file, ..., { mode: 0o600 });`

- [ ] **Step 2: Verify**

Run: `node scripts/bridge.js status >/dev/null 2>&1; stat -f '%Lp' .bridge-runtime/credentials.json`
Expected: `600`

- [ ] **Step 3: Commit**

```bash
git add scripts/bridge.js
git commit -m "fix(launcher): write credential files 0600, tighten existing on read"
```

---

### Task 10: Full verification sweep

- [ ] **Step 1: Full suite + syntax check**

Run: `npm test && npm run check`
Expected: every suite green.

- [ ] **Step 2: Live smoke against real CLIs**

Run: `npm run bridge:restart && sleep 2 && node scripts/bridge.js status`
Expected: all three services online.

Run one real streamed request via the dashboard tester or:

```bash
KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.bridge-runtime/credentials.json','utf8')).apiKey)")
curl -sN http://127.0.0.1:9011/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"bridge-fast","stream":true,"messages":[{"role":"user","content":"Reply with exactly: a|b|c"}]}' | head -30
```
Expected: streamed deltas contain `a|b|c` with pipes intact.

- [ ] **Step 3: Stop services, final commit if anything moved**

Run: `npm run bridge:down`
