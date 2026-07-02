# Bridge v2 Phase 3 — Protocol Hardening + Usage Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Format note:** executed in-session by the author immediately after writing.
> Spec §4.6–§4.7 is normative.

**Goal:** Make the OpenAI surface spec-honest — streaming tool calls never leak raw JSON as content, `response_format` is enforced with one corrective retry, SSE gets heartbeats + backpressure, unsupported params are rejected or reported — and start the durable JSONL usage ledger with API-equivalent pricing that the dashboard's Usage tab will read.

**Deliverables:**

1. **Streaming tool-call hold-back** (consolidated provider, tools requests only): buffer deltas while the trimmed head looks like a candidate JSON block (` ``` ` or `{`), cap 2 KB. Final text parses as tool calls → emit only indexed `tool_calls` deltas (held content discarded); otherwise flush held content through the pacer. Documented edge: tool JSON larger than the hold cap degrades to the old double-delivery.
2. **response_format enforcement** (non-stream): `json_object`/`json_schema` → `extractJson` on the reply; `json_schema` validated by a new dependency-free `validateJsonSchema` in core (type/enum/required/properties/items/additionalProperties); on failure ONE corrective retry (`[ASSISTANT] <bad output> [SYSTEM] not valid JSON (<reason>) — reply with only corrected JSON`), then `bad_output` → 502. Content returned is the re-serialized parsed JSON. Streaming path is exempt (deltas already left) — documented.
3. **SSE hygiene:** `flushHeaders()`, `: ping` heartbeat every `SSE_HEARTBEAT_MS` (default 15000, env-tunable for tests), pacer `onToken` may return a promise — awaited — so the server can block on `res.write === false` until `drain` (real backpressure).
4. **Honest params:** `image_url` content parts → 400 `invalid_request_error` (was silent `[Image: url]` degradation); `n > 1` → 400 `unsupported_parameter`; `temperature/top_p/max_tokens/stop/presence_penalty/frequency_penalty` accepted and echoed in `bridge_ignored_params` on non-stream completions; `stream_options.include_usage` → usage chunk (empty `choices`) before `[DONE]`.
5. **Usage ledger** (`packages/provider/usage.js` + `pricing.json`): append-only `BRIDGE_USAGE_DIR/YYYY-MM.jsonl` (default `.bridge-runtime/usage/`), entries `{ts,reqId,appId,routeId,engine,model,promptTokens,completionTokens,usageSource,durationMs,status}`; buffered writes (`USAGE_FLUSH_MS` default 2000 / 50 entries), sync flush on process exit; `aggregate(range)` reads the relevant month files and returns totals (incl. `apiEquivalentUsd` from editable `pricing.json` API list prices), perApp, perRoute, perDay-by-engine, error counts. Served at `GET /dashboard/usage?range=today|7d|30d|all`.

**Files:** `packages/core/json-schema.js` (+index export), `packages/core/pacer.js` (async onToken), `packages/provider/{server.js,usage.js,pricing.json}`, `tests/fixtures/fake-cli.js` (garbage-first stateful mode), `tests/core.test.js` (+schema validator), `tests/provider2.test.js` (+hold-back, repair, params, heartbeat, ledger), `package.json` check list.

**Tests added (~16):** schema validator accept/reject/nested/enum/additionalProps; hold-back: tools+tool-JSON stream has NO content deltas but indexed tool_calls; tools+plain-text stream still streams content; json_object returns parseable pure JSON; garbage-first stub repaired on retry; always-garbage → 502 after exactly 2 invocations (argv log); json_schema mismatch repaired; image_url → 400; n=2 → 400; ignored params echoed; include_usage chunk; heartbeat `: ping` visible with 100 ms interval + 400 ms delay stub; ledger file rows + aggregate totals + perApp attribution + apiEquivalentUsd > 0.

**Tasks:**
- [ ] 1. core: `json-schema.js` + async-aware pacer + tests — commit
- [ ] 2. provider: hold-back + response_format repair + honest params + SSE hygiene — commit
- [ ] 3. provider: usage ledger + pricing.json + `/dashboard/usage` — commit
- [ ] 4. full suite green + live smoke (real call lands in the ledger) — commit
