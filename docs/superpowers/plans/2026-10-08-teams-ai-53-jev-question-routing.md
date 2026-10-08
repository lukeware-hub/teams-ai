# Plan 53 - Jev-central refinement, slice 1: question routing (auto/po/sm/human)

Status: done (2026-10-08). Roadmap item R11.5a, first of six ordered sub-items.

## Goal

R11.5a (human, 2026-10-07): "Jev's classification is the backbone of refinement; PO and SM decide on it." Today Jev
runs once per cycle before everything (`server/refine/cycle.ts:99`, `jev-validation.ts`): six fixed yes/no checks,
advisory only, API-shaped (persistence/health/responses), absent from backlog detailing. System 1 decisions
(`decider`) only run three Gate 1 filters (readiness, dedup, contradiction) and are off by default outside Gate 1.

Evidence this slice targets (R11.2 live check, 2026-10-07): 19 questions reached the owner in the agenda outline;
many were answerable from the docs the agents already had (R11.10's cycle-14 e2e-pipeline question is the same shape
and already fixed ad hoc in plan 53's predecessor commit, `detail-packs.ts` - this plan is for the general case, not
one more hardcoded fact).

Full R11.5a proposal has six ordered items; this plan scopes only the first: classify every PO/SM question as
`auto` / `po` / `sm` / `human` before it reaches the merged question list the human sees.

## Approach

Follow the exact rollout shape already used for decisions 2-4 (plan from R4.1, `server/decide/decisions/gate1.ts`):
advisory and shadow-run first, journaled, off by default; only promoted to actually dropping/answering questions
after an eval on real labeled data (R5.3's harness, `server/decide/evals.ts`), same as `READY_MIN` was tuned.

**Shadow mode in this plan:** the new decision runs, is journaled (`DECISION_MADE`, already generic per
`server/refine/cycle.ts`'s `recorded()` wrapper), and is shown to the human as a hint — but it never drops a
question or answers one on its own. A later plan (after eval) flips it to actually answering `auto` questions
by writing the answer into a briefing patch and skipping the human, which is the risky, hard-to-reverse part
R11.5a's own ordering defers.

## Scope of this slice

1. New decision id `question-routing` in `server/decide/types.ts`'s `DECISION_IDS`.
2. `server/decide/decisions/gate1.ts` (or a new `server/decide/decisions/question-routing.ts`, TBD at implementation
   time depending on size): one `choice` call per blocking question (not `noul`; four options, not yes/no) asking
   whether the docs/delivery contract already answer it (`auto`), or it needs PO judgement (`po`, product/scope),
   SM judgement (`sm`, technical/feasibility), or the human (`human`, a real open decision). The call gets: the
   question text, its `relatedAcIds`' criteria, and the same fixed delivery-contract facts already injected in
   `SPEC_RULES`/`PREPLAN_RULES` (`server/refine/detail-packs.ts`) so "auto" has something concrete to check against.
3. Wire it into `runCycleSteps` (`server/refine/cycle.ts`) right after the existing decision 2-4 block (same
   `decider`/`dctx`/journaling pattern), for every `merged` blocking question. Shadow mode: attach the routing as
   metadata on the journaled `REFINE_EVALUATED` event (a `routing: Record<questionId, {label, confidence}>` field)
   instead of changing `merged` or `discardedPatches`. The UI is free to show it as a hint (not required by this
   plan; a follow-up can surface it next to each question, same as decision 7's hint in `brief.md`).
4. Config: `decisions.perDecision['question-routing'].enabled` defaults to the same off-unless-configured shape as
   the other named decisions (`config.ts`), so it never fires unless the human turns it on for a session, exactly
   like `decisions.local.enabled` gates the Gate 1 filters today.
5. Unit tests: the new pure classifier function (decider mocked, same style as `test/decide/gate1.test.ts`); a
   `cycle.test.ts` case asserting the routing metadata is journaled and that `merged`/`discardedPatches` are
   byte-identical to a run with the decision off (shadow mode changes nothing observable to PO/SM/human yet).

## Out of scope (left to later plans, per R11.5a's own ordering)

- Actually auto-answering a question and recording it as a briefing assumption (item 1's "risky" half).
- Items 2-6 of R11.5a (patch judging beyond byte-identical dedup already shipped; spec/pre-plan preflight; the
  five-doc preflight replacing the six fixed API checks; spec-contradiction; `ready` needing Jev's approval).
- Any change to `jev-validation.ts`'s six fixed checks.
- UI surfacing of the routing hint (follow-up, not required for the decision to exist and be evaluable).

## Verification

- Unit: as listed above; `npm test` stays green; typecheck clean.
- Live: none in this plan (shadow mode costs nothing extra beyond one more decision call per blocking question,
  same backend chain as Gate 1 - local/jev, no Claude escalation). An eval against real labeled routing decisions
  (R5.3 harness) is a separate, later step before any promotion out of shadow mode, same gate `READY_MIN` went
  through.

## Why not more in one pass

R11.5a is explicitly ordered by the human as six items, "each with its plan and an eval before it is switched on";
shipping more than slice 1 here would pre-empt that ordering and the eval gate the project has used for every
other System 1 decision so far (R4.1's `READY_MIN`/dedup tuning only happened after live data). This plan is sized
to be buildable and testable without a live run, matching plan-first-roadmap practice: one item, approved, then
implemented.
