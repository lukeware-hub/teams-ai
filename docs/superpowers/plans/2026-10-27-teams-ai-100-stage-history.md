# Plan 100 - The stage review pack carries the history of the draft

## Context

Increment 5 of plan 95 (stage history). A stage answer is journaled at once (`QUESTION_ANSWERED`), but only backlog mode writes it into `briefing.md` (`RefineSession.answer`). The stage review pack never read the journal, so it could not see the owner's earlier answers. Plan 95 measured 39 of 96 stage questions repeating an earlier answered one.

## Change

1. **One function for the history** (`server/refine/packs.ts`, `historyBlocks`). It renders the four sections the full review already had: the answered questions with their answer, the skipped questions, the open questions waiting for the owner, and the rejected patches. `refinePack` uses it, and its text does not change; the existing tests pin it.
2. **The stage review pack** (`server/refine/stage-cycle.ts`, `stageReviewPack`). It takes the draft's questions and rejected patches and appends the same four sections after the stage document. `runStageCycle` passes the journal state read at the time of the review.
3. **Nothing is written.** The history is read from the journal state. `briefing.md` is not written at stage time, so the later stages keep their text.

## Impact

- Full review packs: the same text. The existing tests pin it.
- Stage review packs: four more sections, sized by the draft's questions and rejected patches. `fitPackBudget` raises the pack budget to fit them, up to the 120 thousand token cap. Past the cap the stage fails with the pack's own message, as an oversized document already does.
- The stage reorganization pass is not changed. It shares `reorganizePack` with the full rounds, and it can ask a question too. Measure it before changing it.
- No page, state or event changes.

## Deviations

- Only the review pack, as plan 95 names it. The reorganization pass is left out (see Impact).
- A stage pack shows no spec decisions (`decisions: []`): a stage runs before any spec is derived.

## Verification

- `test/refine/stage-cycle.test.ts`: the review pack of a stage carries the answered, skipped and open questions and the rejected patch of a draft, through `runStageCycle` with the answers in the journal; a stage review pack with no history says none under each heading.
- `test/refine/packs.test.ts` and the other refinement tests: the full review text is unchanged.
- Full root and web suites, typecheck and web build: exit codes recorded in the commit.
