# Plan 24: orchestrator fixes (blocked status, supervisor stop rule)

Goal: fix two defects found by golden run 1 (R1.1b) and the supervisor review.

## 1. Explicit `blocked` Dev status

Problem: run todo-001-r1, task T950-deploy-fix-1-r2. The agent could not proceed (deploy environment) but the
DevOutput only had `done` and `spec-gap`, so it sent its final blocking notice as a spec-gap question and burned
3 spec-gap rounds ("spec-gap rounds exhausted (3)").

Approach:
- `server/agents/outputs.ts`: third DevOutput branch `status: 'blocked'` with a required non-empty `reason`
  (same common fields as the others). `done` and `spec-gap` outputs stay valid unchanged.
- `server/orchestrator/task-runner.ts` `implement()`: on `blocked`, call `block(reason)`: the task goes to
  `blocked` at once, TASK_BLOCKED carries the reason (the run report reads it), no SM spec-gap round, no
  attempt consumed (attempts only change in `fail()`).
- `.claude/agents/dev.md` and `devops.md`: describe when to return `blocked` (an external limit that no code change
  in the task's paths can fix) versus `spec-gap` (a question the SM can answer).

## 2. Supervisor stop rule

Problem: `stopRequested` returns true if RUN_STOP_REQUESTED appears anywhere in the journal. After a hand resume
that then crashes, the marker is still there, so the supervisor never resumes the run.

Journaling facts: a stop is `RUN_STOP_REQUESTED`; a resume re-opens the same journal (no RUN_STARTED) and only
journaled `RUN_RESUMED` for `paused:auth`. So a resume of a stopped (draining) run left no trace.

Rule: a stop is intentional only when it is the last lifecycle event: no RUN_RESUMED or RUN_STARTED after the last
RUN_STOP_REQUESTED. Implementation:
- `Run.resume` also journals RUN_RESUMED when the replayed status is `draining` (reducer ignores it for
  draining, so scheduling is unchanged; it only marks the hand resume).
- `supervise.ts`: `stopRequested` applies the rule.

## Files
server/agents/outputs.ts, server/orchestrator/task-runner.ts, server/orchestrator/run.ts (resume marker),
server/supervisor/supervise.ts, .claude/agents/dev.md, devops.md, tests: test/agents/outputs.test.ts,
test/orchestrator/task-runner.test.ts, test/orchestrator/run.test.ts, test/supervisor/supervise.test.ts,
test/cli.test.ts (supervise command).

## Verification
Test-first unit tests; `npx tsc --noEmit`; full `npx vitest run`.
