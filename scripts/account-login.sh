#!/usr/bin/env bash
# Onboard an account into the bridge's pool (run on the NAS host, once per
# account). Writes the account's credentials into a dir inside the mounted
# runtime volume, then tells you the one line to add to accounts.json (which
# hot-reloads — no restart).
#
# Usage:  scripts/account-login.sh <engine> <name>
#   claude — headless: issues a long-lived token in-container.
#   gemini — agy has no in-container browser login, so you log in on a machine
#            that has a browser and this script copies those creds in.
#
# Examples:
#   scripts/account-login.sh claude work
#   scripts/account-login.sh gemini team
set -euo pipefail

ENGINE="${1:?usage: account-login.sh <claude|gemini> <account-name>}"
NAME="${2:?usage: account-login.sh <claude|gemini> <account-name>}"
CONTAINER="${BRIDGE_CONTAINER:-ai-cli-bridge}"
REL="accounts/${ENGINE}/${NAME}"
DIR="/app/.bridge-runtime/${REL}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "error: container '${CONTAINER}' is not running. Start it: docker compose -f deploy/docker-compose.yml up -d" >&2
  exit 1
fi

docker exec "$CONTAINER" mkdir -p "$DIR"

case "$ENGINE" in
  claude)
    echo "Onboarding Claude account '${NAME}' → ${DIR}"
    # 'claude setup-token' prints a URL; open it, approve, paste the code back.
    # It PRINTS a 1-year token but does not persist it — we store it below so
    # the pool's spawns (CLAUDE_CONFIG_DIR=$DIR) can authenticate.
    # Re-run as `account-login.sh claude ${NAME} token` to store an
    # already-issued token without doing the browser dance again.
    if [ "${3:-}" != "token" ]; then
      docker exec -it -e CLAUDE_CONFIG_DIR="$DIR" "$CONTAINER" claude setup-token
    fi
    echo
    printf 'Paste the sk-ant-oat… token that was printed above (input hidden): '
    IFS= read -rs TOKEN
    echo
    if [ -z "$TOKEN" ]; then
      echo "No token entered — the account will show 'needs login' until one is stored." >&2
      exit 1
    fi
    EXP=$(( ( $(date +%s) + 31536000 ) * 1000 ))  # ~1 year, matching the token
    printf '{"claudeAiOauth":{"accessToken":"%s","expiresAt":%s,"scopes":["user:inference"],"subscriptionType":"external"}}' "$TOKEN" "$EXP" \
      | docker exec -i -u root "$CONTAINER" sh -c "umask 077; cat > ${DIR}/.credentials.json && chown 10001:10001 ${DIR}/.credentials.json"
    echo "✓ token stored in ${DIR}/.credentials.json"
    ;;
  gemini)
    HOSTDIR="./data/runtime/${REL}"
    cat <<EOF
Onboarding Gemini account '${NAME}' (Antigravity / agy).

agy authenticates in a browser and can't do that inside a headless container, so
log in on a machine that HAS a browser (e.g. your Mac) under a scratch HOME, then
copy the resulting credentials into this account's dir. On that machine:

  export HOME=/tmp/agy-${NAME}
  mkdir -p "\$HOME"
  agy            # complete the Google login in the browser it opens, then quit

The files agy actually reads back (verified live 2026-07-04 — oauth_creds.json
alone is NOT enough) are:

  .gemini/antigravity-cli/antigravity-oauth-token   # the credential
  .gemini/antigravity-cli/installation_id
  .gemini/google_accounts.json                      # dashboard identity display

Copy them into the account dir in-container — run these from the machine you
logged in on (the NAS rsync/SFTP subsystem remaps home paths, so pipe through
ssh+docker instead of rsync):

  docker exec -u root ${CONTAINER} mkdir -p ${DIR}/.gemini/antigravity-cli
  docker exec -i -u root ${CONTAINER} sh -c 'cat > ${DIR}/.gemini/antigravity-cli/antigravity-oauth-token' < /tmp/agy-${NAME}/.gemini/antigravity-cli/antigravity-oauth-token
  docker exec -i -u root ${CONTAINER} sh -c 'cat > ${DIR}/.gemini/antigravity-cli/installation_id'       < /tmp/agy-${NAME}/.gemini/antigravity-cli/installation_id
  docker exec -i -u root ${CONTAINER} sh -c 'cat > ${DIR}/.gemini/google_accounts.json'                  < /tmp/agy-${NAME}/.gemini/google_accounts.json
  docker exec -u root ${CONTAINER} chown -R 10001:10001 ${DIR}

(Prefix each docker command with "ssh waqar@192.168.1.10" if you're not on the NAS.)
EOF
    ;;
  *)
    echo "error: unknown engine '${ENGINE}' (expected claude or gemini)" >&2
    exit 1
    ;;
esac

cat <<EOF

✓ Add this account to the pool — append it to the "${ENGINE}" array in
  ./data/runtime/accounts.json:

    { "name": "${NAME}", "dir": "${REL}" }

accounts.json hot-reloads — the account joins rotation immediately. The dashboard
Accounts tab will show its signed-in email once creds are in place.
EOF
