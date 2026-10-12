# Refinement (Gate 1) and Phase 0 — design

Block B of the web UI (POC spec §5 and §11 screen 2). Block A (`2026-09-24-run-api-execution-ui-design.md`) covers projects, run control and the Execution screen; block C covers phases 4–6 and the Validation screen.

## 1. Purpose

Turn the human's documentation into a frozen `spec.json` from the browser, with the PO and SM agents asking questions and proposing edits until the readiness checklist is green, then start the run. For a new project, the run itself creates the GitHub repository and commits the documentation (Phase 0).

### 1.1 Success criteria

- From the Projects screen, "New project" reaches a running Phase 1 on a freshly created GitHub repository with no terminal.
- "New spec" and "Continue spec" on an existing project reach a running Phase 1 through a `docs(<specId>): spec vN` PR merged to `main`.
- Every checklist item and every question is attributable to a role (PO or SM) or to the orchestrator (secrets).
- No agent edit reaches a document without the human accepting it; the human can also edit the Markdown directly.
- `spec.json` and `project.json` are always derived from the Markdown and always pass their zod schemas before "Start" is enabled.
- Restarting the UI server keeps the session: documents, answers, pending patches and the checklist come back from the journal.
- `npm test` covers the session state machine, the derive step, the API and Phase 0 with the fake `claude` and a scripted `Exec`; no test touches GitHub.

### 1.2 Non-goals

- Question deduplication and readiness scoring by System 1 (POC 10A.5 decisions 2–4); dedup is textual here and their call sites are named.
- Rich text editing, Markdown preview, file upload beyond paste.
- Editing `plan.json` or tasks with dependencies; human tasks stay `{title, description}`.
- Repository bootstrap by a DevOps step. The repository is deterministic (§4); DevOps keeps the Dockerfile and manifests (infrastructure task, POC §6).
- Multi-user, concurrent sessions on one spec.

## 2. Architecture

```
server/refine/
  session.ts        RefineSession: state machine over the journal, one per <projectId>/<specId>
  cycle.ts          evaluate(): derive → PO ∥ SM refine → merge queue of questions → checklist
  derive.ts         derive step: Markdown → project.json + spec.json, validated, AC ids preserved
  patches.ts        validate/apply DocPatch on the draft; diff for the UI
  draft.ts          draft directory layout, copy from repo, templates
  events.ts         REFINE_* event types and payloads
server/api/refine-routes.ts
server/orchestrator/phases/bootstrap.ts   Phase 0 (§4)
server/cli.ts                             run --project <draftRoot> --spec <id> --draft
web/src/pages/Refinement.tsx, web/src/refine/*
.claude/agents/po.md, sm.md               refine and derive prompt sections
```

- The session runs inside the `teams-ai ui` process. The server is the single writer of the session journal; agent steps go through `runStep` with the governor, breaker and accounting already used by runs.
- One new dependency: `diff` (npm), used server-side to produce unified diffs for the UI.
- The draft lives outside the repository and outside `runs/`:

```
~/.teams-ai/workspaces/<projectId>/refine/<specId>/
  docs/project.md                 human + accepted patches
  docs/project.json               derived
  docs/specs/<specId>/brief.md    human + accepted patches
  docs/specs/<specId>/spec.json   derived
  events.ndjson                   session journal (EventStore)
  steps/s00001/                   prompt.md, output.json per agent step
```

For a project that already has a repository, `docs/` of the draft starts as a copy of `docs/` on `main` (previous specs, ADRs, tech specs are kept so retrieval and the agents see them). Only `project.md`, `brief.md` and the two derived JSON files are written by the session.

## 3. Session

### 3.1 States

```
drafting → evaluating → answering → evaluating → … → ready → started
              │                                        │
              └──── error (derive/step failure) ←──────┘
```

