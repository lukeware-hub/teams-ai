# Phases 4–6 and the Validation screen — design

Block C of the web UI (POC spec §6 phases 4–6, "Validation (human)", and §11 screen 4). Depends on block A (`2026-09-24-run-api-execution-ui-design.md`: run API, Execution screen) and block B (`2026-09-24-refinement-ui-design.md`: "Continue spec", Phase 0).

## 1. Purpose

Take a run from "every task merged" to a deployed service with a report the human can validate in the browser, and close the loop: a problem found in validation reopens refinement on the same spec; a clean validation marks the spec `done`.

### 1.1 Success criteria

- The hello-app fixture reaches `awaiting-validation` on both `docker-local` and `kind`, with the smoke tests of every `smoke: true` AC passed against the running service.
- Every AC has passed evidence in the integrated run on `main` (Phase 4) or belongs to a blocked task listed in the report.
- A deploy failure after `apply` leaves the previous image serving; a fix reaches `main` through a PR with gates, never by hand.
- The Validation screen shows the service URL, healthcheck, smoke results, exploratory script, assumptions, blocked tasks and evidence matrix from the journal alone.
- "Report problem" opens the Refinement screen with the report prefilled without touching git; "Complete spec" sets `status: done` on `main` through a journaled child process.
- `npm test` covers phases 4–6 with the fake `claude`, a scripted `Exec` and a fake `DeployTarget`, killing and resuming after every intent.

### 1.2 Non-goals

- Cloud deploy targets; database migrations and rollback of schema changes (POC §1.4).
- Decision 7 (validation report routing by System 1); its call site is named in §5.
- More than one fix round in Phase 4 and more than three deploy attempts in Phase 5 (POC §6).
- Editing the exploratory script or the report from the UI.

## 2. Architecture

```
server/orchestrator/phases/verify.ts     Phase 4: gates + full test on main, evidence matrix, one round of fix tasks
server/orchestrator/phases/deploy.ts     Phase 5: intent from plan.deploy, runDeployment, smoke gate, deploy-fix tasks, ≤3 attempts
server/orchestrator/phases/report.ts     Phase 6: SM report step, report.json + status awaiting-validation via docs PR
server/orchestrator/run.ts               phase 3 `complete` → phase 4; new terminal results
server/exec/smoke.ts                     smoke gate: SERVICE_URL, JUnit filtered by smoke ACs
server/deploy/target.ts                  + serviceUrl(intent)
server/contracts/plan.ts                 Commands + smoke?: string
server/cli.ts                            teams-ai spec complete --project <dir> --spec <id>
server/api/run-routes.ts                 report in GET /runs/:runId; POST .../complete
web/src/pages/Validation.tsx             /runs/:runId/validation
```

No new dependency. Every side effect stays `intent → effect → confirm` in the run journal; the UI process never writes to git.

## 3. Phase 4 — Integrated verification

