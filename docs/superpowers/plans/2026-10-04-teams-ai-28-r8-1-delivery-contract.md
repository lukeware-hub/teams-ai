# Plan 28: R8.1 delivery contract

## Goal

`plan.delivery` lists the artifacts a generated project must ship: Dockerfile, compose file, CI workflow, release
workflow, e2e suite path and the README sections that must exist. Phase 4 fails when a listed file is missing on main.

## Approach

- `server/contracts/plan.ts`: `Delivery` schema, all fields optional, `Plan.delivery` optional. Default when absent:
  no contract, identical to today's behavior, so stored plans stay valid.
- `server/validators/plan.ts`: `PlanCheckOptions.requireDelivery`. When `delivery` is present every artifact and a
  non-empty `readmeSections` are required (both modes). When absent, it is an error only if `requireDelivery` is set.
- New plans require it: `RunDeps.requireDelivery` / `PhaseDeps.requireDelivery`, set to true in `server/cli.ts`, passed
  to the plan validator and to `planPack` (which states the contract in the plan rules).
- `server/orchestrator/phases/verify.ts`: after `checkoutMain`, `missingDelivery` stats each listed path; any missing
  fails Phase 4 with `delivery contract not met on main, missing: ...` before gates run.
- `.claude/agents/sm.md`: the SM fills `plan.delivery`.

README sections are validated for presence in the plan only; the README is written in Phase 6, after Phase 4.

## Files

contracts/plan.ts, validators/plan.ts, phases/verify.ts, phases/plan.ts, phases/shared.ts, run.ts, steps.ts, cli.ts, sm.md.

## Verification

- test/validators/plan-delivery.test.ts: contract and validator, both modes.
- test/orchestrator/verify-delivery.test.ts: Phase 4 with files present and absent (git-remote fixture).
- `npx tsc --noEmit`, full vitest suite.
