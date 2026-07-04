#!/bin/sh
# Container entrypoint: ensure a v3 credentials file (secrets hashed at rest)
# with an admin key exists in the mounted runtime volume, then run the
# provider in the foreground as PID 1. The admin key is only known at creation
# time — it is printed exactly once, on the first boot, never again (container
# logs are not a safe place for a long-lived credential).
set -e

CRED="${BRIDGE_CREDENTIALS_FILE:-/app/.bridge-runtime/credentials.json}"
mkdir -p "$(dirname "$CRED")"

BOOT=$(node -e "const {bootstrapCredentialsFile}=require('/app/packages/provider/keys'); process.stdout.write(JSON.stringify(bootstrapCredentialsFile(process.argv[1])))" "$CRED")
echo "[bridge] provider starting on :${PROVIDER_PORT:-9011}"
case "$BOOT" in
  *'"created":true'*)
    KEY=$(printf '%s' "$BOOT" | sed -n 's/.*"adminKey":"\([^"]*\)".*/\1/p')
    echo "[bridge] FIRST BOOT — admin API key (save it NOW; keys are hashed at rest and it will never be shown again): ${KEY}"
    ;;
  *'"migrated":true'*)
    echo "[bridge] credentials.json migrated to v3 — key values unchanged, now hashed at rest"
    ;;
  *)
    echo "[bridge] admin key already provisioned (hashed at rest — not displayable; rotate from the dashboard if lost)"
    ;;
esac

exec node /app/packages/provider/server.js
