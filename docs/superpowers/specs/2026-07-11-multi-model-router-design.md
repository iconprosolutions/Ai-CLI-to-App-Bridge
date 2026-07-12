# Multi-Model Router (bridge v3) — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorm 2026-07-10/11)
**Goal owner:** operator (waqar)

## 1. Goal

Make the bridge behave like a hosted API ("personal OpenRouter") backed by
subscription CLIs. The operator's framing: the current app is ~70-80% of the
way to "API model" behavior; close the gap to ~95%. Concretely:

- A caller holding a bridge key never sees a surprise 429 while **any**
  account in the fleet has capacity for an equivalent model.
- Account flips and model downgrades happen silently *before* failures, driven
  by real per-window quota knowledge, not blind cooldowns.
- The dashboard shows live per-account, per-window utilization (Orbit-style)
  and every routing decision is auditable.
- Codex (ChatGPT-subscription) joins claude and gemini/agy as a first-class
  engine, with multi-account rotation the system verifies itself.

Non-goals (v1): vision/image handoff, embeddings, LLM-based task
classification, deleting legacy bridges.

## 2. Account inventory & credential policy

Target: 2+ accounts per provider, treated as true pools.

| Provider | Source | Policy |
|---|---|---|
| claude dev fleet, vaulted (dev1a, dev1b, dev1c, dev2b, dev3b @silentresponder.org) | Orbit OS vault (`~/.claudeos/claudeos.db` settings `vaultIdentity:*` + keychain service "Claude OS Login Vault") | **Bridge-owned OAuth**: credential blob written to the account dir as `.credentials.json`; bridge is the only refresher → no rotation clashes; full usage polling |
| claude daily drivers, vaulted (waqar@iconprosolutions.com, waqar@unitedtf.org) | operator's Mac (active interactive use) | **setup-token** (`claude setup-token`, ~1-year static `sk-ant-oat01-…`): no rotation clash with the Mac; usage intel reactive-only |
| claude tracked-only (dev3, dev3c @silentresponder.org, dev1@/info@iconprosolutions.org) | Orbit knows them, no vaulted credential | onboard on demand: log in once while Orbit's daemon runs (vaults it) or use the bridge's existing web onboarding panel; then treat as dev fleet |
| codex | `~/.codex/auth.json` per account (log in on Mac, copy — officially supported) | Bridge-owned; `CODEX_HOME=<dir>` per account; app-server push gives usage |
| gemini/agy | existing `antigravity-oauth-token` copy flow | Bridge-owned; Google refresh tokens don't rotate → copies stay valid |

Anthropic refresh tokens are single-use and rotate on refresh: a credential
living in two places logs one side out (`invalid_grant`). Hence the split
policy. `accounts.json` records the resulting capability per account as
`usageSource: "oauth" | "reactive"` — auto-detected at onboarding by calling
the usage endpoint once (403/scope error ⇒ reactive).

## 3. Architecture

Evolve `packages/provider` in place. New/changed modules:

```
packages/adapters/codex.js        NEW  persistent app-server adapter
packages/provider/quota.js        NEW  per-account usage snapshots (3 providers)
packages/provider/accounts.js     CHG  headroom-aware selection
packages/provider/breaker.js      CHG  cooldownUntil + quotaThreshold 1
packages/adapters/claude.js       CHG  limit-detection fixes + reset parsing
packages/adapters/agy.js          CHG  reset parsing + floor for reset-loop bug
packages/provider/routes.js(.json) CHG  codex engine, auto routes, rules[]
packages/provider/keys.js         CHG  per-key routing flags
packages/provider/telemetry.js    CHG  TTFB EMA per engine:account
packages/provider/dashboard/*     CHG  Accounts tab usage bars, Connect flags,
                                       Requests "why" annotation
scripts/import-orbit-accounts.*   NEW  onboard Orbit-vaulted claude accounts
deploy/Dockerfile                 CHG  agy ≥1.1.1, codex CLI (musl binary)
```

Request flow: key auth (routing flags) → route resolve (auto alias? rules?) →
account select (pins → headroom score → breaker gate) → adapter dispatch →
feedback (ledger, breaker, passive quota snapshot) → SSE.

## 4. Codex engine (persistent app-server)

One long-lived `codex app-server` child **per account**, JSON-RPC over stdio.

- **Spawn**: lazy on first request for the account; env `CODEX_HOME=<account
  dir>`; args harden to read-only sandbox + never-approve; system instruction
  tells the model to answer directly and never run commands/tools. Handshake:
  `initialize` (`capabilities.experimentalApi: true`) → `initialized` → ~500ms
  settle (known quirk: immediate requests can return empty).
