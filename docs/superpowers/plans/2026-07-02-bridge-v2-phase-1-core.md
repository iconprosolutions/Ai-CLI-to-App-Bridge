# Bridge v2 Phase 1 — Workspace + Core Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Format note:** this plan is executed in-session by the author immediately after
> writing; it specifies exact contracts, file maps, and test assertions, and inlines
> full code only for the subtle parts (kill escalation, ANSI carry, write locks).
> The spec (`docs/superpowers/specs/2026-07-02-bridge-v2-design.md` §4.1–4.2) is
> normative for anything not repeated here.

**Goal:** Create the npm-workspaces layout and the shared `@bridge/core` package — hardened CLI runner with child registry + graceful shutdown, error taxonomy, streaming-safe ANSI stripping, JSON extraction, auth middleware, async context store with write locks, bounded sessions — fully covered by a new `tests/core.test.js` against a scriptable fake CLI.

**Architecture:** `packages/core` is dependency-free (Node core only), so the root workspace install links packages without downloading anything. Legacy servers are untouched this phase; Phase 2 consumes core from the adapters and consolidated provider. Node resolution from the legacy dirs is unaffected.

**Tech Stack:** Node core (child_process, string_decoder, fs/promises, crypto). Zero new npm dependencies.

---

### Task 1: Workspace scaffolding

**Files:**
- Modify: `package.json` (add `"workspaces": ["packages/*"]`)
- Create: `packages/core/package.json` — `{ "name": "@bridge/core", "version": "0.1.0", "private": true, "main": "index.js" }`
- Create: `packages/core/index.js` — re-exports all modules

- [ ] Root package.json gains workspaces; `npm install` at root succeeds and links `node_modules/@bridge/core`.
- [ ] Commit: `feat(core): npm workspaces + @bridge/core scaffold`

### Task 2: Error taxonomy (`packages/core/errors.js`)

Contract (spec §4.2):
- `class BridgeError extends Error` with `kind`, `detail?`, `retryAfterSec?`; constructor throws `TypeError` on unknown kind.
- `KINDS = ['quota','model_not_found','timeout','spawn_failed','truncated','bad_output','aborted']`
- `httpFor(err)` → `{ status, type, param, retryAfterSec }` per the spec table (quota→429/rate_limit_error/60s default; timeout→504/upstream_timeout; model_not_found→400/invalid_model/param "model"; spawn_failed & bad_output & truncated→502/upstream_error; aborted→499/type null). Non-BridgeError input → 502 upstream_error.

Tests (tests/core.test.js): kind round-trip, unknown kind throws, quota mapping carries Retry-After, plain Error maps to 502.

- [ ] Commit: `feat(core): BridgeError taxonomy + HTTP mapping`

### Task 3: ANSI + JSON extraction (`packages/core/ansi.js`, `packages/core/json-extract.js`)

`ansi.js` contract:
- `stripAnsi(str)` — removes complete CSI, OSC (BEL- or ST-terminated), and two-char escapes.
- `createAnsiStripper()` — `{ write(chunk) -> cleanText, end() -> cleanText }`; a sequence **split across chunks** is still removed (trailing partial escapes are carried, not emitted).
- `collapseCarriageReturns(text)` — per line, keep only the segment after the last `\r` (spinner frames); used on final text only, never on live deltas.

