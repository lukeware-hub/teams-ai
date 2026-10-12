# Plan 83: security audit status, R7.3, R7.4 and R7.6 brought up to date

Status: applied on 2026-10-12 to ROADMAP.md (R7.3, R7.4, R7.6 and the Stage 7b and 7c rows), the audit and spec section 14, with the human's approval. Section 4 stays as the list of real fix tasks.
Checked on 2026-10-12 against the current code (branch `diego-dm-morais/feature`, commit 40e4232).

Tests run (read-only): `npx vitest run` on `test/api/security.test.ts`, `auth.test.ts`, `run-index.test.ts`, `onboarding-api.test.ts`, `ops-routes.test.ts`, `test/runner/runner-security.test.ts`, `role-settings.test.ts`, `test/core/redact.test.ts`, `test/infra/compose.test.ts`, `test/supervisor/supervise.test.ts`: 10 files, 88 tests, all passing.
Not run: `test/api/run-api.test.ts` and `refine-api.test.ts` (large; cited only by reading).

Two premises of the task did not hold, so read this first:
1. Spec section 14 does not describe Kubernetes. It never says Kubernetes except in the `kubectl` deny rule. It is stale in other ways (WSL2, "no secrets", no auth, no mention of compose or the nested daemon). The edits below reflect that.
2. ROADMAP.md has no "R11.7.5 path traversal fix". R11.7.5 is "retired items leave main"; plan 80 also added "no phase writes through a symbolic link from main", which is not an audit finding. The audit's path traversal finding is L1 (`SAFE_ID`), fixed by plan 21.

## 1. Status per finding

Totals: 18 findings. Fixed 13, partially fixed 4, still open 1, moot 0 (no whole finding is moot; only the Kubernetes parts of some fixes are, see section 1.1).

