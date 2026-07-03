# Bridge Server Edition — consolidated provider on :9011.
#
# claude engine: installed here (Claude Code CLI, npm). gemini/agy engine:
# Antigravity ships only a macOS binary today (no confirmed linux-amd64 build —
# Spike D0), so it is NOT installed in this image. The bridge degrades
# gracefully: the gemini engine reports "down" and gemini routes fail cleanly
# while every claude route works. Add an agy Linux binary later to enable it.
FROM node:22-bookworm-slim

# curl for the HEALTHCHECK; git + ca-certificates for completeness.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI provides the `claude` engine binary on PATH.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Dependencies (workspaces). Copied before source so this layer caches across
# code-only changes. .dockerignore keeps node_modules/.git/runtime out.
COPY package.json package-lock.json* ./
COPY packages ./packages
RUN npm install --omit=dev

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
  CMD curl -fsS http://127.0.0.1:9011/dashboard/status >/dev/null || exit 1

ENTRYPOINT ["./deploy/entrypoint.sh"]
