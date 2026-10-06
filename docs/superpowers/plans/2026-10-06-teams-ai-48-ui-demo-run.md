# Plan 48 - Demo run in the UI (R9.5), critically scoped

Status: rejected (2026-10-06, human decision: "não quero nada de demo... tem que ser tudo coisa de verdade"). Not implemented. Roadmap item R9.5 withdrawn.

## Why this plan looks different from the ROADMAP's one-liner

R9.5 said: "`teams-ai run --dry-run` is not usable end to end today... Make a scripted scenario on
`test/fixtures/todo-api` and a UI button." Three rounds of research before writing any code found that extending
`--dry-run` is a much bigger and riskier job than that line implies, and that a safer path already exists.

**What extending `--dry-run` would actually require** (rejected):
- `preconditions()` (`server/cli.ts:146-162`) hard-requires real `claude`/`gh`/`docker` on the host even under
  `--dry-run` - confirmed by the one existing test of this path (`test/e2e/pipeline.e2e.test.ts:113-134`), which
  only asserts it fails at "preconditions failed". Making a real dry run skip this is itself a change to a
  security-relevant check.
- `Scenario` (`test/fixtures/fake-claude/scenario.ts`) only fakes the `claude` binary. `exec`/`ghExec` in
  `loadRunDeps` (`server/cli.ts:179-180`) are always the real `execCommand` - a dry run today would still push to
  real git and open real GitHub PRs. No scripted example anywhere covers Phase 5 (deploy, real Docker target) or
  Phase 6 (report); `loop.test.ts`'s `happyScenario` only reaches phases 1-3.
- The one place everything (`exec`, `ghExec`, Docker, `gh`) is already faked for a full pipeline
  (`test/e2e/pipeline.e2e.test.ts`) uses `main()`'s `factory` parameter (`server/cli.ts:211`) - an **in-process**
  dependency-injection seam. It is unreachable from how the API actually runs things: `defaultRunControl`
  (`server/api/run-control.ts:89-111`) spawns a real OS child process (`tsx server/cli.ts run ...`); a spawned
  process cannot receive a JS closure, only `argv`/env strings. Reusing the test harness for a real UI-triggered
  demo would mean inventing a new, never-existed mechanism to fake `exec`/`ghExec`/the deploy target across a
  process boundary - new untested surface on the exact paths (git, GitHub, Docker) this project is most careful
  about.
- Net: a faithful end-to-end fake run would be a substantial, mostly-new feature (new CLI mode, new env-based
  fake-exec plumbing, a fake deploy target, scripted output for every phase), not "add a button."

**Second concern, independent of cost**: a scripted demo *always* succeeds. The project's own definition-of-done
run (golden run 3) has never finished for real (closed, incomplete - R5.1). A demo that always shows a clean
success could read as "it works," masking that the real path is unproven. Any demo must say plainly that it is
canned data, not a real execution.

## The safer path found instead

`web/src/pages/Run.tsx` and the server routes under it do not care how `events.ndjson` got there:

- The client (`useJournal`, `web/src/useSse.ts:27-58`) just opens an `EventSource` on a URL and understands
  `journal`/`end` SSE frames. `runApi.runEvents(runId)` (`web/src/api.ts:162`) is a plain string template.
- The server's SSE route (`GET /api/runs/:runId/events`, `server/api/run-routes.ts:413-441`) and the snapshot
  route (`GET /api/runs/:runId`, `:358-412`) are both driven purely by whether
  `<runsDir>/<runId>/events.ndjson` exists on disk (`events()`/`loadEvents`, `:68-79`) - no pid, no liveness
  check gates reading it. `tailJournal` (`server/api/journal-tail.ts`) is pure file-polling.
- A project lookup failure for the journal's `projectId` is already tolerated (`.catch(() => null)`,
  `run-routes.ts:376-390`) - the demo's `projectId` does not need a real registered project.
- `test/fixtures/runs/hello-run.ndjson` already proves the exact event shapes the real orchestrator emits render
  correctly in this page (`web/src/pages/Run.test.tsx`, `web/src/run/selectors.test.ts`) - it just stops at
  `RUN_PAUSED` (a test fixture for a different test, not a finished run).

