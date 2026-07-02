# Bridge Server Edition — Design Spec

**Date:** 2026-07-02
**Status:** Approved pending user review
**Scope:** Turn ai-cli-bridge into a team-deployable server on the Ugreen NAS (x86_64, Debian 12, Docker 26.1) with multiple Claude/Gemini accounts, named API keys, and closures for the remaining capability gaps (session continuity, overflow policy, tool-call hardening).

## 1. Goals and non-goals

**Goals**
- Deploy the existing consolidated provider on the NAS via Docker, LAN-only, as an internal team product.
- Support N Claude accounts and N Gemini accounts per bridge: pooled rotation with automatic failover on quota, plus optional pinning of a route or API key to a specific account.
- Replace the single API key with named keys (one per app/teammate) attributed in the usage ledger.
- Close fillable gaps: flat prompt size on long conversations (session continuity), explicit oversized-prompt policy, higher tool-call parse reliability.
- Local single-account mode on the Mac keeps working with zero config changes.

**Non-goals**
- Public/multi-tenant SaaS, billing, sign-up. Internal team only (ToS: accounts serve the owner's team; no resale).
- Internet exposure. If ever needed, a NAS reverse proxy with HTTPS sits in front; the bridge itself stays LAN-only.
- Real token usage on Gemini routes, images, embeddings, sampling params — the CLIs don't expose them (documented, honestly labeled).

**Architecture decision:** same codebase, server profile. No fork. The provider gains an account pool, named keys, an Accounts dashboard tab, and gap mitigations; `deploy/` adds Docker packaging. Every feature works identically on the Mac and the NAS.

## 2. Account pool

### 2.1 Registry — `accounts.json`

Lives in the runtime dir beside `routes.json`, hot-reloadable the same way (watch + validate + atomic swap), overridable via `BRIDGE_ACCOUNTS_FILE` for tests.

```json
{
  "claude": [
    { "name": "work",     "dir": "accounts/claude/work",     "enabled": true },
    { "name": "personal", "dir": "accounts/claude/personal", "enabled": true }
  ],
  "gemini": [
    { "name": "main",     "dir": "accounts/gemini/main",     "enabled": true }
  ]
}
```

- `dir` is resolved relative to the runtime dir; absolute paths allowed.
- **No `accounts.json` (or empty engine list) → implicit `default` account** that spawns the CLI with today's environment untouched. This is the backward-compat path: the Mac keeps working with zero config.
- Validation rejects duplicate names per engine and missing/unwritable dirs (a missing dir is created; an unreadable one marks the account `needs-login`).

### 2.2 Pointing a CLI at an account

- **claude:** spawn env gains `CLAUDE_CONFIG_DIR=<abs dir>`. *(Spike A0: verify `claude -p` honors it end-to-end before building on it.)*
- **agy:** spawn env gains `HOME=<abs dir>` (agy stores state in `~/.antigravity`). *(Spike A0: verify agy honors `HOME`; if not, find its config-dir mechanism before proceeding.)*
- The implicit `default` account sets neither variable.

### 2.3 Per-account health and rotation

- The circuit breaker map re-keys from `engine` to `engine:accountName`. Thresholds/cooldowns unchanged (quota×2 → 15 min, timeout×3 → 2 min, half-open single trial).
- The per-engine semaphore becomes per-account: one in-flight CLI per account, so two Claude accounts = two parallel Claude lanes. Queue depth (`PROVIDER_QUEUE_DEPTH`) applies per account.
- **Selection:** round-robin over accounts that are `enabled`, not `needs-login`, and whose breaker is closed/half-open. A cursor per engine advances on each pick.
- **Failover:** on a quota (or spawn-fail) error, open that account's breaker and retry the same request **once** on the next healthy account — transparently for non-streaming, and for streaming only if no bytes have been written to the client. If no healthy account remains: today's 429 with `Retry-After` = soonest breaker reopening across the pool.
- **needs-login:** stderr classification (claude: "Please run /login", invalid API key/OAuth messages; agy: auth/login-required patterns) marks the account `needs-login` and removes it from rotation. It returns only after a successful manual probe from the dashboard (or process restart).

### 2.4 Pinning

- A route may declare `"account": "work"`; an API key may declare `"accountPin": {"claude": "work"}`.
- Precedence: **key pin → route pin → pool rotation.**
- A pinned request never fails over to another account: if the pinned account is cooling down or needs login, respond 429/503 with the reason. Silent unpinning is worse than a loud error.

## 3. Named API keys

### 3.1 `credentials.json` v2

```json
{
  "version": 2,
  "keys": [
    { "key": "<48 hex>", "name": "admin",  "role": "admin", "createdAt": "2026-07-02T00:00:00Z" },
    { "key": "<48 hex>", "name": "hermes", "role": "app",   "createdAt": "...", "accountPin": { "gemini": "main" } }
  ]
}
```

- **Migration:** on boot, a v1 file (`{"apiKey": "..."}`) is rewritten in place to v2 with that key as `admin`/`role: admin`. Existing consumers (Hermes) keep working because the key value is preserved. File stays 0600.
- `role: admin` — full access including `/admin/*` and dashboard mutations. `role: app` — `/v1/*` only.
- Admin endpoints: `POST /admin/keys` (mint; server generates the secret, returns it once), `DELETE /admin/keys/:name`, `GET /admin/keys` (names/roles/pins only — never secret values). Renaming = revoke + mint.
- The usage ledger records `keyName` and `account` on every entry (both already flow through the request context). Existing entries without these fields render as `legacy`.

### 3.2 Stability note

Named keys persist across restarts (they already do — the regeneration that broke Hermes today happens only when `credentials.json` is absent). The guide gains a line making this explicit.

## 4. Session continuity (gap fill #1 — defeats the 200KB cap sideways)

Every OpenAI-style request resends full history; every CLI call today is a fresh spawn that re-ingests it. Both CLIs can resume conversations natively (`claude --resume <session_id>`, agy `--continue`/`--conversation <id>`). The bridge exploits this with strict prefix matching:

### 4.1 Mechanism

- After each successful completion the bridge stores, **per (route, account)**: `prefixHash = sha256(normalized(messages + assistantReply))`, plus the engine's conversation handle (claude: `session_id` from the final `result` line — already captured; agy: see 4.2).
- On a new request, compute `sha256(normalized(messages[0..n-2]))` (everything except the trailing new message(s)). If it equals a stored `prefixHash` **and** that account is currently selectable → spawn with the resume flag and send **only the trailing new message(s)** (rendered through the existing `messagesToPrompt`, so tool results/system additions format identically).
- Any mismatch — edited history, different system prompt, unavailable account — falls back silently to today's full-prompt spawn. Continuity is an accelerator, never a correctness dependency.
- Normalization: JSON-stable stringify of `[route.id, messages]` with content arrays flattened by `formatContent`. Tool-call objects included verbatim.
- Store: in-memory Map, LRU-capped (default 200 entries), TTL 24 h, evicted on `accounts.json`/`routes.json` reload for the affected engine. Not persisted to disk (a restart just means one full-prompt call per conversation). Env: `BRIDGE_SESSIONS=0` disables the feature entirely.
- **Account affinity:** a conversation resumes only on the account that owns it. If that account is busy/cooling, the request falls back to full-prompt on another account rather than waiting.

### 4.2 agy conversation handle *(Spike E0)*

agy `--print` may not emit a conversation ID. Fallback design that works within our constraints: per-account in-flight is 1 (semaphore), so "most recent conversation" on an account is deterministic — track the last prefixHash per account and resume with `--continue` only when the new request extends exactly that hash. If the spike finds `--conversation <id>` discoverable (log file / output), prefer explicit IDs. If neither is reliable, agy continuity ships disabled (claude-only) and the spec's overflow policy (§5) remains the Gemini answer.

### 4.3 Effects

- Prompt size per call stays flat regardless of conversation length → long Hermes sessions stop marching toward the agy 200KB cap.
- Claude repeat calls hit warm cache in-session, cutting the ~15k harness overhead's effective cost.
- Usage accounting: tokens are recorded as reported (claude) / estimated on the delta (agy), with `usageSource: "resumed"` marking continuity calls so the ledger stays interpretable.

## 5. Oversized-prompt policy (gap fill #2)

- Default: **loud failure.** A prompt exceeding the engine's cap (agy 200KB) returns 400 `invalid_request` with a message naming the cap, the actual size, and the two remedies (Claude route / session continuity).
- Opt-in failover: a route may declare `"overflowFallback": "<routeId>"` (validated to exist and to target a different engine or larger-cap route). When triggered, the response carries `"bridge_rerouted": {"from": "...", "to": "...", "reason": "prompt_overflow"}` so the caller always knows. No env-level global fallback — explicit per route only.

## 6. Tool-call hardening (gap fill #3)

- **Corrective retry on malformed tool JSON:** when tools are provided and the reply *attempts* a tool call but fails to parse (heuristic: contains `"tool_calls"` or a fenced `json` block that doesn't parse/validate), retry once appending the parse error and the required schema — the same pattern as the existing `response_format` and `tool_choice` retries. Non-streaming, and streaming pre-first-byte (the existing hold-back buffer already delays tool-looking output).
- **Few-shot example** added to the tool system prompt in `messagesToPrompt` — one complete, correctly-escaped `tool_calls` example (the `arguments`-as-string escaping is the observed failure mode).
- Retries counted in telemetry (`toolRetry` counter) so effectiveness is measurable in the dashboard.

## 7. Dashboard changes

- **Accounts tab (new):** one card per account — engine, name, state (ok / cooling-down with countdown / needs-login / disabled), tokens + ledger value this month, live in-flight indicator, enable/disable toggle, "Probe" button (runs the engine health check under that account), and the exact one-time login command when `needs-login`.
- **Connect tab:** key management for admins — list (names/roles/pins, never secrets), mint (secret shown once), revoke. App-key holders see only their own connection snippet.
- **Usage tab:** account column/filter added alongside the existing per-app view.
- All via existing admin endpoints + SSE events (`account_state`, `keys_changed`).

## 8. Docker packaging and NAS deploy

### 8.1 `deploy/Dockerfile`

`node:22-bookworm-slim` + `curl git ca-certificates`; `npm i -g @anthropic-ai/claude-code`; agy installed via its Linux installer *(Spike D0: confirm agy ships a linux-amd64 build and its install path; if not, Gemini routes ship disabled on NAS and the spec notes it)*. Non-root `bridge` user; app copied in; `EXPOSE 9011`; `HEALTHCHECK` curling `/dashboard/status`.

### 8.2 `deploy/docker-compose.yml`

- Port `9011:9011`, `restart: unless-stopped`, `BIND_HOST=0.0.0.0` (container-internal; the NAS firewall/LAN is the boundary).
- Volumes: `./data/runtime → /app/.bridge-runtime` (ledger, credentials, routes, accounts.json) and `./data/accounts → /app/accounts` (credential dirs).

### 8.3 Account onboarding (one-time per account)

`scripts/account-login.sh <engine> <name>`: creates the account dir, then `docker exec -it` with the account's env — claude: `claude setup-token` (long-lived token designed for headless); agy: its login flow *(Spike D0: if agy login requires a local browser, the documented fallback is: log in on the Mac under a scratch `HOME`, then `rsync` that credential dir into the NAS volume — verified as part of the deploy)*. Tokens self-refresh afterwards inside the volume.

### 8.4 Deploy procedure — `docs/DEPLOY-NAS.md`

Exact commands for this NAS (`waqar@192.168.1.10`): rsync/clone the repo, `docker compose -f deploy/docker-compose.yml up -d --build`, onboard accounts, verify `/dashboard/status`, point Hermes at `http://192.168.1.10:9011/v1`. Includes backup note (the two `./data` dirs are the whole state) and upgrade procedure (`git pull && docker compose up -d --build`).

## 9. Error handling summary

| Situation | Behavior |
|---|---|
| Account hits quota | Breaker opens for that account; request retries once on next healthy account (pre-first-byte only for streams) |
| All accounts cooling | 429 + `Retry-After` = soonest reopening |
| Pinned account unavailable | 429/503 with reason; never unpins silently |
| Account logged out | Marked `needs-login`, out of rotation, dashboard shows login command |
| Prompt over engine cap | 400 with remedies, or declared `overflowFallback` with `bridge_rerouted` marker |
| Resume prefix mismatch | Silent fallback to full-prompt spawn |
| Malformed tool JSON | One corrective retry, then existing behavior (text passthrough) |

## 10. Testing

All new logic is covered by the existing zero-dependency harness (fake CLI + `bootProvider` with env-isolated runtime):

- **Accounts:** spawned env carries `CLAUDE_CONFIG_DIR`/`HOME` per account (FAKE_CLI_LOG records env); rotation advances round-robin; quota on A fails over to B once; all-exhausted → 429 with soonest Retry-After; pin precedence (key > route > pool); pinned+cooling → no failover; needs-login exclusion; no accounts.json → default account with untouched env.
- **Keys:** v1→v2 migration preserves the key; app key rejected on `/admin/*`; mint/revoke round-trip; ledger rows carry keyName+account.
- **Continuity:** second request extending the first resumes (resume flag in argv, prompt = delta only); edited history falls back to full prompt; `BRIDGE_SESSIONS=0` disables; resumed usage marked.
- **Overflow:** oversized prompt → 400 naming cap; with `overflowFallback` → rerouted + `bridge_rerouted` in response.
- **Tool hardening:** malformed-then-valid scripted CLI (existing `FAKE_CLI_STATE_FILE` mechanism) → one retry, valid `tool_calls` out; telemetry counter increments.
- **Docker:** build + boot smoke runs on the NAS as part of the deploy phase (Mac may lack Docker); `/dashboard/status` + one `/v1` round-trip as acceptance.

## 11. Build order

- **Phase A — account pool core.** Spike A0 (`CLAUDE_CONFIG_DIR`, agy `HOME`), registry + resolver, per-account breaker/semaphore, rotation/failover, pinning. *Largest phase; everything else leans on it.*
- **Phase B — named API keys.** v2 credentials, migration, admin endpoints, ledger attribution.
- **Phase C — dashboard.** Accounts tab, Connect key management, Usage account dimension.
- **Phase D — Docker + NAS deploy.** Spike D0 (agy on linux-amd64 + headless auth), image, compose, onboarding script, DEPLOY-NAS.md, live deploy to 192.168.1.10, Hermes pointed at the NAS.
- **Phase E — gap mitigations.** Spike E0 (agy conversation handle), session continuity, overflow policy, tool-call hardening. *Independent of D; can land before or after.*

Each phase ends green (existing 336 assertions + new) and committed; the branch stays unpushed until explicit approval.