- **Request**: `thread/start` + `turn/start` (model + `model_reasoning_effort`
  from the route). Stream `item/agentMessage/delta` notifications → SSE deltas
  (true token-by-token streaming). `turn.completed.usage` → ledger tokens
  (`input_tokens`, `cached_input_tokens`, `output_tokens`).
- **Quota intel free**: subscribe to `account/rateLimits/updated` push;
  `account/rateLimits/read` once at spawn. Shape: `primary` (5h window) /
  `secondary` (weekly), `usedPercent` int, `resetsAt` unix seconds, plus
  `planType` and `rateLimitReachedType`.
- **Auth**: `getAuthStatus` at spawn; 401/login-required events → account
  `needsLogin` (existing pool semantics).
- **Lifecycle**: crash → restart with exponential backoff (cap ~2 min);
  repeated crashes feed the breaker as timeout-kind failures; account disable
  kills the child; graceful shutdown via the core child registry.
- **Failure grammar** (from `turn.failed`/`error` message strings — exec/app-server
  share it): prefix `You've hit your usage limit` ⇒ quota, parse reset from
  `try again at <TIME>.` (machine-local time, `1:28 PM` same-day or
  `Apr 19th, 2026 2:19 AM`); `Selected model is at capacity` ⇒ retry/failover
  **without** penalizing the account; credit/spend-cap variants (no reset
  time) ⇒ quota with fallback cooldown.
- **Risk**: app-server RPC is experimental. Mitigations: pin the codex CLI
  version in Docker; adapter contract-tested against a fake RPC server; if the
  surface breaks hard, fallback design is exec-per-request (`codex exec
  --json`) — documented, not built.
- **Models** (routes.json + pricing.json): `gpt-5.6-sol` (low→ultra efforts),
  `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`.
  Codex meters are account-wide, not per-model — heavier models just drain
  faster.

`routes.js` `VALID_ENGINES` gains `codex`; same-engine fallback rules keep
applying (quota/overflow fallbacks must still cross engines).

## 5. Quota intelligence (`quota.js`)

Normalized per-window shape (ported from Orbit `accounts.ts`):

```js
// one per window, per account
{ kind:  'session' | 'weekly_all' | 'weekly_scoped' | ...,
  group: 'session' | 'weekly',
  label: 'Session (5h)' | 'Weekly' | '<Model> weekly' | ...,
  percent: 0..100,            // utilization; 0 once resetsAt passes ("fresh")
  resetsAt: epochMs | 0,
  fresh: boolean }            // stored reset time has passed
```

Sources:

- **claude (usageSource oauth)**: `GET https://api.anthropic.com/api/oauth/usage`,
  headers `Authorization: Bearer <accessToken from <dir>/.credentials.json>`,
  `anthropic-beta: oauth-2025-04-20`, and a real `User-Agent:
  claude-code/<ver>` (required — anonymous UAs land in an aggressively
  throttled bucket). Parse with Orbit's `parseLimits`: prefers the new
  `limits[]` array (kind/group/percent/severity/resets_at, model-scoped
  entries carry `scope.model.display_name`), falls back to legacy
  `five_hour`/`seven_day` objects. A GET here never refreshes/rotates tokens.
- **gemini/agy**: `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
  with `Bearer <access_token from antigravity-oauth-token>`. Buckets arrive per
  model *family* ("Gemini Models", "Claude and GPT models"), each with weekly +
  five-hour entries: `remaining.remainingFraction` (0..1 → percent = (1−f)·100),
  `resetTime` (ISO-8601, epoch-seconds fallback). Access token self-refresh:
  when `token.expiry` is within ~5 min, POST `https://oauth2.googleapis.com/token`
  `grant_type=refresh_token` with the Antigravity public client id/secret and
  rewrite the token file (Google does not rotate refresh tokens for this
  client; file write must stay atomic — one writer per account dir).
- **codex**: push (`account/rateLimits/updated`) + read-at-spawn from §4. No
  separate poller process.

Mechanics: poll every 5 min (config `QUOTA_POLL_MINUTES`) with jitter;
immediate re-poll after any quota-classified failure; per-account backoff on
poller 429s. Poller failure **never** blocks dispatch — the account degrades
to `reactive` behavior until polls succeed again. Snapshots persist to
`.bridge-runtime/quota-snapshots.json` (atomic write) so restarts keep reset
knowledge; `fresh` recomputed on read. SSE event `quota.change` on every
snapshot delta.

## 6. Headroom-aware dispatch (accounts.js)

