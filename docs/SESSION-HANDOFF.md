# AI CLI Bridge — Session Handoff (2026-07-04)

A working-state snapshot so any future session can pick up cold. Companion docs:
`STATE.md` (authoritative status), `DEPLOY-NAS.md` (deploy runbook),
`HOW-IT-WORKS.md` (architecture), `guide.html` (end-user guide, in the dashboard).

## What this project is

A self-hosted, OpenRouter-style gateway that exposes an **OpenAI-compatible API
(`/v1/chat/completions`)** backed by **CLI subscriptions** — Claude Code
(`claude`) and Google Antigravity (`agy`/gemini) — instead of metered API keys.
Traffic rides flat-rate subscriptions; the "$" figures in the app are
*API-equivalent value* (what it would have cost on metered APIs), not real bills.

It is now a **multi-user product**: dashboard logins, admin-managed users,
per-user `sk-bridge-…` API keys with rate/token/spend limits, multi-account
credential pools with failover, and a control-center dashboard.

## Live deployment (as of this handoff)

- **Runs in Docker on the Ugreen NAS**: container `ai-cli-bridge`,
  `http://192.168.1.10:9011` (LAN). Healthy.
- **Repo copy on NAS**: `/home/waqar/ai-cli-bridge`. Durable state in
  `/home/waqar/ai-cli-bridge/data/runtime/` (compose mounts `../data/runtime`).
