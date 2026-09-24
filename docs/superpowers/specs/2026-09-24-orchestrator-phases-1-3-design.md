# teams-ai — Orchestrator, Phases 1–3 (design)

Companion to `2026-09-23-teams-ai-poc-design.md` (the POC spec). This document designs the module that drives a run from a frozen spec to merged tasks: technical spec (Phase 1), plan (Phase 2) and the task loop (Phase 3), with crash recovery, budgets, quota pauses and the first System 1 decision wired in. Everything the orchestrator calls already exists as a tested unit (Plans 1, 3, 4, 5-decision, 5-knowledge); this design is about composition, state and side-effect discipline.

## 1. Purpose

### 1.1 Outcome

`teams-ai run --project <dir> --spec <id>` takes a project with an existing GitHub repository whose `main` holds `docs/` (project.json, spec.json with `status: running` and a `specHash`), and, with no human in the loop, ends with the plan's tasks merged into `main` one PR each, or with an explicit terminal state (`blocked`, `deadlocked`, `phase-failed`, `drained`) and a reason for every task that did not merge. Killing the process at any moment and running `teams-ai resume` continues without duplicating a commit, a PR or a merge and without charging an interrupted LLM step as an attempt.

### 1.2 Success criteria

- The hello-app fixture (`test/fixtures/hello-app`) with a hand-written `spec.json` reaches all tasks `merged` through the real `claude`, real Docker gates and a real GitHub repository (manual end-to-end, one run).
- `npm test` exercises Phases 1–3 end to end with the fake `claude`, a scripted `Exec` for Docker and `gh`, and a real local git remote; it kills and resumes the run after every intent and asserts idempotency.
- Every side effect on git, GitHub, the filesystem or the event log is an `intent → effect → confirm` triple (POC spec §7.2).
- Token usage per role/phase/task/attempt is in `Accounting`; System 1 decisions are in the event log with backend, probabilities and cost.

### 1.3 Non-goals (later designs)

- Phase 0 bootstrap (`gh repo create`, first commit of `docs/`).
- Gate 1 refinement (PO/SM questions, "Start"), Phases 4–6 (integrated verification, deploy, report), validation loop.
- Web UI and API; this design ships a CLI only.
- Decisions 2–12 of POC spec 10A.5; only their call sites are named.
- Local System 1 backend, decision evals.

## 2. Architecture

### 2.1 Layout

```
server/orchestrator/
  run.ts               Run: loads contracts, opens the event store, rebuilds RunState, tick loop, pause/resume, terminal states
  phases/tech-spec.ts  Phase 1: Dev tech-spec step → PO coverage step → Dev again on uncovered ACs (≤3 phase attempts)
  phases/plan.ts       Phase 2: SM plan step → validatePlan → schema retry → plan.json → TASK_PLANNED events
  task-runner.ts       Phase 3 per task: one state machine, one state advance per call, every advance = events
  steps.ts             runAgentStep(): builds ContextPackInput per step kind, wraps runStep with governor/breaker/accounting
  reconcile.ts         unconfirmed intents → check reality → confirm or redo
  events.ts            event type names, zod payloads, helpers intent()/confirm()
  workspace.ts         paths: workspaces/<projectId>/{repo,worktrees,graph,knowledge.sqlite}, runs/<runId>/{events.ndjson,state.json,steps/}
server/agents/outputs.ts  + step kinds `spec-gap` and `replan` (§4.4, §4.6)
.claude/agents/sm.md      + prompt sections for spec-gap answers and replans
server/cli.ts             teams-ai run | resume | status
scripts/integration/orchestrator.ts   manual end-to-end on hello-app (real claude, Docker, GitHub)
test/fixtures/fake-claude/scenarios/  scripted outputs per step kind and attempt for the loop tests
```

### 2.2 Approach

One `Run` owns one `tick()` loop and at most `maxParallel` `TaskRunner`s. A tick: reconcile if needed → if the breaker says pause, emit `RUN_PAUSED` once and wait → `nextRunnable(state)` → start a runner per picked task → `await Promise.race` of the runners' next step → apply the runner's events → loop until `runProgress(state)` is not `running`. Runners never touch `RunState` directly; they return events and `Run` appends them through the store and reduces them, so replay and live execution follow the same path.