| State | Meaning | Editor |
|---|---|---|
| `drafting` | Documents can be edited; nothing evaluated yet, or checklist stale | writable |
| `evaluating` | derive or refine steps running | read-only |
| `answering` | Questions queued or patches pending | writable |
| `ready` | Checklist green, no blocking question, no pending adjustment approval, secrets present; a reviewer's pending patch is then an optional suggestion (R11.10, 2026-10-12) | writable (an edit sets `stale`) |
| `error` | Last cycle failed; reason shown | writable |
| `started` | Run spawned; session closed | read-only |

Rules:
- Editing a Markdown file, accepting a patch or changing a secret marks the checklist stale (`stale: true`). Stale is not a state: it is a flag shown next to the checklist; "Start" is disabled while stale.
- One cycle at a time per session; a second `evaluate` while one runs is 409.
- "Start" requires `ready` and not stale.
- Entry points: **New project** (empty templates), **New spec** (copy `docs/` from `main`, empty `brief.md`), **Continue spec** (copy `docs/` from `main`; `brief.md` prefilled with the spec's current Markdown plus a "Validation report" section holding the latest `validationReports[]` entry; `spec.json.status` set to `refining` in the draft).

### 3.2 Evaluate cycle

1. **derive** — `runAgentStep({kind: 'derive', role: 'po', tier: 'cheap'})` with `project.md`, `brief.md`, the previous derived JSON (if any) and both zod schemas rendered as text. Output: `DeriveOutput = { project: Project, spec: Spec }`. The orchestrator parses both with `Project` and `Spec`; a validation failure ends the cycle in `error` with the issues list (the human fixes the Markdown). AC ids present in the previous `spec.json` must keep their id when their text is unchanged; new ACs get the next free `AC-nnn`; the orchestrator enforces this by re-numbering against the previous file and rejecting duplicates. `status` is forced to `refining`, `specHash` to `null`, `specVersion` to the previous value or 0.
2. **refine** — PO and SM `runAgentStep({kind: 'refine'})` in parallel. Pack: both Markdown files, both derived JSON, retrieval hits from the project knowledge index (previous specs, ADRs), the Q&A history (answered, skipped), rejected patches with their reasons, and the checklist ids the role owns. Output: `RefineOutput` (exists: `checklist[]`, `questions[]`, `docPatch[]`).
3. **merge** — questions from both roles are concatenated, duplicates removed by normalized text (lowercase, whitespace collapsed; System 1 decision 3 replaces this later), blocking first, PO before SM within a class. Questions already answered or skipped (same normalized text) are dropped. Patches are validated (§3.4) and queued.
4. **checklist** — the union of both roles' items, keyed by the fixed ids of POC §5.1:
   PO `po.objectives-verifiable`, `po.personas`, `po.scope-explicit`, `po.no-contradictions`; SM `sm.dependencies-and-secrets`, `sm.constraints-clear`, `sm.tasks-feasible`, `sm.no-open-questions`. An item an agent omits is `passed: false, detail: 'not reported'`. `sm.dependencies-and-secrets` is overwritten by the orchestrator: passed only when every `secretNames` entry of every external dependency in the derived `spec.json` exists as a file in `~/.teams-ai/secrets/` (one file per secret name, the store `loadSecrets` reads). `sm.no-open-questions` is overwritten too: passed only when the queue has no blocking question.
5. State after the cycle: `ready` when every item passed and no patch is pending; `answering` when at least one question is queued or one patch is pending; `drafting` otherwise (an item failed for a reason the human fixes in the editor or in the secrets panel, with nothing to answer or decide).

Events: `REFINE_CYCLE_STARTED`, `DERIVED {project, spec}`, `STEP_STARTED`/`STEP_FINISHED` per agent step (same payloads as runs, so the token panel of block A applies), `REFINE_EVALUATED {checklist, questions, discardedPatches}`, `PATCH_PROPOSED {patch, diff}` per valid patch, `REFINE_CYCLE_FAILED {reason}`.

### 3.3 Questions and answers

- The UI shows one question at a time: role, blocking flag, text, related AC ids. "Answer" appends `QUESTION_ANSWERED {questionId, text}`; "Skip" appends `QUESTION_SKIPPED` and is refused (409) for a blocking question.
- Answers are not routed to an agent one by one. They reach both agents as history in the next cycle (deviation from POC §5.2 item 4, chosen to spend two agent steps per round of answers instead of one per answer). The human answers as many as they want, then clicks "Re-evaluate".
- A skipped question stays in the history and does not block `ready`; the agent may ask it again, and the dedup drops it if the text is the same.

### 3.4 Patches

- `DocPatch = { file, find, replace, reason }` (exists). Valid when `file` is `docs/project.md` or `docs/specs/<specId>/brief.md` and `find` occurs exactly once in the current file. Invalid patches are not queued; they appear in `REFINE_EVALUATED.discardedPatches` with the reason and the UI lists them as a warning line.
- A pending patch shows a unified diff (`diff.createPatch`) with the role and the reason. "Accept" applies it (`PATCH_ACCEPTED`, `DOC_EDITED {file, hash}`) and marks the checklist stale. "Reject" records `PATCH_REJECTED {patchId, reason?}`; rejected patches are fed back to the agents in the next cycle.
- Patches are applied in acceptance order against the current file; a patch whose `find` no longer occurs (because an earlier patch or a manual edit changed it) fails with 409 and is dropped from the queue with a warning.

### 3.5 Secrets panel

Rows come from `externalDependencies[].secretNames` of the derived `spec.json`. Each row shows present/absent and a 4-character hint when present. Entering a value calls `writeSecret` into `~/.teams-ai/secrets/<NAME>` (one file per name, 0600, atomic; the same store the onboarding uses); the value is never echoed; the checklist becomes stale. No agent is involved.

### 3.6 Start

1. Refuse unless `ready` and not stale.
2. `freezeSpec(spec)` on the derived `spec.json` (status `running`, `specVersion + 1`, `specHash`); write it to the draft. Write `project.json` as derived.
3. Compute `runId = nextRunId(specId)`, spawn `teams-ai run --project <draftRoot> --spec <specId> --run-id <runId> --draft` exactly as block A spawns runs (the draft root holds `docs/project.json`, so it is a valid block A project directory) (`spawnRun`, detached, `pid` file).
4. Register the project in `config.json.projects` (idempotent). Append `REFINE_STARTED_RUN {runId}`; the session is `started` and the UI navigates to `/runs/<runId>`.

The draft is left in place for the run to consume and for audit; a later "New spec" on the same project starts a fresh draft. A `started` session cannot be reopened; a new one is created by "Continue spec" after the run.

## 4. Phase 0 — Bootstrap (inside the run)

`teams-ai run --project <draftRoot> --spec <id> --draft` replaces the current precondition "docs on `main`" with a Phase 0 that puts them there. Everything is `intent → effect → confirm` through the run's journal, so `resume` reconciles a crash at any point.

| Case | Steps |
|---|---|
| No repository (`gh repo view <owner>/<projectId>` 404) | intent `REPO_CREATE`; `ensureRepo` (private, name `projectId`, owner from `project.json.github.owner` or `config.json.github.owner`); clone to `workspaces/<projectId>/repo`; copy draft `docs/` into the clone; intent `DOCS_COMMIT`; commit `docs: <projectId> <specId> v<N>` on `main`; push; confirm `REPO_BOOTSTRAPPED {repo, sha}`. |
| Repository exists | Docs worktree `docs/<specId>` from `main` (same helper Phase 1 uses); copy the draft's `project.md`, `project.json`, `brief.md`, `spec.json` over it; commit; `MergeQueue.submit` with no gates and PR `docs(<specId>): spec v<N>`; confirm `DOCS_MERGED {pr}`. |

Then Phase 1 proceeds unchanged. `PHASE_STARTED {0}` opens the phase. Preconditions of the orchestrator design §4.1 that assume `docs/` on `main` are checked after Phase 0 instead of before. A `run --project <dir> --spec <id>` without `--draft` keeps today's behaviour (docs already on `main`).

Reconcile for the new intents: `REPO_CREATE` → repo exists? clone exists? (`ensureRepo` is already idempotent); `DOCS_COMMIT` → the commit is on `origin/main` (`git log origin/main -- docs/specs/<specId>/spec.json` contains the spec hash in the file) else redo.

## 5. API

All under `/api`; JSON; errors `{ error }` with 400/404/409/500 as in block A. `sessionId` is `<projectId>/<specId>`; both parts validated against `ID_PATTERNS.SLUG`.

| Method | Path | Behaviour |
|---|---|---|
| POST | `/projects/new` `{ projectId, name }` | 409 if a workspace or a registered project with that id exists. Creates the draft from templates; returns the session. Not registered in `config.json` until Start. |
| POST | `/projects/:projectId/specs` `{ specId }` | 409 if `docs/specs/<specId>` exists on `main` or a session is open. Copies `docs/` from `main` (fetches first), creates an empty `brief.md`; returns the session. |
| POST | `/projects/:projectId/specs/:specId/continue` | 409 unless the spec's status on `main` is `awaiting-validation` or `done`. Copies `docs/`, prefills `brief.md`; returns the session. |
| GET | `/refine/:sessionId` | `{ state, stale, docs: { 'project.md', 'brief.md' }, derived: { project, spec } \| null, checklist[], questions: { current, queue[], history[] }, patches: { pending[], history[] }, secrets: [{ name, present, hint }], tokens, error }`. |
| PUT | `/refine/:sessionId/docs/:file` `{ text }` | `file` ∈ `project.md`, `brief.md`. 409 while evaluating. Appends `DOC_EDITED`. |
| POST | `/refine/:sessionId/evaluate` | 409 while evaluating or when `started`. 202; progress over SSE. |
| POST | `/refine/:sessionId/answers` `{ questionId, text }` | 404 unknown question, 409 already decided. |
| POST | `/refine/:sessionId/questions/:questionId/skip` | 409 if blocking. |
| POST | `/refine/:sessionId/patches/:patchId/accept` | 409 if `find` no longer matches (patch dropped). |
| POST | `/refine/:sessionId/patches/:patchId/reject` `{ reason? }` | |
| PUT | `/refine/:sessionId/secrets/:name` `{ value }` | `name` must be listed by the derived spec. Value never echoed. |
| POST | `/refine/:sessionId/start` | 409 unless `ready` and not stale. Returns `{ runId }`. |
| GET | `/refine/:sessionId/events` | SSE, journal replay from `Last-Event-ID`, then tail; same framing as block A. |

A new `GET /refine` lists every draft found under `workspaces/*/refine/*/` as `[{ projectId, specId, state, registered }]` (block A's `GET /projects` keeps its shape), so the Projects screen can show "Open refinement" for registered projects and for new projects whose session has not started. Registered projects' spec rows gain the actions "New spec" and "Continue spec" (the latter only for `awaiting-validation`/`done`).

## 6. Web UI — `/refine/:projectId/:specId`

Three columns.

- **Documents (left).** Tabs `project.md` and `brief.md`, one `textarea` each, saved on blur (`PUT docs`). Button "Evaluate" (first time) / "Re-evaluate" (afterwards), disabled while evaluating. A "checklist out of date" notice when stale. Read-only with a spinner while evaluating.
- **Conversation (centre).** The current question (role badge, "blocking" tag, related ACs), answer field, "Answer", "Skip" (hidden for blocking). Below it, pending patches: role, reason, unified diff, "Accept" / "Reject" (with optional reason). Below, history: answered/skipped questions and decided patches, newest first. Discarded patches appear as one warning line each.
- **Panels (right).** Checklist grouped PO / SM with pass/fail and detail. Derived preview: `spec.json` and `project.json` (pretty JSON, read-only), plus a list of the derived human tasks. Secrets rows with value input. Session tokens (per role, total cost) from `STEP_FINISHED`. "Start" enabled only in `ready` and not stale; on success navigates to `/runs/:runId`.

The page loads `GET /refine/:sessionId` once and then applies SSE events with a browser-side reducer (`web/src/refine/reducer.ts`), the same pattern as the Execution screen. Copy in English.

## 7. Security

- Host check as before. Draft paths are built from validated slugs only; the API never accepts a path.
- Agent steps get the sanitized environment; secrets are never in a pack (only their names and present/absent).
- `writeSecret` is the only writer of `~/.teams-ai/secrets/`; the API returns hints only.
- Patches can only target the two Markdown files of the draft; derived JSON is never patched.
- Phase 0 uses `GH_TOKEN` from the secrets store through the existing git unit; the UI process never runs `gh` for bootstrap.

## 8. Error handling

| Failure | Response |
|---|---|
| derive output fails `Project`/`Spec` validation | `REFINE_CYCLE_FAILED {reason: issues}`; state `error`; UI lists the issues next to the editor |
| An agent step fails (schema retries exhausted, quota) | `REFINE_CYCLE_FAILED`; state `error`; quota reasons show the `until` time |
| Server restart mid-cycle | Replay: a `REFINE_CYCLE_STARTED` without its `REFINE_EVALUATED`/`REFINE_CYCLE_FAILED` is treated as failed with reason `interrupted`; the human re-evaluates; nothing is charged as an attempt |
| Patch `find` ambiguous or absent | Discarded with reason; never applied |
| Repository exists but the human chose "New project" | 409 on `POST /projects/new` with "repository exists; register the project instead" (checked with `gh repo view` when gh is green, else skipped) |
| Start when a run is already active for the spec | 409 (same rule as block A) |
| Phase 0 push rejected (repo not empty, protected branch) | `PHASE_FAILED {phase: 0, reason}`; run ends `phase-failed`; visible in Execution |

## 9. Testing

- `test/refine/session.test.ts` — state machine with a fake `runStep`: first evaluate yields questions and pending patches; blocking skip refused; answers appear in the next pack; a patch with an absent `find` is discarded; accept modifies the file and sets stale; reject feeds the reason to the next pack; `ready` only with all green, no pending patch and secrets present; restart mid-cycle replays as `error: interrupted`; `started` refuses everything.
- `test/refine/derive.test.ts` — AC ids preserved for unchanged text, next free id for new ACs, duplicate rejection, `status`/`specHash`/`specVersion` forced.
- `test/refine/patches.test.ts` — validation and application, diff output.
- `test/api/refine-api.test.ts` — every route with `startApi`, a temp home and the fake `claude`; 409 rules; SSE replay; Start spawns the fake CLI with `--draft` and `--run-id` and registers the project.
- `test/orchestrator/phase0.test.ts` — scripted `Exec` and a local bare remote: no repository → create/clone/commit/push; repository exists → docs PR through the merge queue; kill after each intent and `resume` completes without duplicate commits or PRs.
- `web/src/pages/Refinement.test.tsx` — render per session state; Start disabled when stale.
- Live check before merge: "New project" for a copy of hello-app, real PO/SM evaluation, three answers, one patch accepted and one rejected, one secret entered, Start creates the repository on GitHub and the Execution screen shows Phase 1 running.

## 10. Open items to validate during implementation

- Whether the `derive` step on the cheap tier preserves AC ids reliably enough; if not, derive returns ACs without ids and the orchestrator assigns them by text matching only.
- Prompt wording for `refine` so that PO and SM report exactly the checklist ids they own.
- Whether `gh repo create --private --clone` is enough for Phase 0 or the existing `ensureRepo` needs the `--push` path removed for the empty-clone case.
