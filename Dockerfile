# Node 24 because node:sqlite is only unflagged from 23.4 onward.
FROM node:24-alpine

# Runs unprivileged. The node image already ships a "node" user (uid 1000).
WORKDIR /app

# Dependencies first so a code change does not invalidate the install layer.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY test ./test

# The database lives on a mounted volume, not in the image, so a redeploy never
# destroys request history. Signs are generated artefacts and can be written
# anywhere the operator can read them from.
ENV DATA_DIR=/data \
    SIGNS_DIR=/data/signs \
    BIND_HOST=0.0.0.0 \
    PORT=8080 \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8080

# Compose/Kubernetes restart the container if this starts failing. It hits the
# app's own /health route, which touches the database, so it fails if SQLite
# becomes unreadable rather than only if the process died.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
