# Run API and Execution UI — design

Block A of the web UI (spec §11 screens 1 and 3). Gate 1 refinement (block B) and phases 4–6 with validation (block C) follow in their own specs.

## 1. Purpose

Let a human start, resume and watch orchestrator runs from the browser instead of the CLI. The Projects screen lists projects, specs and runs; the Execution screen shows one run live from its journal.

### 1.1 Success criteria

- A project registered from the UI appears with its specs (status from `spec.json`) and runs (status, tokens, cost from `state.json`).
- "Start run" on a spec starts `teams-ai run` for it; the run appears within one poll and its Execution page streams events while it runs.
- Closing or restarting the UI server never affects a running run; reopening the Execution page replays the journal from the start and continues live.
- "Resume" on a `paused:auth` run starts `teams-ai resume`; "Stop" ends the run process and the journal shows it drained or interrupted.
- The Execution page shows phase timeline, tasks with state and attempts, task detail (steps, gates, review findings, PR), token usage per phase and role, `paused until HH:MM`, and the evidence matrix — all derived from journal events with the same reducer the orchestrator uses.

### 1.2 Non-goals

- Graphical task DAG (a state-ordered list stands in; parallel tasks are visible as several `running` rows).
- Manual pause; editing config, specs or plans; refinement; validation; authentication; remote access.
- Live agent stdout. A step's `prompt.md` and `output.json` are shown after the step finishes.

## 2. Architecture

Three pieces, all inside the existing `teams-ai ui` process and `web/` app:

1. **Project registry** — `~/.teams-ai/config.json` gains `projects: [{ dir }]`. A project is a directory holding `docs/project.json`. The registry is the only new persistent state; everything else is read from the project directory and `~/.teams-ai/runs/<runId>/`.
2. **Run routes** (`server/api/run-routes.ts`) — REST for projects/specs/runs, process control, and one SSE endpoint that replays and tails `events.ndjson`.
3. **Web screens** — `/projects` and `/runs/:runId` in `web/src/pages/`, reducing the event stream in the browser with `server/pipeline/run-state.ts` imported through a Vite alias, so the browser and the orchestrator never disagree on task state.

The run itself is a child process: `tsx server/cli.ts run --project <dir> --spec <specId>` (or `resume --run <runId>`), spawned detached with stdio to `~/.teams-ai/runs/<runId>/ui.log`. The UI never holds a `Run` object. The journal's single-writer lock stays with the child; the UI only reads.

Route matching in `server/api/server.ts` gains path parameters (`:name` segments) since every run route is keyed by id; the matcher stays a linear scan.

## 3. Data sources

| What | Where | Read how |
|---|---|---|
| Projects | `config.json.projects[].dir` | `Project.parse(docs/project.json)` |
| Specs | `<dir>/docs/specs/*/spec.json` | `Spec.parse`; status field |
| Runs of a spec | `~/.teams-ai/runs/<specId>-r<N>/` | `state.json` (status, tasks, tokens); `pid` file when started from the UI |
| Run events | `runs/<runId>/events.ndjson` | `loadEvents` for replay, then tail |
| Step artifacts | `runs/<runId>/steps/<stepId>/{prompt.md,output.json}` | read on demand |

A run started from the CLI has no `pid` file: it is listed, streamable, but "Stop" is unavailable and "Resume" spawns normally.

Run status for the list comes from `state.json` when present; a run directory without `state.json` (crashed before the first write) shows `unknown`. A run with a `pid` file whose process is gone and whose last event is not `RUN_FINISHED` shows `interrupted`, which offers "Resume".

## 4. API