| Id | Severity | Status | Evidence |
|----|----------|--------|----------|
| C1 | Critical | Partially fixed | Fixed: sandbox is mandatory, default `enabled: true` (`server/config/config.ts:144`, `config.example.json:5`); `sandboxPolicyViolation` needs config flag plus env opt-in (`server/runner/sandbox-policy.ts:8-14`) and runs before any phase (`server/orchestrator/run.ts:184`) and again in `runStep` (`server/runner/step.ts:155`); each step gets an empty HOME (`server/runner/step-home.ts` `createStepHome`) and `ENV_ALLOWLIST` (`invocation.ts:31`). Tests: `test/runner/runner-security.test.ts` (sandbox policy, "empty HOME outside the worktree holding only the login"). Remaining: the login credential copy is in the step HOME and readable by the agent (`step-home.ts`, mode 0400 same user; skipped only when `CLAUDE_CODE_OAUTH_TOKEN` or an API key is set); egress is only the sandbox Bash `allowedDomains` (accepted risk, audit status of 2026-10-05); whether the sandbox confines reads outside the worktree is not probed on the real CLI (probe p7 covered login and settings only). |
| H1 | High | Fixed | Bearer token with constant-time compare (`server/api/auth.ts` `tokenEquals`, `bearerOk`), HttpOnly SameSite=Strict cookie on GET only, checked for every `/api/` route (`server/api/server.ts:165`); a non-loopback bind without a token is refused (`auth.ts` `resolveAuth`); allowed Hosts configurable (`TEAMS_AI_ALLOWED_HOSTS`, `security.ts` `parseAllowedHosts`). Tests: `test/api/auth.test.ts`, `test/api/security.test.ts` ("accepts configured Service names", "keeps token protection for a non-loopback Host"). Caveat: in compose the token is empty by default because the port is published on host loopback only (`TEAMS_AI_UI_LOOPBACK_PUBLISHED=1`, `docker-compose.yml`); any container on the compose network (for example `goproxy`) can still call the API with `Host: localhost`. No test for that case. |
| H2 | High | Fixed | JSON content type required for non-GET (415, `server.ts:156`, `security.ts` `isJsonContentType`); cross-site check by `Sec-Fetch-Site` or `Origin` when no bearer (`server.ts:157`, `security.ts` `crossSite`); `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` on every response (`security.ts:8` `SECURITY_HEADERS`). Tests: `security.test.ts` "rejects a state-changing request that is not application/json", "refuses a cross-site browser request", "sends frame, nosniff, referrer and CSP headers". |
| H3 | High | Partially fixed | Done: `find:*` removed from every role (`role-settings.ts` comment above `ROLE_ALLOW`; test "no role may run find"); nested denies added (`NESTED_DENIED`, `server/agents/registry.ts`: `node -e`, `npm exec`, `* gh *`, `* git push*`, and others), and they are declared defense in depth only. Real boundary is the empty HOME and no `DOCKER_HOST` in the agent env. Remaining: `gh` (pinned release binary in `/opt/teams-ai-bin`, `Dockerfile`) and `docker` + compose plugin (`Dockerfile:5-6`) are still on the agent PATH; `node:*`, `npm:*`, `npx:*` still allow arbitrary code; the wildcard deny syntax (`Bash(* gh *)`) is unverified on the real CLI (roadmap 7b says so). |
| H4 | High | Partially fixed | Done: non-root `USER node` (`Dockerfile:42`); no host socket, gates and docker-local deploys on a rootless `dind` sidecar with the Docker API only `expose`d inside the compose network (`docker-compose.yml`); `cap_drop: ALL` on `teams-ai` and `goproxy`; tests `test/infra/compose.test.ts` ("never mounts the host docker socket nor runs privileged", "publishes only the deployed-service port range", "drops every capability"). Remaining: `teams-ai` and `dind` still run `seccomp:unconfined`, `apparmor:unconfined` and `systempaths=unconfined` (needed by bubblewrap and rootless dockerd); no `readOnlyRootFilesystem` or `no-new-privileges` on `teams-ai`; the nested daemon API on `tcp://dind:2375` has no TLS or auth (reachable by any container on the compose network); `docker` CLI stays in the image. The k8s Job path of the fix is moot. Not verified live (roadmap says so). |
| M1 | Medium | Fixed (residual rebinding) | Clone host allowlist, default `github.com` (`config.ts:141`), then private literal, internal name and resolved-address checks (`security.ts` `refuseCloneHost`, called at `run-routes.ts:220`); clone uses `-c http.followRedirects=false clone ... -- url` (`run-routes.ts:86`); the `dir` branch must resolve inside `paths.workspaces` (`run-routes.ts:227-233`); parser errors are replaced by fixed messages (`run-routes.ts:236`). Tests: `security.test.ts` "classifies private ... addresses", "applies the allowlist first"; `run-api.test.ts:185` (`dir` outside the root gives 400). Residual: git resolves the name again at clone time (rebinding window narrowed, not closed; roadmap 7c). No test asserts the `followRedirects` or `--` arguments. |
| M2 | Medium | Fixed (small leftover) | Agents run with `--setting-sources user` against the per-step HOME, never `project` (`invocation.ts:14-17`), so a worktree `.claude/settings.json` is not read; verified on the real CLI by probe B (roadmap 7b); `Bash(*.claude/*)` denied (`registry.ts`). Tests: `runner-security.test.ts` "does not load worktree project settings", "every role denies ... .claude writes". Leftover: `.claude` is still not in `DEFAULT_COMMIT_EXCLUDES` (`server/git/git.ts:24`), so a `.claude/` an agent writes can still be committed (harmless to policy, noise in the repository). |
| M3 | Medium | Fixed | Both paths redact the `ui.log` tail with values read at failure time: `run-routes.ts:156` and `waitForRunJournal` in `server/api/run-control.ts` (covers `refine/registry.ts` and `program/service.ts`); tests "redacts the ui.log tail ... (audit M3/M4)" in `run-api.test.ts` and "audit M3" in `refine-api.test.ts` and `program/service.test.ts`. |
| M4 | Medium | Fixed | The login transcript reads secret values from disk on every chunk (`server/api/onboarding-routes.ts:30-31`, `loadSecretValuesSync`). Test: `onboarding-api.test.ts:167` "masks a secret stored after startup, written through the API or straight to disk". |
| M5 | Medium | Fixed | Caps of 200 streams total and 50 per address (`server.ts:139`, 503 at `:177`); lifetime 30 min and idle 10 min with `event: reconnect` (`server.ts:140`, `:201`); one shared poller per file (`journal-tail.ts`); `headersTimeout` 15 s and `requestTimeout` 60 s (`server.ts:228-229`). Tests: `security.test.ts` "caps concurrent streams", "ends a stream with a reconnect event", "caps streams per remote address". Timeouts and caps are `ApiDeps` options, not read from the config file (roadmap 7c). |
| M6 | Medium | Partially fixed | Done: base image pinned by digest (`Dockerfile:2`), `@anthropic-ai/claude-code@2.1.295` (`:29`), `npm@12.2.0` (`:33`), `graphifyy==0.9.67` (`:24`), `.env*` and `config.json` in `.dockerignore`, `HEALTHCHECK` (`:47`). Remaining: `docker:27-cli`, `golang:1.26-bookworm`, `rust:1-bookworm` and `docker:27-dind-rootless` are tags, not digests; `apt-get install` packages (`:21`) are unpinned. No test checks the pins. |
| L1 | Low | Fixed | `SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/` (`server/api/run-index.ts:12`). Tests: `run-index.test.ts:171` (rejects `.`, `..`, `.hidden`, `...`), `run-api.test.ts:761` (`..%2Fui.log` gives 400). |
| L2 | Low | Fixed | `file.startsWith(path.resolve(dir) + path.sep)` (`server.ts:123`). Test: `security.test.ts:99` "does not serve a sibling directory that shares the prefix". |
| L3 | Low | Fixed | `SECURITY_HEADERS` on API, SSE, 404 and static (`security.ts:8`, applied by `applySecurityHeaders`). Test: `security.test.ts:79`. |
| L4 | Low | Fixed | `PUT /api/refine/.../secrets/:name` returns `{ present: true }` only (`server/api/refine-routes.ts:179`); the list returns the mask `****`. Test: `refine-api.test.ts:428-429`. |
| L5 | Low | Fixed (one gap) | `redactSecrets` also masks URL-encoded and base64 forms in the three byte alignments, and short values as whole tokens (`server/core/redact.ts` `forms`, `base64Forms`, `WHOLE_TOKEN_BELOW`); more key shapes added. Test: `redact.test.ts:44`. Gap: line-wrapped base64 is not masked. |
| L6 | Low | Fixed | One `safeHttpUrl` helper (`web/src/safeUrl.ts`) used in `Markdown.tsx:13`, `TaskDetail.tsx:13`, `LoginCard.tsx:101`, `pages/Run.tsx:337,902`. Test: `web/src/safeUrl.test.ts` (not run here; web tests were not run). |
| L7 | Low | Still open | Spec section 14 is unchanged since 2026-09-23 and still states the guarantees the audit calls false. See section 3. |

