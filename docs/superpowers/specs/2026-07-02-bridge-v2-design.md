# AI CLI Bridge v2 — Resiliency Overhaul + Control Center

- **Status:** Approved (user, 2026-07-02)
- **Inputs:** Full codebase audit (2026-07-02, in-session), user Q&A on dashboard goals, mockup review
- **Mockup:** https://claude.ai/code/artifact/5490dcf1-4e91-4009-a299-6fff7f575f1d (kept in repo at `docs/superpowers/specs/assets/control-center-mockup.html`)
- **Design system:** `docs/DESIGN.md` (Together AI) governs all web surfaces

## 1. Context and goals

The bridge exposes local subscription CLIs (`claude`, `agy`) as an OpenAI-compatible
`/v1` provider on port 9011. The audit found the current three-process design
(claude-bridge :9002, gemini-bridge :9003, provider :9011) works but is fragile:
~85% duplicated engine code already drifting, prompt-as-argv breaking over ~1 MB
(ARG_MAX), a streaming pacer that corrupts `|` characters, UTF-8 chunk splitting,
quota errors flattened into 502s that trigger client retries, no graceful shutdown
(orphaned CLI children), and engine bridges binding 0.0.0.0 despite the
loopback-only goal.

Goals for v2, in priority order:

1. **Correctness:** streamed bytes match CLI output; long histories work; tool
   calls and JSON mode are spec-compliant.
2. **Resilience:** quota exhaustion is a first-class state (429 + Retry-After +
   circuit breaker), not a crash; no orphan processes; graceful shutdown.
3. **Operability:** a control-center dashboard that answers "safe to fire?",
   manages routes, accounts usage per app, tests routes, and inspects requests.
4. **Maintainability:** one engine = one adapter file; adding a model = one JSON
   entry; zero copy-pasted server code.

## 2. Architecture decision: consolidated control plane

**One provider process** hosts everything: HTTP `/v1` surface, engine adapters
(in-process — no HTTP hop to engine bridges), route registry, circuit breakers,
usage ledger, SSE event bus, admin API, and the dashboard static files.

Rationale: every control-center action (kill a CLI child, reset a breaker,
hot-reload routes, probe models) operates on state the provider process owns.
The three-process split forced cross-process side channels for all of these and
was the root of the NODE_PATH dependency hack.

**Compatibility:** the legacy engine-bridge HTTP surface (`/api/chat`,
`/api/process`, `/api/contexts/*`, `/api/sessions/*`, `/models`, `/health`)
remains available via thin standalone servers (`packages/adapters/*/standalone.js`)
that wrap the same adapter + shared core packages. Docker compose runs these as
today. The launcher (`scripts/bridge.js`) manages only the provider by default;
`bridge up claude|gemini` starts a standalone wrapper explicitly.

Rejected alternatives: (A) evolve three processes in place — control actions
would cross process boundaries, duplication survives; (C) separate React/Vite
dashboard app — build step and dependencies contradict the flat, no-build DX
principle for a single-user tool.

## 3. Repository layout (npm workspaces)

```
package.json                    # workspaces: ["packages/*"] — kills NODE_PATH hack
packages/
  core/
    config.js                   # env parsing, defaults, validation
    errors.js                   # BridgeError taxonomy + HTTP mapping
    cli-runner.js               # the one hardened process runner
    auth.js                     # bearer middleware (timing-safe)
    context-store.js            # async contexts CRUD + per-file write lock
    sessions.js                 # session registry (bounded)
    sse.js                      # SSE writer: heartbeats, backpressure, abort
    ansi.js                     # streaming-safe ANSI/OSC/CR stripper transform
    json-extract.js             # fence/preamble-tolerant JSON extraction
  adapters/
    claude/adapter.js           # claude -p --output-format stream-json (stdin prompt)
    claude/standalone.js        # legacy :9002 HTTP surface (thin)
    agy/adapter.js              # agy --print (stdin prompt, ANSI transform)
    agy/standalone.js           # legacy :9003 HTTP surface (thin)
  provider/
    server.js                   # thin: wiring only
    translate.js                # OpenAI ⇄ engine request/result (incl. streaming)
    routes.js                   # route registry: load/validate/hot-reload routes.json
    routes.json                 # data: routes, aliases, default
    breaker.js                  # per-engine circuit breaker
    semaphore.js                # per-engine concurrency + bounded wait queue
    usage.js                    # JSONL ledger + aggregation
    pricing.json                # editable API-list-price map for $-equivalents
    capture.js                  # opt-in request/response ring buffer (memory only)
    events.js                   # SSE event bus for the dashboard
    admin.js                    # POST /admin/* control endpoints
    dashboard/                  # static: index.html, app.js, styles.css (no build)
scripts/bridge.js               # launcher (updated: single service default)
tests/                          # fixture fake-CLI + contract/integration tests
```