`json-extract.js`: `extractJson(raw)` — strip ANSI, strip ```json fences, direct parse, then first-`{`/`[` to last-`}`/`]` fallback, throw `BridgeError('bad_output', …)` on failure (promoted from gemini-bridge, error type upgraded).

Tests: strip basic CSI; strip OSC title; split-across-chunks CSI removed via stripper; carry flushed clean on end(); collapseCarriageReturns keeps last frame; extractJson handles fence + preamble + throws BridgeError.

- [ ] Commit: `feat(core): streaming-safe ANSI stripping + JSON extraction`

### Task 4: CLI runner (`packages/core/cli-runner.js`) + fake CLI fixture

Contract (spec §4.1):
```js
runCli(bin, args, {
  stdin,            // string|null — piped and closed; null = stdio 'ignore'
  signal,           // AbortSignal|null — abort → SIGTERM→(2s)→SIGKILL → reject BridgeError('aborted')
  timeoutMs,        // default 300_000 → reject BridgeError('timeout') after escalation
  maxBytes,         // default 10 MiB, byte-accurate via Buffer lengths; over-cap → SIGTERM, resolve {truncated:true}
  onDelta,          // (str) => void — StringDecoder'd stdout increments
  classifyError,    // (stderr, stdout) => BridgeError|null — refines nonzero-exit rejections
  cwd, env, killGraceMs,
}) -> Promise<{ text, stderr, exitCode, truncated }>
```
Every live child sits in a module-level registry:
- `liveChildren()` → count; `killAllChildren(signal)`;
- `installGracefulShutdown({ server, logger, killGraceMs })` — SIGTERM/SIGINT: close server, SIGTERM all children, SIGKILL after grace, then exit. Idempotent.

The subtle part — settle/cleanup/escalation (normative):

```js
const settle = (isErr, payload) => {
  if (settled) return;
  settled = true;
  liveChildren.delete(child);
  clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onAbort);
  if (isErr) reject(payload); else resolve(payload);
};
const escalate = () => {
  try { child.kill('SIGTERM'); } catch (_) {}
  const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, killGraceMs);
  hard.unref();
};
```
`close` flushes both StringDecoders before settling; nonzero exit consults `classifyError` first, falls back to `BridgeError('bad_output', stderr||stdout||code)` with `stderr`, `stdout`, `exitCode` attached.

Fixture `tests/fixtures/fake-cli.js` (node script, mode via `FAKE_CLI_MODE` env or argv[2]):
`echo-stdin`, `utf8-split`, `ansi-split` (CSI split across two writes), `flood` (write `FAKE_CLI_BYTES`), `hang`, `stderr-fail` (msg to stderr, exit 2), `ok`.

Tests: stdin round-trip (2 MB); abort mid-hang rejects `aborted` and the process dies (poll `kill(pid,0)`); timeout rejects `timeout` promptly; flood resolves `truncated:true` at cap ±1 KiB; utf8-split deltas contain 😀 and no U+FFFD; stderr-fail rejects with classifyError result when provided; registry count returns to 0 after each.

- [ ] Commit: `feat(core): hardened CLI runner with child registry + graceful shutdown`

### Task 5: Auth, sessions, config (`auth.js`, `sessions.js`, `config.js`)

- `auth.js`: `bearerAuth(apiKey, { publicPaths })` — timing-safe compare, no-op when key empty (verbatim behavior from the bridges, factored).
- `sessions.js`: `class SessionRegistry({ ttlMs, maxEntries })` — `getOrCreate(slug, extra)`, `touch`, `remove`, `sweep()`, `list()`; evicts oldest beyond `maxEntries` (default 1000) — closes the unbounded-Map growth vector.
- `config.js`: `intEnv(name, def)`, `strEnv(name, def)`, `boolEnv(name, def)`.

Tests: auth 401 wrong/missing, 200 correct, open mode passes; registry eviction at maxEntries; TTL sweep removes idle; intEnv parses/falls back.

- [ ] Commit: `feat(core): auth middleware, bounded sessions, config helpers`

### Task 6: Context store (`packages/core/context-store.js`)

`class ContextStore(rootDir, { types })` — async `read/write/append/list/remove`, slug regex + resolved-path check (both preserved from bridges), atomic writes (tmp + rename), and a **per-file promise-chain write lock** so concurrent `append()`s never lose updates:

```js
_withLock(key, fn) {
  const prev = this.locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const guard = run.catch(() => {});
  this.locks.set(key, guard);
  guard.then(() => { if (this.locks.get(key) === guard) this.locks.delete(key); });
  return run;
}
```

Tests: write/read round-trip; traversal slug throws; 10 parallel `append()`s to one slug → all 10 sections present (the legacy read-modify-write loses some); list returns slug+size+mtime.

- [ ] Commit: `feat(core): async context store with per-file write locks`

### Task 7: Verification sweep

- [ ] `packages/core/index.js` exports everything; `npm test` (now incl. `tests/core.test.js`) and `npm run check` green; legacy suites unaffected.
- [ ] Commit: `test(core): full core contract suite`