So: no new server route logic, no new client code, no CLI/exec/git/docker/claude surface touched. The only gap is
a file: a complete, successful NDJSON journal, placed at the one path both existing routes already read.

## Approach

1. **Author the demo journal as typechecked code, not hand-written JSON** - same pattern as
   `test/fixtures/runs/make-hello-run.ts`, so the event shapes are checked against the real `OrchEvent`/`RunEvent`
   types at compile time instead of silently rendering wrong. Covers, on a 2-task toy spec: tech-spec, plan,
   per-task dev/review/security, gates passing, merge, Phase 4 verification, Phase 5 deploy (`DEPLOY_VERIFIED`),
   Phase 6 report, ending on `RUN_FINISHED` with `result: 'awaiting-validation'` (the real success terminal
   state, not `done` - a demo should stop exactly where a human would need to act next, same as a real run).
   Lives as a real shipped asset (not under `test/`), e.g. `server/demo/demo-run.ts` generating
   `server/demo/demo-run.ndjson` at build time or committed as a static file - decide which during review of this
   plan; either way it ships in the Docker image like any other file (no `.dockerignore` exclusion applies).
2. **One small new API route**, e.g. `POST /api/demo-run`: idempotently copies the bundled fixture to
   `<runsDir>/demo-001/events.ndjson` if not already present (plain `fs.copyFile`, no process spawn, no git, no
   Docker, no Claude), then returns `{ runId: 'demo-001' }`. This is the only new server-side logic; everything
   downstream is the existing, already-tested run-viewing path.
3. **UI button** on the Projects page (empty state or a persistent "Ver demonstração" action): calls the new
   route, navigates to the existing `/runs/demo-001` route.
4. **Mandatory demo banner** on the Run page when `runId === 'demo-001'` (or any reserved demo id): a persistent,
   unmissable "dado de demonstração - não é uma execução real" notice, so the always-succeeds nature of a canned
   run is never mistaken for proof the real pipeline works.

## What this actually buys the project (asked for explicitly)

- Lets someone try the product's UI and see the whole mental model (phases, tasks, evidence, deploy, report)
  in under a second, with no Claude account, no GitHub token, no Docker, no cost - genuinely removes a real
  adoption barrier (today, R9.3's "Comece em 5 minutos" quickstart still ends at a real, paid first run).
  Legitimate value.
- No contribution to the project's actual Definition of Done (golden run 3 / the two-run comparison) - it is
  pure onboarding polish, not verification of anything. Should not be mistaken for progress on finishing the POC.
- Risk introduced is small and reviewable: one new route doing a file copy, one typechecked fixture file, one UI
  button and one banner. No change to the orchestrator, runner, git, GitHub or Docker code paths at all.

## Files touched

`server/demo/demo-run.ts` (new, fixture generator, reusing `test/fixtures/runs/write-run.ts`'s `eventLines` or an
equivalent shipped copy), `server/demo/demo-run.ndjson` (new, generated or committed), `server/api/run-routes.ts`
(one new route), `web/src/api.ts` (one new call), `web/src/pages/Projects.tsx` (one button),
`web/src/pages/Run.tsx` (one banner, keyed off the reserved demo run id), plus tests for the new route and the
banner.

## Verification

- `npm run typecheck` (the fixture generator must typecheck against real event types - this is the main
  bug-prevention mechanism asked for).
- `npm test`: a server test for the new route (idempotent copy, returns the fixed runId, works with no project
  configured) and a web test asserting the demo banner renders for the demo run id and the existing Run page
  tests still pass unmodified against the new, longer fixture if it replaces rendering assumptions anywhere (it
  should not, since it reuses the same event types `hello-run.ndjson` already exercises).
- Manual check: click the button in a dev build, confirm the Run page renders a full phase-by-phase demo ending
  at "aguardando validação" with the banner visible, no network/process activity beyond the one file-copy call.
- No real Claude/git/GitHub/Docker involved anywhere in this plan, so no paid verification step is needed.

## Out of scope (explicitly deferred)

- A real `--dry-run` that executes the actual orchestrator against faked tools end to end. Flagged above as a
  separate, much larger piece of work with its own risk profile; not part of this plan.
