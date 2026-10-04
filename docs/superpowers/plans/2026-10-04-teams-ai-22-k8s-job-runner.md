# Plan 22: Kubernetes Job runner for gates and smoke (R7.1 part 1)

## Goal

Run quality gates and the smoke suite as Kubernetes Jobs instead of `docker run`, selected by config, with `docker` staying the default so nothing changes for existing users. The smoke gate reaches the deployed service by its in-cluster Service DNS name.

## Verified against the code

- `runGate` shells out to `docker run` directly (`gate-runner.ts`), reads the JUnit file from the worktree through `deps.readFile`, and removes a timed-out container with `docker rm -f`. `runSmoke` calls `runGate` with `SERVICE_URL` as a secret. The orchestrator wires both in `server/orchestrator/run.ts` (`gates`, `phaseDeps().smoke`).
- Plan 14 recommends one Job per gate. The backend Role already allows jobs, pods, pods/log, secrets in the namespace. The orchestrator mounts PVC `teams-ai-data` (subPath `teams-ai`) at `/root/.teams-ai`, so worktrees are on a PVC a Job can mount too.
- `DeployTarget.serviceUrl` for kind returns `http://127.0.0.1:<nodePort>`, which a pod cannot use. Nothing reports an in-cluster URL yet.

## Design

1. `GateExecutor` interface (`gate-runner.ts`): `run(gate, ctx) -> { exitCode, timedOut, durationMs, stdout, stderr }`. JUnit parsing, redaction, tails and classification stay in `runGate`. `GateDeps.executor?` is optional; when absent, `runGate` builds the docker executor from `deps.exec` (today's code moved behind the interface, byte-identical docker args). That is how docker stays the default and existing tests are untouched.
2. `K8sGateExecutor` (`server/exec/k8s-gate-executor.ts`), all through the injected `Exec` calling `kubectl -n <namespace>`:
   - Pre-clean `job/<name> secret/<name>` (a resumed run may have left them), then one `kubectl apply -f -` on stdin with a `List` of a per-run Secret (only the secrets the gate declares, `stringData`, never on argv) and the Job.
   - Job: `backoffLimit 0`, `activeDeadlineSeconds = ceil(timeout)`, `ttlSecondsAfterFinished` as a safety net, `automountServiceAccountToken false`, pod `runAsNonRoot` with numeric uid/gid and `fsGroup`, container `allowPrivilegeEscalation false`, drop ALL caps, `seccompProfile RuntimeDefault`, cpu/memory limits, `workingDir /work`, `HOME=/tmp`, secrets via `secretKeyRef`, the worktree from the workspace PVC at `/work` using `subPath`, plus a second read-only `subPath` mount of `<worktree>/.git` over `/work/.git` (same protection as the docker bind). Label `teams-ai.dev/network: egress|deny` from `gate.network`.
   - Wait by polling `kubectl get job -o json` (injected sleep/clock). Terminal when a `Complete` or `Failed` condition is true; reason `DeadlineExceeded` is a timeout (`timedOut`, exit null, classified infra by `classifyGate`). A pod stuck in `ImagePullBackOff`, `InvalidImageName` or `CreateContainerConfigError` aborts early with an infra error. A client-side backstop (timeout plus 60 s) also yields a timeout.
   - Exit code from the pod's terminated container state; `OOMKilled` is added to stderr so the existing infra pattern fires. Output is `kubectl logs job/<name> --tail=500` (stdout and stderr are merged by Kubernetes, so it goes to `stdout`).
   - `finally`: `kubectl delete job/<name> secret/<name> --ignore-not-found --wait=false` always runs, including after an apply failure.
3. JUnit: simplest robust choice is the shared workspace volume. The Job writes the report under `/work/<junitPath>`, which is the same files the orchestrator sees under the worktree, so `runGate` keeps reading it with `deps.readFile`. No `kubectl cp` (needs a live pod and `tar` in the image) and no sidecar. Cost: the worktree must be on the shared PVC.
4. Config `executor` section: `kind` (`docker` default | `k8s`), `namespace` (`teams-ai`), `serviceAccount` (`default`), `workspacePvc` (`teams-ai-data`), `workspaceRoot` (`/root/.teams-ai`, the orchestrator-side mount path), `workspaceSubPath` (`teams-ai`), `runAsUser`/`runAsGroup` (1000). `createGateExecutor(cfg.executor, exec)` selects the implementation; `cli.ts` puts it on `RunDeps.gateExecutor`; `run.ts` passes it to `runGates` and `runSmoke`.
5. Smoke URL: new optional `DeployTarget.gateServiceUrl(intent)`, the URL as seen from a gate pod. `KindTarget` returns `http://<project>.<namespace>.svc.cluster.local:<port>` and gets an optional `namespace` dep (adds `--namespace` to its kubectl calls only when set). `deploy.ts` passes it as a third argument to `deps.smoke`; `run.ts` uses it as `SERVICE_URL` only when the executor is `k8s`.

## Files

New: `server/exec/k8s-gate-executor.ts`, `server/exec/gate-executor.ts`, `test/exec/k8s-gate-executor.test.ts`, `test/exec/gate-executor.test.ts`. Edited: `gate-runner.ts`, `smoke.ts` (no change needed if `GateDeps` carries the executor), `server/config/config.ts`, `server/cli.ts`, `server/orchestrator/run.ts`, `server/orchestrator/phases/deploy.ts` and `shared.ts` (smoke arg), `server/deploy/target.ts`, `server/deploy/kind.ts`, their tests.

## Verification

Golden JSON for the Job and Secret manifests (egress and deny); lifecycle with `FakeExec` (success, non-zero exit, OOM, deadline, client backstop, image pull stuck, apply failure, cleanup always runs, secret values never on argv); docker is the default (`createGateExecutor` and `runGate` without an executor); KindTarget `gateServiceUrl`; config default. `npx tsc --noEmit`, `npx vitest run`.
