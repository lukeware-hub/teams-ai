# Plan 51 - R11.2: a spec and a pre-plan for every backlog item

Status: approved by the human on 2026-10-06, together with the gap audit recorded in the ROADMAP (Stage 11). Parent:
plan 50 (`2026-10-06-teams-ai-50-spec-driven-backlog.md`). Roadmap item R11.2.

## Goal

Refinement in backlog mode stops at an outline today (R11.1). After this plan, when the human clicks "Detalhar specs" the
agents derive, for every backlog item, one spec (PO: objectives, features, acceptance criteria) and one pre-plan (SM:
modules, tasks, risks), so that refinement ends with the whole tree docs -> backlog -> spec -> plan -> tasks reviewed and
covered. Later cycles re-derive only what the docs changed. Runs still cannot start from the backlog (R11.3).

## Two worlds, never mixed

- **Target project**: the product teams-ai develops (for example Kayron Hub). Every `docs/...` path in this plan is a
  file of the target project, in its refinement draft (`<workspaces>/<projectId>/refine/<draftId>/docs/`) and later in
  its GitHub repo. Its five docs are written by the human.
- **teams-ai**: every change in this plan is teams-ai code (`server/`, `web/`, `.claude/agents/`, `test/`). teams-ai's
  own `docs/` is not one of the five docs.

## Decisions (human, 2026-10-06)

1. The target project's briefing becomes `docs/briefing.md` in backlog mode (today the per-draft
   `docs/specs/<draftId>/brief.md`). Single-spec mode is untouched.
2. The generated per-item Markdown is `spec.md`, not `brief.md`: in teams-ai refinement code `brief.md` always means the
   hand-edited briefing, and no run-time step reads a per-spec brief.md (packs come from spec.json,
   `server/orchestrator/steps.ts:23-32`, `server/cli.ts:171-176`). This departs from the roadmap wording.
3. The pre-plan file is `preplan.json`, never `plan.json`: Phase 2 reuses a `plan.json` found on main as the real plan
   (`server/orchestrator/phases/plan.ts:17-21`).
4. Global AC ids keep the `AC-\d{3}` format and are numbered by the orchestrator across the backlog.

## Design

**Briefing move.** `enableBacklog()` (`server/refine/session.ts`) runs an idempotent `moveBriefingToProject()`: rename
the draft's `docs/specs/<draftId>/brief.md` to `docs/briefing.md`; if `docs/briefing.md` exists, keep it and append the
draft brief under `## Nova demanda (<draftId>)` unless it is the bare template; remove `docs/specs/<draftId>/` (clears the
stale single-spec spec.json); `open()` repeats the move after a crash. In backlog mode the human and the target project
see only `briefing.md`: tab label, patch target, source citations in `specs.json`, `backlog.md`, `spec.md` and
`derivedFrom`. An internal key may stay `brief.md` only where it is never shown. `draftExists` accepts the per-spec brief
or the briefing, otherwise the registry returns 404 after the move. Phase 0 is untouched until R11.3.

**Per-item files** in `docs/specs/<draftId>-<key>/`: `spec.json` (status `planned`, `derivedFrom`), `spec.md`
(`renderBriefMd(spec)` under the header "Gerado pelo teams-ai a partir de spec.json; não edite. Fontes: …"), and
`preplan.json`. Directories of items removed from the outline are deleted by keys tracked in state.

**Contracts.** `SpecStatus` gains `planned`. `Spec.derivedFrom?: {backlogKey, inputHash, docsHash, sources:[{doc,
heading, hash|null}]}` is optional and outside HASHED_FIELDS. New browser-safe `server/contracts/preplan.ts`:
`{specId, specRev, inputHash, modules[1..8]{name, purpose}, tasks[1..12]{id "P1".., title, module, owner
dev|devops|front, criteriaRefs (min 1), dependsOn}, risks[0..5]{risk, mitigation}}`, `specRev = computeSpecHash(spec)`.

**Events and state.** `BACKLOG_DETAIL_ENABLED`, `SPEC_DERIVED {cycle, key, specId, inputHash, rev, spec|null, issues}`,
`PREPLAN_DERIVED {cycle, key, inputHash, specRev, preplan|null, issues}`; `BACKLOG_DERIVED` gains `flowHeadings` and
`draftHash`. `BacklogState` gains optional `detail`, `flowHeadings`, `draftHash`, `specs`, `preplans`, `acHighWater`;
the `BACKLOG_DERIVED` reducer merges instead of replacing and drops the rows of removed keys.

