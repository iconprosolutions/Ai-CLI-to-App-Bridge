FROM node:22-alpine

WORKDIR /app

# Install app dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy server code
COPY server.js ./

EXPOSE 9010

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9010/health || exit 1

CMD ["node", "server.js"]
