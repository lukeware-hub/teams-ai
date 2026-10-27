# Plan 102 - A Spec Kit question that repeats a decision is repaired once, then dropped and kept on record

## Context

Plan 101 gave every prompt the question rules and the Spec Kit asker the earlier questions of its item, latest answer first. A repeat can still get through: the agent may reword a question the owner already decided, and the rules are only advice. On `kayron-hub-001` the same decision came back eight times on 2026-10-27. The Spec Kit had no check of its own: the only duplicate check was the Jev classifier, which fails open when it has no verdict (93 of the 187 calls made from 09:01Z on 2026-10-27 ended `exhausted`, and the question was kept).

## Change (Spec Kit only; full rounds and stage reviews follow in a later plan)

1. **The agent names the difference.** A Spec Kit question may carry `distinctFrom`: up to three entries, each the id of a decided question it repeats and one sentence of at least eight words with a fact that decided question did not have (`server/agents/outputs.ts`, `server/refine/events.ts`).
2. **The check.** `server/refine/question-guard.ts` compares each new question with the decided questions of its own item: answered by the owner, or skipped by the owner. A repeat is a Jaccard overlap of 0.3 or more on the meaningful words (the same rule as `question-pairs.ts`). A repeat is kept only when every related decided question has an entry in `distinctFrom` whose sentence holds a word that decided question and its answer do not have. Otherwise it is unresolved.
3. **Repair once, then drop.** `runStep` (`server/refine/speckit.ts`) runs the step again once with a note that names each decided question and its id, and asks for `distinctFrom`. The repair round is journaled as blocked, so no reuse treats it as finished, and its questions are not triaged. A question still unresolved after the repair is journaled as `QUESTION_DROPPED` with the decided question it repeats and that answer, and the step is recorded as done.
4. **Kept on record.** `QUESTION_DROPPED` fills `droppedQuestions` in the state, not `questions`, so a dropped question never blocks the start. `QUESTION_REASKED` moves it back to the pending questions as a pending question with the same id, and the owner answers it like any other (`server/refine/state.ts`, `server/refine/session.ts`, `POST .../questions/:questionId/reask`).
5. **Owner screen.** A question with `distinctFrom` shows the block "Por que não é a mesma pergunta": each decided question, the owner's answer or "Você ignorou esta pergunta.", and the difference (`web/src/pages/Refinement.tsx`). The backlog screen lists the dropped repeats in a closed list, each with "Perguntar de novo" (`DroppedRepeats`). The layout follows the mock approved with the refinement plan (its section 8), reusing the classes of the sibling blocks.

## Deviations from plan 101 section 8 and the plan of record

- **Scope.** Full rounds and stage reviews keep their drop-only path for plan 103; this plan changes the Spec Kit path only, where the eight repeats happened.
- **Reask without a new run.** "Perguntar de novo" puts the dropped question back on the pending list directly, so no step runs again to produce it. The plan of record said a re-ask journals an exemption; the pending question needs none.
- **Step state of a drop.** The step of a dropped question is recorded as done, because the drop is final and visible. A blocked step would run again and drop again on every preparation.
- **Pending questions are not repeats.** Only decided questions count. An identical pending question is still deduplicated as before; a near-identical pending question is not checked yet.

## Verification

- `test/refine/question-guard.test.ts`: the related questions and their order, the rule for a difference, the keep and unresolved split, the note text, and the reducer for the drop, the reask and the no-duplicate case.
- `test/refine/speckit.test.ts`: a repeat of a decided question is repaired once, then dropped and kept on record, and can be asked again; a repeat whose `distinctFrom` names a real difference is kept with it.
- `web/src/pages/RefinementStages.test.tsx`: the block with the decided question and the difference; the dropped list with "Perguntar de novo", which calls the handler.
- Calibration on the live journal, before this plan (copy read inside the container, never written): at similarity 0.3 and above, same item, decided earlier question, 102 pairs; by judgment 72 are repeats of one decision (71%), 26 borderline, 4 false. That is the basis of the threshold.
- Full root and web suites: exit codes recorded in the commit.
- Chrome: the block and the dropped list checked on `http://localhost:8787` after the deploy. The live open question has no `distinctFrom`, so the block shows only on the next run.
