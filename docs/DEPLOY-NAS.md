# Deploying the Bridge to the NAS

How to run the consolidated provider as a LAN-only server on the Ugreen NAS
(`192.168.1.10`, x86_64 Debian 12, Docker 26.1). Companion: `HOW-IT-WORKS.md`
(architecture), `superpowers/specs/2026-07-02-server-edition-design.md` (design).

> **Engines:** the `claude` engine runs in the container. The `gemini`/agy engine
> does **not** yet — Antigravity ships a macOS binary and no confirmed
> linux-amd64 build (Spike D0). Gemini routes degrade cleanly (the engine reports
> "down"); every Claude route works. See [Gemini on the NAS](#gemini-on-the-nas).

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

## 5. Onboard Claude accounts

The container starts with no Claude login. Add one or more accounts:

```bash
cd ~/ai-cli-bridge
./scripts/account-login.sh work        # opens claude setup-token; paste the code
```

Then append what it prints to `./data/runtime/accounts.json` (create it if absent):

```json
{
  "claude": [
    { "name": "work",     "dir": "accounts/claude/work" },
    { "name": "personal", "dir": "accounts/claude/personal" }
  ]
}
```

`accounts.json` hot-reloads — no restart. With **no** file, the container runs a
single implicit `default` account using its own `~/.claude` (also fine if you
`claude setup-token` once without `CLAUDE_CONFIG_DIR`). Multiple accounts give you
parallel lanes and automatic quota failover.

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

Not supported in the container yet — the `agy` binary Antigravity distributes is
macOS-only, and no linux-amd64 build is confirmed. Options:

1. **Claude-only on the NAS** (current default). Gemini routes return a clean
   "engine down"; nothing else is affected.
2. **When a Linux `agy` exists:** add its install to `deploy/Dockerfile`, then
   onboard a gemini account. If its login needs a browser, the documented
   fallback is to log in on the Mac under a scratch `HOME`, then
   `rsync` that `~/.gemini` dir into `./data/runtime/accounts/gemini/<name>/` on
   the NAS and reference it in `accounts.json`.

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
