# Seaport Global platform: Node API + React UI + Python engine in one container.
#   docker build -t seaport-platform .
#   docker run -d -p 127.0.0.1:3000:3000 -v seaport-data:/data --env-file /etc/seaport/seaport.env --name seaport seaport-platform
# Data (SQLite database + documents) lives in /data - always mount a volume there.
# Publish the port on 127.0.0.1 only and put nginx (HTTPS) in front: Docker's own port
# publishing bypasses host firewalls such as ufw.

FROM node:22-bookworm-slim

# Python 3.11 for the analytics engine (standard library only - no pip packages needed).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# No npm install: the API uses only built-in Node modules and the React UI ships pre-built in public/.
COPY package.json ./
COPY src ./src
COPY engine ./engine
COPY public ./public

ENV NODE_ENV=production \
    TRUST_PROXY=true \
    COOKIE_SECURE=true \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    ENGINE_PORT=8001 \
    PYTHON=python3 \
    DB_PATH=/data/seaport.db \
    FILES_DIR=/data/files

RUN mkdir -p /data && chown -R node:node /data   # code stays root-owned and read-only to the app
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
