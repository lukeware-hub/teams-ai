# Base pinned by index digest (node:22-bookworm, read from Docker Hub on 2026-10-04); bump deliberately.
FROM node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8

# The docker CLI talks to the rootless `dind` sidecar over tcp (DOCKER_HOST in docker-compose.yml), never to the host daemon.
# gh and docker live in /opt/teams-ai-bin: only the orchestrator PATH has it, agent steps never do (audit H3, see invocation.ts).
COPY --from=docker:29-cli@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00 /usr/local/bin/docker /opt/teams-ai-bin/docker
COPY --from=docker:29-cli@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00 /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose

# Go for the Dev's own checks (go mod, vet, test); the gates use their own image. GOTOOLCHAIN=local never downloads another one.
COPY --from=golang:1.26-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c /usr/local/go /usr/local/go
# Rust for the same purpose; CARGO_HOME is set per step to a writable folder, the toolchain itself stays read-only here.
COPY --from=rust:1-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 /usr/local/cargo /usr/local/cargo
COPY --from=rust:1-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 /usr/local/rustup /usr/local/rustup
ENV PATH=/opt/teams-ai-bin:/usr/local/go/bin:/usr/local/cargo/bin:$PATH GOTOOLCHAIN=local RUSTUP_HOME=/usr/local/rustup
# The official rust image ships without rustfmt and clippy; the Dev's format and lint checks need both.
RUN rustup component add rustfmt clippy
# The install gate runs `sh -lc`, and a Debian login shell resets PATH, so the toolchains are also linked into /usr/local/bin.
RUN ln -s /usr/local/go/bin/* /usr/local/cargo/bin/* /usr/local/bin/

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux bubblewrap socat pipx python3-venv python-is-python3 \
  && rm -rf /var/lib/apt/lists/*
# gh is the pinned official release (a static, current Go build); the Debian package is built with an old Go that trivy flags.
ARG TARGETARCH
ARG GH_VERSION=2.102.0
ARG GH_SHA256_AMD64=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GH_SHA256_ARM64=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
RUN set -eu; \
  case "$TARGETARCH" in amd64) sha=$GH_SHA256_AMD64 ;; arm64) sha=$GH_SHA256_ARM64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac; \
  curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
  echo "$sha  /tmp/gh.tar.gz" | sha256sum -c -; \
  tar -xzOf /tmp/gh.tar.gz "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" > /opt/teams-ai-bin/gh; \
  chmod 755 /opt/teams-ai-bin/gh; \
  rm /tmp/gh.tar.gz
# graphify builds the code graph the step packs read (R11.13 slice 3); pinned to the version the CLI spike recorded.
RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install graphifyy==0.9.67

COPY package*.json ./
RUN npm ci --omit=optional --no-audit --no-fund
# Version recorded in docs/superpowers/spikes/2026-09-23-cli-findings.md.
RUN npm install --global @anthropic-ai/claude-code@2.1.295 --no-audit --no-fund
# npm 10.9 (bundled with node 22) crashes in its peer-dependency resolver ("Cannot read properties of
# null (reading 'edgesOut')") on some current packages, e.g. vitest 4.x; the Dev then cannot install
# the toolchain it scaffolds. npm 12 resolves them.
RUN npm install --global npm@12.2.0 --no-audit --no-fund
COPY web/package*.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY . .
RUN npm run --prefix web build

# Mount points owned by `node`: a new named volume takes the owner of the image directory it mounts over.
RUN mkdir -p /home/node/.teams-ai /home/node/.claude /home/node/.config/gh && chown -R node:node /home/node
# Non-root: the base image's `node` user (uid 1000). State lives under $HOME (named volumes, see docker-compose.yml).
USER node
ENV HOME=/home/node
ENV HOST=0.0.0.0
EXPOSE 8787
# Any HTTP answer below 500 means the server is up (the API may answer 401 once authentication is on).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/').then((r)=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
# The graphify skill for Claude Code is written at each start, not at build: ~/.claude is a volume that keeps only what it had when first created.
CMD ["sh", "-lc", "export PATH=/opt/teams-ai-bin:$PATH; [ -f \"$HOME/.teams-ai/config.json\" ] || { mkdir -p \"$HOME/.teams-ai\" && cp /app/docker/config.json \"$HOME/.teams-ai/config.json\"; }; find \"$HOME/.teams-ai/workspaces\" -name '*.ndjson.lock' -delete 2>/dev/null || true; graphify install --platform claude >/dev/null || echo 'graphify: skill not installed' >&2; exec npm run ui -- --port 8787"]
