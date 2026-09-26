FROM node:22-bookworm

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux gh bubblewrap socat docker.io \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=optional --no-audit --no-fund
RUN npm install --global @anthropic-ai/claude-code --no-audit --no-fund
# npm 10.9 (bundled with node 22) crashes in its peer-dependency resolver ("Cannot read properties of
# null (reading 'edgesOut')") on some current packages, e.g. vitest 4.x; the Dev then cannot install
# the toolchain it scaffolds. npm 12 resolves them.
RUN npm install --global npm@12 --no-audit --no-fund
COPY web/package*.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY . .
RUN npm run --prefix web build

ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["sh", "-lc", "find /root/.teams-ai/workspaces -name '*.ndjson.lock' -delete 2>/dev/null || true; exec npm run ui -- --port 8787"]