All under `/api`, JSON, same host check as onboarding. Errors: `{ error }` with 400 (bad input), 404 (unknown id), 409 (conflict), 500.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/projects` | `[{ projectId, dir, specs: [{ specId, status, activeRunId }] }]`. `activeRunId` = the newest run whose status is `running`, `paused:*` or `draining`. |
| POST | `/projects` `{ dir }` | Validates `docs/project.json`, appends to `config.json.projects` (idempotent by `projectId`), returns the project row. 400 when the file is missing or invalid. |
| GET | `/projects/:projectId/runs` | `[{ runId, specId, status, at, tokens, cost, stoppable }]` newest first. |
| POST | `/projects/:projectId/specs/:specId/runs` | 409 when the spec has an active run. Otherwise spawns `run`, waits until `runs/<runId>/events.ndjson` exists (or 10 s → 500 with the child's stderr tail), writes `pid`, returns `{ runId }`. |
| POST | `/runs/:runId/resume` | 409 unless status is `paused:auth` or `interrupted`. Spawns `resume`, writes `pid`, returns `{ runId }`. |
| POST | `/runs/:runId/stop` | 409 without a live `pid`. `SIGTERM`, wait up to 15 s for exit, else `SIGKILL`. Returns `{ stopped: true }`. |
| GET | `/runs/:runId` | `{ runId, specId, projectId, status, state: RunState (tasks as array), finished: RunFinished data or null, tokens }` computed from the journal — the same numbers the CLI `status` prints. |
| GET | `/runs/:runId/events` | SSE. Every journal event as `event: journal`, `id: <seq>`, `data: StoredEvent`. Honors `Last-Event-ID`: replay from `seq + 1`. After replay, tails the file (poll 500 ms; `fs.watch` where it fires) until the client closes. A `RUN_FINISHED` event is followed by `event: end` and the stream closes. |
| GET | `/runs/:runId/steps/:stepId` | `{ prompt, output }` from the step directory; 404 when absent. |

The run id is derived by the server, not the client: the spawn helper computes `nextRunId(ws, specId)` before spawning, and the CLI is told it with a new `--run-id` flag so both sides agree without parsing stdout. Run ids and step ids are validated against `^[A-Za-z0-9_.-]+$` before any path is built.

## 5. Process control

`server/api/run-control.ts` (pure, testable with a fake spawn):

- `spawnRun({ projectDir, specId, runId, mode: 'run' | 'resume' })` → `spawn(process.execPath, [tsx, cli, ...])`, `detached: true`, `stdio: ['ignore', log, log]`, `unref()`. On WSL/Linux this puts the child in its own process group so closing the UI does not signal it.
- `isAlive(pid)` → `process.kill(pid, 0)`.
- `stop(pid)` → `SIGTERM` to the group (`-pid`), poll `isAlive` every 250 ms up to 15 s, then `SIGKILL`.

Today only budget exhaustion drains a run; a signal kills the process mid-step and leaves unconfirmed intents for `resume` to reconcile. This block adds the graceful path: the CLI `run`/`resume` commands install `SIGTERM`/`SIGINT` handlers that call `Run.requestStop()`, which journals `RUN_STOP_REQUESTED` (a new `RunEvent`, reduced to status `draining`). The loop already finishes a draining run as `drained` once in-flight tasks settle; no new task starts. A second signal within the 15 s window is not needed — the UI escalates to `SIGKILL` itself, and the next `resume` reconciles as it does after a crash. The `pid` file is removed when `stop` completes or when a list/detail request finds the process gone.

## 6. Web UI

`web/src/api.ts` gains the run endpoints; `web/src/useSse.ts` is generalized to accept an event name list and expose the events array.

### 6.1 Projects (`/projects`)

- Header: "Add project" (directory path input → `POST /projects`; inline error).
- One card per project: id, dir; specs table with status and one action: "Start run" (no active run), "Open run" (active run), or nothing (`done`). Below, the runs table (newest first): run id, spec, status, tokens, cost, actions "Open", "Resume" (`paused:auth`/`interrupted`), "Stop" (stoppable).
- Polls `GET /projects` and `GET /projects/:id/runs` every 5 s while the tab is visible.

### 6.2 Execution (`/runs/:runId`)

Loads `GET /runs/:runId` once for the header, then opens the SSE stream from seq 0 and reduces every event in the browser:

- **Header:** run id, spec, status badge; when `paused:quota`, "paused until HH:MM" from the last `RUN_PAUSED` event's `until`.
- **Phases:** timeline row from `PHASE_STARTED` / `PHASE_FAILED` / `TECH_SPEC_WRITTEN` / `DOCS_MERGED` / `RUN_FINISHED`.
- **Tasks:** rows in `state.order` with state, attempts, owner, PR link (`PR_CREATED`), merge lock holder (`MERGE_LOCK_ACQUIRED`); rows grouped by state so parallel `running` tasks sit together. Selecting a row opens the detail.
- **Task detail:** attempts with their steps (`STEP_STARTED`/`STEP_FINISHED`: kind, role, model tier, tokens, duration, failure), gate results per attempt (`GATE_PASSED`/`GATE_FAILED` with failed test ids), review profile and scope drift, review findings (`REVIEW_CHANGES`), blocked reason. A step row expands to fetch `/runs/:runId/steps/:stepId`.
- **Tokens:** table per phase and per role from `STEP_FINISHED.usage`, plus `DECISION_MADE` usage as role `system1`; total cost.
- **Evidence:** AC rows × test ids from the latest `GATE_PASSED`/`GATE_FAILED` per task, status colored; ACs come from the spec in `GET /runs/:runId`.

The reducer for the run-level view is `reduceEvents` from `server/pipeline/run-state.ts`; the panels above derive from the raw event list with small pure selectors in `web/src/run/selectors.ts`, each unit-tested against a recorded `events.ndjson` fixture from the hello-app live run.

### 6.3 Navigation

`/` redirects to `/projects` when at least one project is registered, else to `/onboarding`. The onboarding status page links to Projects when all items are green.

## 7. Security

- Host check unchanged (`localhost` only).
- Project directories come from the local user and are stored verbatim; the server only reads `docs/**` under them and never executes anything from them except through the CLI it already trusts.
- Ids in paths are validated before joining; step files are served only from the run's `steps/` directory.
- Events are journaled already redacted; the API adds no secret. `ui.log` (child stdio) is never served.

## 8. Error handling

- Spawn failure (tsx missing, bad project) → 500 with the last 500 chars of `ui.log`; nothing is written to the registry.
- SSE on a run whose `events.ndjson` does not exist → 404 before headers are sent.
- A corrupt journal (`EventLogCorruptError`) → 500 `{ error: 'journal corrupt; run teams-ai status --repair' }`; the UI shows the message on the run page.
- Client reconnects (EventSource does this) resume from `Last-Event-ID`; duplicate events are impossible because seq is monotonic and the browser reducer ignores a seq it already has.

## 9. Testing

- `test/api/run-api.test.ts`: real `startApi` on an ephemeral port, temporary home with `config.json`, a fixture project (`test/fixtures/hello-app`), and hand-written `runs/<id>/events.ndjson` + `state.json`. Covers listing, registration errors, spawn with a fake CLI script that writes a journal, 409 on double start, resume/stop state rules, run detail numbers equal to `Run` state, SSE replay from `Last-Event-ID`, tail delivering an appended event, `end` after `RUN_FINISHED`, step artifact 404.
- `test/api/run-control.test.ts`: `spawnRun` argv and detach flags with a fake spawn; `stop` escalates to `SIGKILL` after the timeout with a fake clock.
- `web/src/run/selectors.test.ts`: every selector against the recorded fixture.
- `web/src/pages/*.test.tsx`: Projects renders rows and actions per status; Execution reduces a scripted event list into the expected panels (EventSource mocked).
- CLI: `--run-id` flag test in `test/cli.test.ts`; a signal during a scripted run journals `RUN_STOP_REQUESTED` and exits with the `drained` code (fake-claude scenario in `test/orchestrator/loop.test.ts`).
- `test/store` or `test/orchestrator/run.test.ts`: `RUN_STOP_REQUESTED` reduces to `draining`, and replay of a journal ending in it resumes as finished-drained, never as running.
- Live check before merge: start the UI in WSL, register `teams-ai-hello-app`, start a `--dry-run` run from the browser, watch it stream, stop it, reopen the page and see the replay.

## 10. Open items to validate during implementation

- Whether `fs.watch` fires for appends on the WSL filesystem used for `~/.teams-ai/runs`; the 500 ms poll is the fallback either way.
- Whether `SIGTERM` to a detached `tsx` child reaches the orchestrator's handler or only `tsx`; if only `tsx`, spawn `node` on the compiled CLI or forward the signal.