`select(engine, {pin, pinMode, exclude, model})` changes only in the unpinned
ordering (pins/primary/needs-login/breaker semantics unchanged):

1. **Score** each eligible account: bottleneck utilization =
   `max(weekly windows)` then session as secondary sort key. Requests for a
   model with a scoped weekly window (e.g. Opus) take that window into the
   max. Unknown/stale (> 3× poll interval) snapshots score a neutral 50 so
   they neither hog nor starve.
2. **Drain threshold**: accounts with session ≥ 90% or any weekly ≥ 95%
   (config) are skipped — unless *all* eligible accounts exceed it, in which
   case least-utilized still serves. Capacity is never refused while it
   exists.
3. Lowest score wins; the round-robin cursor breaks ties.
4. Breaker gate per account still applies (now reset-precise, §7).
5. Engine exhausted → existing cross-engine `quotaFallback` unchanged.

Primary preference persists but is also gated by the drain threshold (a
drained primary spills to the pool even while "healthy").

## 7. Reset-precise breakers + detection fixes

`breaker.js`:

- `recordFailure(kind, {until})` — quota failures may carry an explicit
  `cooldownUntil` (epoch ms); `allow()` honors it over the fixed cooldown.
- `quotaThreshold` drops to **1** (a parsed limit error is definitive).
- Fallback stays 15 min when no reset signal parses.
- When a quota breaker opens on a pollable account, schedule one usage poll at
  `resetsAt` to confirm before fully closing (cheap, read-only).

Adapter detection fixes (each with the reset-time source order:
fresh usage poll → parsed error text → 15-min fallback):

