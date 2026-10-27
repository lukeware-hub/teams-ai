# Plan 95 - Measure the owner's agreement before the owner is asked less

## Context

A journal study of `kayron-hub-001` (726 questions, 699 agent steps, 1,091 owner actions, 60 hours idle) shows that the owner's answers mostly repeat the recommended option. The autonomy work (FEATURES item 11) lets agents decide what the owner decides today, so every gate that decides when agents may stop asking needs honest labels first. Two facts from the study set the rule:

- The owner's answers given within 3 seconds of the previous one agree with the recommendation 92% of the time; the deliberate ones agree 76%. A label counted from fast clicks overstates the agreement.
- The refinement journal kept only the outcome of each decision. Its attempts, usage and the answers of a call below its threshold were dropped, so "exhausted" could not be explained and the Jev cost of refinement read zero.

## Change

1. The decider hands the full record of each call to its caller through `DecideContext.onRecord`, the same record `onDecision` gets. A call below its threshold keeps its answers in the attempt (`server/decide/decider.ts`, `server/decide/types.ts`). The refinement journal writes the whole record (`recorded` in `server/refine/cycle.ts`), so the attempts and usage reach the Jev cost (`server/usage/jev-cost.ts`) and an exhausted decision shows its cause.
2. `isIndependentOwnerLabel` (`server/decide/evals.ts`): an owner answer labels a route only when no role marked it and it came at least 3 seconds after the owner's previous answer. The first answer of a journal has no earlier one, so it labels nothing. `routingSamples` uses it, so the measured auto-answer floor counts deliberate answers only.
3. The replay (`server/refine/agreement.ts`, `scripts/evals/refine-replay.ts`): agreement by pause, a 95% cluster bootstrap by item (2,000 runs, fixed seed), and leave-one-item-out. The recommendation of an answer is the newest definition of its question before the answer, because a triage can re-decide it; judging against the first definition gave 52.8% and was wrong.

The decider's outcome is unchanged, so `server/cli.ts` does not change.

## Result on kayron-hub-001 (local copy of the journal, not committed)

| Pause before the answer | Answers | Agreement | Wilson lower bound (95%) |
|---|---|---|---|
| All answers | 641 | 83.2% | 0.806 |
| Under 3 s | 283 | 91.9% | 0.888 |
| 3 to 30 s | 242 | 82.6% | 0.783 |
| 30 s and more | 115 | 63.5% | 0.559 |
| Labels (3 s and more) | 357 | 76.5% | 0.726 |

Cluster bootstrap of the labels by item: 68.1% to 86.0%. Leave-one-item-out: 73.7% to 81.3%.

## Not in this plan

- The resolver, the question policy, the Spec Kit repair and the autopilot (plan 96 onwards).
- Batch answers: no batch route exists yet, so the label rule does not exclude them.
- Any screen: the change is server-side and inert for the owner.

## Verification

- Unit tests: decider (`test/decide/decider.test.ts`), evals (`test/decide/evals.test.ts`), recorded decisions (`test/refine/recorded.test.ts`), agreement (`test/refine/agreement.test.ts`).
- `npm run typecheck`, the root suite and the web suite, run to the end.
- The replay script on a local copy of the journal, against the table above.
