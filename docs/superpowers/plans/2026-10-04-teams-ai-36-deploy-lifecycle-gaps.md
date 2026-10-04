# Plan 36: deploy lifecycle gaps (R8.1, R8.2)

## 1. Failed first deploy tears the stack down (R8.2)

`runDeployment`'s `fail()` returned early when `previous` was null, so a compose stack or kind Deployment
that failed verify or smoke on its first deploy kept running. Now it calls `target.destroy(intent)`:
`docker compose down -v` (docker-local compose), `rm -f` of the container (docker-local plain), and
`kubectl delete -f - --ignore-not-found` plus the secret (kind). The result stays `rolledBack: false` and the
detail says the stack was torn down; a failing teardown is reported in the detail, never thrown.
Apply-stage failures are unchanged (docker-local plain restores itself; compose apply failures are not torn
down, see open issues in the run report).

Tests: `test/deploy/deploy.test.ts` (generic, docker-local compose via FakeExec, kind via FakeExec).

## 2. Automatic fix round for a missing delivery (R8.1)

Phase 4 round 1 with missing delivery files used to end the run with no fix tasks. Now it plans fix tasks
deterministically (no agent call, so no cost): one task owned by devops for Dockerfile, compose and the two
workflows, one owned by dev for the e2e suite and the README sections. Ids follow the `T900-fix-N` scheme,
the plan is validated with the tasks appended (they depend on `T0-scaffold` on a first spec), and
`FixTasksPlanned` is journaled. `Run.postPhases` already runs fix tasks returned by round 1 and then calls
round 2 as the verdict, so the existing round budget is reused; round 2 fails as before, without tasks.
A resumed round 1 reuses the planned tasks through the existing `plannedBefore` check.

## 3. README sections in the delivery check (R8.1)

`missingDelivery` also checks `plan.delivery.readmeSections` against the headings of `docs/README.md`, but only
when that file already exists on main. Phase 6 writes the docs after Phase 4/5 and its gate already enforces
the document structure, so before Phase 6 a missing README is the normal state; failing then would make every
first run fail the delivery check. Once a README is on main (rerun, `spec readme`, an earlier docs PR), a
section counts as present when a heading contains its name (case-insensitive).

Tests: `test/orchestrator/verify-delivery.test.ts`.