## 4. Core components

### 4.1 CLI runner (`core/cli-runner.js`)

`runCli(bin, args, opts) -> Promise<{text, exitCode, truncated, stderr}>` with
`opts = {stdin, signal, timeoutMs, maxBytes, onDelta, registry}`.

- Prompt delivered via **stdin** (`stdio: ['pipe','pipe','pipe']`,
  `child.stdin.end(prompt)`). Never as argv (fixes E2BIG at ARG_MAX ≈ 1 MB and
  `ps` prompt leakage).
- Output decoded with `string_decoder.StringDecoder`; caps measured with
  `Buffer.byteLength` (bytes, not UTF-16 units).
- `AbortSignal` aborts: HTTP client abort and server shutdown share one
  mechanism. Kill escalation: SIGTERM → 2 s → SIGKILL (kept from v1).
- Every live child registered in a module-level `Set`; `process.on('SIGTERM'/'SIGINT')`
  kills all children, stops the HTTP server, then exits (fixes orphan CLIs).
- Timeout rejects with `BridgeError('timeout')`; truncation resolves with
  `truncated: true` (kept from v1).

### 4.2 Error taxonomy (`core/errors.js`)

`BridgeError { kind, message, detail, retryAfterSec? }` with
`kind ∈ {quota, model_not_found, timeout, spawn_failed, truncated, bad_output, aborted}`.
Adapters own `classifyError(stderr, stdout)` (the current string matchers move
there). Provider edge maps kinds to HTTP:

| kind | HTTP | OpenAI `type` | notes |
|---|---|---|---|
| quota | 429 | `rate_limit_error` | `Retry-After` header; feeds breaker |
| timeout | 504 | `upstream_timeout` | feeds breaker |
| model_not_found | 400 | `invalid_model` | param `model` |
| spawn_failed | 502 | `upstream_error` | |
| bad_output | 502 | `upstream_error` | after JSON repair retry fails |
| aborted | — (499-class) | — | telemetry only; never a health sample |

### 4.3 Engine adapters

Contract:

```js
{ name, capabilities: {streaming, nativeUsage, sessions},
  listModels({probe}) , healthCheck(),
  invoke({prompt, model, signal, onDelta}) -> {text, usage?, stopReason?} }
```

- **claude:** `claude -p --output-format stream-json --include-partial-messages
  --model <m>`, prompt on stdin. Parses NDJSON events → real deltas, **real
  token usage**, structured errors. Fallback: if the installed CLI rejects
  `stream-json`, degrade to text mode (est. usage) and log once.
- **agy:** `agy --print --model <m> --print-timeout <s>`, prompt on stdin
  (temp file 0600 fallback if stdin unsupported). stdout piped through the
  streaming ANSI transform (`core/ansi.js`) which carries partial escape
  sequences and `\r` frames across chunk boundaries. Usage estimated
  (chars/4), flagged `estimated: true`.
- Model discovery: claude = static list + `--version` check; agy = probe on
  **explicit request only** (`POST /admin/engines/agy/probe`), never implicit —
  probing costs ~1 CLI call per candidate and the UI must say so.

### 4.4 Route registry (`provider/routes.js` + `routes.json`)

Routes and aliases move verbatim from code to `routes.json`:
`{id, label, engine, model, aliases[], bestFor, enabled, fallback?}` +
`{defaultRoute}`. Loaded and validated at boot; `POST /admin/routes*` writes
atomically (temp file + rename) and hot-reloads; file watcher picks up manual
edits. Adding a model = one JSON entry.

### 4.5 Concurrency and circuit breaker

- Per-engine semaphore, `MAX_CONCURRENT_PER_ENGINE` default 1 (unchanged), plus
  a bounded FIFO wait queue (depth 4, wait timeout 30 s, both configurable).
  Queue full/timeout → 429 `engine_busy` + `Retry-After`.
- Per-engine breaker: **open** after 2 consecutive `quota` (or 3 `timeout`)
  errors; while open, fail fast 429 + `Retry-After` (no CLI spawn); **half-open**
  after cool-down (quota: 15 min, timeout: 2 min) admits one trial; success
  closes. State changes emit events and are visible/resettable in the dashboard.
- Route-level `fallback` applies only when the breaker is open **and** the
  caller opts in (`X-Bridge-Fallback: allow`). Response carries
  `x-bridge-served-by: <routeId>`.

