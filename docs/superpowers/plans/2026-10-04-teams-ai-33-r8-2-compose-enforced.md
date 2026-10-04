# Plan 33: R8.2 compose enforced for docker-local

Goal: the docker-local target deploys with `docker compose` when `plan.delivery.compose` is declared, and the smoke gate reaches the service by its compose service name on the project network (the old SERVICE_URL=127.0.0.1 hit the gate container's own loopback).

1. DevOps contract (devops.md): compose file at `plan.delivery.compose`, service named like the project id, `image: ${TEAMS_AI_IMAGE:-...}`, `build: .`, healthcheck, default network only.
2. `DeploymentIntent.compose` filled from `plan.delivery.compose` in `deployIntent`.
3. `DockerLocalTarget`: validate `compose config --quiet`; apply `up -d --build --wait` (project `teams-ai-<projectId>`); verify = compose health status + HTTP; rollback `up -d --no-build --wait` with the previous tag, or `down` when no previous; destroy `down -v`. Without a compose file the single `docker run` path is unchanged.
4. Smoke seam: optional `DeployTarget.gateNetwork`, `gateServiceUrl` returns `http://<service>:<port>`; `GateContext.network` makes the docker gate join `<project>_default`.

Tests (fake Exec): test/deploy/docker-compose.test.ts.
Not provable without Docker: real compose healthchecks, network DNS name resolution, `--wait` semantics, project-name normalization.
