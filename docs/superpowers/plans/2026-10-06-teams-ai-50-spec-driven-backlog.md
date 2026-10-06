# Plan 50 - Spec-driven backlog: break the docs down, organize, prioritize, select, queue

Status: approved by the human on 2026-10-06 (design, roadmap, Stage 0 and R11.1 detail). Roadmap items R11.0-R11.5.
Each later item (R11.2 onward) gets its own plan and approval before implementation.

## Goal

Today one refinement session derives ONE spec and "Iniciar análise" freezes it and starts ONE run. The real input is much
bigger (the Kayron Hub `flow.md` is 49 KB with 18+ numbered sections, dozens of deliverables). The agents must take the five
docs (project.md, briefing.md, stack.md, flow.md, design.md), break everything down, organize the whole backlog and
prioritize it. The human selects what to implement. When refinement ends everything is organized and every spec is
generated (anticipated during the cycles). Work follows spec-driven development: the docs are the truth, the backlog and
the specs are derived and follow the docs when they change.

## Decisions (human, 2026-10-06)

1. Selected specs run through an automatic queue: one run each, in dependency order, stop at the first failure.
2. Agents propose organization and priority; the human marks what to implement and adjusts by writing in the docs.
3. All specs are published to `main` when the first run starts; unselected ones stay for later.
4. When refinement ends ALL specs are detailed (objectives, features, acceptance criteria); questions answered once.
5. When a doc changes later, specs not yet started are re-derived only where the source changed (by hash), keeping ids and
   the human's priority decisions; delivered specs produce an adjustment spec for approval.

## Spec-driven principles

- The five docs are the only hand-edited truth. Backlog and specs are derived, reproducible and carry provenance
  (`derivedFrom`: docs hash + the sections that produced them).
- The human's decisions (priority, cuts, grouping) are written in natural language in `briefing.md` (agents may propose
  them as the existing accept/reject patches) and are binding for the derivation. No parallel hand-edited backlog state.
- Selection and the queue are execution choices, kept in session/queue state, not truth.
- A frozen spec never mutates; drift on a started or delivered spec yields a new adjustment spec.

## Design

- **Backlog mode** is explicit (button "Quebrar em backlog", event `BACKLOG_ENABLED`); existing single-spec flows are
  untouched. Each cycle in backlog mode runs: Jev docs check, a `backlog` step (role PO) producing epics and items
  (`key`, `title`, `epic`, `scope`, `priority` P0-P3, `rationale`, `dependsOn`, `sources`, `size`), then (R11.2) one `spec`
  step per item whose input hash changed, then PO and SM `refine` over the backlog (the existing questions, patches and
  checklist loop). Deterministic validators: unique non-reserved slug keys, dependencies resolve and are acyclic, a
  dependency is never lower priority than its dependent, 60 items max, every item cites a source, every `flow.md` section
  heading is cited (best effort).
- **Status `planned`**: a derived, complete, not frozen spec that can still be re-derived; frozen (hash, version+1,
  `running`) only when its run starts. New optional Spec fields use `.optional()` and stay out of `HASHED_FIELDS`.
- **Ids**: spec id is `${draftId}-${key}`; AC ids are global across the set; the umbrella briefing stays at
  `docs/specs/<draftId>/brief.md` without a spec.json.
- **Start and publish (R11.3)**: selection with dependency closure; Phase 0 publishes docs plus every `planned` spec absent
  from main, never overwriting anything already there.
- **Queue (R11.4)**: items 2..N are frozen at their turn and started like the Projects "Iniciar execução" button;
  persisted `queue.json`, disk-only reconciler tick in the UI server (pattern of `server/supervisor/supervise.ts`).
- **Sync (R11.5)**: a new session compares each spec's `derivedFrom` with the docs on main and re-derives or proposes.

## R11.0 - Stage 0, prerequisite fixes (separate commits)

1. Context pack silently drops the docs: `feedback` is the last droppable section and is removed whole over budget
   (`server/knowledge/context-pack.ts:74,150-158`). Size the budget from the real feedback and fail the step when it is
   still dropped.
2. Resume can run the wrong spec: `loadRunDeps` takes `.at(-1)` of `docs/specs` (`server/cli.ts:168`) and the resume argv
   has no `--spec`. Add `specForRun` reading the spec from the run's `RUN_STARTED`; the argv stays (3 tests pin it).
3. `firstSpec` counts directories (`server/cli.ts:189`): one dir stays true, else true iff no OTHER spec has
   `docs/specs/<id>/report.json` on `origin/main`; no repo means true.
4. Project dir by spec and a live pid with no `state.json` counts as running (`run-routes.ts:48-54`, `run-index.ts:180`).

## R11.1 - backlog outline (tasks, test first, one commit each)

1. `server/contracts/backlog.ts` (`Backlog`, `BacklogItem`, `validateBacklog`).
2. New step kind `backlog` in `outputs.ts`, the agents registry and `steps.ts` `outputContract`.
3. `server/refine/backlog.ts` (`backlogPack`, `postProcessBacklog`).
4. `state.ts` / `events.ts`: `backlog` state, `BACKLOG_ENABLED`, `BACKLOG_DERIVED`.
5. `cycle.ts` backlog branch; generated `docs/backlog.md` in the draft.
6. `session.ts` `enableBacklog()`, `POST .../backlog`, `refineApi.enableBacklog`.
7. Web `BacklogPanel.tsx` and the button; "Iniciar" stays disabled in backlog mode until R11.3.
8. Policy text in `.claude/agents/po.md` and `sm.md`; one live cycle on the Kayron docs.

## Risks

Docs too big for the pack (R11.0.1); cost grows with the number of specs (explicit trigger, outline first, details only for
changed inputs, measure before R11.2); a bad breakdown (validators, citations, the human reviews the outline before details
exist); unattended queue cost and skipped Gate 2 (stop at first failure, confirm dialog, cap); derived specs going stale
after earlier runs (R11.5); parallel session conflicts (small hunks, rebase before each commit).

## Verification

Per task `npx vitest run <file>`; before each push `npm test`, `npm run test:web`, `npx tsc --noEmit`. Live R11.1 on the
Kayron docs in a throwaway project (spends quota; ask first): every flow section is a source of some item, priorities and
dependencies are coherent and acyclic, editing a decision in `briefing.md` changes the ranking while keys stay stable. A
project without backlog mode behaves exactly as today.