- **claude.js**: also classify stream-json `assistant` events carrying
  `isApiErrorMessage: true && error: "rate_limit"` (today these can look like
  clean completions — upstream issue #68816; the text carries "You've hit your
  session|weekly|Opus limit · resets <time>"). Parse both error generations:
  legacy `Claude AI usage limit reached|<epoch>` and current `resets <local
  time>` wording. Explicitly exclude `system/api_retry` events and "Server is
  temporarily limiting requests (not your usage limit)" from quota
  classification (server throttle ≠ quota).
- **agy.js**: parse `Your quota will reset after <GoDuration>` (e.g.
  `146h52m11s`) and `baseline quota will refresh on <M/D/YYYY, h:mm:ss AM/PM>`
  (weekly). Floor sub-30s resets and escalate backoff on repeats (known
  server-side "resets after 1s/2s" loop bug). **Prereq: agy ≥ 1.1.1 in the
  Docker image** — 1.0.16 swallows server errors in print mode (exit 0, empty
  output), so the NAS currently cannot see agy quota errors at all.
- **codex.js**: per §4 grammar; capacity errors don't penalize.

## 8. Auto-routing, rules, per-key flags

- **Auto aliases**: routes.json gains virtual routes `auto`, `auto-fast`,
  `auto-deep`, `auto-long`, each an ordered `candidates: [routeId, …]` list.
  Deterministic v1 classification for bare `auto`: prompt token estimate,
  `tools` present, requested `max_tokens` → pick the cheapest candidate tier
  that fits the context window; dispatch failure escalates to the next
  candidate (bounded, marked `bridge_rerouted` like today's fallbacks).
  Migration note: `auto-fast` and `auto-long-context` already exist as
  aliases on concrete routes — the validator forbids duplicate names, so
  those aliases move off the concrete routes onto the new virtual ones
  (existing callers keep working, now with candidate escalation).
- **Rules engine**: routes.json `rules: [{match: {key?, app?, model?,
  timeRange?}, action: {preferEngine?, preferAccount?, denyModels?,
  usdCeilingPerDay?}}]` — first-match-wins, validated like routes, editable
  from the dashboard Routes tab. Covers "reserve Opus for app X",
  "agy-first during work hours", per-app budget caps.
- **Per-key routing flags** (per-connection capability marks): key records
  gain `routing: {headroom: true, auto: true, rules: true, latency: true}`.
  Connect tab shows them as checkboxes on mint + edit. A disabled flag opts
  that connection out of the corresponding behavior (e.g. an app that must
  always hit its exact pinned account/model).
- **Latency tiebreak**: telemetry keeps a time-to-first-byte EMA per
  `engine:account`; among candidates equal on tier and headroom, fastest
  wins. Never overrides headroom or rules.

## 9. Dashboard & import tooling

- **Accounts tab**: per-account cards gain live usage bars per window
  (percent, reset countdown, staleness minutes, source badge
  polled/push/reactive), fed by `quota.change` SSE.
- **Overview**: fleet headroom summary per engine (best account, % windows
  free, next reset).
- **Requests tab**: each record gains a routing annotation — why this
  route/account (pin, rule id, headroom score, fallback hop).
- **Import script** (`scripts/import-orbit-accounts`): enumerates Orbit's
  vault (SQLite `settings.vaultIdentity:*` + keychain "Claude OS Login
  Vault"), writes each blob to `data/runtime/accounts/claude/<name>/.credentials.json`,
  registers the account in accounts.json (`usageSource` auto-detect), probes
  it. Daily-driver accounts instead get a guided `claude setup-token` paste
  (existing web onboarding panel). Codex: copy each account's `auth.json`
  into its dir; agy: existing flow. Runs on the Mac (keychain access);
  transfers to the NAS ride the existing rsync/volume path.

## 10. Error handling

- Poller/app-server failures degrade single accounts, never the engine.
- Quota snapshots are advisory: dispatch always has the reactive path.
- Malformed provider payloads (schema drift on undocumented endpoints) are
  caught per-account, logged once per change, and mark the account
  `reactive` — no crash, no retry storm.
- Rules/routes validation extends the existing throw-at-boot /
  keep-last-good-on-reload contract.
- Secrets: credential blobs only ever land in account dirs (0600) — never in
  the ledger, snapshots file, logs, or SSE payloads.

## 11. Testing & verification (minimal-live)

- **Fake-CLI/fake-RPC suites** (extend existing patterns): codex adapter
  against a scripted app-server stub (handshake, deltas, turn.failed
  grammars, crash/restart); quota parsers against fixture payloads captured
  in research (all three providers, both claude payload generations);
  headroom selector (scores, drain threshold, neutral prior, tiebreak);
  breaker `cooldownUntil`; auto-alias classification + escalation; rules
  precedence; per-key flag enforcement.
- **Live (piggyback, no deliberate exhaustion)**: one tiny smoke per
  provider per new account; when an operator-drained account nears its limit
  (already happening in the operator's terminal), observe the bridge flip
  accounts on its own, then force-pin the drained account to confirm the
  precise cooldown message. Requests-tab annotations are the evidence trail.

## 12. Phasing

1. **Quota intel + precise breakers + detection fixes + Accounts tab bars**
   — biggest utilization win, no new engine risk (includes agy ≥1.1.1).
2. **Headroom dispatch + Orbit account import** — the fleet goes live.
3. **Codex engine** — app-server adapter, routes, pricing, onboarding,
   Docker install (musl binary), NAS device-auth flow for future logins.
4. **Auto-routes + rules + per-key flags + latency tiebreak.**
5. **NAS deploy round** — image rebuild, live smokes, Hermes untouched.

Each phase lands with green fake-CLI suites before any live smoke.

## 13. Risks

- Three of four quota-read surfaces are undocumented/experimental (claude
  oauth/usage, agy cloudcode endpoint, codex app-server). Mitigation:
  normalize early, degrade to reactive per account, contract tests on
  fixtures so drift is caught by a failing parser, reactive path always
  works.
- Multiple subscription accounts driven from one NAS IP is technically clean
  (per-account isolation is complete on all three providers) but the
  fingerprinting posture of providers can change; traffic stays shaped like
  real CLI usage (it *is* the real CLI).
- setup-token accounts have no proactive intel; if they become the
  bottleneck, the fix is converting them to bridge-owned (dedicated) logins.

## 14. Reference — provider quota surfaces (research 2026-07-10)

| | claude | agy | codex |
|---|---|---|---|
| Proactive read | `GET api.anthropic.com/api/oauth/usage` (+beta header, real UA) | `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` | app-server `account/rateLimits/read` + `…/updated` push |
| Windows | 5h session, 7d all-models, 7d model-scoped | 5h + weekly, per model family | 5h primary, 7d secondary (account-wide) |
| Utilization field | `percent`/`utilization` (0-100) | `remainingFraction` (0-1, remaining) | `usedPercent` (0-100) |
| Reset field | `resets_at` ISO | `resetTime` ISO/epoch | `resetsAt` epoch s |
| Limit-error text | "You've hit your session\|weekly\|Opus limit · resets <t>"; legacy `…\|<epoch>` | "quota will reset after <GoDur>"; "baseline … refresh on <date>" | "You've hit your usage limit … try again at <t>." |
| Isolation env | `CLAUDE_CONFIG_DIR` | `HOME` | `CODEX_HOME` |
| Refresh rotation | **rotates (single-use)** | none | writes back auth.json; lifetime undocumented |
