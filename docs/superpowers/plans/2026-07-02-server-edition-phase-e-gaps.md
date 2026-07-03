# Server Edition Phase E — Gap Mitigations Implementation Plan

> **For agentic workers:** TDD per task (fake-CLI harness; `FAKE_CLI_STATE_FILE`/`FAKE_CLI_TEXT_FILE` scripts malformed-then-valid replies). Session continuity (E3) additionally needs a live `claude --resume` spike before wiring. Steps use checkbox (`- [ ]`).

**Goal:** Close the three fillable capability gaps from the spec: reliable tool-call parsing (§6), an explicit oversized-prompt policy (§5), and flat prompt size on long conversations via CLI-native session resume (§4).

**Risk-ordered build:** E1 (tool hardening) and E2 (overflow) are self-contained and fully fake-testable — land first. E3 (session continuity) touches the hot path, needs a live-CLI spike, and must never become a correctness dependency (any mismatch → full-prompt fallback) — land last, in its own focused pass.

**Verified facts:**
- Tool JSON leaks as content today when `parseToolCallsFromText` returns null: non-stream returns the raw text (server.js ~640); stream pushes the held head (server.js ~582). The stream *hold-back* buffers tool-looking output until parse, so `!streamedBytes` still holds → a pre-first-byte retry is possible. Existing single-retry patterns to mirror: `enforceJson` (~481) and the tool_choice retry (~647).
- agy already throws `invalid_request` on `promptBytes > maxPromptBytes` (200KB) (agy.js:67) — §5's loud default exists; the message just needs the remedies, and the server needs the opt-in reroute.
- claude adapter already returns `sessionId` from the result line (claude.js:123); agy has no conversation id (Spike E0). `messagesToPrompt` is engine-agnostic.

---

### Task E1 — tool-call hardening (§6)  ✅ this pass

**Files:** `packages/provider/translate.js`, `packages/provider/server.js`, `packages/provider/telemetry.js`; tests `tests/provider2.test.js`.

- [ ] **E1.1 few-shot example** — in `messagesToPrompt`'s tool system block, append one complete, correctly-escaped example showing `arguments` as a JSON-encoded string (the observed failure mode). Both paths benefit.
- [ ] **E1.2 telemetry counter** — `telemetry.recordToolRetry()` increments a module counter; `computeTelemetry` surfaces `toolRetries`.
- [ ] **E1.3 non-stream retry** — unify with the existing tool_choice retry: fire one retry when `toolsProvided && (!satisfiesChoice() || malformedToolAttempt())`, where `malformedToolAttempt = !detectedTools && /"tool_calls"|```json/.test(text)`. Count it, re-parse, keep existing 502-on-required behavior; under `auto`, a still-unparseable retry falls through to text passthrough.
- [ ] **E1.4 stream retry (pre-first-byte)** — when `toolsProvided && !streamedBytes && !detectedTools && looksLikeToolAttempt(result.text)`, do one blocking corrective `adapter.invoke`; on success set `result`/`detectedTools` and clear `held`; on failure deliver the original held content as today.
- [ ] **E1.5 tests** — a `claude-sim` stub scripted malformed-then-valid (`FAKE_CLI_STATE_FILE`): non-stream → one retry → valid `tool_calls` out, `toolRetries` incremented; stream (held, pre-first-byte) → same. Run `node tests/provider2.test.js`.
- [ ] **E1.6 commit** `feat(provider): tool-call hardening — corrective retry on malformed tool JSON + few-shot`.

### Task E2 — oversized-prompt policy (§5)

- [ ] **E2.a (this pass) loud message** — agy.js overflow error names the cap, the actual size, and the two remedies (a Claude route / shorter history / session continuity). Test: prompt > cap → 400 `invalid_request` whose message includes "limit" and a remedy. Commit `feat(adapters): oversized-prompt error names cap + remedies`.
- [ ] **E2.b (next pass) opt-in reroute** — route may declare `overflowFallback: '<routeId>'` (routes.js validates it exists + targets a different engine/larger cap). Server pre-flight: build prompt early, compare bytes to the engine cap (`gemini`=`MAX_PROMPT_BYTES`, `claude`=∞); on overflow with a fallback, switch `route` before account selection and add `bridge_rerouted:{from,to,reason:'prompt_overflow'}` to the response; else 400. Tests + commit.

### Task E3 — session continuity (§4)  (next pass, focused)

- [ ] **E3.0 Spike** — live: capture `session_id` from one real `claude -p` call, then confirm a second `claude -p --resume <id>` continues context (adapter needs a `resumeId` passthrough → `--resume`). Confirm agy has no usable id → ships claude-only (§4.2 fallback).
- [ ] **E3.1 store** — `packages/provider/sessions.js` (new or extend core): LRU(200)+TTL(24h) mapping `sha256(normalized([route.id, account, messages]))` → `{sessionId, engine}`. `BRIDGE_SESSIONS=0` disables. Evict on accounts/routes reload for the engine. Unit tests.
- [ ] **E3.2 wire** — after success, store `prefixHash(messages + assistantReply)`. On new request, if `prefixHash(messages[0..n-2])` hits and the owning account is selectable → spawn with `--resume` and send only the trailing message(s); any mismatch → today's full prompt. `usageSource:'resumed'` marks continuity calls. Account affinity: resume only on the owning account.
- [ ] **E3.3 tests + docs + commit** — fake-CLI resume-arg assertion, edited-history fallback, `BRIDGE_SESSIONS=0` disables; HOW-IT-WORKS + STATE.

---

**This pass delivers E1 (full) + E2.a.** E2.b and E3 follow in subsequent passes to keep hot-path changes small and individually verified.