Entered when Phase 3 ends with every task `merged` (today's `complete`). `PHASE_STARTED {4}`.

1. Fresh checkout of `origin/main` in `workspaces/<projectId>/repo` (`git fetch && git checkout --detach origin/main`).
2. `runGates(blocking, repo)` — the plan's blocking gates, then the full `commands.test` (already one of the gates; run here on `main`, not on a worktree). Gate failures are triaged as in Phase 3 (`triageGateFailure`); `infra`/`flaky` rerun the gate, `code`/`dependency` count as a verification failure.
3. `buildEvidenceMatrix(spec.acceptanceCriteria, tasks, junit)`; `readyForValidation(rows)` must hold for every AC whose tasks are not `blocked`.
4. On success: `VERIFICATION_PASSED {matrix}` → Phase 5.
5. On failure (first time): `VERIFICATION_FAILED {failedTests, uncoveredAcs, round: 1}`; `runAgentStep({kind: 'fix-tasks', role: 'sm'})` with the failed test ids, JUnit tails, uncovered ACs, the plan and the module boundaries. Output:

   ```ts
   FixTasksOutput = { specHash, tasks: PlanTask[] }   // 1..3, ids `fix-<n>`, criteriaRefs ⊆ spec ACs, dependsOn within the plan or empty
   ```

   Validated with `validatePlan` on the plan with the fix tasks appended. `FIX_TASKS_PLANNED {tasks}` (reduced like `TASK_PLANNED`; tasks carry `origin: 'fix'`). The run returns to Phase 3 for those tasks, then re-enters Phase 4 with `round: 2`.
6. On failure in round 2, or when `fix-tasks` fails validation twice: `RUN_FINISHED {result: 'verification-failed'}` after Phase 6 (the report is still produced, §5).

## 4. Phase 5 — Deploy

`PHASE_STARTED {5}`. The intent is `plan.deploy` (image, port, healthcheckPath, manifests — frozen with the plan) plus `project.deploy.target`, `secretNames` = the union of `spec.externalDependencies[].secretNames`, `tag` = short sha of `origin/main`, `contextDir` = the Phase 4 checkout. `DeploymentOutput` and a separate `deployment.json` are not used: the infrastructure task delivers the Dockerfile and the manifests the plan names, and `validate` checks they exist.

Per attempt (≤3):

1. intent `DEPLOY_APPLY {attempt, image, tag}`; `runDeployment(target, intent)` (existing: validate → build → apply → verify with rollback); confirm `DEPLOY_APPLIED {previous}` or fact `DEPLOY_FAILED {attempt, stage, detail, rolledBack, rollbackHealthy}` (+ `ROLLBACK_DONE` when it rolled back).
2. Smoke gate (`server/exec/smoke.ts`): when any AC has `smoke: true`, `plan.commands.smoke` is required (plan validation, §7) and runs as a gate in `gateImage` with `network: 'egress'`, env `SERVICE_URL=<target.serviceUrl(intent)>`, `junitPath` as usual. The JUnit is filtered to test names carrying a smoke AC id; each smoke AC needs one `passed` result. Failure → `DEPLOY_FAILED {stage: 'smoke'}` and rollback via `target.rollback(intent, previous)` when `previous` exists. Success → `DEPLOY_VERIFIED {url, smoke: [{acId, testId, status}]}` → Phase 6.
3. On failure with attempts left: `runAgentStep({kind: 'dev', role: 'devops'})` on a worktree `task/<specId>-deploy-fix-<n>` with the stage, detail, log tail, manifests and Dockerfile as the pack. The output is the normal `DevOutput`; the synthetic task `deploy-fix-<n>` (`origin: 'deploy-fix'`, `owner: 'devops'`, `affectedPaths` = manifests + Dockerfile, `criteriaRefs: []`) goes through the Phase 3 state machine (gates, review, merge queue) with its own 3 attempts. When it merges, the next deploy attempt starts from the new `main`. If it blocks, the phase ends.
4. Attempts exhausted or fix task blocked: `RUN_FINISHED {result: 'deploy-failed'}` after Phase 6.

`serviceUrl(intent)`: `http://localhost:<port>` for `docker-local`; for `kind`, `http://localhost:<nodePort>` from the Service the manifests declare (read with `kubectl get svc -o jsonpath` after apply).

Reconcile for `DEPLOY_APPLY`: `target.currentImage(intent)` equals `image:tag` → confirm; otherwise redo the attempt (rollback state is re-derived from `currentImage`, never from memory).

## 5. Phase 6 — Report

`PHASE_STARTED {6}`. Runs after Phase 5 succeeds and also on `verification-failed` and `deploy-failed`, so every run ends with a report.

1. `runAgentStep({kind: 'report', role: 'sm'})` (contract `ReportOutput` exists) with: delivered and blocked tasks with reasons, the evidence matrix, the run's assumptions (`SPEC_GAP_ANSWERED`), the deploy outcome and URL, token totals per role. The SM writes `summary`, `exploratoryScript` (one entry per AC), `assumptions` in prose.
2. The orchestrator assembles `Report`:

   ```ts
   Report = { runId, specId, specHash, result, service: { url, healthcheck, smoke[] } | null, deploy: { attempts, lastFailure? },
              evidence: EvidenceRow[], delivered[], blocked[], assumptions[], exploratoryScript[], tokens: { byRole, total, costUsd }, summary }
   ```

   Written to `docs/specs/<specId>/report.json`; on `awaiting-validation`, `spec.json.status` is set to `awaiting-validation` in the same commit. Docs worktree `docs/<specId>-report`, `MergeQueue.submit` with no gates, PR `docs(<specId>): report`. Events: intent `DOCS_COMMIT`, confirm `DOCS_MERGED {pr}`, then `REPORT_READY {report}`.
3. `RUN_FINISHED {result}` with `result` ∈ `awaiting-validation | verification-failed | deploy-failed`. Exit codes: 0, 2, 2.

Decision 7 (POC 10A.5) call site: between "Report problem" and the refinement session, to route the report text to PO or SM first; today both receive it as history.

## 6. Spec lifecycle after the run

- **Report problem** (`POST /projects/:projectId/specs/:specId/report-problem { text }`): 409 unless the spec is `awaiting-validation` on `main`. Calls block B's "Continue spec" with `validationReports` extended by `{ at, text }` in the draft's `spec.json` and the text as the "Validation report" section of `brief.md`. Returns the session id; the UI navigates to `/refine/...`. No git write; the next Start commits the spec (with the report entry) through Phase 0.
- **Complete spec** (`POST /projects/:projectId/specs/:specId/complete`): 409 unless `awaiting-validation`. Spawns `teams-ai spec complete --project <dir> --spec <id>` detached (block A's `spawnRun` with `mode: 'complete'`, journal `runs/<specId>-complete-r<N>/`). The command sets `status: 'done'` on a docs worktree and merges `docs(<specId>): done` through the merge queue (`DOCS_COMMIT`/`DOCS_MERGED`), then `RUN_FINISHED {result: 'done'}`. The UI polls `GET /projects` until the spec shows `done`.

## 7. Contract changes

- `Commands.smoke?: string` — required by `validatePlan` when any AC has `smoke: true`; error otherwise. It runs against `SERVICE_URL` and must emit JUnit to `junitPath`.
- `PlanTask.origin?: 'plan' | 'fix' | 'deploy-fix'` (default `plan`) — set by the orchestrator, never by the SM; the UI shows it as a tag.
- New step kinds `fix-tasks` and `report` outputs as above (`report` exists; `fix-tasks` is new). `.claude/agents/sm.md` gains sections for both; `devops.md` gains the deploy-fix section.
- New `RunEvent` types: `VERIFICATION_PASSED`, `VERIFICATION_FAILED`, `FIX_TASKS_PLANNED`, `DEPLOY_APPLY` (intent), `DEPLOY_APPLIED`, `DEPLOY_FAILED`, `ROLLBACK_DONE`, `DEPLOY_VERIFIED`, `REPORT_READY`. `run-state.ts` reduces `FIX_TASKS_PLANNED` like `TASK_PLANNED`; the rest are facts for the UI and reconcile.
- `RunFinished.result` gains `awaiting-validation | verification-failed | deploy-failed | done`.

## 8. API and UI

- `GET /runs/:runId` gains `report: Report | null` (from `REPORT_READY`) and `phase: 0..6`.
- `GET /projects` spec rows gain the actions "Validate" (spec `awaiting-validation`, links to the last run's validation page).
- **Execution screen (block A):** the phase timeline shows phases 0, 4, 5 and 6 with their events; tasks with `origin` show a "fix" / "deploy-fix" tag; the header links to Validation once `report` exists.
- **Validation screen `/runs/:runId/validation`** — loads `GET /runs/:runId` once; panels top to bottom:
  1. Service: URL link, healthcheck detail, smoke table (AC, test, status). On `deploy-failed`: stage, detail, rolled back or not, attempts.
  2. Exploratory script: one block per AC, steps as checkboxes; checkbox state in `localStorage` keyed by run id (wrapped in try/catch; purely a convenience).
  3. Assumptions: one line each.
  4. Blocked tasks: id, title, reason, last PR link.
  5. Evidence matrix: the report's rows, status coloured.
  6. Actions: "Report problem" (textarea + submit → `report-problem` → navigate to Refinement) and "Complete spec" (→ `complete`, then poll). Both disabled unless the spec is `awaiting-validation`; a note explains why when disabled (`verification-failed`, `deploy-failed`, or already `done`).

## 9. Security

- Smoke gate: `SERVICE_URL` is the only added variable; secrets follow the gate's `secrets` list as today. Egress is limited to the gate container.
- `kubectl`/`docker` run only from the orchestrator through `Exec`; manifests come from `main` after gates and review.
- `report.json` contains no secret; the assumptions and summary are agent text already redacted at step output.
- The UI never runs `git`, `gh`, `docker` or `kubectl`; both lifecycle actions go through the draft (block B) or a journaled child CLI.

## 10. Error handling

| Failure | Response |
|---|---|
| `plan.commands.smoke` missing while a smoke AC exists | Plan validation error in Phase 2 (schema retry, then `phase-failed`) |
| Manifests or Dockerfile listed in the plan absent on `main` | `DEPLOY_FAILED {stage: 'validate'}`, counts as an attempt; deploy-fix task created |
| `serviceUrl` cannot be resolved (kind Service without NodePort) | `DEPLOY_FAILED {stage: 'verify', detail}` |
| Rollback fails (`rollbackHealthy: false`) | Recorded; the run still continues to the fix task; the Validation screen shows "previous version unhealthy" |
| `report` step fails after retries | `REPORT_READY` with the orchestrator-assembled fields and `summary: 'report step failed: <reason>'`, `exploratoryScript: []`; the run still finishes |
| Docs PR for the report cannot merge (main protected, conflict) | `PHASE_FAILED {phase: 6}`; `REPORT_READY` is still journaled so the UI shows the report; spec status stays `running` and "Complete spec"/"Report problem" are disabled with the reason |
| `spec complete` child crashes | `interrupted` in the runs list; "Resume" reuses block A's resume with the `complete` journal |

## 11. Testing

- `test/orchestrator/phase4.test.ts` — all green → Phase 5; failed tests → one `fix-tasks` round → Phase 3 → Phase 4 again; second failure → `verification-failed` with a report; `fix-tasks` invalid twice → same.
- `test/orchestrator/phase5.test.ts` — fake `DeployTarget` recording calls: success; failure at `apply` with rollback; smoke failure with rollback; three failures → `deploy-failed`; deploy-fix task merged then success; kill after `DEPLOY_APPLY` and resume confirms via `currentImage`.
- `test/exec/smoke.test.ts` — JUnit filtering by smoke AC ids, missing smoke AC evidence fails, `SERVICE_URL` in the docker args.
- `test/orchestrator/phase6.test.ts` — report assembled from a scripted journal; docs PR; `awaiting-validation` status written; report step failure fallback.
- `test/validators/plan.test.ts` — `smoke` required with smoke ACs.
- `test/api/run-api.test.ts` — `report` and `phase` in run detail; `report-problem` creates the refinement session with the entry; `complete` spawns the fake CLI; 409 rules.
- `test/cli.test.ts` — `spec complete` on a local remote sets `done`.
- `web/src/pages/Validation.test.tsx` — panels per result; actions enabled only for `awaiting-validation`.
- Live check before merge: hello-app on `docker-local` and on `kind` reaches `awaiting-validation`; "Report problem" opens the Refinement prefilled; "Complete spec" lands `done` on `main`.

## 12. Open items to validate during implementation

- Whether `kind` exposes the NodePort on `localhost` under WSL2 without extra port mapping in the cluster config; if not, `serviceUrl` uses `kubectl port-forward` held for the smoke gate's duration.
- Whether running the smoke gate in Docker can reach `localhost` of the host (`--network host` on Linux/WSL2, `host.docker.internal` otherwise); the gate args need the right form per platform.
