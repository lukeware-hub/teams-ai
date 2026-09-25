FROM node:22-bookworm

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux gh bubblewrap socat \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=optional --no-audit --no-fund
RUN npm install --global @anthropic-ai/claude-code --no-audit --no-fund
COPY web/package*.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY . .
RUN npm run --prefix web build

ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["sh", "-lc", "find /root/.teams-ai/workspaces -name '*.ndjson.lock' -delete 2>/dev/null || true; exec npm run ui -- --port 8787"]