### 1.1 Parts of fixes that are moot because Kubernetes was removed
- C1 fix 3 (agent steps as separate Jobs with their own ServiceAccount and a default-deny NetworkPolicy).
- H1 fix part "NetworkPolicy that admits only the ingress proxy"; replaced by loopback publish plus token (compose).
- H4 fix "Jobs through a namespaced ServiceAccount"; replaced by the rootless `dind` sidecar.
- Roadmap 7b "Left" text "the backend pod runs unsandboxed with both opt-ins" is obsolete: the sandbox is on in compose (`docker/config.json` has no opt-in; `docker-compose.yml` sets no `TEAMS_AI_UNSAFE_NO_SANDBOX`).
- Audit scope line "read for a Kubernetes deployment with all NetworkPolicies open" is historical.

## 2. Roadmap

### 2.1 R7.3 (supervisor)
Check: the gap "stopped, hand-resumed, then crashed is never auto-resumed" is not real any more. `stopRequested` in `server/supervisor/supervise.ts:17-24` treats a stop as intentional only while it is the last lifecycle event; a later `RUN_RESUMED` or `RUN_STARTED` lifts it. Test: `test/supervisor/supervise.test.ts:81-88` ("hand resume, then crashed" is resumed; "stopped again" is not). Plan 24 did this and the Stage 7b row already says so, but the R7.3 row was not updated.
Still true: not run live (no live evidence found); `supervise` watches one project directory (`--project`), and nothing in `docker-compose.yml` starts it, so in the compose setup interrupted runs are resumed only by hand or by `teams-ai supervise` run inside the container.

Current row (line 245):
```
| R7.3 | Supervisor, plan 16 (`teams-ai supervise`) | done, unit | not run live; a run stopped, hand-resumed, then crashed is never auto-resumed |
```
Proposed row:
```
| R7.3 | Supervisor, plan 16 (`teams-ai supervise`) | done, unit | not run live; a hand resume lifts an earlier stop, so a crash after it is resumed (plan 24, `supervise.test.ts`); it watches one project and compose does not start it |
```

