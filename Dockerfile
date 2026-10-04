# Base pinned by index digest (node:22-bookworm, read from Docker Hub on 2026-10-04); bump deliberately.
FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7

# buildctl talks to the in-namespace rootless BuildKit (deploy/k8s/base/builder.yaml, same version) for registry
# builds. There is no docker.io: neither the daemon nor its socket exists in this image.
COPY --from=moby/buildkit:v0.17.2 /usr/bin/buildctl /usr/local/bin/buildctl

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux gh bubblewrap socat \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=optional --no-audit --no-fund
# Version recorded in docs/superpowers/spikes/2026-09-23-cli-findings.md.
RUN npm install --global @anthropic-ai/claude-code@2.1.281 --no-audit --no-fund
# npm 10.9 (bundled with node 22) crashes in its peer-dependency resolver ("Cannot read properties of
# null (reading 'edgesOut')") on some current packages, e.g. vitest 4.x; the Dev then cannot install
# the toolchain it scaffolds. npm 12 resolves them.
RUN npm install --global npm@12.2.0 --no-audit --no-fund
COPY web/package*.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY . .
RUN npm run --prefix web build

# Non-root: the base image's `node` user (uid 1000). State lives under $HOME (a volume in Kubernetes).
USER node
ENV HOME=/home/node
ENV HOST=0.0.0.0
EXPOSE 8787
# Any HTTP answer below 500 means the server is up (the API may answer 401 once authentication is on).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/').then((r)=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-lc", "find \"$HOME/.teams-ai/workspaces\" -name '*.ndjson.lock' -delete 2>/dev/null || true; exec npm run ui -- --port 8787"]
