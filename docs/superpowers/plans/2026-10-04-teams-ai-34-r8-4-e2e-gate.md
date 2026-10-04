# Plan 34: R8.4 e2e gate for the generated project

## Goal

A generated project ships an e2e suite distinct from `commands.smoke`; Phase 5 runs it against the deployed compose stack and a failure blocks the run.

## Approach

- `commands.e2e` (optional in the schema). `server/exec/e2e.ts` mirrors `smoke.ts`: blocking egress gate named `e2e` with `SERVICE_URL` injected like a secret, same `gateNetwork` / `gateServiceUrl`, JUnit parsed by the same runner. Rows are keyed by acceptance criterion (all criteria, not only smoke ones).
- `server/validators/e2e.ts` + `requireE2e` (same opt-in as `requireDelivery`; `cli.ts` turns it on): commands.e2e (or a gate named e2e) required, blocking, not disarmed, different from smoke, referencing `delivery.e2eSuite`.
- Phase 5: after smoke passes, run e2e; failure rolls back like smoke, plans a deploy-fix task for the dev on the e2e suite within the existing attempt budget. A missing command plans no task. Legacy plans without a command skip it. A plan gate named `e2e` is excluded from per-task gates.
- Plan pack, `test.md`, `sm.md` state the contract. CI template gets an `e2e` job (compose up, e2e with SERVICE_URL on the published port, compose down) when the plan has an e2e command.

## Verification

Unit tests: validator, e2e rows and runner, Phase 5 ordering and fix task, workflow goldens; tsc; full suite.
