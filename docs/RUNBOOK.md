# AI CLI Bridge Runbook (v2 — consolidated provider)

## Architecture in one paragraph

One provider process on **:9011** serves the OpenAI-compatible `/v1` surface and
the control-center dashboard. Engines run **in-process** as adapters — `claude`
via `claude -p --output-format stream-json` (real streaming deltas + real token
counts, prompt via stdin) and `gemini` via `agy --print`. There is no HTTP hop
to engine bridges anymore; the legacy `claude-bridge`/`gemini-bridge` servers
remain in-tree for the old `/api/*` surface and Docker, started only by
explicit name. Routes live in `packages/provider/routes.json` (hot-reloaded),
usage in `.bridge-runtime/usage/*.jsonl` (durable), credentials in
`.bridge-runtime/credentials.json` (0600, auto-generated).

## Local daily use

```bash
cd /Users/waqar/Projects/experiments/ai-cli-bridge
npm run bridge:up          # starts the consolidated provider only
open http://127.0.0.1:9011/dashboard/
```

The launcher prints the API key on every `up`/`status`. It also lives in
`.bridge-runtime/credentials.json`. Paste it once into the dashboard's
**Connect** tab — the Tester and all admin buttons use it from localStorage.

```bash
npm run bridge:status      # health + pids
npm run bridge:down        # stop launcher-owned processes
npm run bridge:restart     # bounce the provider
npm run bridge:probe       # routes + live engine status (quota-free)
npm run bridge:connect     # write .bridge-runtime/connection.json (paste-ready)
npm run bridge:logs        # tail logs (add --follow)
node scripts/bridge.js up claude    # legacy engine bridge, explicit only
node scripts/bridge.js down all     # stop everything incl. legacy
```

## Dashboard (control center)

`http://127.0.0.1:9011/dashboard/` — six tabs:

- **Overview** — is it safe to fire work right now? Engine cards show breaker
  state, quota reason, slots/queue, 24 h uptime; actions: probe, reset breaker,
  kill a stuck run, disable engine. Alert banner when a circuit is open.
- **Routes** — toggle/add/delete routes; edits persist to `routes.json` and
  hot-apply. "Probe" lists each engine's live catalogue for free (no
  completions — claude is static, gemini uses `agy models`).
- **Usage** — durable per-app/per-route/per-day token accounting from the
  JSONL ledger, with **real** token counts on Claude routes (stream-json) and
  `~est` labels elsewhere. "API-equivalent value" prices your flat-rate usage
  at API list prices from the editable `packages/provider/pricing.json`.
- **Tester** — SSE or blocking, tools JSON, `json_object`/`json_schema`
  modes, side-by-side A/B route compare, copy-as-cURL.
- **Requests** — opt-in capture of the last 50 full exchanges (memory only,
  cleared on restart/toggle-off) with per-request stage timelines. Default
  stays metadata-only.
- **Connect** — base URL, key field, Hermes/curl/JS/Python snippets.

Live updates arrive over `GET /dashboard/events` (SSE) with polling fallback.

## App integration

```text
Base URL:  http://127.0.0.1:9011/v1
API key:   <from .bridge-runtime/credentials.json>
Header:    X-App-Id: <your-app>     # enables per-app usage attribution
```

Routes (aliases like `bridge-fast`/`bridge-smart` still work):

- `bridge-agy-gemini-3.5-flash-medium-pulse` — balanced default (Gemini)
- `bridge-agy-gemini-3.5-flash-high-forge` — stronger fast reasoning
- `bridge-agy-gemini-3.1-pro-high-atlas` — long context
- `bridge-claude-haiku-4.5-spark` — quick Claude
- `bridge-claude-sonnet-4.6-northstar` — coding/planning Claude
- `bridge-claude-opus-4.5-oracle` — hard reasoning when limits allow

Behavior contracts (v2):

- **Quota exhaustion → 429** with `Retry-After` and type `rate_limit_error`
  (OpenAI SDKs back off correctly). After 2 consecutive quota failures the
  engine's circuit opens and requests fail fast — no CLI spawns — until the
  cool-down (15 min) half-opens it. Reset early from the dashboard.
- Bursts queue briefly (depth 4, 30 s) instead of instantly 429ing. Tune with
  `PROVIDER_QUEUE_DEPTH` / `PROVIDER_QUEUE_TIMEOUT_MS`.
- Tool calls: pass `tools`; streamed tool calls arrive as proper indexed
  `tool_calls` deltas (raw JSON never leaks as content). Tool-shaped replies
  are ignored unless the request actually sent tools.
- `response_format` `json_object`/`json_schema` is enforced server-side with
  one corrective retry; hard failures return 502.
- Images are rejected with 400 (not silently degraded); `n>1` rejected;
  ignored sampling params are listed in `bridge_ignored_params`.
- Client aborts kill the underlying CLI process immediately; provider
  shutdown (SIGTERM) reaps all CLI children.

## Hermes

Provider `ai-cli-bridge` → `http://127.0.0.1:9011/v1`, key in
`~/.hermes/.env` as `AI_CLI_BRIDGE_API_KEY`. Text + tool-JSON calls work;
keep tool-heavy agentic sessions on a native provider and the Claude MCP
delegate for handing Hermes work to Claude Code.

```bash
hermes -z "Reply with exactly: ok" --provider ai-cli-bridge -m bridge-agy-gemini-3.5-flash-medium-pulse -t ""
```

## Troubleshooting

- **Claude route says usage limit** — the circuit will open after the second
  consecutive hit; Overview shows the retry countdown. Use a Gemini route
  meanwhile; reset the breaker after the window if impatient.
- **429 engine_busy** — the per-engine slot (default 1) plus queue is full;
  it's protecting your subscription. Retry after `Retry-After`.
- **Engine shows DOWN** — the CLI binary isn't on PATH for the launcher's
  environment. Set `CLAUDE_PATH`/`GEMINI_PATH` and `bridge:restart`.
- **Something looks wrong in a specific request** — flip capture ON in the
  Requests tab, reproduce, inspect the exact prompt/output/stage timings,
  flip it off (buffer clears).
- **Ledger** — `.bridge-runtime/usage/YYYY-MM.jsonl`; delete files to reset
  history (bodies are never stored there).

## Docker (legacy profile)

`docker-compose.yml` still runs the **three-process v1 stack** (engine
bridges + old HTTP-proxy provider in `provider-bridge/`) because the
consolidated provider needs the CLI binaries inside its container — not yet
built. Bare-metal is the primary path; compose is kept working for the old
`/api/*` consumers. Containers bind 0.0.0.0 explicitly; bare metal defaults
to loopback.

## Tests

```bash
npm test        # 5 suites, ~330 assertions, fake CLIs only (no quota spend)
npm run check   # node --check over every entrypoint
```
