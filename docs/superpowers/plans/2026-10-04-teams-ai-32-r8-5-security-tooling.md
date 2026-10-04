# Plan 32: R8.5 security tooling for the generated project

## Goal

The generated project's security gates use prescribed tools and block on high findings, instead of naming a gate
`secret-scan` and letting the SM pick any command.

## Approach

- `server/validators/security-tooling.ts` (pure): the prescribed gate set, a per-stack allowlist, `validateSecurityGates(plan)`
  and `securityToolingRules()` (the text for the plan pack).
- Gates, in this order, all `blocking: true`:
  - `security-tools` (network egress): installs gitleaks, semgrep, osv-scanner and trivy into `.tools/bin` of the worktree.
  - `secret-scan`: `gitleaks detect|dir`, no disarm (`|| true`, `--exit-code 0`).
  - `sast`: `semgrep` with `--severity ERROR --error` (ERROR = high); egress when rules come from the registry.
  - `dependency-scan` (egress): `osv-scanner` for every stack; additionally `npm audit --audit-level=high` for node
    stacks and `pip-audit` for python stacks.
  - `image-scan` (egress, after `build`): `trivy image --severity CRITICAL --exit-code 1`.
- Tool availability, simplest honest option: gates run in `gateImage` as separate `--rm` containers and the worktree is the
  only thing that persists, so the `security-tools` egress gate installs the binaries under `.tools/` (gitignored) and the
  other gates run with `PATH=$PWD/.tools/bin:$PATH`. No tools image is built; `gateImage` must have curl, tar and
  python3/pip (a non-slim Debian image, for example node:22-bookworm). Rejected alternative: a dedicated tools image,
  which needs a build and registry story the platform does not have yet.
- `requireSecurityTooling` on `PlanCheckOptions` (same wiring as `requireDelivery`): off keeps older plans valid; `cli.ts`
  turns it on. `planRules` / `planPack` state the exact commands when on.
- `sm.md` and `sec.md` mention the contract.

## Known limit

Gates have no docker, so `trivy image` needs an image archive (`--input`) that an earlier gate produced; the plan pack
tells the SM to name it, but how the archive is produced is not wired by this item.

Superseded by plan 37: image-scan is 	rivy config + 	rivy fs, and the install gate runs a rendered pinned installer.

## Files

server/validators/security-tooling.ts, server/validators/plan.ts, server/orchestrator/steps.ts, phases/shared.ts,
phases/plan.ts, run.ts, server/cli.ts, .claude/agents/sm.md, sec.md, tests under test/validators and test/orchestrator.

## Verification

Unit tests: accept, each rejection, legacy mode, pack text; tsc; full vitest suite.
