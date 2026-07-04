# Bridge Server Edition — consolidated provider on :9011.
#
# Both engines run here: claude (Claude Code CLI, npm) and gemini (Antigravity
# `agy`, whose official installer ships a linux-amd64 build). agy auth is
# file-based under a per-account HOME (.gemini/oauth_creds.json) — onboard a
# gemini account by copying credentials logged in elsewhere (see DEPLOY-NAS.md);
# there is no in-container browser login. If agy is ever absent the gemini engine
# just reports "down" and claude routes keep working.
FROM node:22-bookworm-slim

# curl for the HEALTHCHECK + the agy installer; git + ca-certificates for completeness.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI provides the `claude` engine binary on PATH.
RUN npm install -g @anthropic-ai/claude-code

# The Antigravity CLI provides the `gemini` engine binary. The official installer
# detects linux/amd64 and downloads the matching build; --dir puts it on PATH for
# all users. Pinned to the current line via the installer's own manifest.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin \
    && test -x /usr/local/bin/agy \
    && /usr/local/bin/agy --version

WORKDIR /app

# Dependencies (workspaces). Only the manifests come before npm install, so
# code-only changes reuse the cached install layer — a NAS redeploy of source
# edits takes seconds, not minutes. .dockerignore keeps node_modules/.git out.
COPY package.json package-lock.json* ./
COPY packages/core/package.json ./packages/core/
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/provider/package.json ./packages/provider/
RUN npm install --omit=dev

# Now the actual source (workspace symlinks from the install layer still hold).
COPY packages ./packages

# Remaining app files the runtime needs.
COPY scripts ./scripts
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
RUN chmod +x ./deploy/entrypoint.sh

# Non-root runtime that owns the runtime + account credential dirs.
RUN useradd -m -u 10001 bridge \
    && mkdir -p /app/.bridge-runtime/accounts /app/.bridge-runtime/usage \
    && chown -R bridge:bridge /app
USER bridge

# CLAUDE_CONFIG_DIR/HOME are set per-account by the pool; the defaults below make
# the whole state live under the single mounted volume (/app/.bridge-runtime).
ENV PROVIDER_PORT=9011 \
    BIND_HOST=0.0.0.0 \
    BRIDGE_CREDENTIALS_FILE=/app/.bridge-runtime/credentials.json \
    BRIDGE_ACCOUNTS_FILE=/app/.bridge-runtime/accounts.json \
    BRIDGE_USAGE_DIR=/app/.bridge-runtime/usage

EXPOSE 9011
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:9011/healthz >/dev/null || exit 1

ENTRYPOINT ["./deploy/entrypoint.sh"]