### 2.2 R7.4 (security audit)
Current row (line 246):
```
| R7.4 | System security audit (`docs/superpowers/security/2026-10-04-system-audit.md`) | done | 1 critical, 4 high, 6 medium, 7 low, none fixed yet |
```
Proposed row:
```
| R7.4 | System security audit (`docs/superpowers/security/2026-10-04-system-audit.md`), status checked against the code on 2026-10-12 | done | 18 findings: 12 fixed (H1, H2, M1, M2, M4, M5, L1-L6), 5 partly (C1 credential copy readable and no real-CLI proof of read confinement, H3 `gh`/`docker` still on the agent PATH, H4 compose still runs `seccomp`/`apparmor` unconfined and the nested daemon API has no auth, M3 `waitForRunJournal` tail unredacted, M6 helper images not pinned by digest), 1 open (L7, spec section 14 not rewritten); Kubernetes-only fixes are moot |
```

### 2.3 R7.6 (ops)
Facts: `/healthz` and `/metrics` exist and are tested (`server/api/ops-routes.ts`, `test/api/ops-routes.test.ts`). Compose uses the Dockerfile `HEALTHCHECK` on `/` (answers below 500), not `/healthz`. `docs/superpowers/ops/runbook.md` is Kubernetes only (title, Deployment scale, PVC, kubectl, probes with `Host: localhost`, CronJob backup). The three files it links (`deploy/k8s/ops/restore-runbook.md`, `secret-rotation-runbook.md`, `backup.yaml`) do not exist (no `deploy/` directory). No backup of any kind exists for compose.

Obsolete (cluster or CronJob only): "Start and stop the service" (scale, rollout, port-forward), the probe YAML and the scrape Host remark, "Incident basics" items 1, 2, 6, the three links, the `/root/.teams-ai` paths (now `/home/node/.teams-ai`), and the backup CronJob. Still valid: Runs, Quota pauses, Reading the journal (with `docker compose exec teams-ai` instead of `kubectl exec`), the `/healthz` and `/metrics` text, run status values.
README.md line 436 already calls the runbook historical for `kubectl`.

Current row (line 248):
```
| R7.6 | Ops: `/healthz`, `/metrics`, backup CronJob, runbooks (`docs/superpowers/ops/`) | done, unit | not run in a cluster |
```
Proposed row:
```
| R7.6 | Ops: `/healthz`, `/metrics` (unit tested) and a runbook (`docs/superpowers/ops/runbook.md`) | partly obsolete | the runbook and the backup CronJob were written for Kubernetes, which was removed; the runbook links three files that do not exist and there is no backup for the compose volumes (`teams-ai-data`, `teams-ai-claude`, `teams-ai-gh`, `dind-data`); compose health uses the image `HEALTHCHECK` on `/`, not `/healthz` |
```
Follow-up (a real task, see section 4): rewrite the runbook for compose and add a volume backup and restore.

### 2.4 Stage 7b and 7c rows that mention these
Stage 7b, row "R7.4 runner (plan 20, audit C1/H3/M2)", column "Left". Current end of the cell: `...the credential copy is still readable by the agent; the backend pod runs unsandboxed with both opt-ins until agent steps are their own pods`. Proposed replacement of that last clause:
`the credential copy is still readable by the agent; the compose container runs sandboxed (no opt-in set), so the pod remark of 2026-10-04 is obsolete; the `gh` and `docker` binaries are still on the agent PATH`.
(Keep the rest of the cell unchanged. Also in the same cell, `Still unverified: the wildcard deny syntax` stays true.)

Stage 7b, row "R7.4 API (plan 21, ...)", column "Left". Current: `SSE idle timeouts; clone allowlist is `github.com` only by default; DNS-rebinding window on clone`. Proposed:
`clone allowlist is `github.com` only by default; DNS-rebinding window on clone (narrowed in plan 25, not closed); `waitForRunJournal` still returns an unredacted `ui.log` tail to the refine start route (M3)`.
(SSE idle timeouts were added by plan 25, Stage 7c, so that item is stale.)

Stage 7b, row "Orchestrator (plan 24)", column "Left": `supervise CLI test covers argument validation only` is stale (plan 27 tests the loop through `main()`). Proposed: `supervise is not run live`.

Stage 7c, bullet "Supervise CLI test". Current ends with: `` `docker-compose.yml` no longer mounts the Docker socket or `/root` (not validated with `docker compose config`) ``. Proposed ending:
`` `docker-compose.yml` no longer mounts the Docker socket or `/root`; `test/infra/compose.test.ts` now checks the compose file ``.

