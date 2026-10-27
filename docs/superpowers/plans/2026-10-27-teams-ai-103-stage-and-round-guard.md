# Plan 103 - Stage reviews and full rounds drop a repeat of a decided question too

## Context

Plan 102 guards the Spec Kit questions. The stage reviews and the full rounds still put repeats to the owner. A stage review had no repeat check at all, and a full round only dropped exact text, silently, even when the owner had already answered it. The live journal holds 122 owner-decided questions, and their repeats fall into a few families: privacy before import, urgency regularization, credentials, the blank briefing template, missing objectives, signature delegation, the deployment target and the deadline.

## Change

1. **Calibrated floors.** A stage question is compared with the decided questions of any document at word overlap 0.25 or more; a full-round question at 0.3 or more. On the live journal, the stage floor flags 39 questions: 38 repeats of one decision, 5 borderline, none false. The round floor flags 4.
2. **Same kind only.** Stage and round questions are compared only with decided questions of the same kind; Spec Kit questions are compared as plan 102 defines.
3. **The agent names the difference.** `distinctFrom` now belongs to the refinement output (`server/agents/outputs.ts`): each entry is the id of a decided question the new one repeats, and one sentence of at least eight words with a fact that question did not have. A valid difference keeps the question.
4. **Drop only, nothing re-runs.** A repeat with no valid difference is dropped and journaled as `QUESTION_DROPPED`, with the decided question it repeats and that answer. A stage or round does not run again: its patches and moves are already on record, so a second pass would propose them twice. The round's checklist counts the blocking questions after the drops, so a dropped question never holds the round.
5. **Ids in the history.** The answered, skipped and open questions of the history block now carry their ids (`server/refine/packs.ts`), so the agent can name them in `distinctFrom`. The block states the rule for every pack that carries it.
6. **Reask restores the question as it was asked.** A dropped question keeps its document, blocking flag, related criteria, options, subject, rule and context. Its origin is restored only when it had one. The reducer used to restore every question as a non-blocking Spec Kit question, which would have moved a stage question into the Spec Kit list.
7. **Owner screen** (approved mock, 2026-10-27). The stage review panel lists the dropped questions of its document, after the empty-state line. The final review lists the round's dropped questions in compact form. Both use the component of the Spec Kit list.
8. **Spec Kit wording.** The dropped Spec Kit questions now show the same "Antes / Você respondeu" lines.

## Deviations

- An exact repeat of an answered question in a full round is still dropped silently, as before. An exact repeat of a spec decision has no question id, so it also stays silent. Only near repeats are journaled.
- Stuck questions are not guarded. They are rule-keyed system questions that repeat on purpose while a check keeps failing; their own rule dedupe stays.
- Reversals: ten owner answers contradict an earlier answer on the same point, and eight of their questions match at 0.3, so they are dropped. The dropped row shows the contradicted answer, so the owner sees the conflict instead of being asked to reconcile it.

## Verification

- Typecheck, root and web: the root suite passed 256 files and 2865 tests; the web suite passed 48 files and 514 tests after the screen change.
- `test/refine/stage-cycle.test.ts`: a stage question that repeats a decided one is dropped and kept on record; one with a valid difference is kept with it.
- `test/refine/cycle.test.ts`: a round question that repeats a decided one is journaled as dropped and stays out of the evaluation.
- `test/refine/question-guard.test.ts`: a dropped stage question comes back with its document, blocking flag and criteria, and no Spec Kit origin.
- `web/src/pages/RefinementWizard.test.tsx`: the stage panel lists only the questions of its document; the final review lists the round's, and "Perguntar de novo" calls the handler.
- Calibration on the live journal, read-only: the counts and the judgements in the Context section.
- Chrome after the deploy: the stage panel and the final review on `http://localhost:8787`, checked for no regression. The live journal holds no stage or round drops yet, so the new lists show on the next run.
