# Bridge v2 Phase 4 — Failure Domains + Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Format note:** executed in-session by the author immediately after writing.
> Spec §4.5, §4.8, §4.9, §4.10 are normative.

**Goal:** Quota exhaustion becomes a managed state (circuit breaker fails fast with Retry-After instead of spawning doomed CLI runs), bursts queue briefly instead of instantly 429ing, and every dashboard control gets its backend: `/admin/*` endpoints, the SSE event bus, the opt-in capture ring buffer, interval-based health sampling, and a live-request registry with kill.

**New files:** `packages/provider/{breaker.js,semaphore.js,events.js,capture.js,admin.js}`. **Modified:** `server.js` (wiring), `routes.js` (`update()` for admin route mutations, `BRIDGE_ROUTES_FILE` override), `tests/provider2.test.js`, `package.json` check list.

**Contracts:**

- `createBreaker({engine, quotaThreshold:2, timeoutThreshold:3, quotaCooldownMs:15m, timeoutCooldownMs:2m, onChange})` → `allow() -> {allowed, retryInSec?, reason?}` (open → fail fast; cooldown elapsed → half-open admits ONE trial), `recordSuccess()` (closes), `recordFailure(kind)` (consecutive quota/timeout counters; trial failure reopens), `reset()`, `status()`. Only `quota` and `timeout` kinds count; other kinds reset the streaks.
- `createSemaphore({max, queueDepth:4, queueTimeoutMs:30s})` → `acquire(signal) -> release` — FIFO wait queue; full/timeout → `{busy:true}` error (429 engine_busy + Retry-After 5); abort while queued rejects `aborted`. Exposes `active`/`queued` for the dashboard. Env: `PROVIDER_QUEUE_DEPTH`, `PROVIDER_QUEUE_TIMEOUT_MS`.
- `createEventBus()` → express handler for `GET /dashboard/events` (SSE, 15 s pings, `retry: 3000`) + `emit(type, data)`. Events: `request.start`, `request.end`, `breaker.change`, `engine.health`, `capture.change`. Open like `/dashboard/status` (EventSource can't set headers; loopback default).
- `createCapture({max:50})` — off by default; `setEnabled` (disable clears), `start(meta)` returns a mutable entry `{id, meta, stages, sentPrompt, rawOutput, error}`, `list()` summaries (no bodies), `get(id)` full. Memory only.
- `admin.js` mounts under `/admin` — **always** requires the bearer key (503 `admin_disabled` if no key configured): `POST /admin/requests/:id/kill` (aborts the live AbortController → CLI killed), `POST /admin/breakers/:engine/reset`, `POST /admin/engines/:engine/probe` (`listModels({refresh:true})`), `POST /admin/engines/:engine/{disable,enable}`, `POST/PUT/DELETE /admin/routes[/:id]` (atomic routes.json mutation via `registry.update()`, validated, hot-applied), `GET/POST /admin/capture`, `GET /admin/capture/:id`.
- Server wiring: breaker gate after route checks (fail-fast 429 `rate_limit_error` + Retry-After = remaining cooldown); semaphore replaces the raw inflight counter (AbortController created before acquire so queued waiters cancel); active-request registry (`id, routeId, engine, appId, startedAt, streaming`) exposed on `/dashboard/status` and used by kill; breaker outcomes fed from invoke results; interval health sampler (`HEALTH_SAMPLE_MS` default 30 s) replaces poll-driven sampling; `/dashboard/status` gains `breakers`, `queue`, `activeRequests`, `enginesDisabled`.
- Admin-killed non-stream requests get a JSON error (`request_cancelled`), recorded as 499; client aborts keep the silent-end behavior.
- Test isolation: `BRIDGE_ROUTES_FILE` env points the registry at a temp copy so admin route tests never mutate the repo's routes.json.

**Tests (~18):** breaker unit (open after 2 quota, retryInSec, half-open single trial, success closes, reset); queue: depth 4 → two parallel both 200 (second waited), depth 0 → instant 429 (existing test updated); breaker integration: quota stub → 3rd call fails fast without CLI spawn (argv log), admin reset closes; kill: slow stream, kill via admin, 499 recorded + no orphan children; capture: off = empty, on = entry with sentPrompt/rawOutput + stage timings, disable clears; events: `request.end` arrives over SSE; admin route add/delete reflected in `/v1/models`, duplicate id → 400; engine disable → 400, enable → 200; admin without key → 401/503.

**Tasks:**
- [ ] 1. breaker + semaphore + unit tests — commit
- [ ] 2. events + capture + admin + routes.update + server wiring — commit
- [ ] 3. provider2 integration tests green + full suite — commit
- [ ] 4. live smoke: admin endpoints + events stream against real stack — commit