Stage 7c, bullet "SSE lifetime": current says `Timeouts are ApiDeps options, not yet read from the config file.` Still true; no edit.

Audit file (separate edit, after approval): add under "Status update 2026-10-05" a new block "Status update 2026-10-12 (plan 83)" with the table of section 1, and replace the scope sentence "read for a Kubernetes deployment with all NetworkPolicies open" by "read for a Kubernetes deployment (since removed; the system is one compose container plus a rootless dind sidecar)".

## 3. Spec section 14 (`docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md`, lines 505-511)

Current text has five bullets. There is no Kubernetes text to remove. Exact edits:

1. Bullet 1. Replace `Agents run in the Claude Code sandbox in WSL2: filesystem limited to the working directory, network limited to an allowlist.` with:
   `Agents run in the Claude Code sandbox (bubblewrap), which is mandatory; running without it needs both a config flag and an environment opt-in. Network access of Bash is limited to an allowlist; the sandbox does not limit other egress (accepted risk).`
2. Bullet 2. Replace `Agents have no GitHub token, no secrets and no cloud credentials in their environment; `gh`, `git push`, `docker` and `kubectl` are denied.` with:
   `Each agent step runs with an empty home directory and an allowlisted environment, so it has no GitHub token and no secrets store; the only credential in it is a copy of the Claude login. `gh`, `git push`, `docker` and `kubectl` are denied by rules that match command text only, so the real protection is the empty home, not the rules.`
3. Bullet 3. Keep, and append: `They run on a rootless Docker daemon in a separate container (`dind`); the host Docker socket is never mounted.`
4. Bullet 4. Keep.
5. New bullet after 4: `The API requires a bearer token when it listens beyond loopback; in the compose setup the port is published on the host loopback only and the token is optional. State-changing requests must be JSON and same-origin, responses carry framing and content security headers, and clone sources are limited to an allowlist of hosts (default `github.com`).`
6. Last bullet ("Residual risk"). Replace with:
   `Residual risk (accepted): the Claude login copy in each step home is readable by the agent; `gh` and `docker` binaries are still on the agent path; the app container and the nested daemon run with `seccomp` and `apparmor` unconfined (needed by bubblewrap and rootless Docker); the nested Docker API has no authentication inside the compose network; isolation relies on the sandbox and the empty home, not on separate operating system users.`

Also (outside section 14, same stale WSL2 wording): none needed for this plan; line 22, 130, 151 only mention `kubectl` as a denied command and stay.

## 4. Open findings that deserve a real fix task

1. M3 (small): redact the `ui.log` tail inside `waitForRunJournal` (`server/api/run-control.ts:88`) so `refine/registry.ts:259` and `program/service.ts:103` are covered; one test per caller. Cheapest, real leak.
2. H4/H1 (medium): add `no-new-privileges` and a read-only root filesystem with a tmpfs where possible to `teams-ai`; require a token or a private network for `dind:2375`; test in `test/infra/compose.test.ts`.
3. C1/H3 (medium): remove `gh` and the `docker` CLI from the agent PATH (agent steps get a PATH without them, or the image keeps them in a path outside `PATH` the orchestrator adds for itself); add a test on `invocation.ts` env.
4. C1 (needs a real CLI session, about US$ 0.05): probe that the sandbox blocks reads outside the worktree and that the `Bash(* gh *)` deny syntax works; record the result in the audit.
5. M6 (small): pin `docker:27-cli`, `golang`, `rust` and `docker:27-dind-rootless` by digest; add a test that every `FROM`/`COPY --from` has a digest.
6. R7.6 (medium): rewrite `docs/superpowers/ops/runbook.md` for compose (paths, `docker compose exec`, no CronJob), add a documented backup and restore of the four volumes, and point the compose healthcheck at `/healthz`.
7. L7 and the audit and roadmap edits of this plan (docs only): apply sections 2 and 3 after approval.
8. Minor: add `.claude` to `DEFAULT_COMMIT_EXCLUDES` (`server/git/git.ts:24`) to close the M2 leftover; add a test that the clone command keeps `followRedirects=false` and `--`.

## 5. Could not verify
- Anything that needs a live container or the real `claude` CLI: sandbox read confinement, the `Bash(* gh *)` deny syntax, the compose file under `docker compose config`, `supervise` live.
- Web tests (`web/src/safeUrl.test.ts`) and the large API tests were not run.
- Whether any other session already changed `server/refine/*` after commit 40e4232 (the worktree was clean when read).
