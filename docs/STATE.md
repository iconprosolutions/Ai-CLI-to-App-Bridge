---
last-updated: '2026-07-03T08:00:00.000Z'
---
# AI CLI Bridge State

## Current Status

- **v2 consolidated architecture shipped** (branch `feat/dashboard-overhaul`,
  Phases 0–5 of `docs/superpowers/specs/2026-07-02-bridge-v2-design.md`).
- **Server Edition Phase A (multi-account pool) shipped** — Tasks 1–8 of
  `docs/superpowers/plans/2026-07-02-server-edition-phase-a-accounts.md`.
  `packages/provider/accounts.js` owns N named accounts per engine with
  per-account breaker+semaphore, round-robin selection, route-level pinning,
  one-shot transparent failover (never after first byte), `auth`/needs-login
  handling, and hot-reloadable `accounts.json`. Zero-config: no file → one
  implicit `default` account (verified live — single real call + status
  snapshot). Adapters take per-invocation `env` (claude→`CLAUDE_CONFIG_DIR`,
  agy→`HOME`); fixed a latent agy exit-0 auth bug. 364 assertions green.
- **Server Edition Phase B (named API keys) shipped** — Tasks 1–6 of
  `docs/superpowers/plans/2026-07-02-server-edition-phase-b-keys.md`.
  `packages/provider/keys.js` owns a v2 `credentials.json` (named keys, `admin`/
  `app` roles, optional per-engine `accountPin`); a v1 `{apiKey}` file migrates
  in place preserving the key value (verified live — Hermes/launcher unaffected).
  `/v1` accepts any valid key and attaches `req.auth`; account-pin precedence is
  key → route → pool; the admin router is admin-role-gated with mint/revoke/list
  (`/admin/keys`). Ledger + telemetry attribute `keyName`. New `tests/keys.test.js`
  (33) + provider2 key suite; 413 assertions green; live mint→call→revoke smoke
  passed.
- **Server Edition Phase E (gap mitigations) — shipped (streaming continuity is
  the one refinement left).** **E1 tool-call hardening** (one corrective retry on
  malformed tool JSON — non-stream and streaming pre-first-byte — so raw JSON
  never leaks; few-shot example; `toolRetries` counter). **E2 oversized-prompt
  policy** (prompt flattened before lane acquisition; over the engine cap → loud
  400 naming cap+remedies, or opt-in `overflowFallback` reroute marked
  `bridge_rerouted`). **E3 session continuity** (`claude --resume` with a
  prefix-hash store → delta-only follow-ups on the same account; pure accelerator
  with full-prompt fallback; `BRIDGE_SESSIONS=0` off; **streaming + non-streaming**,
  both verified live end-to-end). Plus a user
  request: **signed-in account shown per engine** on Overview + Accounts (reads
  each CLI's config identity, mtime-cached).
- **Server Edition Phase C (dashboard) shipped** — Tasks 1–6 of
  `docs/superpowers/plans/2026-07-02-server-edition-phase-c-dashboard.md`.
  Backend: `pool.setEnabled` + `POST /admin/accounts/:e/:name/{enable,disable}`;
  `usage.aggregate()` gains `perAccount` + `perKey` rollups. Dashboard: new
  **Accounts tab** (per-account cards — state/breaker countdown, slots, month
  usage, Probe, Enable/Disable, one-time login command on needs-login), **Connect
  tab key management** (list/mint/revoke, secret shown once, admin-gated), and a
  **Usage attribution toggle** (by app / account / key). Static files, same
  `renderAll()`/`admin()`/`ACTIONS` patterns, SSE `account.change`/`keys.change`.
  446 assertions green; live smoke on restarted provider confirmed all endpoints.
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

- **Server Edition Phase D (Docker + NAS deploy) — artifacts shipped.**
  `deploy/Dockerfile` (node:22-slim, claude via npm, non-root, healthcheck),
  `deploy/entrypoint.sh`, `deploy/docker-compose.yml` (9011, single runtime
  volume, restart), `scripts/account-login.sh`, `docs/DEPLOY-NAS.md`. **Both
  engines on the NAS**: the image installs claude (npm) and agy (Antigravity's
  official linux-amd64 installer — Spike D0 corrected: agy *does* ship for Linux).
  agy has no headless login, so gemini accounts are onboarded by copying `.gemini`
  creds (file-based OAuth, self-refreshing); claude logs in in-container.
  Container runtime config verified locally (bootstrap + boot + auth); the actual
  `docker build` + live deploy to 192.168.1.10 need the operator present.

## Up Next

- **The whole Server Edition (Phases A–E) is implemented on `feat/dashboard-overhaul`.**
  Decide push/PR/merge. Nothing is pushed yet.
- **Operator-gated:** run the NAS deploy (`docs/DEPLOY-NAS.md`) — `docker build`,
  onboard claude + gemini accounts, point Hermes at `http://192.168.1.10:9011/v1`.
  First deploy should confirm `agy --version` in-container and one gemini creds-copy
  round-trip (headless auth is the only unverified link, per DEPLOY-NAS.md).
- Later (out of scope per spec): real image handoff, CLI session continuity
  (`--resume`), deleting the legacy provider-bridge once nothing depends on it.
