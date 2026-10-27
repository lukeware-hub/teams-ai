# Plan 99 - A heal driver starts again what a restart or a failure stopped, behind a flag

## Context

Step 4 of plan 95. On `kayron-hub-001`, the failures that waited for an owner's click were the cycles and preparations a restart cut (the boot marks them `error`, and nothing starts them again), and the schema and timeout failures that a second try would have passed. Decision D3 of plan 95 amends the restart rule: the cut cycle stays failed, and a driver starts a new one.

## Change

1. **The failure kind** (`server/refine/heal.ts`). A failed cycle or preparation carries its kind: the boot writes `interrupted`, and a cycle or preparation whose agent failed carries that failure's kind (`failureMessage` and `AgentFailure` keep it, `stopKindOf` gives a preparation the kind its failed steps share). A stopped run is `aborted`, never `timeout`, so the driver does not retry it. A journal written before this change has none, so its kind is read from the reason text (`kindOfLegacyReason`).
2. **The policy** (`nextHeal`). `interrupted` starts a new cycle or preparation while the failures in a row are below three; `schema` and `timeout` below two; `environment` below three. A `quota` failure waits, and the step waits for the quota itself. An `auth` failure and any other kind pause the draft for the owner at once. The failures in a row are read from the journal, so a restart does not reset them. They count every kind together, and the limit of the kind that came last applies, so an alternation of kinds reaches its limit too.
3. **The driver** (`server/refine/heal-driver.ts`). `RefineHealer` ticks over the drafts. A tick never starts while another runs. It calls only `evaluate` and `runSpeckit`, and it journals `AUTOPILOT_PAUSED` with the reason when it pauses. It never calls `freeze`, `start` or `markStarted`. A draft a run or a discard holds (`BusyError`) is left for the next tick. Any other refusal or failure is reported, and the draft is paused with its message; a pause that fails too is reported as well.
4. **The flag and the timer.** `refine.heal.enabled` is off by default. `server/cli.ts` runs the tick 30 seconds after boot and then every 60 seconds; with the flag off, a tick reads the flag and does nothing. Closing the server clears both timers.

## Deviations

- **A new project's draft waits for its final review to close.** Its stage reviews are retried through the stage routes, which the driver does not call, so the driver leaves the draft as it is while `staged` is set. Once the owner closes the final review (`reviewClosed`), the driver heals it like any other draft.
- **A quota wait is not timed.** The driver leaves a quota failure to the step, which already waits for the quota.
- **A stopped run stays stopped.** A run the owner stopped is `aborted`, and a Spec Kit preparation the owner stopped has no retry kind, so the driver pauses the draft for the owner instead of starting it again. A draft being thrown away is busy until it is gone.
- **The failures of an agent kind other than those above pause the draft** for the owner, with the kind as the reason. Nothing else is retried.
- **The restart rule is amended** in the refinement design (`docs/superpowers/specs/2026-09-24-refinement-ui-design.md`): the cut cycle stays failed, and the driver starts a new one when the flag is on.
- **The owner's button** (`POST /api/ops/refine-drain`, which lets a redeploy wait for an idle point) is not in this step.

## Verification

- `test/refine/heal.test.ts`: the kinds, read from real failure texts and from recorded kinds; the policy table; the failures in a row read from the journal, with a success and a pause ending them; an alternation of kinds reaching the limit of the kind that came last; a quota waiting, an environment failure getting three tries, and an aborted run going to the owner.
- `test/refine/heal-driver.test.ts`: the flag off makes no call; an interrupted cycle starts again and a repeated one pauses; a Spec Kit preparation starts again; one tick runs at a time; a draft a run holds is left alone and not reported; any other failure pauses its draft with the message and is reported, and the other drafts go on; a refusal pauses its draft with the refusal as the reason; a pause that fails too is reported.
- `test/refine/session.test.ts`: the heal view of a draft a timeout stopped shows the failure, and the pause the driver journals is read back; a quota keeps its kind in the journal; a new project is staged until its final review closes; a draft being discarded is busy and starts no run.
- `test/refine/speckit.test.ts`: a quota step keeps its kind in the heal view; `stopKindOf` gives a preparation the kind its failed steps share, and none when they differ.
- `test/runner/step.test.ts`, `test/scheduler/retry-policy.test.ts`, `test/refine/agent-failure.test.ts`: a stop is `aborted`, with the same attempt policy as a timeout in the pipeline, and its reason says the execution was interrupted.
- `test/config/heal-flag.test.ts`: the flag is off by default.
- Full root and web suites: exit codes recorded in the commit.
