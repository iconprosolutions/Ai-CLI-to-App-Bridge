---
last-updated: '2026-07-04T18:45:00.000Z'
---
# AI CLI Bridge State

## Current Status

- **SaaS hardening shipped + live (2026-07-04 pm).** Per-user keys now carry
  optional `limits` (`rpm` sliding window, `tokensPerDay` calendar-day,
  `usdPerMonth` API-equivalent calendar-month) enforced on `/v1` with
  `429 + Retry-After`; counters seeded from the ledger at boot so restarts
  keep budgets. `PATCH /admin/keys/:name` edits limits; `GET /admin/keys`
  returns limits + live consumption; Connect tab has limit inputs on mint, a
  "Limits · used" column, and an edit action. `DASHBOARD_AUTH=1` (default in
  the deploy compose) gates dashboard data endpoints behind an admin key
  (Bearer or `?key=` for SSE) so a Cloudflare tunnel exposes nothing
  unauthenticated — static UI stays public, `/v1`+`/admin` were already gated.
  Verified live on the NAS: `demo-user` key (rpm 2) → 200, 200, 429 with
  `Retry-After: 54`; dashboard 401 without key / 200 with; hermes unaffected.
  198 assertions green (20 new in P25).
- **LIVE ON THE NAS (2026-07-04).** The Server Edition runs in Docker on the
  Ugreen NAS (`ai-cli-bridge` container, `http://192.168.1.10:9011`). Both
  engines verified with real completions (claude 2.1.201 via copied
  keychain-extracted `.credentials.json`; agy 1.0.16 via copied
  `antigravity-cli/antigravity-oauth-token` — NOT `oauth_creds.json`, docs
  corrected). Auth enforced (named keys; startup banner fixed to read
  `keyStore.authEnabled`, it previously lied "DISABLED" when only file keys
  existed). Streaming verified over the LAN. **Hermes cut over** to
  `http://192.168.1.10:9011/v1` with a minted app-role key `hermes`
  (`~/.hermes/config.yaml` + `.env`; backup `config.yaml.bak-nas-cutover-20260704`).
  Usage ledger attributes the `hermes` app/key. Deploy fixes this session:
  runtime volume standardized to repo-root `data/` (compose `../data/runtime`),
  Ugreen rsync `~`-remap quirk documented, and the claude adapter now
  self-heals when a newer CLI rejects a `--disallowedTools` name as unknown
  (2.1.201 dropped `SlashCommand`) — pruned + retried, regression-tested.

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

- **Deployed and live** — the NAS deploy, account onboarding, and Hermes cutover
  all completed 2026-07-04 (see Current Status). Remaining: decide PR/merge of
  `feat/dashboard-overhaul` into main.
- Watch item: the claude account on the NAS shares the Mac's OAuth
  refresh token (keychain copy). If Anthropic rotates it on refresh, one side
  may need a re-login; the durable alternative is `claude setup-token`
  in-container (`scripts/account-login.sh claude main`, needs the operator).
- Later (out of scope per spec): real image handoff, deleting the legacy
  provider-bridge once nothing depends on it.