- **Planned public URL**: `bridge.iconprosolutions.com` via Cloudflare tunnel.
  Tunnel origin MUST be **Type: HTTP** → `192.168.1.10:9011` (the bridge speaks
  plain HTTP; TLS terminates at Cloudflare's edge). `DASHBOARD_AUTH=1` is set so
  nothing is exposed unauthenticated.
- **Dashboard**: `/dashboard/` (login required). **Guide**: `/dashboard/guide.html`.
- **Admin login**: user `admin`; first-boot password is in the container log
  (`docker logs ai-cli-bridge | grep 'dashboard login'`). The operator has
  likely changed it. Demo user `testuser` / `testpass99` exists — delete before
  going fully public.
- **Accounts in the pool**: `claude:main` (Team, info@silentresponder.org, ★primary),
  `claude:personal` (subscription token login), `gemini:main` (waqarsolo1@gmail.com).
- **Hermes** (`~/.hermes/config.yaml` + `.env` on the Mac) points at the NAS
  with an app-role key named `hermes`.

## Branch / git

- Branch: `feat/dashboard-overhaul` (NOT merged to `main`; ~90 commits ahead).
- Working tree clean, everything pushed to origin.
- Tests: `npm test` → **247 assertions green** (suites in `tests/`, notably
  `provider2.test.js` groups P18–P27; fake-CLI fixtures, no real quota).
- Deploy loop (fast — code-only rebuild ~2.4s thanks to Dockerfile layer order):
  ```
  # push changed files to NAS (rsync remaps ~, so pipe individual files):
  ssh waqar@192.168.1.10 "cat > /home/waqar/ai-cli-bridge/<path>" < <path>
  ssh waqar@192.168.1.10 'cd /home/waqar/ai-cli-bridge && docker compose -f deploy/docker-compose.yml up -d --build'
  ```

## Architecture / key files (all under `packages/provider/` unless noted)

- `server.js` — Express app: `/v1/*`, `/auth/*`, `/me/*`, `/dashboard/*`, mounts
  `/admin`. Auth middleware, CSRF guard, security headers, session cookies,
  limit enforcement, dispatch + failover live here.
- `keys.js` — named API keys (`credentials.json` v2): mint/verify/revoke,
  `sk-bridge-` prefix (verify strips it), per-key `limits`, `accountPin` +
  `pinMode` (hard/soft), `owner`, `setLimits`/`setAccountPin`.
- `users.js` — dashboard users + sessions (`users.json`/`sessions.json`): scrypt
  passwords, roles admin/user, `defaultLimits`, disable, 7-day sessions,
  login rate-limit, `bootstrap()` prints admin password once.
- `limits.js` — per-key guard: sliding rpm window, calendar-day tokens,
  calendar-month $; seeded from the ledger at boot so restarts keep budgets.
- `accounts.js` — credential pool: per-account breaker+semaphore, round-robin,
  `primary` preference, `select({pin, pinMode, exclude})`, hot-reload + `reload()`.
- `usage.js` — durable JSONL ledger; `aggregate(range, {ownerOf, keyFilter})`
  with perApp/perKey/perAccount/perUser/perDay; `costOf()`.
- `admin.js` — `/admin/*`: keys, users CRUD, accounts (add/rename/primary/
  enable/disable/probe), guided claude OAuth (`/oauth/claude/start|finish`).
- `adapters/claude.js`, `adapters/agy.js`, `adapters/identity.js` — engine
  adapters + signed-in-identity readers.
- `dashboard/{index.html,app.js,styles.css,guide.html}` — no-build control center.
- `routes.json`, `pricing.json` — route catalogue + list prices (baked in image).

## What was built this session (newest first)

- Guide rewritten for the live multi-user app.
- Account **email capture** on OAuth login + account **rename** (repoints pins).
- **Security hardening**: Secure cookies behind proxy, security headers
  (nosniff/frame-deny/referrer/HSTS), Origin-based **CSRF guard** on cookie
  mutations.
- Token-login identity shows "Subscription" (not "External").
- **Guided claude browser login** (OAuth PKCE) from the dashboard.
- **Primary account** + **soft pins** (per-app account assignment w/ failover).
- **Web account onboarding** (paste token / oauth-token file, no terminal).
- **Session-authorized Tester** (no key paste when signed in).
- **`sk-bridge-` API keys** + session-aware key manager.
- **Dashboard logins + user management + per-user keys/usage**.
- **Per-key limits** (rpm/tokens-day/$-month) + **dashboard auth** for exposure.
- Dockerfile layer-cache perf; `/healthz` for the healthcheck.

## OPEN ITEMS / NEXT STEPS

1. **Security audit — INCOMPLETE.** A background auditor agent was launched but
   stalled (no findings returned). **Re-run a thorough security review** for
   internet exposure (small trusted team threat model) covering: session/CSRF
   (partly done — verify), secret handling (API keys + OAuth tokens are stored
   plaintext at 0600; consider hashing keys at rest), CLI-arg injection into
   claude/agy, rate limiting (login is per-username only — add global/IP + API
   throttle), force bootstrap-admin password change on first login, request-size
   limits, error/log info disclosure. Then implement the fixes.
2. **Capability roadmap** (from a completed reviewer; dollars are fiction so
   quota/token failure is the real risk). Ranked value-for-effort:
   - (1) **Alerting** on breaker-open / needs-login / health-fail via webhook
     (Slack/Discord/ntfy) — new `notify.js` subscribed to the existing `events`
     bus; the pool `onChange` already emits these signals. **Highest value.**
   - (2) **Cross-model failover** (claude exhausted → gemini) — extend the
     `overflowFallback` pattern in `routes.js` + `invokeWithFailover` in server.js.
   - (3) **API key expiry/rotation** — add `expiresAt` to key records + verify check.
   - (4) **Usage CSV export** + **budget *warnings*** at ~80% before the hard 429.
   - Rejected as bloat for this team: embeddings (needs a paid key — breaks the
     premise), Prometheus, per-model ACLs, audit log, auto-routing.
3. **Gemini second-account** onboarding is manual (Google login can't be relayed);
   claude has the guided flow. Document/accept this.
4. **Merge decision**: `feat/dashboard-overhaul` → `main` (large branch).
5. **Before public tunnel**: delete `testuser`, confirm admin password changed,
   double-check tunnel is Type: HTTP.

## Gotchas discovered

- NAS rsync/SFTP remaps `~` and `/home/waqar/...` into `/home/waqar/waqar/` —
  pipe individual files via `ssh 'cat > …'` instead of rsync.
- `data/runtime` is owned by uid 10001 (container user); write into it via
  `docker exec -i -u root ai-cli-bridge sh -c 'cat > …'` then chown 10001.
- `claude setup-token` PRINTS a 1-year token but persists nothing — must be
  captured and written to the account's `.credentials.json` (handled in
  `account-login.sh` and the web onboarding path).
- agy headless auth needs `.gemini/antigravity-cli/antigravity-oauth-token`
  (NOT `oauth_creds.json`). agy hangs on its first run in a fresh HOME; a second
  run is clean — warm new gemini accounts with a dashboard Probe.
- The `claude` CLI (≥2.1.201) rejects unknown `--disallowedTools` names; the
  adapter self-heals by pruning + retrying.