No new dependency. `node --no-warnings=ExperimentalWarning` in the CLI entry for `node:sqlite`.

### 2.3 Dependencies (all injected into `Run` for tests)

`exec: Exec` (docker, gh, graphify), `runStep`, `EventStore`, `Accounting`, `Governor`, `QuotaBreaker`, `MergeQueue`, `Graphify`, `KnowledgeIndex`, `Decider`, `clock`, `sleep`. Git goes through `server/git/git.ts` with the same `exec`.

## 3. Workspace and run layout

```
~/.teams-ai/workspaces/<projectId>/
  repo/                 clone of the GitHub repository; `main` checked out; only the orchestrator commits here
  worktrees/<branch>/   one per task or docs branch (branch name with `/` replaced by `__`)
  graph/                graphify output for `main` (POC spec §9); graph/worktrees/<branch>/ for review-time updates
  knowledge.sqlite      KnowledgeIndex (docs/, ADRs)
~/.teams-ai/runs/<runId>/
  events.ndjson         the log (EventStore)
  state.json            RunState snapshot after each tick (derived; never read for decisions, only for `status`)
  steps/s00001/         prompt.md, output.json, stream.ndjson (redacted) per agent step
```

`runId` = `<specId>-r<n>` where `n` = 1 + number of existing runs for that spec. `specHash` comes from `spec.json` and every event carries it (EventStore does that).

## 4. Phases

### 4.1 Preconditions (checked before Phase 1; failure = exit 2 with the list)

- `repo/` exists and `origin` is reachable (`git fetch`); `main` contains `docs/project.json` and `docs/specs/<specId>/spec.json`.
- `spec.json.status === 'running'` and `specHash` present (frozen by Gate 1 or by hand for the POC).
- `claude auth status --json` reports `loggedIn`; `gh auth status` green; Docker daemon answers `docker version`.
- If `decisions.enabled`, `OPENROUTER_API_KEY` present or the run logs that Jev is unavailable (chain still works).

### 4.2 Phase 1 — Technical spec

1. Docs worktree `docs/<specId>` from `main`.
2. `runAgentStep({kind: 'tech-spec', role: 'dev'})` with a pack of objectives, features, ACs, project principles, constraints, stack, existing ADRs (retrieval), and the output contract. Dev writes `docs/specs/<specId>/tech-spec.md` and ADRs; returns `TechSpecOutput`. References validated: `techSpecPath` and every ADR path must exist in the worktree.
3. `runAgentStep({kind: 'coverage', role: 'po'})` with ACs + the tech-spec text. Every AC must have `covered: true`; otherwise Dev runs again with the uncovered list as `feedback`. Each return is a phase attempt; 3 attempts → run ends `phase-failed` (event `PHASE_FAILED {phase: 1, reason}`).
4. Commit on the docs worktree (`commitAll`), then merge through the `MergeQueue` with branch `docs/<specId>`, gates = none (docs only; the gate set applies to code), PR titled `docs(<specId>): technical spec`. Events: `PHASE_STARTED {1}`, `TECH_SPEC_WRITTEN`, `COVERAGE_CHECKED {uncovered[]}`, `DOCS_MERGED {pr}`.

### 4.3 Phase 2 — Plan

1. `runAgentStep({kind: 'plan', role: 'sm'})` with ACs, tech-spec, ADRs, principles, project constraints, human-defined tasks from `spec.json.tasks`, and (spec 2+) `godNodes` from the graph. Output is `Plan` (`PlanOutput`).
2. `validatePlan(plan, spec, {firstSpec})` errors are appended to the schema-retry feedback (POC spec §12: up to 2 re-runs), then `phase-failed`.
3. Plan written to `docs/specs/<specId>/plan.json` on the same docs branch flow as 4.2 step 4 (second PR, `docs(<specId>): plan`).
4. One `TASK_PLANNED {task}` event per task (this is what `reduceEvents` needs; the file is for humans and agents). `PHASE_STARTED {3}` closes the phase.

### 4.4 Phase 3 — Task runner

States are the POC spec §7.1 states; each row is one `advance()` call.

