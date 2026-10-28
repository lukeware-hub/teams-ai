# Plan 107 - The plan step: Superpowers writes each spec's implementation plan

## Context

The owner decided on 2026-10-27 to migrate the Spec Kit preparation to Superpowers, and to follow the migration plan without leaving it. That plan's part B has three increments after the question policy (part A, plans 98 and 101 to 106, already on main):

- Increment 2, the pilot: a gate. Twenty real plan steps run unattended with the `writing-plans` skill on a scratch draft. Spec Kit stays unless the gate passes.
- Increment 3, the cut-over: one deploy that replaces the four Spec Kit commands of each item by one plan step per spec.
- Increment 4, the delete: remove the Spec Kit install, the legacy engine and its tests, once no program waits on legacy files.

This plan records increment 2 and the decisions it needs. Increment 3 is written after the gate result.

## Change (increment 2)

1. **The plan file.** `server/refine/plan-file.ts` names the path of one spec's plan: `docs/specs/<specId>/implementation-plan.md`. It uses the spec id from `specIdOf`, so both id forms (the key alone, and the older `<draft>-<key>`) give a path.
2. **The shape check.** `server/refine/plan-shape.ts` is a pure check of the plan text against the spec's acceptance criteria. It lists every problem it finds, in English, for the repair note.
3. **The pack.** `server/refine/superpowers-pack.ts` builds the context pack of one plan step. It tells the agent to load `writing-plans` with the Skill tool, to ask nothing in the chat, to write only the plan file, and to record every unknown as an assumption with its reason.
4. **The step.** `server/refine/plan-step.ts` runs one plan step through the runner, checks the file it wrote, and repairs it up to twice with the problems named. A `blocked` answer is not repaired.
5. **The write folder.** Kind `speckit` may also write `docs/specs` (`server/runner/step.ts`). `.specify` and `specs` stay until the cut-over, so the live Spec Kit engine keeps working.
6. **The pilot harness.** `scripts/evals/superpowers-pilot.ts` runs the step on a scratch draft copied from the live run's documents. It never writes to the live run.

## Decisions the plan left open

- **Staging.** The plan file is written in the staging folder `<draft>/speckit`. Phase 0 copies it into the draft docs at the cut-over, not in this increment.
- **Kind.** The step keeps kind `speckit` and role `dev`, because the configuration schema rejects a new kind.
- **Shape rules.** A plan passes when all of these hold:
  - the header has the title and the lines `**Goal:**`, `**Architecture:**`, `**Tech Stack:**` and `**Spec:**`;
  - it has the sections `## Global Constraints`, `## Review Focus` and `## Assumptions`;
  - it has at least one `### Task N:` block, and every block has `**Files:**` and `**Criteria:**` lines;
  - the criteria ids named in the `**Criteria:**` lines are exactly the spec's acceptance criteria ids: none missing, none unknown;
  - it has no placeholder marker (TBD, TODO and FIXME in capitals, or a phrase such as handle edge cases, add appropriate, implement later, to be determined) and no `[NEEDS CLARIFICATION` marker;
  - only words that start with AC- count as criterion ids;
  - every bullet under `## Assumptions` contains `Reason:`.
- **Repairs.** At most two repairs; each repair names the problems of the previous file. A `blocked` answer is never repaired.
- **Questions.** The step asks nothing. Any question in its output counts as a violation in the pilot.
- **Gate.** The pilot passes only when all of these hold:
  - at least 95% of the plans are valid within the two repairs;
  - no plan carries a question;
  - the median plan is at most 3 times the length of its spec section in `specs.md`, and no plan is over 60,000 characters;
  - the median time is at most 10 minutes per plan at the pinned model.
- **Sample.** The five items with the most criteria, plus fifteen items spread across the backlog order, each run once at the pinned model and once at the next model up.

## Verification

- Unit tests: the shape check (valid, and each rule failing on its own), the plan path in both id forms, the pack's instructions, and the step with a fake runner (valid first time, repaired, repairs exhausted, blocked, no file).
- Pilot: the harness output, with one line per plan (valid, repairs, questions, seconds, cost, size ratio) and the gate verdict. The numbers are added below when the run ends.

## Results

Run in a scratch draft copied from the live run's documents: 20 items, the five with the most criteria and fifteen spread across the rank order, one plan step each with the real CLI in a copy of the app.

| Run | Setting | Valid | Questions | Repairs (0 / 1 / 2) | Median plan / spec | Largest plan | Median seconds | Cost (USD) | Gate |
|---|---|---|---|---|---|---|---|---|---|
| r4 | pinned: haiku, effort low | 20 of 20 | 0 | 15 / 4 / 1 | 4.63 | 39,936 chars | 109 | 3.94 | fails: size |
| r4 | sonnet, effort low | 20 of 20 | 0 | 14 / 5 / 1 | 2.83 | 19,400 chars | 75 | 8.68 | passes |
| r5 | haiku, effort max (stopped after 3 of 20) | 3 of 3 | 0 | 3 / 0 / 0 | 6.45 | 54,912 chars | 895 | 2.92 for three | fails: size and time |

Earlier runs, kept on the container as evidence:

- r1, a smoke run of one plan at the pinned setting: valid on the first answer, 136 seconds, US$ 0.19.
- r2 and r3 were stopped. The validator flagged the Portuguese word "todo" as the TODO marker, and an HTML attribute named "placeholder". Both were validator false positives, fixed before r4. Only r4 runs the final validator.

Verdict: the sonnet setting passes every gate criterion, and the pinned setting fails the size criterion. The plan says the result sets the role setting the owner is advised to use, so the advice is sonnet at effort low for the plan step. The cut-over waits for the owner's decision on how to apply it, because the dev role's pin also drives every builder task.

The owner then chose Haiku at effort max for the plan step. The first three plans were measured and each failed the size and time gates, so the owner asked for the full run. Run r5b finished all 20 items: 19 valid (95%, which meets the validity gate exactly), no question, one failed on a schema error. The median plan is 6.58 times its spec (gate: 3), the largest plan 72,224 characters (gate: 60,000), the median time 1,035 seconds (gate: 600), and the cost US$ 22.55. The gate fails on size and time, so the advice stays sonnet at effort low.

Increment 3, the cut-over, is one commit with the engine, the screen, the install and the docs. The plan step runs sonnet at effort low (`PLAN_STEP`), and the dev role's pin does not apply to it. Spec Kit is removed from the install, the engine and stage 7. The names persisted in old journals stay, so they replay. Found by the full suite: the web page imported Node modules through `planItems`, so it moved to `server/refine/plan-items.ts`. Found after the cut-over: a Spec Kit completion in an old journal counted as a finished plan preparation, so it no longer does, and the heal driver ends its failure run on the new completion event too.

Renamed (commit `6af926e0`): the seven plan events the step writes now read `PLANS_*`, and a journal under the old names reads through `currentEvent`. The config key `speckitAgents` is now `planAgents`, and the old key still reads. Checked on a copy of the live journal: 639 events renamed, and the preparation state survives. Finished later (commit `c11436e7`): the plan task field is `planTasks` (`speckitTasks` still reads through `taskPlanIds`), the orchestrator writes `PLANS_CONVERGED`, `PLANS_SKIPPED` and `PLANS_GAP` and reads the old names, and two literal `SPECKIT_STEP_DONE` comparisons that the first rename had missed now use the current name. Kept on purpose: the `speckit` step kind (it names the settings folder on disk and is journaled), and the legacy-only events.

Not run: a scratch project through Phases 0 to 3, which creates a repository and spends money. The owner chose to run it later.
