# Node 22 LTS (alpine) - node:sqlite is built in, so no native modules to compile
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8081 \
    DB_PATH=/data/attendance.db

WORKDIR /app

# Install only production dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application files
COPY server.js ./
COPY public ./public

# Database folder, writable by the unprivileged "node" user
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:8081/healthz || exit 1

CMD ["node", "server.js"]