**Steps.** `spec` (role PO): `{specHash, specs[1..3]{key, type, bug?, objectives, features, acceptanceCriteria,
outOfScope, externalDependencies}}`; the orchestrator sets specId, status, hash, version, derivedFrom and AC ids, then
`Spec.parse`. `preplan` (role SM): `{specHash, preplans[1..3]{key, modules, tasks, risks}}`, checked by
`server/validators/preplan.ts` (unique ids, known deps, acyclic, known module, only this spec's criteria, every criterion
covered). Both packs carry everything the step needs and say so.

**Trigger, caching, cost.** "Detalhar specs" is enabled when the outline is `ready` and shows the estimated calls; from
then on each cycle re-details only items with no result, a changed input hash, or issues on the last attempt.
- Spec input hash: `{v, key, title, scope, dependsOn, sources, text of every cited section}`. The briefing and project.md
  enter only through cited sections.
- Pre-plan input hash: `{v, key, title, dependsOn, specRev, stack.md, first}` (`first` = rank 1, carries the scaffold).
- The backlog pack's previous backlog carries scope and sources ("keep verbatim when your sources are unchanged").
- Batching: items to re-run grouped by epic in rank order, 3 per call, each validated alone, one solo retry with its
  issues. A per-cycle `Governor(3)`; the first quota or auth failure stops new batches and fails the cycle; finished
  items stay cached.
- Estimate for 30 items in 6 epics: first detailing 27 calls (63 unbatched), about 0.5M input tokens; one flow section
  edited (3 items) at most 6 calls, about 0.2M; answers only 3 calls; stack.md edited 16. The live check measures it.

**Global AC ids.** Numbered uniquely across the backlog, above every id already in the target project's
`docs/specs/*/spec.json`; same text or an echoed id keeps its id; numbers never reused; fail closed at AC-999. Removes
the cross-spec hazard where Phase 4 matches criteria against the whole repo's JUnit (`verify.ts:121-126`,
`matrix.ts:32`) and lets Jev decision 3 work across specs.

**Readiness and coverage.** Browser-safe `server/refine/coverage.ts` (`coverageMatrix`, `coverageGaps`; citation matching
moves there from `validators/backlog.ts`). In detail mode `ready` also needs zero gaps: every flow heading cited; every
item has a valid spec and a pre-plan with matching `specRev`; every AC has a pre-plan task; every task cites an AC of its
spec. Doc edits mark backlog sessions stale. `sm.dependencies-and-secrets` reads all item specs.

**Review pack** (PO and SM `refine`, under the 120k cap): docs, Jev result, project.json, a ~350-token digest per item,
the coverage gaps, full JSON only for items changed this cycle while under ~100k, history; the raw outline JSON is
dropped in detail mode. Specs change only through the docs; questions cite AC ids.

**UI.** `BacklogPanel`: "Detalhar specs" with the estimate and per-item chips (planejada, em refinamento, erro). New
`SpecTree.tsx`: doc section -> spec -> AC -> pre-plan tasks, gaps in red, counts. `Refinement.tsx`: AC tooltips across
item specs, progress text for the new steps; Start stays disabled.

## Tasks

Each task: test first, one commit, pushed. Per task `npx vitest run <file>`; before each push `npm test`,
`npm run test:web`, `npx tsc --noEmit`.

### Task 1: Briefing move to the target project's `docs/briefing.md`

- Files: `server/refine/draft.ts`, `server/refine/session.ts`, `server/refine/patches.ts`, `server/refine/packs.ts`,
  `server/refine/backlog.ts`, with their tests.
- Test first: the move renames; appends when `docs/briefing.md` exists; is idempotent; leaves single-spec drafts
  untouched; the session still opens (GET returns 200) after enabling backlog mode; packs and patches name
  `briefing.md` in backlog mode.
- Done when single-spec tests are unchanged and green.

### Task 2: Contracts

- Files: `server/contracts/spec.ts`, new `server/contracts/preplan.ts`.
- Test first: `planned` parses; `derivedFrom` is kept and does not change the spec hash; a pre-plan task without
  criteria is rejected.

### Task 3: Step kinds `spec` and `preplan`

- Files: `server/agents/outputs.ts` (and the registry/steps wiring the `backlog` kind used).
- Test first: outputs parse with 1-3 items and reject 4; JSON schemas are generated.

### Task 4: Sections, input hashes, batches

- Files: new `server/refine/sections.ts`, new `server/refine/details.ts`.
- Test first on a Kayron-style fixture: a section ends at the next numbered section; editing one section changes only
  the hashes of items citing it; a dependency's scope does not enter the hash; a batch holds at most 3 items of one epic.

### Task 5: AC allocator, item spec post-processing, pre-plan validator

- Files: `server/refine/details.ts` (or a sibling), new `server/validators/preplan.ts`.
- Test first: ids unique across items, stable across cycles, above the highest id in the target project's specs,
  failing at 999; every pre-plan rule.

