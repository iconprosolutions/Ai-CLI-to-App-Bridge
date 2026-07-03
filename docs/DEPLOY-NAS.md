# Deploying the Bridge to the NAS

How to run the consolidated provider as a LAN-only server on the Ugreen NAS
(`192.168.1.10`, x86_64 Debian 12, Docker 26.1). Companion: `HOW-IT-WORKS.md`
(architecture), `superpowers/specs/2026-07-02-server-edition-design.md` (design).

> **Engines:** both `claude` (Claude Code CLI) and `gemini` (Antigravity `agy`)
> run in the container — the image installs agy's official linux-amd64 build.
> Claude accounts log in headlessly; gemini accounts need credentials copied from
> a browser login (agy has no headless login). See [onboarding](#5-onboard-accounts).
> If agy is ever missing, gemini routes just report "down" and claude keeps working.

> **Security:** this binds `0.0.0.0` *inside* the container — the NAS LAN/firewall
> is the boundary. Do **not** forward `9011` to the internet. If you must expose
> it, put an HTTPS reverse proxy in front and keep the bridge LAN-only.

## 1. Prerequisites

- Docker + the compose plugin on the NAS (`docker --version`, `docker compose version`).
- Your Claude subscription login(s).
- SSH access: `ssh waqar@192.168.1.10`.

## 2. Get the code onto the NAS

From your Mac (rsync keeps `./data` and excludes junk):

```bash
rsync -avz --delete \
  --exclude node_modules --exclude .git --exclude .bridge-runtime --exclude deploy/data \
  ~/Projects/experiments/ai-cli-bridge/ waqar@192.168.1.10:~/ai-cli-bridge/
```

Or clone/pull on the NAS if it has repo access.

## 3. Build and start

```bash
ssh waqar@192.168.1.10
cd ~/ai-cli-bridge
docker compose -f deploy/docker-compose.yml up -d --build
```

First boot creates `./data/runtime/` (the durable state volume) and generates an
admin API key.

## 4. Get the admin API key

```bash
docker logs ai-cli-bridge 2>&1 | grep 'admin API key'
# → [bridge] admin API key (persisted in the volume): <48 hex>
```

It persists in `./data/runtime/credentials.json`; it won't change on restart.
Mint per-app keys later from the dashboard **Connect** tab (admin key required).

## 5. Onboard accounts

The container starts with no logins. Add one or more per engine — the helper
writes each account's credentials into `./data/runtime/accounts/<engine>/<name>/`.

**Claude** (headless — issues a long-lived token in-container):

```bash
cd ~/ai-cli-bridge
./scripts/account-login.sh claude work    # opens claude setup-token; paste the code
```

**Gemini** (agy has no headless login — log in on a machine with a browser, copy
the creds in). Run `./scripts/account-login.sh gemini team` for the exact steps;
in short:

```bash
# On your Mac (or any machine with a browser + agy):
export HOME=/tmp/agy-team && mkdir -p "$HOME" && agy   # complete Google login, then quit
rsync -a /tmp/agy-team/.gemini/ waqar@192.168.1.10:~/ai-cli-bridge/data/runtime/accounts/gemini/team/.gemini/
```

agy reads `<account dir>/.gemini/oauth_creds.json` (via the account's `HOME`); the
refresh token keeps it alive. Then append the accounts to
`./data/runtime/accounts.json` (create it if absent):

```json
{
  "claude": [
    { "name": "work",     "dir": "accounts/claude/work" },
    { "name": "personal", "dir": "accounts/claude/personal" }
  ],
  "gemini": [
    { "name": "team", "dir": "accounts/gemini/team" }
  ]
}
```

`accounts.json` hot-reloads — no restart. With **no** file, each engine runs a
single implicit `default` account using the container's own `~/.claude` / `~/.gemini`.
Multiple accounts per engine give you parallel lanes and automatic quota failover.

## 6. Verify

```bash
# Health + which account is signed in per engine:
curl -s http://192.168.1.10:9011/dashboard/status | python3 -m json.tool | less

# One real completion (use your admin key):
curl -s http://192.168.1.10:9011/v1/chat/completions \
  -H "Authorization: Bearer <admin-key>" -H "Content-Type: application/json" \
  -d '{"model":"bridge-claude-sonnet-4.6-northstar","messages":[{"role":"user","content":"say NAS-OK"}]}'
```

Open the dashboard from any LAN machine: `http://192.168.1.10:9011/dashboard`.
The **Accounts** tab shows each account's signed-in email and health.

## 7. Point Hermes / clients at it

OpenAI-compatible base URL: `http://192.168.1.10:9011/v1`. In Hermes:

```yaml
providers:
  ai-cli-bridge:
    type: openai
    base_url: http://192.168.1.10:9011/v1
    api_key: ${AI_CLI_BRIDGE_API_KEY}
    models:
      - bridge-claude-sonnet-4.6-northstar
      - bridge-claude-haiku-4.5-spark
```

Send `X-App-Id: <app>` to attribute usage per app; use a per-app named key
(minted in the Connect tab) to attribute per teammate and scope it to `/v1` only.

## Gemini on the NAS

Supported. The image installs Antigravity's official **linux-amd64** `agy` build
(`curl -fsSL https://antigravity.google/cli/install.sh | bash`, which detects the
platform). The one wrinkle is auth: `agy` logs in through a browser and can't do
that headless, so you copy credentials in rather than logging in on the NAS —
see [§5 onboarding](#5-onboard-accounts). Once `<account>/.gemini/oauth_creds.json`
is in place, `agy` runs non-interactively and the refresh token self-renews.

- **First-deploy check:** confirm `docker exec ai-cli-bridge agy --version` prints
  a version (proves the linux binary installed). Then, after copying a gemini
  account's creds, `docker exec -e HOME=/app/.bridge-runtime/accounts/gemini/<name> ai-cli-bridge agy -p "say ok" -m "Gemini 3.5 Flash (Low)"` should answer — if it instead
  demands a keyring/login, the file creds weren't picked up; re-copy `.gemini/`
  and check ownership (`chown 10001:10001`). The dashboard Accounts tab shows the
  gemini account's signed-in email when it's working.
- **Claude-only fallback:** if you skip gemini onboarding, gemini routes report
  "engine down" and everything else works — no action needed.

## Backup

The single directory `~/ai-cli-bridge/data/runtime/` **is** all state —
credentials (named keys), account logins, the usage ledger, accounts.json. Back
it up:

```bash
tar czf bridge-backup-$(date +%F).tgz -C ~/ai-cli-bridge data/runtime
```

## Upgrade

```bash
cd ~/ai-cli-bridge
git pull            # or re-rsync from the Mac
docker compose -f deploy/docker-compose.yml up -d --build
```

`./data/runtime` survives — keys, logins, and history carry over.

## Troubleshooting

- **`docker logs ai-cli-bridge`** — startup + per-request lines, breaker/account events.
- **Account shows "needs login"** — re-run `./scripts/account-login.sh <name>`, then hit **Probe** on the Accounts tab.
- **Container unhealthy** — the HEALTHCHECK curls `/dashboard/status`; check the logs for a crash or a missing `claude` binary.
- **401 from `/v1`** — send `Authorization: Bearer <key>`; app-role keys can't reach `/admin/*` (403).
