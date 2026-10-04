# Plan 23 — Registry build path, hardened images and agent-step network isolation (R7.1 part 2, H4, M6)

## Goal

1. Deploy a project to Kubernetes without a local Docker: build with the in-namespace rootless BuildKit, push to the in-namespace registry, deploy by that image reference. The existing docker build + `kind load` path stays the default.
2. Backend image non-root, no `docker.io`, tools pinned (audit H4, M6); `securityContext` on every Deployment.
3. Pods labeled `role=agent-step` get default-deny ingress and egress plus an allowlist; everything else keeps the open policy.

## Audit claims checked against the code

- H4: `Dockerfile` has no `USER`, installs `docker.io`, `CMD` uses `/root/.teams-ai`; `backend.yaml` mounts under `/root`. Confirmed. `docker-compose.yml` (not owned here) also mounts `/root` and the host socket; see "Out of scope".
- M6: floating `node:22-bookworm`, unpinned `claude-code` and `npm@12`, `.dockerignore` lacks `.env*`/`config.json`. Confirmed.
- Network: the existing `allow-all` policy selects every pod. NetworkPolicies are additive, so a deny policy for agent pods would have no effect while `allow-all` also selects them. The `allow-all` selector is therefore changed to exclude `role=agent-step`.

## Approach

### Registry build (`server/deploy/kind.ts`, `target.ts`)

- `KindDeps.registry?: { buildkitAddr, pushHost, pullHost, namespace }`. Unset means the current behaviour, byte for byte.
- When set:
  - `build`: `buildctl --addr <buildkitAddr> build --frontend dockerfile.v0 --local context=<dir> --local dockerfile=<dir> --output type=image,name=<pushHost>/<name>:<tag>,push=true,registry.insecure=true` through the injected Exec. No `docker`, no `kind load`.
  - The deployed reference is `<pullHost>/<name>:<tag>` (nodes pull through the containerd mirror; see below). `pushHost` is the in-cluster Service (`registry:5000`), `pullHost` is the virtual host `registry.teams-ai:5000` that the node mirror redirects to the registry NodePort. A registry host already present in `intent.image` is dropped.
  - kubectl runs in-cluster: no `--context` pin, `-n <namespace>` instead (the backend ServiceAccount is limited to that namespace).
  - `verify`: `rollout status`, then an HTTP probe of the in-cluster URL from the backend (`waitHealthy`, injectable `httpGet`). `kubectl run` would need `pods/attach`, which the Role does not grant and should not.
- `DeployTarget.serviceUrlInCluster?(intent): string` (optional): `http://<projectId>.<namespace>.svc.cluster.local:<port>`. Implemented by `KindTarget` in registry mode (and, for consistency, in default mode with namespace `default`). The k8s-job-runner task passes it to the smoke gate, which runs as a Job in the cluster where the NodePort URL from `serviceUrl` is not reachable. Absent on `DockerLocalTarget`.

### Hardened image (`Dockerfile`, `.dockerignore`)

- Base `node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7` (index digest read from Docker Hub on 2026-10-04), `@anthropic-ai/claude-code@2.1.281` (version recorded in the CLI spike), `npm@12.2.0` (exists on the npm registry), `buildctl` copied from `moby/buildkit:v0.17.2` (same version as the builder Deployment).
- No `docker.io`. Runs as the `node` user (uid 1000), `HOME=/home/node`, `CMD` uses `$HOME`. `HEALTHCHECK` on `/`.
- `.dockerignore` adds `.env*` and `config.json`.

### Manifests (`deploy/k8s`)

- Pod and container `securityContext` on all five Deployments: `runAsNonRoot`, `seccompProfile`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `readOnlyRootFilesystem` where possible. Backend: home is an `emptyDir` (the PVC subPaths mount inside it), `/tmp` emptyDir. Exception: `buildkitd` (rootless BuildKit needs setuid `newuidmap` and an unconfined seccomp profile); it keeps `runAsNonRoot` only and the test lists it as the one exemption.
- `networkpolicy.yaml`: `allow-all` excludes `role=agent-step`; new `agent-step-isolation` (ingress and egress denied by default) with egress to: kube-dns (53 udp/tcp), `app=registry:5000`, `app=omniroute:20128`, `app=llama:8080`, and tcp 443 to CIDR placeholders.
- `agent-step.yaml`: ServiceAccount `agent-step` with `automountServiceAccountToken: false` (pods set it too).
- kind: registry Service NodePort 30500 in the kind overlay; `scripts/wsl/kind-cluster.yaml` gets the containerd mirror `registry.teams-ai:5000 -> http://localhost:30500` and the 30787 port mapping the overlay already assumed.

### External 443 CIDR placeholders

Agent steps need the model/API endpoints and the package registry. The policy ships TEST-NET-1 placeholders (`192.0.2.0/24`, the npm registry slot; `198.51.100.0/24`, the model API slot) that match nothing real. Operators replace them with the real CIDRs (or a forward-proxy IP) via a kustomize patch before enabling agent steps. Deliberately not `0.0.0.0/0`.

## Files

`server/deploy/target.ts`, `server/deploy/kind.ts`, `Dockerfile`, `.dockerignore`, `deploy/k8s/base/*`, `deploy/k8s/overlays/kind/kustomization.yaml`, `scripts/wsl/kind-cluster.yaml`, `test/deploy/deploy.test.ts`, `test/deploy/k8s-manifests.test.ts`.

## Verification

- Unit tests with the fake Exec: registry build issues `buildctl` and no `docker`/`kind`; deploy uses the pull reference; kubectl has `-n` and no `--context`; verify probes over HTTP; default path unchanged; `serviceUrlInCluster`.
- Manifest test: single namespace, no inline secrets, security contexts on every Deployment, `allow-all` excludes agent pods, isolation policy shape (no `{}` egress, no `0.0.0.0/0`), agent ServiceAccount without automount.
- `npx tsc --noEmit`, `npx vitest run`.
- Not verified (no cluster, no Docker): image build, kustomize build, containerd mirror syntax for the node image in use, `buildctl` path in `moby/buildkit`, that omniroute/llama/registry run as uid 1000 with a read-only root.

## Out of scope

`docker-compose.yml` still mounts `/root` and the Docker socket; gate runner Jobs (k8s-job-runner task); wiring `registry` config from the CLI/config.
