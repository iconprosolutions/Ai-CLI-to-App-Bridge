FROM node:22-alpine

WORKDIR /app

# Install Claude Code CLI globally
# This is the official Anthropic Claude Code CLI package
RUN npm install -g @anthropic-ai/claude-code --no-audit --no-fund

# Install app dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy server code
COPY server.js ./

# Create context directory structure
# The actual contexts/ dir is mounted as a volume at runtime,
# but we bake in a skeleton so the server starts cleanly without a volume.
RUN mkdir -p contexts/global contexts/clients
COPY contexts/ ./contexts/

EXPOSE 9002

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:9002/health || exit 1

CMD ["node", "server.js"]
