---
last-updated: '2026-07-11T23:49:00.000Z'
---
# AI CLI Bridge State

## Current Status

- **Router Phase 2 shipped (2026-07-11): headroom-aware dispatch + Orbit
  import.** (1) Unpinned selection now orders candidates by bottleneck
  utilization — the worst applicable weekly window dominates, busiest
  session is a sub-integer tiebreak; model-scoped windows (e.g. "Opus
  weekly") count only for their model family. Drained accounts (session
  ≥90% / weekly ≥95%) sort last unless every eligible account is drained
  (then least-utilized still serves); busy accounts (no free CLI slot) rank
  behind free ones so bursts spill across the pool; unknown/stale snapshots
  score neutral (50); no headroom fn passed → legacy round-robin (existing
  tests unaffected); a drained primary spills to the pool, a healthy one is
  still preferred; soft-pin fallback stays headroom-aware. All four
  `server.js` `pool.select()` call sites (primary dispatch, cross-engine
  fallback ×2, mid-dispatch failover) now pass `model`+`headroom`. (2)
  `quota.change` → `pool.refreshQuotaBreaker`: a fresh, clean poll (never an
  error-bearing or stale-beyond-3-poll-intervals snapshot) retires a quota
  breaker whose parsed reset deadline was wrong; conservative — any
  still-hot window (session ≥90 / weekly ≥95, unscoped) blocks the clear;
  timeout breakers are never poll-cleared. (3) Per-account exponential poll
  backoff on fetch failure (60s base ×2, 30min cap, cleared on success;
  `QUOTA_BACKOFF_BASE_MS`) — keeps a failing endpoint from being hammered
  across N accounts once Orbit multiplies the fleet. (4) Orbit import:
  `scripts/import-orbit-accounts.js` (`--dry-run`/`--runtime`/`--skip`/
  `--orbit-db`) reads Orbit's SQLite DB + keychain vault and registers
  Claude accounts into `accounts.json`. Live dry-run against the operator's
  real `~/.claudeos/claudeos.db` verified: 5 dev-fleet accounts importable
  (dev1a, dev1b, dev1c, dev2b, dev3b); daily drivers
  (`waqar@iconprosolutions.com`, `waqar@unitedtf.org`) skipped for separate
  `claude setup-token` onboarding; re-runs are idempotent (new `orbitEmail`
  field on each imported account skips already-imported ones on the next
  pass — verified). **Operator TODO: run the script WITHOUT `--dry-run` on
  the Mac when ready, then rsync the new account dirs + `accounts.json` to
  the NAS.** (5) Dashboard Overview gains a fleet headroom summary (best
  account per engine, windows free, next reset). Tests: `quota.test.js`
  grew to 52 assertions (Q7 backoff); new `headroom.test.js` at 46
  assertions (H1 scoring, H2 select(), H3 refreshQuotaBreaker, H4 Orbit
  planner); full chain now **8 suites / 758 assertions, all green**; `npm
  run check` clean. Spec:
  `docs/superpowers/specs/2026-07-11-multi-model-router-design.md` §6
  (headroom-aware dispatch) / §9 (dashboard & import tooling); plan:
  `docs/superpowers/plans/2026-07-11-router-phase-2-headroom-dispatch.md`.
- **Router Phase 1 shipped (2026-07-11): quota intelligence + reset-precise
  breakers.** (1) `packages/provider/quota.js` — per-account usage snapshots
  via free provider endpoints (claude `api/oauth/usage` w/ oauth-scope
  accounts, agy `retrieveUserQuotaSummary` w/ CLI-driven token refresh), 5-min
  poller + `pollSoon` on breaker-open, persisted to `quota-snapshots.json`,
  SSE `quota.change`, per-account `quota` in `/dashboard/status`;
  `usageSource: oauth|reactive` per account (reactive = setup-token accounts,
  never polled). (2) Breakers: quota trips on FIRST failure and cools down
  until the parsed reset instant (clamped 30s-8d; sources: error-text parse →
  15-min fallback; poll-derived resets_at feeds the dashboard only — wiring
  it into breaker correction is Phase 2). (3) Adapter detection
  fixes: claude parses both limit-error generations + catches mid-stream
  `isApiErrorMessage` limits (upstream #68816) + excludes "not your usage
  limit" server throttles via shared `isQuotaText`; agy parses "reset after
  <dur>"/"baseline refresh on <date>" grammars (floored vs the 1s-loop server
  bug), freshest-log-entry wins, quota-on-stdout guard. (4) Dashboard
  Accounts tab: per-window usage bars (percent/reset ETA/staleness/source/error).
  (5) Dockerfile now FAILS the build on agy <1.1.1 (1.0.16 swallows
  print-mode errors — NAS was blind to agy quota exhaustion; **NAS needs an
  image rebuild to pick this up**). Tests: 48-assertion quota suite +
  provider2 at 366; full chain green. Spec:
  `docs/superpowers/specs/2026-07-11-multi-model-router-design.md`; plan:
  `docs/superpowers/plans/2026-07-11-router-phase-1-quota-intel.md`. Phase 2
  next: headroom-aware dispatch + Orbit account import.