| From → to | Effect | On failure |
|---|---|---|
| `ready → implementing` | intent `WORKTREE_CREATE`; `createWorktree(repo, task/<specId>-<taskId>, main)`; confirm. Pack: task, its ACs, tech-spec excerpt (sections named by the plan or grep by AC id), ADRs in `adrRefs`, `graphify query` (or `grepFallback` when coverage < 0.5), handoffs of merged tasks, `feedback` from the previous attempt (gate delta, review findings, rebase conflicts or spec-gap answer). `runAgentStep({kind: 'dev'})`. `checkScope(changedFiles, affectedPaths, frozenPaths, scopeJustification)`. intent `COMMIT`; `commitAll(worktree, commitMessage)`; confirm `DEV_COMMITTED {sha}`. | Step failure → `decideOnFailure`. `spec-gap` → §4.5, stays `implementing`, no attempt. Scope violation → treated as `review-changes` failure (attempt) with the violation as feedback. |
| `implementing → validating` | `runGates(blocking, worktree)`; `GATE_PASSED`/`GATE_FAILED {gate, failure}` per gate. Failed gate: `triageGateFailure(gate, result, decider, {confidential})` → `Failure {kind, gate}` → `decideOnFailure`. | `retry-dev` → `implementing` with delta (JUnit failed ids + tails). `rerun-gate` → stays, re-runs that gate (counter events `INFRA_RETRY`/`FLAKY_RETRY`). |
| `validating → reviewing` | `graphify update` on the worktree (graph/worktrees/<branch>), `affected` for the symbols in changed files. Pack: diff stat + changed files, ACs, tech-spec excerpt, impact radius. `runAgentStep({kind: 'review', role: 'test'})`. `verifyClaimedEvidence(criteria, junit)`; any error rejects the review as `schema` failure (agent cited non-existent evidence). `decision: 'changes'` → `review-changes`. | `retry-dev` → `implementing` with findings. |
| `reviewing → rebasing → merging → merged` | `MergeQueue.submit(taskId, steps)` where `steps` = real `MergeSteps`: `alreadyMerged` (`findMergedPr`), `rebase` (`rebaseOnto main`), `gates` (`runGates` again), `push`, `ensurePr` (body: summary, ACs, gate results), `remoteMainSha`, `merge` (`mergePr --squash --match-head-commit`), `afterMerge` (`graphify update` on `main`, `removeWorktree`, record `HandoffSummary`). Intents: `PUSH`, `PR_CREATE`, `PR_MERGE`; confirms `PR_CREATED {number}`, `PR_MERGED {number, sha}`. | `rebase` conflicts → `rebase-conflict` failure → `implementing` with the conflict list; Dev resolves in the same worktree. `gates` fail → same as validating. `merge` refused (main moved) → `rebasing` again, no attempt. |

Attempt bookkeeping is `decideOnFailure` + `ATTEMPT_CONSUMED`; `replan` → §4.6; `block` → `TASK_STATE_CHANGED {blocked}` then `tasksToBlock(state)` for dependents.

### 4.5 Spec gap

Dev returns `status: 'spec-gap'` with `question`. The orchestrator runs `runAgentStep({kind: 'spec-gap', role: 'sm'})` with the question, the task, its ACs and the tech-spec excerpt. New output schema:

```ts
SpecGapOutput = { specHash, answer: string, assumption: string }   // assumption is the one-line entry for the assumptions log
```

Event `SPEC_GAP_ANSWERED {taskId, question, answer, assumption}`. The assumption joins the run's assumptions list (fed to later packs and to the Phase 6 report). Dev runs again with the answer as feedback; no attempt consumed (POC spec §12).

### 4.6 Replan

On `action: 'replan'`, `runAgentStep({kind: 'replan', role: 'sm'})` with the task, its attempts' feedback history, the ACs and the module boundaries (graph god-nodes or file tree). New output schema:

```ts
ReplanOutput = { specHash, replacements: PlanTask[] }   // 1..3 tasks, ids `<taskId>-r<n>`, same criteriaRefs union, dependsOn within the plan
```

Validated with `validatePlan` on the plan with the replacements swapped in (DAG, coverage). Event `TASK_REPLANNED {taskId, replacements}` (already reduced by `run-state.ts`). Replacements start with 3 attempts and `replanned: true`.

