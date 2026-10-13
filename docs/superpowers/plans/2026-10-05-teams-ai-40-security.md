# Plan 40 — Security block after the k8s removal (docs/superpowers/plans/2026-10-05-teams-ai-40-security.md)

## Context

The single-container compose (R6.1 superseded) brought back audit H4 and left C1/H3 half open. Today the backend
container mounts the real `/var/run/docker.sock` (`docker-compose.yml:26`, `group_add`), so the agent-written
`docker-compose.yml`, Dockerfile and gate image run with host-root power through `compose up --build`
(`server/deploy/docker-local.ts`) and `docker run` (`server/exec/gate-runner.ts`). The k8s egress allowlist is gone.
Decisions (human, 2026-10-05): isolate the daemon with a **rootless DinD sidecar**; **no egress restriction** for
agent steps (accepted risk, documented). Goal: nothing an agent writes reaches the host daemon or the orchestrator's
secrets.

## Approach

### 1. Rootless DinD sidecar (H4)

- `docker-compose.yml`: add service `dind` (`docker:27-dind-rootless`, no `privileged`, `seccomp/apparmor:unconfined`
  only if rootless needs them), own volume for its image cache, TLS off on a private compose network. Backend loses the
  socket mount and `group_add`; gets `DOCKER_HOST=tcp://dind:2375` (network not published to the host).
- `Dockerfile`/`docker/config.json`: `docker.bindRewrite` now maps `/home/node/.teams-ai` to the path the nested daemon
  sees; share the data volume read-write with `dind` at the same path so bind sources need no rewrite (preferred,
  removes `rewriteBindSource` use). `serviceHost` becomes `dind`, `publishBind` `0.0.0.0` inside the nested daemon.
- Smoke/e2e gates and the orchestrator reach the deployed service through `dind:<port>`; `gateReachableUrl`
  (`server/exec/smoke.ts:13`) and `gateNetwork` keep working through the nested network.
- Hardening of the backend container: `cap_drop: [ALL]`, `no-new-privileges` where bwrap allows it, drop `group_add`.
- Gate containers (`dockerArgs`, `server/exec/gate-runner.ts:68`): add `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--pids-limit`; reject a `plan.gateImage` that starts with `-` (validator in `server/validators/plan.ts`).

### 2. Agents cannot reach docker or secrets (C1/H3)

- Probe first (read-only, no cost): from an agent step under the real sandbox, try to read
  `/home/node/.teams-ai/secrets`, `/home/node/.config/gh` and the old socket path; record in the plan whether bwrap
  confines reads outside the worktree. Script: `scripts/wsl/probes/p8-agent-reach.sh`.
- If reads are not confined: move secrets and `gh` config out of the agent's uid view (agent steps run as a second
  uid, secrets directory mode 0700 owned by the orchestrator uid) and add absolute-path deny rules in
  `server/runner/role-settings.ts` (the current `~` rules resolve against the step HOME, not the orchestrator's).
- Remove the `docker`, `gh` binaries from the agent's PATH (steps run with a PATH that excludes `/usr/local/bin/docker`;
  `sanitizeEnv` in `server/runner/invocation.ts`), keeping them for the orchestrator's `Exec`.
- Not changed: egress (accepted), the credential copy in the step HOME (still needed by the CLI; mode 0400,
  refresh gate from plan 38).

### 3. Regression tests

- `test/infra/compose.test.ts` (new): parses `docker-compose.yml` and `Dockerfile` like `runner-security.test.ts:36`
  reads `config.example.json`; asserts no `docker.sock` mount, no `privileged`, `DOCKER_HOST` points at `dind`, the port
  is loopback only, `cap_drop` present.
- `test/exec/gate-runner.test.ts`: `dockerArgs` contains the new flags; image starting with `-` is refused.
- `test/validators/plan.test.ts`: `gateImage` validation.
- `test/runner/runner-security.test.ts`: the agent PATH has no `docker`/`gh`; absolute secret paths are denied.
- `test/deploy/docker-compose.test.ts`: unchanged command lines (`FakeExec` prefix `P`), env gains no socket path.

## Critical files

`docker-compose.yml`, `Dockerfile`, `docker/config.json`, `server/exec/gate-runner.ts`, `server/exec/smoke.ts`,
`server/deploy/docker-local.ts`, `server/runner/role-settings.ts`, `server/runner/invocation.ts`,
`server/validators/plan.ts`, `docs/superpowers/security/2026-10-04-system-audit.md` (status update), `ROADMAP.md`.

## Verification

1. `npx tsc --noEmit` and `npx vitest run` green (new tests included).
2. `docker compose config` valid; `docker compose up -d --build` starts backend + dind; UI answers 200 on
   `http://localhost:8787`; `docker exec` into backend: `docker ps` lists only the nested daemon's containers and the
   host's containers are not visible.
3. `spec deploy --target docker-local` on the `hello-app` fixture (no Claude tokens): build, compose up, smoke OK
   through `dind`, `down -v` clean.
4. Probe `p8-agent-reach.sh` on the real CLI (about $0.02): the agent cannot read secrets or run docker.
5. Update the audit (C1/H3/H4 status) and ROADMAP; commit to `main`.

## Risks and cost

- Rootless DinD may need relaxed seccomp/AppArmor; image cache is lost on volume reset (slow first build).
- Port publishing now happens in the nested daemon: a UI link to a deployed service must go through `dind`, not
  `localhost`; check `serviceHost` consumers first.
- Cost: no agent run except the probe (about $0.02); the golden runs are unaffected until redone.

## Outcome (2026-10-05, unit level)

Built: `dind` rootless sidecar, no host socket and no `group_add`, `cap_drop: ALL` on the backend, shared data volume at the
same path (no `bindRewrite`), `serviceHost: dind`; gate containers get `--cap-drop ALL`, `no-new-privileges`, `--pids-limit 512`;
a `gateImage` starting with `-` is rejected; absolute `Read` deny rules for the orchestrator's real HOME
(`hostHome` in `role-settings.ts`); `test/infra/compose.test.ts`. 1018 tests pass, typecheck clean.

Deviations from the plan:
- The `docker` and `gh` binaries stay on the agent PATH (`/usr/local/bin` also holds node, npm and claude, so the directory
  cannot be dropped). With the host socket gone and `DOCKER_HOST` outside the agent env allowlist, `docker` has no daemon to
  reach; the nested daemon is not the host's. Revisit if the probe shows a path to `dind:2375`.
- The probe ran on 2026-10-13 (`scripts/wsl/probes/p8-agent-reach.ts`, not `.sh`): the `Read` deny rules did not stop `cat` on the credential stores, so `sandbox.filesystem.denyRead` now hides them from every command (`server/runner/role-settings.ts`); the same probe then found nothing. The second uid stays open as a stronger layer, and `CLAUDE_CODE_OAUTH_TOKEN` is still in the step environment.

Not verified live: `docker compose up` with `dind-rootless` on this host (user namespaces, port publishing through
rootlesskit, `host-gateway` for the smoke gate) and `spec deploy --target docker-local` through `dind`.