### 4.6 Protocol translation (`provider/translate.js`)

- Message flattening as today (`[ROLE]` blocks), minus the hard-coded
  background-server instruction (dropped). Multimodal `image_url` parts →
  **400 invalid_request** (honest unsupported) until image handoff is built.
- **Tool calls:** detection only when the request includes `tools`. Streaming
  holds back content while the head of the response is a candidate JSON block
  (starts with ``` or `{`, hold cap 2 KB); on parse → emit spec-correct
  `tool_calls` deltas (per-entry `index`), never the raw JSON as content; on
  no-parse → flush held content through the pacer.
- **response_format:** `json_object`/`json_schema` → post-process with
  `json-extract`; `json_schema` validated (own ~150-line validator for
  type/required/enum/properties — no ajv dependency); one corrective retry,
  then `bad_output`.
- **Streaming:** SSE heartbeat comments every 15 s; `flushHeaders()`;
  backpressure honored (`await drain` when `write()` returns false); usage chunk
  when `stream_options.include_usage`. Pacer v2: correct tokenizer
  (`/\s+|\S+/g` — the v1 regex ate `|`), abort on client close, adaptive delay
  capped so total added latency ≤ 2 s.
- Unsupported params: `logprobs`, `n>1` rejected 400; `temperature`, `top_p`,
  `max_tokens`, `stop` accepted but reported in a `bridge_ignored_params` field.

### 4.7 Usage ledger (`provider/usage.js`)

- Append-only JSONL: `.bridge-runtime/usage/YYYY-MM.jsonl`, one line per
  request: `{ts, reqId, appId, routeId, engine, model, promptTokens,
  completionTokens, usageSource: real|estimated, durationMs, status, kind?}`.
  Bodies are **never** written.
- Async buffered writes (batch every 2 s / 50 records); monthly file rotation;
  on boot, current month is scanned to warm aggregates.
- Aggregation endpoint `GET /dashboard/usage?range=today|7d|30d|all` returns
  per-app, per-route, per-day rollups. $-equivalents computed from
  `pricing.json` (editable; API list prices) and labeled "API-equivalent value".

### 4.8 Event bus + telemetry (`provider/events.js`)

- `GET /dashboard/events` (SSE, key-authed): `request.start/end`, `engine.health`,
  `breaker.change`, `capture.change`. Dashboard falls back to 5 s polling.
- Health sampling: server-side 30 s interval per engine (adapter
  `healthCheck()`), plus real-traffic outcomes **excluding** `aborted`. Fixes
  poll-bias and abort-poisoning.
- In-memory recent-request window (200) stays for the live feed.

### 4.9 Admin API (`provider/admin.js`)

All under `/admin`, Bearer-key required even when `/v1` auth is disabled;
loopback-only by default via BIND_HOST. Mutations are POST/PUT/DELETE with
JSON bodies; dashboard confirms destructive ones.

```
POST   /admin/requests/:id/kill        # abort in-flight run (kills CLI child)
POST   /admin/breakers/:engine/reset
POST   /admin/engines/:engine/probe    # explicit, quota-spending
POST   /admin/engines/:engine/disable | enable
PUT    /admin/routes/:id               # edit; POST /admin/routes to add; DELETE to remove
POST   /admin/capture  {enabled:bool}
GET    /admin/capture/:id              # captured exchange detail
```

### 4.10 Capture buffer (`provider/capture.js`)

Off by default. When on: ring buffer of last 50 exchanges
`{meta, sentPrompt, rawOutput, parsed, error, stages[]}` in memory only,
cleared on restart and on toggle-off. Stage timestamps recorded per request:
received → queued → spawned → firstByte → done. Dashboard renders the timeline
and tabs. The metadata-only privacy stance remains the documented default.

## 5. Dashboard — control center (`provider/dashboard/`)

Static files, no build step, self-hosted font stack (system substitutes per
DESIGN.md §Note on Font Substitutes; no CDN fonts). App shell per the approved
mockup: slim `canvas-dark` sticky header (logo dot, readiness verdicts per
engine, inflight, live toggle) + mono-caps tab nav + white working surfaces +
stencil wordmark footer.

Tabs (all shown in the mockup):

1. **Overview** — breaker alert banner when open; per-engine cards (status
   badge, quota state, slot pips, last error, 24 h uptime strip, actions:
   probe / reset breaker / kill run / disable); KPI tiles (requests, p50/p95
   latency, tokens today, API-equivalent value); SSE live feed with kill button
   on running rows.
2. **Routes** — registry table (toggle enabled, alias chips, edit/delete),
   add-route form fed by discovered models, discovery panel with per-model
   status (routed/new/quota) and an explicit probe button labeled with its
   quota cost.
3. **Usage** — range picker (today/7d/30d/all); tiles (total tokens,
   API-equivalent value, top app, error rate); per-app table (real vs ~est
   badges); per-day stacked bars by engine (CSS bars, no chart lib); per-route
   table; ledger location note.
4. **Tester** — route A + optional compare route B; prompt; collapsible system
   prompt and tools JSON; response_format segmented control (text/json_object/
   json_schema + schema editor); SSE/blocking; Run/Stop; copy-as-cURL; session
   history list. Route options show live readiness inline.
5. **Requests** — capture toggle with privacy line; list + detail: stage
   timeline, tabs (sent prompt / CLI output / parsed / error), kill on running.
   Empty state explains capture-off.
6. **Connect** — base URL / auth / default route / `X-App-Id` kv rows + snippet
   tabs (Hermes, curl, JS, Python).

`GET /dashboard` and static assets stay unauthenticated (loopback); every data
and admin endpoint requires the key. The dashboard keeps the key in
localStorage as today.

## 6. Security

- `BIND_HOST` default `127.0.0.1` everywhere (provider and standalone wrappers);
  Docker sets `0.0.0.0` explicitly. Startup warning when non-loopback + no key.
- Credentials files written `0o600`.
- Prompts via stdin (not argv), so conversation content never appears in `ps`.
- `/admin/*` always requires the key. Capture data is memory-only.
- Existing protections kept: timing-safe compare, slug regex + resolved-path
  check, execFile (no shell).

## 7. Launcher changes (`scripts/bridge.js`)

- Default service set = `provider` only; standalone wrappers by explicit name.
- `restart`: poll for process exit + port free (up to 5 s) instead of fixed
  500 ms sleep. Pidfiles store `{pid, startedAt}`; `down` verifies both.
- `probe` command calls `POST /admin/engines/:e/probe` and says it spends quota.
- Log rotation: truncate-to-tail at 5 MB on `up`.

## 8. Delivery phases

- **Phase 0 — hotfixes on current tree** (independent, shippable immediately):
  pacer regex + abort + cap; BIND_HOST wiring; stdin prompts; StringDecoder;
  tool-detection gating + indexed deltas; explicit-only agy probe; abort ≠
  health failure; 0600 credentials; `activeChild` scoping.
- **Phase 1 — workspace + core:** npm workspaces; `core/*` modules incl.
  cli-runner with child registry + graceful shutdown; tests with fake CLI.
- **Phase 2 — adapters + consolidated provider:** claude stream-json adapter,
  agy adapter, routes.json registry, provider serves `/v1` via in-process
  adapters; standalone wrappers for legacy surface; launcher update.
- **Phase 3 — protocol + usage:** translate.js hardening (tool-call hold-back,
  response_format repair, SSE heartbeats/backpressure, pacer v2), usage ledger
  recording + aggregation.
- **Phase 4 — failure domains + control plane:** breaker, wait queue, error
  mapping, admin API, event bus, capture buffer.
- **Phase 5 — dashboard + polish:** six-tab UI per mockup, integration tests,
  RUNBOOK/README updates, docker-compose update.

Each phase ends green: `npm test` + `npm run check` + manual smoke via
launcher. Phase 0 commits directly to the working branch; Phases 1–5 land as
sequential commits (same branch), tests first where practical.

## 9. Testing strategy

- `tests/fixtures/fake-cli.js`: scriptable via env — emit fixture text, ANSI/OSC
  noise, split multi-byte UTF-8 across flushes, flood N MB, hang, exit with
  quota stderr, emit claude stream-json events.
- Contract tests run each adapter against the fake CLI: streaming integrity
  (byte-identical, `|` preserved, UTF-8 intact), caps, timeout kill, error
  classification.
- Provider integration tests (fake CLI end-to-end): tool-call stream shape,
  response_format repair, client abort → child killed + no health poison,
  429 + Retry-After on quota, breaker open→half-open→close, usage ledger rows,
  admin endpoints, legacy standalone surface.
- Existing `tests/security.test.js` assertions carried forward.

## 10. Out of scope (explicit)

- Real multimodal image handoff (v2 rejects with 400; design later).
- CLI session continuity (`--resume`) — adapter contract reserves `sessions`
  capability for it.
- Multi-user auth, TLS, non-local deployment.
- SQLite or any DB — JSONL is sufficient at this scale.