### 4.7 Terminal states of a run

`complete` (every task merged), `blocked` (some tasks blocked, none runnable), `deadlocked` (scheduler cannot pick and nothing is active), `drained` (run budget spent, in-flight finished), `phase-failed` (Phase 1 or 2 exhausted). Event `RUN_FINISHED {result, merged[], blocked[{taskId, reason}]}`. Exit codes: 0 complete; 2 blocked/deadlocked/phase-failed; 3 drained.

## 5. Events

Every event has `type`, `kind: fact | intent | confirm`, `intentId` for pairs, `data`. Types used here: `RUN_STARTED`, `PHASE_STARTED`, `PHASE_FAILED`, `TECH_SPEC_WRITTEN`, `COVERAGE_CHECKED`, `DOCS_MERGED`, `TASK_PLANNED`, `TASK_STATE_CHANGED`, `ATTEMPT_CONSUMED`, `INFRA_RETRY`, `FLAKY_RETRY`, `TASK_REPLANNED`, `STEP_STARTED`, `STEP_FINISHED {stepId, kind, role, ok, failure?, usage}`, `DEV_COMMITTED`, `GATE_PASSED`, `GATE_FAILED`, `REVIEW_APPROVED`, `REVIEW_CHANGES`, `SPEC_GAP_ANSWERED`, `DECISION_MADE {record}`, `MERGE_LOCK_ACQUIRED`, `PR_CREATED`, `PR_MERGED`, `TASK_BLOCKED`, `RUN_PAUSED`, `RUN_RESUMED`, `RUN_BUDGET_EXHAUSTED`, `RUN_FINISHED`. Intents: `WORKTREE_CREATE`, `COMMIT`, `PUSH`, `PR_CREATE`, `PR_MERGE`, `WORKTREE_REMOVE`, `DOCS_COMMIT`. `run-state.ts` reduces the subset it already knows; the others are facts for the UI and for reconciliation.

Redaction: every string that came from an agent or a process (step output, gate tails, conflict lists, PR bodies) goes through `redactSecrets` with the project's secret values before it is appended.

## 6. Crash recovery (reconcile)

On `resume`: `loadEvents` (repairs a torn tail), `reduceEvents`, `unconfirmedIntents`. For each, in log order:

| Intent | Reality check | Then |
|---|---|---|
| `WORKTREE_CREATE` | directory exists and `git -C … status` works | confirm, else redo |
| `COMMIT` / `DOCS_COMMIT` | `HEAD` of the worktree ≠ recorded base sha and tree clean | confirm with the sha, else redo the step whose output produced it (LLM step interrupted: re-run, no attempt) |
| `PUSH` | `git ls-remote origin <branch>` equals local head | confirm, else push |
| `PR_CREATE` | `gh pr list --head` finds one | confirm with the number, else `ensurePr` |
| `PR_MERGE` | `findMergedPr` / `prState` is `MERGED` | confirm, run `afterMerge`, else re-submit to the queue |
| `WORKTREE_REMOVE` | directory gone | confirm, else remove |

A task whose last event is `STEP_STARTED` without `STEP_FINISHED` gets that step re-run from the same state; the process that ran it is gone (no session resume, POC spec §8.3). `state.json` is rewritten after reconcile.

## 7. Budgets, concurrency and quota

- `Governor(cfg.concurrency.maxClaudeProcesses)` wraps every `runStep`; `setLimit(1)` while the breaker reports a rate-limit signal, back to the configured value on resume.
- `QuotaBreaker.observe(summary.rateLimit)` after every step; `onQuotaFailure` on `quota` failures. When `!canStart()`: `RUN_PAUSED {reason}`, `state.status = 'paused:quota'` (via `RunEvent.RunPaused`), the tick sleeps until the breaker's `until`, then `RUN_RESUMED`. `auth` failures pause the same way with `paused:auth` and never auto-resume (exit 2 with the message; `resume` tries again).
- Per-task budget: after each step, `Accounting.total({taskId})` tokens > `budgets.perTaskTokens` → failure `budget` (attempt) unless `observeOnly`, which only logs `BUDGET_EXCEEDED`.
- Per-run budget: `Accounting.total()` > `budgets.perRunTokens` → `RUN_BUDGET_EXHAUSTED`, status `draining`; runners finish, no new task starts; result `drained`.

