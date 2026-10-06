# Plan 47 - Absolute, stack-agnostic quality rules: coverage, lockfile, pinned base image, license scan

Status: done (2026-10-06). Roadmap item R10.2. All four steps implemented and tested in this session.

## Changes against the plan as written

- No `Commands.coverage` field was added - a gate's own `command` is enough (`unit-test`/`build`/`lint` don't get a
  duplicate `Commands` entry either). `coveragePath`/`coverageExemptions` live directly on `Plan`.
- The coverage shape check landed as `server/validators/coverage.ts` + `server/exec/coverage.ts` (mirrors the
  real `validators/e2e.ts` / `exec/e2e.ts` split already in the codebase), not the single `coverage-gate.ts` the
  draft guessed at.
- License-scan needed no new module at all: it is one more entry in `security-tooling.ts`'s existing `RULES`
  array, with `allowed: () => true` (no tool prescribed) - reusing `validateSecurityGates` end to end, gated by
  the existing `requireSecurityTooling` flag rather than a new one.
- Lockfile and pinned-base-image are unconditional checks inside `missingItems()` in `verify.ts` (same function,
  extended), not separate gates; `lockfilePath`'s presence in the plan *shape* is gated by `requireDelivery`
  (reusing that flag) rather than a dedicated flag.
- Mid-implementation, the human added a standing constraint - neither the agents nor teams-ai may be fixed to a
  stack - which revised the lockfile and license-scan designs before any code was written for them (see "Standing
  constraint" below); coverage and pinned-image were already compliant as first drafted.

## Standing constraint (human, 2026-10-06, mid-implementation)

Neither the agents nor teams-ai itself may be fixed to a language or framework; any stack the user picks must stay
possible. This revises two of the four steps below (marked `REVISED`): any hardcoded per-language filename or
tool list is a violation unless the orchestrator truly only ever needs a generic, already-stack-agnostic tool
(e.g. `osv-scanner`, which `dependency-scan` already uses as its universal fallback for `stackKind === 'other'`).
Where no universal tool exists, the agent must declare the path/command itself (same contract pattern as
`delivery.dockerfile` or `coveragePath` below) and the orchestrator checks existence/shape only, never a fixed
per-language name.

## Goal (human, 2026-10-06)

Add rules agents must obey on every project regardless of stack, enforced the same way `requireDelivery`/
`requireSecurityTooling`/`requireE2e` already are (`server/validators/plan.ts`):

1. **Test coverage >= 80%**, aggregate line coverage, with an escape valve for genuinely untestable files.
2. **Lockfile committed** for whatever package manager the stack uses.
3. **No `:latest` tag / unpinned base image** in the Dockerfile the Dev/DevOps ship.
4. **Dependency license scan** (no incompatible-license dependency lands unreviewed).

## Findings that shape the plan

- `server/exec/gate-runner.ts` only ever parses JUnit XML or TAP (`runGate`, line ~194-204) into pass/fail
  `TestResult`s. **No gate today reads a coverage percentage, a lockfile, Dockerfile content, or license data** -
  every one of the four rules needs a new signal path, not just a new flag.
- The established pattern for "a new required rule" is `PlanCheckOptions` in `server/validators/plan.ts`
  (`requireDelivery`/`requireSecurityTooling`/`requireE2e`, each `boolean | undefined`, off for legacy plans),
  threaded through `RunDeps` (`run.ts:52-54`) -> `PhaseDeps` (`phases/shared.ts:31-34`) -> `phases/plan.ts` (both
  into `planPack`/`planRules` for the SM's prompt, and into `validatePlan` for enforcement) -> set to `true` in
  `cli.ts:201` (today's house default for new runs).
- `server/validators/security-tooling.ts` is the closest precedent for a command the agent writes but the
  orchestrator must recognize regardless of stack: `stackKind(stack)` buckets any stack string into
  `'node' | 'python' | 'other'`; `prescribedCommands(kind)` and `RULES` (one `Rule` per gate name, with
  `allowed(cmd, kind)`/`extra(gate)`/`egress(gate)`) check the SM's gate commands by pattern, not verbatim, except
  the installer gate itself (`bare(tools.command) !== INSTALLER_COMMAND`, exact match).
- `server/validators/tools-installer.ts` renders one deterministic, sha256-pinned shell script
  (`renderToolsInstaller`) that installs gitleaks/osv-scanner/trivy (static binaries, pinned release URL + real
  published sha256) plus semgrep (pip zipapp). **This only works cleanly for tools that ship a single pinned
  binary release with a published checksum.** License-scan tooling does not uniformly fit that shape (see Step 4).
- `server/orchestrator/phases/verify.ts` (`missingItems`, line ~40-54) already reads files straight off the
  checked-out `main` worktree for the delivery contract (no gate, no agent-written command needed) - the right
  home for the lockfile and Dockerfile checks, since both are pure static checks with no tool to run.
- Test style precedent: `test/validators/plan-delivery.test.ts`, `plan-security.test.ts`, `plan-e2e.test.ts` each
  pin a `check()`/`plan()` helper, assert the flag-off case stays legacy-valid, the flag-on case rejects an
  incomplete plan, and one test per violation kind.

## Approach

### Step 1 - Coverage >= 80% (requested first; builds the contract pattern Step 2-4 don't need)

- `server/contracts/plan.ts`: no new `Commands` field (unlike `smoke`/`e2e`, a gate's own `command` is enough -
  `unit-test`/`build`/`lint` don't get a duplicate `Commands` entry either). Add `Plan.coveragePath?: RepoPath`
  (where the normalized summary lands) and `Plan.coverageExemptions?: { path: RepoPath; reason: string (min 10
  chars) }[]` (the escape valve - excluded paths the coverage tool's own ignore mechanism already left out of the
  denominator, with a documented reason; the orchestrator never recomputes the percentage itself, it only
  requires a reason to exist).
- New contract (`COVERAGE_CONTRACT`, same style as `SMOKE_CONTRACT`/`E2E_CONTRACT` in `server/orchestrator/steps.ts`):
  whatever tool the agent picks for its stack (istanbul/c8 for node, coverage.py for python, `go test -cover` for
  go, ...), the `coverage` gate's command must end by writing `plan.coveragePath` as a one-line JSON file
  `{"linesPct": <number>}` - the orchestrator parses only that fixed shape, never the underlying tool's own report
  format.
- New gate name `coverage`, required blocking when `requireCoverage` (same shape as `REQUIRED_BLOCKING_GATES`,
  just conditional). After `gate-runner.ts`'s `runGate()` produces its normal pass/fail, add a coverage-specific
  post-check: read `coveragePath`, parse `linesPct` (pure functions in new `server/exec/coverage.ts`, mirroring
  `exec/e2e.ts`), fail the gate if `< 80` (`MIN_LINE_COVERAGE_PCT = 80`) even when the command's own exit code was
  0, and fail closed (missing file, unparseable, gate misnamed) rather than passing on an unverifiable claim.
- `server/validators/plan.ts`: new `requireCoverage?: boolean` in `PlanCheckOptions`; a new `server/validators/
  coverage.ts` (mirrors the `validators/e2e.ts` / `exec/e2e.ts` split already in the codebase: `validators/*`
  checks plan shape before any run, `exec/*` does the runtime parse) checks `coveragePath` is set and every
  `coverageExemptions` entry has a real reason.
- Thread `requireCoverage` the same way as the other three flags: `run.ts`, `phases/shared.ts`, `phases/plan.ts`,
  `steps.ts` (`planRules`/`planPack`), and set it `true` in `cli.ts:201`.
- Tests: new `test/validators/plan-coverage.test.ts` mirroring `plan-e2e.test.ts`'s shape (legacy-off stays valid,
  required-on rejects a missing/non-blocking/under-threshold gate, accepts a documented exemption, rejects an
  exemption with no reason). A `gate-runner` or small `coverage-gate` unit test for the `linesPct` parse/threshold
  logic itself, independent of the full gate-run pipeline.

### Step 2 - Lockfile committed (REVISED for the standing constraint)

- No per-language filename list (the original draft's `package-lock.json`/`poetry.lock`/`go.sum` enumeration
  would silently skip-and-pass any stack not in the list, or need constant upkeep as new ecosystems appear - a
  stack lock-in by omission). Instead: `plan.lockfilePath?: RepoPath`, declared by the SM exactly like
  `delivery.dockerfile` - the agent names its own stack's lockfile, the orchestrator only ever checks that the
  named file exists on `main` at Phase 4 (same mechanism and same home as `missingItems` in
  `server/orchestrator/phases/verify.ts` - no new tool, no new gate).
- `requireCoverage`-style flag not needed here either: `requireDelivery` already gates "is `delivery` required at
  all" for new plans; add `lockfilePath` as a new required field alongside `DELIVERY_PATH_FIELDS` (or its own
  small check right next to it) under the same `requireDelivery` flag, rather than inventing a fifth flag for one
  file.
- Tests: extend the delivery-fix-task test(s) found in Phase 4 verification coverage with a missing-`lockfilePath`
  case, same shape as a missing `dockerfile`.

### Step 3 - No `:latest` / unpinned base image in the shipped Dockerfile

- Pure static check on the Dockerfile content at the path `plan.delivery.dockerfile` names, read from the checked-
  out `main` worktree - same home as Step 2 (`verify.ts`), same mechanism as `gate-files.ts`'s regex-based checks
  (`PATH_TOKEN`-style approach) but reading file content, not file names.
- Rule: every `FROM` line's image reference must carry either a `@sha256:` digest or an explicit non-`latest` tag
  (reject bare `image` or `image:latest`); multi-stage builds checked per `FROM` line, not just the last one.
- Tests: a few literal Dockerfile fixtures (pinned-by-digest passes, bare `FROM node` fails, `FROM node:latest`
  fails, `FROM node:22-bookworm` passes).

### Step 4 - Dependency license scan (REVISED for the standing constraint)

- No prescribed per-stack tool roster (`license-checker`/`pip-licenses`/`go-licenses` only cover 3 ecosystems and
  there is no universal license scanner the way `osv-scanner` is universal for vulnerabilities - a fixed roster
  would silently have nothing to require, or block, for any other stack). Revised to the loosest version of the
  existing `security-tooling.ts` pattern: a `license-scan` gate name joins `RULES`, but with no `allowed()`
  pattern restricting the command to specific tools - only that the gate exists, is blocking, is not disarmed
  (same `DISARMED` check already shared by every other rule), and runs after the dependency-scan gate (the
  dependencies must be resolved first). The agent picks whatever its ecosystem actually offers; nothing is
  prescribed, so nothing is assumed about the stack. Loses the exact-tool verification the other four scanners
  get, by necessity - documented as a tradeoff, not hidden.
- Needs a human decision this plan does not make on its own: which licenses are disallowed (e.g. GPL/AGPL) -
  project-specific, not universal; default to a conservative deny-list (GPL-family copyleft) stated in the plan
  rule text, overridable by the project's own ADRs if the human says otherwise.
- Tests: extend `plan-security.test.ts`'s per-gate-name loop with `license-scan` (missing/non-blocking/disarmed/
  ordering only - no "wrong tool" case, since none is prescribed).

## Files touched

`server/contracts/plan.ts`, `server/validators/plan.ts`, `server/validators/coverage.ts` (new), `server/validators/
pinned-image.ts` (new), `server/exec/coverage.ts` (new), `server/validators/security-tooling.ts`,
`server/exec/gate-runner.ts`, `server/orchestrator/run.ts`, `server/orchestrator/phases/shared.ts`,
`server/orchestrator/phases/plan.ts`, `server/orchestrator/phases/verify.ts`, `server/orchestrator/steps.ts`,
`server/cli.ts`; tests: `test/validators/plan-coverage.test.ts` (new), `test/validators/pinned-image.test.ts`
(new), `test/exec/coverage.test.ts` (new), `test/validators/plan-security.test.ts` (extended for license-scan),
`test/validators/plan-delivery.test.ts` (extended for lockfilePath), `test/orchestrator/verify-delivery.test.ts`
(extended for lockfile + pinned-image), `test/exec/gate-runner.test.ts` (extended for the coverage gate hook).

## Verification (actual)

- `npm run typecheck`: clean throughout.
- `npm test`: 128 files, 1083 passed / 4 skipped, 0 real failures. Two pre-existing, load-dependent timing tests
  (`test/cli.test.ts`'s SIGTERM-stop count, `test/api/journal-tail.test.ts`) flaked once under full-suite
  parallel load and were confirmed to pass reliably in isolation (3/3) - unrelated to this plan's diff.
- Every new rule has both a "missing/violating" and an "accepts a compliant plan" test, plus a legacy-mode test
  proving an old plan with the flag off stays valid, following the existing `plan-e2e.test.ts`/
  `plan-security.test.ts` shape.
- No real-CLI or paid run was needed - everything here is schema, validator and static-file logic, exercised by
  the existing fixture-based unit suite.
under `test/validators/`, `test/orchestrator/`, `test/exec/`.

## Verification

- `npm run typecheck` and `npm test` green after every step (same discipline as plan 46).
- Each step's own unit tests (per-step list above) before moving to the next step.
- No real-CLI/paid run needed for steps 1-3 (pure schema/validator/static-file logic, exercised by the fake-CLI
  fixture already used across the suite). Step 4's spike needs a live fetch to verify real tool checksums, not a
  paid agent run.
- A full paid run (a real spec through Phase 1-6) to confirm the SM actually produces a plan that satisfies all
  four rules end to end is deferred to after review, same caution as every other plan here.

## Cost and risk

- Steps 1-3 are additive, off-by-default-for-legacy-plans (same convention as the three existing require-flags),
  low risk - no change to how an already-passing legacy plan behaves until `requireCoverage` is turned on.
- Step 1 is the biggest of the three cheap ones: it adds a real new contract the SM/Dev must satisfy correctly on
  every stack, so expect at least one replan/feedback round on early real runs (same as `E2E_CONTRACT` did).
- Step 4 is explicitly flagged as higher-cost/risk than the other three: it needs real, verified pinned tool
  checksums (not available from memory) and a project-specific license deny-list decision. Recommend sequencing
  it after 1-3 land and are verified, not in the same sitting.
- A hard 80% floor can legitimately block trivial scaffold/glue tasks; the `coverageExemptions` escape valve
  exists for exactly that, but expect friction until agents learn to use it (same adoption curve `e2eExemptions`
  had).
