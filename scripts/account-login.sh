#!/usr/bin/env bash
# Onboard a Claude account into the bridge's account pool (run on the NAS host,
# once per account). Issues a long-lived headless token into the account's
# credential dir inside the mounted runtime volume, then tells you the one line
# to add to accounts.json (which hot-reloads — no restart).
#
# Usage:  scripts/account-login.sh <account-name>
# Example: scripts/account-login.sh work
#
# gemini/agy is not supported in the container yet (macOS-only binary); see
# docs/DEPLOY-NAS.md for the Mac-login + rsync fallback if you obtain a Linux agy.
set -euo pipefail

NAME="${1:?usage: account-login.sh <account-name>}"
CONTAINER="${BRIDGE_CONTAINER:-ai-cli-bridge}"
REL="accounts/claude/${NAME}"
DIR="/app/.bridge-runtime/${REL}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "error: container '${CONTAINER}' is not running. Start it first: docker compose -f deploy/docker-compose.yml up -d" >&2
  exit 1
fi

echo "Onboarding Claude account '${NAME}' → ${DIR}"
docker exec "$CONTAINER" mkdir -p "$DIR"

# 'claude setup-token' prints a URL; open it, approve, paste the code back. The
# token is written into CLAUDE_CONFIG_DIR and self-refreshes afterward.
docker exec -it -e CLAUDE_CONFIG_DIR="$DIR" "$CONTAINER" claude setup-token

cat <<EOF

✓ Logged in. Add this account to the pool by appending it to the "claude" array
  in ./data/runtime/accounts.json:

    { "name": "${NAME}", "dir": "${REL}" }

accounts.json hot-reloads — the new account joins rotation immediately. Verify on
the dashboard Accounts tab (it will show the signed-in email), or:
  curl -s http://<nas-ip>:9011/dashboard/status | grep -o '"${NAME}"[^}]*'
EOF
