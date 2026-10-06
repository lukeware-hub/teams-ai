# Plan 41: published service card, links, status and start

Status: **implemented 2026-10-06** (approved by the human the same day). Changes against the plan as written:

- The spike passed: host `localhost:3000` reaches a container in `dind` through the published range.
- `kind` and `docsPath` went into `plan.deploy` (the SM writes the plan), not into the devops `DeploymentOutput`; the SM plan rules state them.
- The port range is enforced by the SM prompt only; a port outside it still deploys and the card says it cannot be opened from the host.
- The browser URL is built in the page (`http://<hostname the UI was opened from>:<port>`), so no `browserHost` config.
- The start route is `POST /api/projects/:projectId/specs/:specId/deploy` (same lock as complete and readme); the status route is `GET /api/runs/:runId/service`, and for reports without a health path any HTTP answer counts as online.
- The devops compose rule now writes `ports: ["<port>:<port>"]` (no `127.0.0.1`): a loopback binding inside `dind` would never be reachable from the host.
- Live check done on `hello-001-r13`: offline card, "Subir serviço" ran `hello-001-deploy-r1` (done), the container came up healthy, `localhost:3000/health` answered from the host, and the card turned "No ar". The new `kind`/`docsPath` values still need a paid run to appear for real.

## Goal

On the Validation page, the "Serviço publicado" card lets the human, without leaving the UI:

1. see whether the deployed service is online right now;
2. open the API docs (Swagger) when the project is an API;
3. open the app when the project is a front-end;
4. start the service again when it is offline, with no agent involved.

## Decisions (human, 2026-10-06)

- **Start** is done by the orchestrator through the existing docker-local deploy (`spec deploy`, `Run.deployOnly`), never by an agent: agents must not run `docker` (spec §1.2) and a click must not spend tokens.
- **Reachability:** the service port is published on the host. Today the report URL is `http://dind:3000`, a compose-internal name the browser cannot open.
- **Scope:** API and front-end together.

## Findings that shape the plan

- `DeploymentOutput` / `plan.deploy` carry `image, port, healthcheckPath, manifests`; there is no project kind and no docs path (`server/agents/outputs.ts:111`, `server/contracts/plan.ts:89`).
- `Report.service` is built from the `DeployVerified` event (`server/orchestrator/phases/report.ts:39`, `server/orchestrator/phases/deploy.ts:85`); it has `url, healthcheck, smoke, e2e` only.
- No API route deploys or checks health. `POST .../specs/:specId/complete` (`server/api/run-routes.ts:272`) is the template for a launch route; `RunTarget.mode` in `server/api/run-control.ts:20` has no `deploy` mode.
- `dind` publishes nothing to the host (`docker-compose.yml`, `expose: 2375` only). Services are published inside dind's network namespace on `0.0.0.0`.
- The compose `ports:` list must be static, but the service port comes from the plan.

## Approach

### A. Reachable URL (spike first)

- `docker-compose.yml`: publish a fixed port range from `dind` to host loopback, `127.0.0.1:3000-3019:3000-3019` (range name and size to confirm). Loopback only, same rule as the UI.
- `docker/config.json`: new `docker.browserHost` (default `localhost`); the report gets `service.browserUrl = http://<browserHost>:<port>`. The orchestrator keeps using `serviceHost` (`dind`) for its own checks.
- Devops prompt (`.claude/agents/devops.md`) and the plan validator: `deploy.port` must be inside the published range; otherwise the plan is rejected with a clear message.
- **Spike (blocks the rest):** prove host -> dind -> rootless port forward works on Docker Desktop (WSL2) with one container on port 3000. If it does not, fall back to a reverse proxy in the UI server and revisit this plan.

### B. Project kind and docs path

- Add to `DeploymentOutput` and `plan.deploy`: `kind: 'api' | 'front'` and optional `docsPath` (for example `/docs`, `/swagger`). Devops fills them from the stack it chose; the plan validator requires `docsPath` to start with `/`.
- Carry `kind`, `docsPath`, `port` and `healthcheckPath` in the `DeployVerified` event and into `Report.service` (server `Report` and `web/src/api.ts`).
- Old reports without these fields keep working: the card shows the status and one generic "Abrir serviço" button.

### C. Status and start

- `GET /api/runs/:runId/service`: the orchestrator calls `httpGet(baseUrl + healthcheckPath)` and returns `{ online, status, checkedAt }`. Read-only, no lock.
- `POST /api/runs/:runId/service/start`: same shape as the complete route (spec lock, 409 on a competing run, 202 `{ runId }`). New `deploy` mode in `run-control.ts` maps to `spec deploy --project --spec --target docker-local`. Allowed only when the spec is `awaiting-validation` or `done`, as the CLI already requires (`server/cli.ts:172`).
- The page polls the status after a start (5 s, same pattern as the completion run) and shows the failure reason if the deploy run ends `deploy-failed`.

### D. UI (`web/src/pages/Validation.tsx`, `validation.css`)

- Status chip "No ar" / "Fora do ar" / "Verificando" in the card header, plus "Verificar de novo".
- Buttons, all pt-BR: "Abrir Swagger" (kind `api` and `docsPath` present), "Abrir aplicação" (kind `front`), "Subir serviço" (offline only, disabled while a deploy run is live).
- Links open `browserUrl` + path in a new tab with `rel="noreferrer"`, through the existing `safeHttpUrl`.

## Files touched

`docker-compose.yml`, `docker/config.json`, `server/config/config.ts`, `server/agents/outputs.ts`, `server/contracts/plan.ts`, `.claude/agents/devops.md`, `server/orchestrator/phases/deploy.ts`, `server/orchestrator/phases/report.ts`, `server/api/run-routes.ts`, `server/api/run-control.ts`, `web/src/api.ts`, `web/src/pages/Validation.tsx`, `web/src/pages/validation.css`, plus tests next to each.

## Verification

1. Tests first, red then green: schema (`kind`, `docsPath`, port range), report carries the new fields, the status route (online/offline), the start route (202, 409, wrong spec state), and the Validation card for api, front, offline and old report.
2. `npm test`, `npm run test:web`, `npm run typecheck`.
3. Live, no tokens: `task up`, run `spec deploy` for an existing spec, open `http://localhost:<port>/health` from the host browser, stop the container, confirm "Fora do ar", click "Subir serviço", confirm "No ar".
4. New `kind` and `docsPath` values only appear on a run made after the devops prompt change (paid run). Until then the card is verified with a fixture report.

## Cost and risk

- Implementation and steps 1-3 above spend no model tokens.
- Step 4 is one paid golden-style run; a cheaper option is to patch `plan.json` of `hello-001` by hand and use `spec deploy` (no agent).
- Risks: rootless port forwarding (spike), host ports 3000-3019 already in use on the machine, and the single fixed range limiting concurrent projects (one port per running service).
- The spec lock means "Subir serviço" cannot start while another run owns the spec.

## Out of scope

Authentication for the app itself, stopping a running service from the UI, multiple services per project, a proxy path unless the spike fails.
