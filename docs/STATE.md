---
last-updated: '2026-07-02T09:30:00.000Z'
---
# AI CLI Bridge State

## Current Status

- **v2 consolidated architecture shipped** (branch `feat/dashboard-overhaul`,
  Phases 0–5 of `docs/superpowers/specs/2026-07-02-bridge-v2-design.md`).
- One provider process on :9011; engines are **in-process adapters**
  (`packages/adapters`): claude via stream-json (real deltas + real token
  usage, stdin prompts), agy via guarded argv with streaming ANSI strip.
- `@bridge/core` (npm workspaces): hardened CLI runner (AbortSignal, byte
  caps, StringDecoder, child registry, graceful shutdown), BridgeError
  taxonomy → single HTTP mapping, ANSI/json-extract/json-schema utilities,
  async context store with write locks.
- Failure domains: per-engine circuit breaker (quota ×2 / timeout ×3 → open,
  fail-fast 429 + Retry-After, half-open trial), bounded wait queue.
- Control plane: `/admin/*` (kill run, reset breaker, probe, engine
  enable/disable, route CRUD → routes.json hot-reload, capture toggle),
  `GET /dashboard/events` SSE bus, interval health sampling.
- Durable usage ledger `.bridge-runtime/usage/*.jsonl` + pricing.json
  API-equivalent value; `GET /dashboard/usage` rollups.
- **Control-center dashboard live** at /dashboard/ — six tabs per the
  approved mockup (Overview/Routes/Usage/Tester/Requests/Connect), static
  files, SSE-driven, Together AI design system, no CDN fonts.
- Tests: 5 suites, ~330 assertions, all green; fake-CLI fixtures only.
- Legacy `claude-bridge`/`gemini-bridge`/`provider-bridge` remain in-tree
  for the old `/api/*` surface + Docker; launcher starts them only by name.

## Ports

- Consolidated provider (everything): `9011`
- Legacy engine bridges (explicit start only): claude `9002`, gemini `9003`

## In Flight

Nothing building. Branch holds the full v2 series (spec + 5 phase plans +
implementation commits), unpushed, not merged to main.

## Blocked

Nothing blocked.

## Up Next

- User review of the live dashboard at http://127.0.0.1:9011/dashboard/
- Decide merge/push of `feat/dashboard-overhaul`
- Later (out of scope per spec): real image handoff, CLI session continuity
  (`--resume`), consolidated-provider Docker image, deleting the legacy
  provider-bridge once nothing depends on it.
