# Plan 105 - Refinement questions follow the rules and the earlier answers

## Context

Plan 100 made the stage review pack read the answered, skipped and open questions of the draft. The Spec Kit asker, the step that runs the Spec Kit commands, still saw none of them. On `kayron-hub-001` the same question about a rule version without an end date was asked eight times on 2026-10-27; each owner answer was followed by a new ask of the same point. The owner also set six rules for every agent: no invented facts, no invented business rules, the existing behavior kept, no change to existing behavior for good practice alone, no irrelevant question, and no question that the existing sources already answer. No agent prompt carried them.

## Change (first slice)

1. **Rules for every role.** `QUESTION_RULES` in `server/agents/registry.ts`, sent before every prompt by `buildInvocation` (`server/runner/invocation.ts`), so every role gets it, in the refinement and in the run alike. It is not in the agent body on purpose: the body travels on the command line (`--agents`), and Windows caps a command line near 32 thousand characters. With the rules in the body, the largest plan step passed that cap, and the orchestrator loop test failed on Windows. The rules state seven rules: nothing is invented and every fact says its source; an assumption is recorded as one and is never evidence; existing behavior is kept faithfully; good practice never changes existing behavior alone; a question goes to the owner only when no source settles it, the answer changes what gets built, and no earlier question covers it; the latest owner answer wins; and no earlier question is asked again, even reworded.
2. **Two agent lines.** `.claude/agents/sm.md` and `.claude/agents/po.md` said that unclear documentation always becomes a question. Both now defer to rule 5. `dev.md` is unchanged: a dev spec-gap goes to the SM, who records an assumption, so it never reaches the owner.
3. **The asker sees the item's history.** `speckitPack` (`server/refine/speckit-pack.ts`) takes the questions of the item from the journal (`runCommand` in `server/refine/speckit.ts`). Each line gives the question, its role and its state: answered by the owner, the PO or the SM with its time, skipped, or open. The latest answer comes first, up to 40 lines.
4. **Answer times.** `QuestionRow.answeredAt` (`server/refine/state.ts`) holds the event time of an answer or a skip. The field is optional, so journals written before this change read as before.

## Impact

- Every prompt grows by the rules text, about 350 tokens per call. The rules are part of the prompt, not of the cached system prompt, so each call pays them at full input price. The cost is small beside a step's context.
- The Spec Kit asker pack grows by the item's history, at most 40 lines. The pack budget already grows to fit a pack (`fitPackBudget`).
- Owner decisions still reach the Spec Kit files through `briefing.md`, as before. The history is additional context.
- No page, no event type and no setting changes in this slice.

## Deviations

- The triage pack (`server/refine/speckit-answers.ts`) does not get the history yet. Triage answers open questions from the documents and does not ask again, so its history waits for plan 102.
- A repeat is not yet detected or dropped. The rules and the history ask the agents not to repeat a question; the check that drops a repeat the agent still makes is plan 102.

## Verification

- Typecheck, and the test files of the registry, the journal state and the Spec Kit: passing in the worktree. The new `test/refine/question-ledger.test.ts` covers the pack lines, their order, the empty case and the journal time of an answer.
- Full root and web suites: exit codes recorded in the commit.
- Not yet measured: the repeat rate on a copy of the live journal, before and after. That comes with plan 102, which holds the guard and the measurement script.
