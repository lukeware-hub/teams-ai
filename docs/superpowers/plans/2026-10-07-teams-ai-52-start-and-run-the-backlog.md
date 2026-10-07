# Plan 52 - R11.3 and R11.4: start the backlog and run it spec by spec

Status: scope approved by the human on 2026-10-07 ("do not turn the backlog off, build R11.3 and R11.4, go on with the whole test, cost is not the concern now, the GitHub side effects are a go"). Parent: plan 50. Roadmap items R11.3 (freeze and publish planned specs) and R11.4 (autonomous program controller), cut to the smallest vertical slice that takes a refined backlog to delivered specs; the Jev repair loop is R11.5/R11.5a.

## Two worlds, never mixed

- **Target project**: its five docs, `docs/backlog.md`, `docs/specs.json` and `docs/specs/<id>/{spec.json,spec.md,preplan.json}` in the refinement draft and later in its GitHub repo.
- **teams-ai**: every change below is `server/`, `web/`, `.claude/agents/`, `test/`.

## Design

**Freeze at the item's turn.** A `planned` item spec is frozen (`specVersion+1`, `running`, `specHash`) when its run starts, never before (`freezeSpec` accepts `planned`). The frozen copy is written into the draft root's `docs/specs/<id>/spec.json`, where the run reads it (`--draft`, `loadRunDeps`).

**Publish (Phase 0).** First spec: the repository does not exist yet and Phase 0 already copies the whole draft `docs/`. Later specs: the docs PR today copies four files and needs `specs/<id>/brief.md`, which item specs do not have (`bootstrap.ts:67`). It now copies the run's own spec directory (overwriting, so main gets the frozen `spec.json`) and every other file of the draft `docs/` that main lacks (`briefing.md`, `stack.md`, `flow.md`, `design.md`, `backlog.md`, `specs.json`, other planned specs), never overwriting what main has.

**First spec.** `isFirstSpec` reads main (nothing but `docs/` and `.github/`), so a resume of spec 1 after its scaffold merged reads false and Phase 4 fix tasks reject `T0-scaffold`. `firstSpec` is journaled in `RUN_STARTED` and reused on resume.

**Program ledger.** `program.json` in the draft root, written atomically: ordered items (spec id, key, rank, dependsOn) each `pending | running | done | failed | blocked`, with `runId`, times and a reason; program status `running | finished`. A pure controller `tick()` with injected effects (list items, freeze, start a run, read a run's status, complete a spec, write the ledger):
1. A `running` item: read its run. `awaiting-validation` with zero blocked tasks and every criterion passed in the journal's evidence: complete it (the existing `complete` run), then `done`. A run `interrupted` with no live process: resume it (bounded). Any terminal failure (`blocked`, `deadlocked`, `phase-failed`, `verification-failed`, `deploy-failed`, ...): `failed` with the reason, its dependents `blocked`.
2. No item running: take the first `pending` item by rank whose dependencies are all `done`, freeze it, start its run, `running`. Nothing left to take: program `finished`.
One item at a time (shared clone, one compose stack, account-wide quota). Restart-safe: the ledger is the only state, the tick runs every few seconds in the UI server and on start. The Jev classification and repair loop of a failed spec are R11.5/R11.5a: here a failure isolates the item and the program goes on with the specs that do not depend on it.

**API and screen.** `POST /api/refine/:p/:s/start` in backlog mode starts the program (409 unless the backlog is detailed and `ready`; ledger created once, idempotent); `GET .../program` returns the ledger with each item's run, cost and status. The refinement screen enables "Iniciar" for a ready backlog and shows the program panel (item, status, run link, cost, reason); the run itself is followed on the existing Run page.

**Pre-plan at run time.** Phase 2 receives `preplan.json` (read from main with the other docs) as context in the plan pack and journals deviations (module or criterion coverage that differs). It stays context, never the plan (`plan.json` is only ever the real plan).

## Tasks (test first, one commit each, pushed; `npm test`, `npm run test:web`, `npx tsc --noEmit` before each push)

1. `freezeSpec` accepts `planned`.
2. Phase 0 publish of planned specs and the missing docs (existing-repo path), without `brief.md`.
3. `firstSpec` in `RUN_STARTED`, reused by `loadRunDeps` and resume.
4. `server/program/ledger.ts` and `controller.ts` (fakes: order, dependencies, failure isolation, restart, completion gate).
5. Session/registry: start an item (freeze item, spawn `run --draft` on its spec id, no sticky `started`) and the program start route, `GET .../program`.
6. UI-server wiring of the tick; the web screen (button and panel).
7. Phase 2 consumes `preplan.json` and journals deviations.
8. Live: refine `r112-biblioteca` to ready in the browser, start the program, follow every run, fix what breaks (each fix with a test), write the report.

## Risks

A paid run with GitHub side effects (private repo and PRs under the configured owner, containers through dind); parallel UI sessions touching the shared checkout; the draft root `spec.json` of a delivered spec staying `running` (R11.0: the controller completes through the run journal, not the draft file); container restart kills the spawned run (the tick resumes interrupted runs); AC ids already global, so no JUnit collisions across specs; the repair loop is deliberately minimal.

## Verification

Unit tests per task with fakes. Live: `r112-biblioteca` (6 to 8 items) through Start to every item `done`: repository on GitHub with one merged PR per task, JUnit with every acceptance criterion passed per spec, green deploy and smoke, `spec.json` of each item `done` on main, the ledger and the screen agree with the journals.
