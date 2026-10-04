# Plan 31 — Cutover to Kubernetes only (roadmap R6.1)

Goal (human, 2026-10-04): application, back, front, the optional OmniRoute and the local model run as pods of one namespace
(`teams-ai`) on `kind`; nothing is left installed directly on WSL or Docker. Docker stays only as the engine under `kind`.
OmniRoute is an optional parameter (R3.1): the default provider is the Claude Code CLI, so the cutover must work with
OmniRoute off.

This plan is the gate before any apply. It changes nothing by itself.

## What exists

- Manifests: `deploy/k8s/base` (backend, builder + registry, llama, omniroute, ingress, network policies, agent-step),
  overlays `kind` and `gpu`; validated on 2026-10-04 (both overlays render, 23 resources pass `kubectl apply
  --dry-run=server`). Never applied.
- Gates and smoke as Jobs (`executor.kind: k8s`, plan 22), registry builds through BuildKit (plan 23, `registry` deps of
  `KindTarget`), agent-step egress policy with placeholder CIDRs (plan 23), non-root backend image without docker.io.
- kind cluster `teams-ai` exists with one host-mapped port (30080, app NodePort). The UI NodePort 30787 and the registry
  NodePort 30500 need the extra mappings of `scripts/wsl/kind-cluster.yaml`, so the cluster must be recreated.

## Stages (each ends with a check; nothing destructive before stage 5)

1. **Build the backend image** from the repo `Dockerfile` and make it available to the cluster. Check: `kind load` or a
   push to the in-cluster registry, and `kubectl get pods` shows the backend pulling it. (Needs `docker build` once: the
   builder pod cannot build itself. This is the only Docker use left, on the host that runs `kind`.)
2. **Recreate the kind cluster** with `scripts/wsl/kind-cluster.yaml` (ports 30080, 30500, 30787). Check: `kubectl
   cluster-info`, the three host ports answer after stage 3.
3. **Secrets and data**: create the Secrets from the templates in `deploy/k8s/secrets-templates` WITHOUT committing values:
   `GITHUB_TOKEN`, `OPENROUTER_API_KEY` (Jev, optional), the `claude` credential, and `config.json`. Copy
   `~/.teams-ai` (runs, workspaces, knowledge) into the data PVC. Check: backend pod Ready, `/healthz` 200.
4. **Apply** `kubectl apply -k deploy/k8s/overlays/kind` and bring up llama (CPU first; `gpu` overlay only if the NVIDIA
   device plugin is installed). Check: all pods Ready; the UI answers on `http://localhost:30787`; the local model answers
   `scripts/smoke/local-logprobs.ts` pointed at the in-cluster service.
5. **Prove it works before removing anything**: run the cheap end-to-end from the browser (start, stop, resume a run, as in
   R2.2) against the in-cluster backend, and one gate Job plus one smoke Job against a deployed service by its Service DNS
   name. Check: journal shows the run through the Job executor, no `docker` call.
6. **Reconfirm with the human, then remove**, in this order, listing each target first:
   - the WSL processes (`llama-server`, `cli.ts ui`), `~/llama.cpp`, `~/models`, the clones `~/teams-ai-live`,
     `~/teams-ai-e2e`, `~/hello-kind`, `~/teams-ai`, `~/workspace/teams-ai`;
   - the Docker containers `omniroute` and `teams-ai-backend-1` and their images;
   - **only with an explicit yes**: the volumes `teams-ai_teams-ai-claude`, `-config`, `-gh` (they hold the `claude` and `gh`
     logins) and `omniroute-data`; `~/.teams-ai` only after its copy in the PVC is verified.

## Rollback

Stages 1 to 5 only add things: `kubectl delete -k deploy/k8s/overlays/kind` and `kind delete cluster --name teams-ai`
return to today. Stage 6 is the point of no return for the logins and data, which is why it needs the reconfirmation and a
verified copy first.

## Known open items that this plan does not hide

- CIDRs of the package registry and the model API in `agent-step-isolation` are placeholders (RFC 5737): agent-step pods
  have no external egress until the human supplies the real ones.
- The backend pod runs unsandboxed with both opt-ins (bubblewrap cannot nest); the pod is the boundary until agent steps run
  as their own pods (audit C1, plan 20).
- Image pins and the OmniRoute secret key names were never checked against a registry or the product; verify at stage 4.
- The `claude` login lives in the volume being replaced: the Secret must carry the credential file, and a re-login in the
  pod may be needed.

## Verification of this plan

Manifest test (`test/deploy/k8s-manifests.test.ts`) and the server dry-run already pass. The stages above are the live
verification; each is checked before the next starts, and nothing here is run without the human's go for stage 1 and a
second explicit go for stage 6.
