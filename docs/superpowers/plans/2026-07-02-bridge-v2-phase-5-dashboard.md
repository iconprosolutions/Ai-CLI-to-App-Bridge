# Bridge v2 Phase 5 — Dashboard Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Format note:** executed in-session by the author immediately after writing.
> Spec §5 + the approved mockup (`docs/superpowers/specs/assets/control-center-mockup.html`)
> are normative for layout; `docs/DESIGN.md` for visual tokens.

**Goal:** Replace the embedded legacy dashboard HTML with the approved six-tab control center as static files served by the provider — every control wired to the real backends built in Phases 2–4.

**Files:**
- Create: `packages/provider/dashboard/{index.html,styles.css,app.js}` (no build step, no CDN fonts — system font stacks per DESIGN.md substitutes note)
- Modify: `packages/provider/server.js` — `GET /` redirects to `/dashboard/`; `express.static` serves the dir (static passthrough keeps `/dashboard/status|events|usage` handlers working); delete `dashboard.js` (legacy embedded HTML)
- Modify: `tests/provider2.test.js` (+ dashboard serving assertions), `package.json` (check list: remove dashboard.js, add none — static assets aren't JS-checked except app.js)
- Docs: `docs/RUNBOOK.md` rewrite for the consolidated architecture; `docs/STATE.md` refresh; docker-compose comment marking the three-process path as the legacy/container profile

**Data wiring (per tab):**
- Shell header: readiness verdicts derived from status (`breaker open → BLOCKED`, `busy → BUSY`, `disabled → OFF`, else `READY`), inflight, live SSE indicator.
- **Overview:** breaker alert banner (with reset/probe actions when open); engine cards (status badge, breaker state, quota reason, slot pips from `inflight`/`queue`, last error from telemetry, 24 h strip from `engines.*.history`, actions probe/reset/kill/disable via `/admin/*`); KPI tiles from `telemetry` + `usage?range=today`; live feed from `recentRequests` + `activeRequests` (kill button), updated by `request.*` SSE events.
- **Routes:** table from `routes` (+ enabled toggle → `PUT /admin/routes/:id`), edit via prompt-based form, delete with confirm; add-route form; discovered-models panel via `POST /admin/engines/:e/probe` (labeled free).
- **Usage:** range picker → `/dashboard/usage?range=`; tiles, per-app table with real/mixed/~est accuracy badges, per-day stacked CSS bars by engine, per-route table.
- **Tester:** route select (readiness inline), prompt, system prompt, tools JSON, response_format seg, SSE/blocking, optional compare route B (two parallel runs, two consoles), Stop via AbortController, copy-as-cURL, session history list.
- **Requests:** capture toggle → `POST /admin/capture`; list from `GET /admin/capture`; detail from `GET /admin/capture/:id` (stage timeline bar from `stages`, tabs: sent prompt / raw output / error); empty state when off.
- **Connect:** base URL/auth/default/X-App-Id kv rows + Hermes/curl/JS/Python snippets; the admin key field lives here (localStorage `providerApiKey`, shared by tester + admin calls; 401 responses surface a "set your key in Connect" hint).
- Transport: initial `fetch /dashboard/status`; `EventSource /dashboard/events` triggers throttled refresh (500 ms) + instant feed updates; 10 s polling fallback when SSE errors; usage fetched on tab entry / range change.

**Tests:** `GET /dashboard/` serves HTML containing `Control Center` + `app.js`; `/dashboard/app.js` 200 JS; `/dashboard/status` unchanged shape (existing assertion); full five-suite pass; live smoke in a real browser is left to the user (noted in handoff) with a curl sanity pass in CI-style.

**Tasks:**
- [ ] 1. index.html + styles.css (mockup-faithful, system fonts) — commit
- [ ] 2. app.js (state, SSE, six tab renderers, admin actions, tester) — commit
- [ ] 3. server static wiring + delete legacy dashboard.js + tests — commit
- [ ] 4. RUNBOOK/STATE/docker notes + full suite + live smoke — commit
