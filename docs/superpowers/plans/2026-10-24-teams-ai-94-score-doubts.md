# Plan 94 - The stage review fixes what the Jev doubted, not a number

## Context

The diagnosis of `kayron-hub-001` (plan 91 scores, commit `36e6bce`) showed that the low document scores are mostly real defects, not judge noise:

- design.md promises tokens that its CSS block never declares, and holds stack and business rules.
- briefing.md lacks the written explanation of each flow step that the charter requires, and names Next.js and Go.

The stage review received only the four numbers as an index, with no place to look, and is told not to change a document to raise a number. Keep that guard.

## Change

The scorer already answers every window. A window below `DOUBT_BELOW` (0.6) is a place the Jev doubts. The score stores these places, and the stage review gets one line per doubt.

- `server/refine/readiness.ts`: `ScoreDoubt` (check, value, and `part`: the window's index and count, the headings that open it and the next one, or `null` for the whole document). `DocScore.doubts` is optional, so journals from before this plan still reduce. `DOUBT_BELOW = 0.6`.
- `server/refine/jev-scoring.ts`: one list of window reports per run feeds both the `onWindow` callback and the doubts. For `concrete`, `consistent` and `scoped`, each window below the cut is a doubt with its place. For `complete` (the best window counts), one whole-document doubt when no window reaches the cut. A single-window document gives whole-document doubts. Non-answers still make the whole result unavailable, as before.
- `server/refine/stage-cycle.ts`: `stageReviewPack` takes the stored `score` (not a prebuilt string) and builds the index lines plus a "Where the Jev doubts this document" section. Each doubt line names the check, its value, its place and what to look for (one fixed sentence per check). The gating is unchanged: confidential, blank and outdated documents get no index and no doubts.
- The page is unchanged: `DocScoreView` and `ReadinessBanner` read only `checks`.

Deviation from the first plan: a doubt carries `part` (index and count) next to the headings, because `flow.md` has no headings and would otherwise have no place.

## Verification done

- Tests first: the new scorer, reducer and stage-review tests failed for the right reason before the change; the reducer guard passed (it is a regression guard).
- Focused files: `jev-scoring`, `jev-scoring-answers`, `state`, `stage-cycle` and `readiness`, 111 of 111 pass.
- Typecheck of the root project: clean.

## Not done yet (needs the owner's go: Claude quota and OpenRouter cost)

- Full root and web suites, and the web build (the page imports `readiness.ts`).
- Deploy by clean export, then one design stage review on a throwaway project seeded with scratch copies of the five documents (never on `kayron-hub-001`: moves and the reshape pass rewrite documents).
- Success test: the proposed patches fix the real defects named in the diagnosis, and the scope and consistency windows of design.md rise in `scripts/evals/doc-readiness.ts`.

## If the review still ignores the doubts

The next levers are a dedicated fix pass per doubted window, or backward moves for foreign content. Decide only with the measurement above.