## 8. Decisions

`createDecider({cfg, secrets, accounting, runEscalation, onDecision})` where `runEscalation({role, prompt})` = `runStep({kind: 'decide', role, agent: registry[role], cwd: <current worktree or repo>, prompt, expectedSpecHash, phase, taskId, attempt})` and `onDecision` appends `DECISION_MADE`. Decision 1 is called from the task runner's `validating` state. Named call sites for phase 3 of the decision layer, not implemented: `pr-risk` (before review), `attempt-progress` (attempt ≥ 2), `scope-drift` (after `checkScope`), `model-tier`/`effort` (before `runAgentStep` for dev/test).

## 9. CLI

```
teams-ai run    --project <dir> [--spec <id>] [--max-parallel N] [--dry-run]
teams-ai resume --run <runId>
teams-ai status --run <runId> [--json]
```

`--dry-run` runs Phases 1–3 with `runStep` replaced by the fake claude scenario named in `TEAMS_AI_FAKE_SCENARIO` (for demos and for the integration script without spending tokens). `status` prints run status, per-task state/attempts, open PRs, token totals per role. Logs go to stderr, one line per event, redacted.

## 10. Security

- Agents run with the runner's sanitized env; secrets never reach `runStep`; gate secrets reach containers only through the existing `GateContext.secrets` for the names the gate declares.
- Only `repo/` (the orchestrator's clone) pushes; worktrees push their own branch only. `main` is written exclusively through the `MergeQueue`, docs included.
- `OPENROUTER_API_KEY` and `GITHUB_TOKEN` are read with `loadSecrets` at run start; `GH_TOKEN` is set only for the `gh` invocations of `github.ts`.

## 11. Error handling

Follows POC spec §12 exactly, plus:

| Failure | Response |
|---|---|
| Precondition failed | exit 2 before `RUN_STARTED`, list printed |
| Phase 1/2 attempts exhausted | `PHASE_FAILED`, `RUN_FINISHED {phase-failed}`, exit 2 |
| Review cites evidence that does not exist | `schema` failure (re-run the review up to 2 times with the errors) |
| Scope violation by Dev | `review-changes`-class failure with the violation as feedback (attempt) |
| Merge refused because `main` moved | back to `rebasing`, no attempt |
| Docs PR merge refused | retry the docs merge once, then `phase-failed` |
| Event log locked by another process | exit 2 "run already in progress" |
| graphify unavailable / coverage < 0.5 | grep fallback in packs, `affected` empty, review pack says so |

## 12. Testing

- **Unit:** `events.ts` payload schemas; `workspace.ts` paths; `steps.ts` pack assembly per kind (snapshot of `ContextPackInput`, not of the rendered text); `task-runner.ts` transitions with fake `runStep`/`exec`, one test per row of §4.4 and per failure column; `reconcile.ts` one test per row of §6.
- **Loop (integration in `npm test`):** real git (bare `origin` in a temp dir), fake `claude` scenarios (`test/fixtures/fake-claude/scenarios/<name>/<kind>-a<attempt>.json`), scripted `Exec` for `docker` (gate results from a scenario table) and `gh` (in-memory PR store: list/create/merge/state). Scenarios: happy path 3 tasks with one dependency; gate failure then fix; review changes then approve; spec-gap; rebase conflict; replan then block; quota pause and resume (fake clock); run budget drain.
- **Crash-resume:** run the happy path with an injected "crash after intent N" for every N; resume; assert one commit per task, one PR per branch, one merge, all tasks merged, no duplicate events.
- **Manual end-to-end:** `scripts/integration/orchestrator.ts` on hello-app with real tools; records token totals and wall time in the plan's findings section.

## 13. Open items to validate during implementation

1. Whether `graphify update` on a worktree can write to a separate out dir while the `main` graph stays untouched (POC spec §9 assumes so).
2. PR body size limits with long gate tails; truncate to 8 kB.
3. The cost of the Phase 1 packs for the hello-app (observe-only run) to set `budgets.step` defaults.
4. `gh pr merge --squash` on a repository whose default branch protection is unset (POC repos): confirm no admin flag needed.