- **SaaS polish round shipped + live (2026-07-04 night).** (1) Keys are
  presented OpenRouter-style as `sk-bridge-<48hex>` (verify strips the prefix;
  bare legacy keys keep working). (2) Signed-in sessions authorize `/v1`
  directly — the Tester needs no key paste; calls attribute as `user:<name>`
  with the user's default limits. (3) **Web account onboarding**: Accounts tab
  "Add an account" panel → paste a `claude setup-token` value or agy's
  `antigravity-oauth-token` contents; files land in the volume, accounts.json
  registers + `pool.reload()` (explicit — post-boot files had no fs.watch),
  auto-probe. `account-login.sh` now stores the printed token itself (it never
  persisted!) with a `token` re-entry mode. Token logins display
  "token login · expires <date>" instead of "not signed in". (4) **Primary
  account + soft pins**: `primary: true` in accounts.json (one per engine,
  Make/Unset primary buttons) — unpinned traffic prefers it while healthy with
  a free slot; key `accountPin` gains `pinMode` `soft` (mint UI default:
  per-app assigned account that fails over when exhausted, selection-time and
  mid-dispatch) vs `hard` (fail loud; route pins stay hard). Live: `claude:main`
  (Team) is primary; `claude:personal` (1-yr token) is failover capacity.
  Perf: Dockerfile layers reordered — code-only NAS rebuilds ~2.4s (was
  minutes). 238 assertions green (P27 covers primary/soft-pin semantics).
- **SaaS user management shipped + live (2026-07-04 eve).** Real dashboard
  logins (`users.js`: scrypt passwords, 7-day sessions persisted in the
  runtime volume, login rate-limit; first boot prints the `admin` password
  once). Admins: full dashboard + **Users tab** (create/disable/delete users,
  default limits, password resets, per-user today/month usage), Usage **By
  user** dimension, admin *session* now authorizes `/admin` and the gated
  dashboard (no key paste). `user`-role logins get a profile-only view:
  self-mint one key per app (`<username>.<app>`, inherits admin-set default
  limits), revoke own keys, own usage, change password — 401 on everything
  else. Keys carry `owner`; deleting a user revokes their keys + sessions.
  Verified live on the NAS end-to-end (admin session → create `testuser` →
  user login → self-mint `testuser.myapp` (rpm 5 inherited) → USER-KEY-OK on
  /v1 → own-usage view → /admin 401). 220 assertions green (22 new in P26).
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

- **Router Phase 3 next**: codex engine (persistent app-server, spec §4),
  then Phase 4 (auto-routes/rules/per-key routing flags, spec §8), then
  Phase 5 (NAS deploy round + live smokes against real headroom data) — all
  per `docs/superpowers/specs/2026-07-11-multi-model-router-design.md`.
- Operator TODO carried from Phase 2: run
  `node scripts/import-orbit-accounts.js` WITHOUT `--dry-run` on the Mac,
  then rsync the new `accounts/claude/<name>/.credentials.json` dirs +
  updated `accounts.json` to the NAS.
- **Deployed and live** — the NAS deploy, account onboarding, and Hermes cutover
  all completed 2026-07-04 (see Current Status). Remaining: decide PR/merge of
  `feat/dashboard-overhaul` into main.
- Watch item: the claude account on the NAS shares the Mac's OAuth
  refresh token (keychain copy). If Anthropic rotates it on refresh, one side
  may need a re-login; the durable alternative is `claude setup-token`
  in-container (`scripts/account-login.sh claude main`, needs the operator).
- Later (out of scope per spec): real image handoff, deleting the legacy
  provider-bridge once nothing depends on it.
