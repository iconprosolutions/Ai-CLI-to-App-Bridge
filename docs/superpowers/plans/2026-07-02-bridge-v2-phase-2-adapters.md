# Bridge v2 Phase 2 — Adapters + Consolidated Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Format note:** executed in-session by the author immediately after writing;
> exact contracts + file map here, full code lives in the commits. Spec §2–§4.5
> is normative.

**Goal:** One provider process serving `/v1` through in-process engine adapters — `claude` on stream-json (real deltas, real token usage), `agy` on guarded argv with streaming ANSI stripping — with routes as data (`routes.json`), taxonomy-mapped errors (429 + Retry-After for quota), and graceful shutdown. Legacy servers stay in-tree and untouched; the launcher switches its `provider` service to the new package.

**Verified live (2026-07-02):**
- `claude -p --output-format stream-json --include-partial-messages` **requires `--verbose`**.
- Framing: `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":…}}}`; thinking/signature deltas interleave and must be skipped; hook noise arrives as `type:"system"` lines.
- Final line: `{"type":"result","subtype":"success","is_error":false,"result":"…","stop_reason":"end_turn","session_id":…,"usage":{"input_tokens":…,"cache_creation_input_tokens":…,"cache_read_input_tokens":…,"output_tokens":…}}` — promptTokens = input + both cache buckets.
- `agy models` lists the account catalogue instantly and free; `agy --print <prompt>` is argv-only (stdin unverified), so the 200 KB guard stays until proven otherwise.

**File map:**

```
packages/core/pacer.js            # moved from provider-bridge (re-exported)
packages/core/errors.js           # + 'invalid_request' kind → 400
packages/adapters/{package.json,index.js,claude.js,agy.js}
packages/provider/{package.json,server.js,translate.js,telemetry.js,routes.js,routes.json,dashboard.js}
tests/provider2.test.js           # boots the NEW provider against fake CLIs
tests/fixtures/fake-cli.js        # + claude-sim / agy-sim modes (argv log, FAKE_CLI_TEXT, FAKE_CLI_DELAY)
scripts/bridge.js                 # provider service → packages/provider; default service set = provider only
```

**Adapter contract (both adapters):**
```js
{ name, capabilities: { streaming, nativeUsage, sessions },
  listModels() -> Promise<Model[]>,            // free; cached
  healthCheck() -> Promise<{ok,status,durationMs,detail}>,  // cached 60s
  invoke({ prompt, model, signal, onDelta }) ->
    Promise<{ text, usage?: {promptTokens,completionTokens,source}, stopReason?, sessionId? }> }
```
- claude: stream-json first; on "unknown option/output-format" failure, permanent in-process fallback to text mode (log once). classifyError: usage-limit/rate-limit → `quota`; "issue with the selected model"/deprecated → `model_not_found`.
- agy: prompt-size guard → `invalid_request`; deltas through `createAnsiStripper`; final text `collapseCarriageReturns(stripAnsi(text))`; classifyError: capacity-exhausted → `quota`, entity-not-found → `model_not_found`. `listModels` via `agy models` (10 s timeout, 1 h cache, candidates fallback).

**Provider behavior deltas vs legacy (everything else copied verbatim, incl. dashboard HTML):**
1. Engine calls are in-process `adapter.invoke` with an `AbortController` per request (`res.close` → abort → CLI killed via core runner).
2. Errors map through `httpFor()`: quota → 429 `rate_limit_error` + `Retry-After`; model_not_found → 400; timeout → 504; spawn/bad_output → 502. Streaming errors keep the in-band error-delta pattern but record the mapped status.
3. Routes/aliases/default live in `routes.json`; `routes.js` validates on load and hot-reloads on file change (invalid edits keep the last good config). Disabled routes reject as `invalid_model` mentioning "disabled".
4. Real usage from the claude adapter flows into `usage` and telemetry (`usageSource: real`); agy stays estimated.
5. `installGracefulShutdown({server})` — SIGTERM/SIGINT kills live CLI children (closes audit H7).
6. The hard-coded "background web servers" [SYSTEM] injection is dropped (spec §4.6).
7. `/dashboard/status` keeps its legacy shape; engine entries come from adapter health checks.

**Tests (`tests/provider2.test.js`, fake CLIs only, ~24 assertions):** models surface + alias hiding; routing pins upstream `--model` (argv log); real-usage passthrough (7/9 tokens from the sim's result line); streaming shape incl. pipes intact; tool gating (with/without tools); quota stderr → 429 + Retry-After + rate_limit_error; agy entity-not-found → 400 invalid_model; oversized prompt → 400 invalid_request; dead binary → 502 + health degraded; per-engine concurrency 429 (FAKE_CLI_DELAY); abort → 499 + clean health; auth gate; disabled route rejected; routes.json hot-reload picked up.

**Tasks:**
- [ ] 1. core: move pacer into `@bridge/core`; add `invalid_request` kind (tests updated) — commit
- [ ] 2. `@bridge/adapters` (claude, agy) + fake-cli sim modes + adapter contract tests — commit
- [ ] 3. `@bridge/provider` (routes.json/routes.js/translate/telemetry/dashboard/server) — commit
- [ ] 4. `tests/provider2.test.js` green + full legacy suite still green — commit
- [ ] 5. launcher: provider service → packages/provider, default service set = provider only, engine env passthrough; live smoke (real CLIs): non-stream + stream + `/dashboard/status` — commit
