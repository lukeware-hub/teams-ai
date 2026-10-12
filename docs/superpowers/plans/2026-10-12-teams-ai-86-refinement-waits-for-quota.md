# Plan 86 - Refinement waits for the Claude quota and goes on by itself

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** when the Claude usage window (5 hours) runs out during refinement, the cycle waits for the reset and repeats the step that was rejected, as the run already does, so the human no longer has to start the detailing or the derivation again.

**Architecture:** every refinement step goes through the function `makeRunAgent` (`server/refine/agent.ts`), which already owns one `QuotaBreaker` for the whole UI process, and `runAgentStep` already feeds it each reading and each quota failure. A new wrapper around the agent function (`server/refine/quota-wait.ts`) waits while the breaker is paused, runs the step, and when the step fails on quota waits for the reset and runs it again, a few times at most. The callers (`detail-cycle.ts`, `cycle.ts`, the derive steps) never see a quota failure that the wait can clear, so none of them changes.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** ROADMAP R11.5a (Jev and refinement autonomy). Evidence: `server/refine/detail-cycle.ts` stops the whole cycle on the first quota failure (`STOPPING`), and `makeRunAgent` creates a breaker that nothing waits on, while the run (`server/orchestrator/run.ts`, `waitWhilePaused`) pauses and resumes by itself.

## Design decisions

- One wrapper at the single entry point, so the detailing, the refinement, the outline and the derive steps are all covered and no loop is copied.
- The wait is the run's rule: sleep until the breaker's `until`, then check again; the breaker already holds the reset time the CLI reported, or its own probe schedule (5, 10, 20, 40, 60 minutes) when no time was reported.
- A wait never lasts longer than `QUOTA_WAIT_MAX_MS` (5 hours and 30 minutes, the 5 hour window plus a margin), because a spent 7 day window would hold a job for days. Past it the step returns its quota failure, with the reset time added to the message, and the cycle stops as it does today.
- A step is repeated at most `QUOTA_RETRIES` (3) times after a quota failure, so a reset time the CLI keeps getting wrong cannot loop forever.
- Only `quota` is waited on. `auth` stays a stop, since only a human clears it, and every other failure goes back to its caller untouched.
- A repeated step is a new step in the journal (`runAgentStep` allocates a new sequence number), so the rejected attempt stays visible as a failed step and nothing is overwritten.
- The wait ends at once when the cycle's abort signal fires, and the step then runs (and stops) the way it does with no wait.
- The breaker, the clock and the sleep are injected, so the tests run without real time. No configuration key: both limits are constants until a live run shows they need tuning.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- The worktree is shared with other sessions: commit with an explicit pathspec (`git commit -m ... -- <files>`) and verify in a clean worktree.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A step that fails on quota once and then succeeds returns the success, after one sleep of the breaker's remaining time, and the journal shows both steps.
2. A reset time beyond `QUOTA_WAIT_MAX_MS` returns the quota failure with the reset time in its message, and never sleeps.
3. Four quota failures in a row return the last failure (three repeats), so the loop always ends.
4. `auth`, `schema`, `code` and every other failure return at once with no sleep, and a success never sleeps.
5. An abort during the wait ends it and runs the step once, so cancelling a cycle never hangs for hours.
6. A breaker that is paused before the call (a reading of 95% or more from another step) makes the call wait first, so it does not start a step that would be rejected.

## Limits

- The refinement screen does not show the wait: the cycle looks like it is running until the reset, and only `ui.log` and the failed steps in the journal say why. A visible "waiting for the limit until HH:MM" belongs to a later plan, since it needs a new refinement event and a chip on the screen.
- The wait lives in the UI server process, so a restart of the server during it fails the cycle as today and the human starts it again; the finished items are already recorded.
- One breaker serves every refinement session of the process, so two sessions wait together, which is right because they share one account.
- The quota breaker of the refinement and the one of a run are separate objects in separate processes, so a run that is paused does not make the refinement wait; the shared account limit is found by the first rejected step.

---

### Task 1: The waiting wrapper

**Files:**
- Create: `server/refine/quota-wait.ts`
- Test: `test/refine/quota-wait.test.ts`

**Interfaces:**
- Produces: `withQuotaWait(inner: RunAgent, breaker: QuotaBreaker, io: { sleep(ms: number, signal?: AbortSignal): Promise<void>; now(): Date; log(line: string): void }): RunAgent`, plus the constants `QUOTA_WAIT_MAX_MS` and `QUOTA_RETRIES`.

- [ ] **Step 1: Write the failing tests** in `test/refine/quota-wait.test.ts`, with a fake inner agent that returns a queue of outcomes, a real `QuotaBreaker` on a fake clock, and a recording sleep that advances the clock:
  - quota failure then success: returns the success, the inner agent ran twice, the sleep was the breaker's remaining time;
  - a breaker already paused before the call: the sleep comes before the first run, not after;
  - a reset time beyond `QUOTA_WAIT_MAX_MS`: no sleep, returns the quota failure with the reset time in `errors`;
  - four quota failures in a row: three sleeps, returns the fourth failure;
  - `auth` and `code` failures and a success: no sleep, one run;
  - an aborted signal: the sleep is cut short and the inner agent still runs once.
- [ ] **Step 2: Run** `npx vitest run test/refine/quota-wait.test.ts` and see it fail (module missing).
- [ ] **Step 3: Implement** `quota-wait.ts`: a `remaining()` that returns the breaker's `until` minus now (zero when closed); a loop that waits while `remaining() > 0` and within the cap, runs the inner agent, and on `quota` repeats up to `QUOTA_RETRIES` times; the sleep rejects nothing and resolves early on abort. A wait that would pass the cap returns the failure with `retry after <ISO time>` appended to its errors.
- [ ] **Step 4: Run** the new test file, then commit.

### Task 2: Wire it into the refinement and drop the stop on quota

**Files:**
- Modify: `server/refine/agent.ts` (wrap the returned agent, with a real abortable sleep and `console`-free `log` that writes to `ui.log` as the other refinement code does)
- Modify: `server/refine/detail-cycle.ts` (`STOPPING` keeps `auth` only if a quota failure can no longer reach it; otherwise leave it, since a quota failure past the cap must still stop the cycle)
- Test: `test/refine/agent.test.ts`, `test/refine/detail-cycle.test.ts`

- [ ] **Step 1: Write the failing tests**: `makeRunAgent` with a fake `runStep` that fails on quota once and then succeeds returns the success; a detail cycle whose agent fails on quota once reaches `ready` instead of failing as interrupted (the wrapper sits in front of the fake agent).
- [ ] **Step 2: Run** them and see them fail.
- [ ] **Step 3: Implement** the wiring in `makeRunAgent`. Keep `STOPPING` as it is: a quota failure that gets past the wrapper is one the wait could not clear, and it must stop new calls.
- [ ] **Step 4: Run** the refinement tests, then the whole suite and the typecheck, then commit.

### Task 3: Roadmap

- [ ] Record in R11.5a that refinement now waits for the quota and goes on (plan 86), with the limit that the screen does not show the wait, and commit.
