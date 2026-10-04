# Plan 14 — Whole stack in one Kubernetes namespace (R6.1)

## Goal

Run backend (orchestrator + API + web UI), OmniRoute and llama.cpp in the single namespace `teams-ai` on Kubernetes only (no WSL, no traditional Docker). Manifests live in `deploy/k8s` as kustomize.

## Approach

- `deploy/k8s/base`: namespace, backend (one pod: `npm run ui` already serves the built web bundle, so the web build is not split), omniroute, llama (Qwen2.5-7B-Instruct Q4_K_M GGUF fetched by an init container onto a PVC; CPU by default), builder (rootless BuildKit + registry), Services, Ingress, allow-all NetworkPolicy, backend ServiceAccount/Role limited to the namespace.
- `deploy/k8s/overlays/kind`: backend Service as NodePort 30787 (kind has no LoadBalancer). `overlays/gpu`: CUDA llama image, `--n-gpu-layers 99`, `nvidia.com/gpu: 1` limit (NVIDIA device plugin required).
- Secrets: `deploy/k8s/secrets-templates/*.yaml` carry empty `stringData` and are not in the kustomization; real Secrets are created with `kubectl create secret`. Workloads reference them as `optional`. The backend mounts a projected volume at `~/.teams-ai/secrets` (one file per key, what `server/core/secrets.ts` reads). Claude credentials are copied once onto the data PVC (`~/.claude`) so token refreshes persist.
- `~/.teams-ai` is a PVC subPath; `config.json` is seeded from a ConfigMap only when absent (omniroute `http://omniroute:20128`, llama `http://llama:8080`).

## Gates and deploys without a local Docker

Today `server/exec/gate-runner.ts` shells out to `docker run` (bind-mounting the worktree, `--network none|bridge`, cpu/memory limits, secrets via `-e NAME`), and `server/deploy/kind.ts` runs `docker build`, `kind load` and `kubectl`. Neither works in a pod without a daemon.

Options:

1. **Kubernetes Jobs for gates** (one Job per gate, `restartPolicy: Never`, `activeDeadlineSeconds` = gate timeout, resources limits = cpus/memory, secrets from a per-run Secret via `secretKeyRef`, logs via `pods/log`, JUnit via the shared workspace volume, network isolation via a per-Job label plus a deny-egress NetworkPolicy). Maps 1:1 onto the Docker flags. Trade-off: the worktree must be visible to the Job pod (shared RWX volume, or RWO on one node as on kind), and the allow-all policy must be narrowed for `network: none` gates.
2. **Docker-in-Docker sidecar**: keeps the code unchanged but needs a privileged container; rejected (security, and the goal is to drop Docker).
3. **kubectl exec into long-lived runner pods**: no per-gate isolation or resource limits; rejected.

Image builds:

- **Rootless BuildKit** (`buildkitd` Deployment, `buildctl --addr tcp://buildkitd:1234`, push to the in-namespace `registry`): no privileged pod, layer cache, close to `docker build`. Needs an unconfined seccomp profile. Cluster nodes must pull from `registry` (kind: containerd mirror config for `registry.teams-ai`; an `insecure` registry entry).
- **kaniko Job**: no daemon either, but archived upstream and slower; kept as fallback.

**Recommendation:** Jobs for gates (option 1) plus rootless BuildKit with the in-namespace registry for builds, and `KindTarget` generalized to a cluster target that skips `kind load` and uses the registry image reference. The Role in `backend.yaml` already grants what this needs (jobs, pods, pods/log, secrets, deployments, services in the namespace only). The code changes (a Job-based `GateRunner`, registry build in the deploy target) are NOT part of this plan; they are a follow-up item.

## Files

`deploy/k8s/**`, `test/deploy/k8s-manifests.test.ts`, `package.json` (dev dependency `yaml`, no YAML parser existed).

## Verification

- `test/deploy/k8s-manifests.test.ts` parses every manifest as YAML and asserts: one namespace (`teams-ai`) everywhere, no inline secret values, the NetworkPolicy allows all ingress and egress, kustomizations reference existing files.
- `npx tsc --noEmit`, `npx vitest run`.
- Not verified: `kubectl kustomize`/apply on a cluster (kubectl and kind are off limits in this task); image pins (`omniroute:4.12.0`, llama.cpp `server` tags, buildkit v0.17.2-rootless) and the Hugging Face URL are unchecked.
