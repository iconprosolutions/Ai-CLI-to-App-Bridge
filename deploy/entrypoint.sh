#!/bin/sh
# Container entrypoint: ensure a v2 credentials file with an admin key exists in
# the mounted runtime volume (created on first boot, persisted thereafter), print
# it once to the container log, then run the provider in the foreground as PID 1.
set -e

CRED="${BRIDGE_CREDENTIALS_FILE:-/app/.bridge-runtime/credentials.json}"
mkdir -p "$(dirname "$CRED")"

KEY=$(node -e "const {bootstrapCredentialsFile}=require('/app/packages/provider/keys'); process.stdout.write(bootstrapCredentialsFile(process.argv[1]).adminKey)" "$CRED")
echo "[bridge] provider starting on :${PROVIDER_PORT:-9011}"
echo "[bridge] admin API key (persisted in the volume): ${KEY}"

exec node /app/packages/provider/server.js
