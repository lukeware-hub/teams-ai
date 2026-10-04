# Plan 29: GitHub Actions in the generated repository (R8.3)

## Goal

Every generated repository ships `.github/workflows/ci.yml` and `.github/workflows/release.yml`, committed to
main by the orchestrator when the repository does not already have them.

## Decision: template, not agent-written

Deterministic templates rendered from the plan. Agent-written YAML is unverified, differs run to run, and
actionlint is not available offline, so the safe default is a renderer whose output is pinned by golden
tests and checked by a pure validator. The DevOps agent stays free to extend the files later through the
normal task flow; the bootstrap never overwrites an existing file.

## Approach

- `server/orchestrator/workflows.ts` (new, pure): `renderCi`, `renderRelease`, `renderWorkflows`,
  `validateWorkflow`, `allowedCommands`.
  - ci: checkout, setup-node or setup-python (stack and version from `plan.stack` and `plan.gateImage`;
    no setup step for an unknown stack), install, format, lint, typecheck (when present), test, build,
    secret scan. Read-only `contents` permission.
  - release: on push to main or `v*` tags; buildx, ghcr.io login with `GITHUB_TOKEN`, metadata-action
    (lowercases the image), build-push with tags `<sha>` and `latest` for `ghcr.io/<owner>/<plan.deploy.image>`.
    Top-level `contents: read`; only the job gets `packages: write`.
  - Actions pinned by major tag. Run steps only use `plan.commands` values. The secret scan uses
    `gitleaks/gitleaks-action@v2` rather than a `run` step, because the runner has no gitleaks binary and
    the validator allows only plan commands. Note: that action needs a license secret for organisation repos.
- Validator: parses with the `yaml` package; checks required keys, no `write-all`, no write scope except
  `packages: write` in release, major-tag pinning, every `run` is a plan command, ci contains every plan
  step, release contains buildx/login/build-push, GITHUB_TOKEN, sha and latest tags. actionlint is not
  available offline, so this structural check is what gates the commit.
- Bootstrap: the plan does not exist during Phase 0 (it is produced in Phase 2), so
  `runWorkflowBootstrap(deps, plan)` lives in `phases/bootstrap.ts` and runs right after Phase 2, only for
  bootstrapped (draft) runs. It uses a docs worktree and branch `docs/<spec>-workflows`, skips files already
  on main, validates before writing, and merges through `commitAndMergeDocs` with journal key phase 7
  (type widened in `shared.ts`). No missing files means no commit and no PR. Crash resume reuses the
  confirmed commit.
- `Run.executeWorkflows(plan)` wraps it (public for tests) and `execute()` calls it after Phase 2.

## Files

New: `server/orchestrator/workflows.ts`, `test/orchestrator/workflows.test.ts`,
`test/orchestrator/workflow-bootstrap.test.ts`, `test/fixtures/workflows/{node,python}-{ci,release}.yml`.
Small edits: `phases/bootstrap.ts`, `phases/index.ts`, `phases/shared.ts` (phase type), `run.ts` (two hooks).

## Verification

Golden files for a node and a python plan; validator negative tests; bootstrap tests on the git-remote
fixture (files land, existing ci.yml kept, no PR when both exist); `tsc --noEmit`; full vitest suite.

## Not covered

No e2e job in ci (R8.4), no `devops.md` change, no gate in `gate-runner.ts` (validation happens at render
time, before commit). Workflows are not exercised on real GitHub.