### Task 6: Coverage, events, state

- Files: new `server/refine/coverage.ts`, `server/refine/events.ts`, `server/refine/state.ts`,
  `server/validators/backlog.ts`.
- Test first: `BACKLOG_DERIVED` merges; a removed key drops its rows; each gap blocks `ready`; doc edits mark backlog
  sessions stale; single-spec status unchanged.

### Task 7: Step packs

- Files: `server/refine/details.ts` or new `server/refine/detail-packs.ts`, `server/refine/backlog.ts`.
- Test first: only cited sections are included; a shared section appears once; previous ids and the rejection are
  carried; the backlog pack carries scope and sources.

### Task 8: Review digest

- Files: `server/refine/packs.ts`.
- Test first: 60 items with 45k-token docs fit under `PACK_TOKEN_CAP`; gaps are listed; the raw outline JSON is gone in
  detail mode.

### Task 9: Cycle integration

- Files: `server/refine/cycle.ts`.
- Test first (vi.fn agent): call counts per scenario of the estimate; files written (planned `spec.json`, `spec.md` with
  the header, `preplan.json`; no `brief.md` or `plan.json` per item); solo retry; a quota failure stops new batches; a
  retired item's directory is removed.
- A targeted review of tasks 1-9 follows this task.

### Task 10: Session and API

- Files: `server/refine/session.ts`, `server/api/refine-routes.ts`, `web/src/api.ts` (`refineApi`).
- Test first: `enableDetail()` returns 409 unless the outline is ready; `POST /api/refine/:p/:s/backlog/detail`; the
  fake agent scripts `spec/po` and `preplan/sm` (`test/fixtures/fake-run-agent.ts`).

### Task 11: Agent policies

- Files: `.claude/agents/po.md` ("Detailing a backlog item (`spec` step)"), `.claude/agents/sm.md` ("Pre-planning
  (`preplan` step)"), the briefing patch path.
- Test first: `backlog-policy.test.ts` asserts the new sections.

### Task 12: Web

- Files: `web/src/refine/BacklogPanel.tsx`, new `web/src/refine/SpecTree.tsx`, `web/src/pages/Refinement.tsx`,
  `web/src/api.ts` types, with tests.
- Test first: the button with its estimate, the chips, the tree with gaps, AC tooltips across item specs.

### Task 13: Roadmap outcome and live check

- Record the outcome in the ROADMAP. The live check waits for the human's ok (Claude quota and a few Jev calls; no
  Start, no GitHub).

Deferrable if the work grows: batching (one item per call uses the same schema), skipping the backlog step when the docs
hash is unchanged, per-item downloads, a "too many items changed" cost guard, Jev decision 2 for new criteria.

## Left for later

- **R11.3:** `freezeSpec` accepts `planned`; Start with dependency closure (the registry must spawn the item spec id);
  Phase 0 publishes `docs/briefing.md`, stack/flow/design, `backlog.md`, `specs.json` and every planned spec directory
  absent from main, never overwriting; Phase 2 gets `preplan.json` and journals deviations; `planned` label on Projects;
  `chooseSpecId`/`isFirstSpec` with many spec directories.
- **R11.4:** queue, order, repair loop, automatic completion (relies on the global AC ids).
- **R11.7:** re-derive from the `derivedFrom` section hashes.

## Risks

The two reviews dominate cost; outline rewording can cascade into re-derivations (previous scope carried); an uncited
heading leaves the PO without context (lenient match, unresolved headings listed in the digest); unhashed context
(personas, a briefing-wide rule) never re-derives a spec until R11.7; one bad item can spoil a batch (solo retry); the
AC-999 ceiling; scaffold tasks must cite an AC; the governor and the quota are shared with the human's own sessions; the
journal grows about 5 KB per detailed item.

## Verification

Per task and before each push as above. Single-spec refinement behaves exactly as today. Live check (needs the human's
ok): a throwaway target project from "Novo projeto" with a 3-section `flow.md` (4-6 items, 2 epics). Quebrar em backlog;
Avaliar until the outline is ready; Detalhar specs, Avaliar; Reavaliar with no edit; edit one flow section, Reavaliar.
Pass when: the draft has `docs/briefing.md` and no `docs/specs/<draftId>/`; each item directory holds `spec.json`
(planned, `derivedFrom` with section hashes), `spec.md` with the generated header and `preplan.json`, and no brief.md or
plan.json; AC ids are unique across items and unchanged by the no-edit cycle; `STEP_STARTED` counts match the estimate
(the no-edit cycle runs only front, PO and SM; the one-section edit re-runs only the items citing it); full coverage
gives `ready` and Start stays disabled; tokens and cost per cycle are recorded from "Consumo de IA".
