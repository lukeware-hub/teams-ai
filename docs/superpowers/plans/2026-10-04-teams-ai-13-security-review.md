# Plan 13 — Security review (`sec` agent)

Design: `docs/superpowers/specs/2026-10-04-security-review-design.md`.

## Tasks

1. **Role plumbing** — `sec` in `ROLES` and `CLAUDE_DEFAULTS` (`server/config/config.ts`), `ROLE_TOOL_POLICY` (`server/agents/registry.ts`), `ROLE_ALLOW` (`server/runner/role-settings.ts`), report token roles (`server/orchestrator/phases/report.ts`). `.claude/agents/sec.md`.
2. **Contract** — `security` step kind and `SecurityOutput` (`server/agents/outputs.ts`); `securityPack` (`server/orchestrator/steps.ts`); events `SECURITY_APPROVED` / `SECURITY_CHANGES` (`server/orchestrator/events.ts`).
3. **Gate** — `TaskRunner.securityReview()` after the Test approval (`server/orchestrator/task-runner.ts`).
4. **Visibility** — `securityFindings` in the report and the report pack; Validation "Security" section; task detail findings (`web/src/run/selectors.ts`, `web/src/components/TaskDetail.tsx`, `web/src/pages/Validation.tsx`).
5. **Tests** — registry and role-settings expectations; task-runner security cases (runs on the diff, `high` blocks even with `decision: approve`, `medium`/`low` pass); loop and run fakes script the `security` step; `report-security.test.ts`; Validation and selectors tests.

## Status

Implemented and unit-tested (commits `e024114`, `ee68ebe`). Live check not run.

## Findings

- Test fakes that answer unknown step kinds with a Dev output made every task block silently after the gate was added; each fake must now script `security` explicitly.
- Shell-escaped multi-line edits corrupted source twice (a literal newline inside a string); edits were redone with the editor tool and verified by typecheck.

## Live check (to do)

Run the hello-app fixture on a WSL host and confirm: `sec` returns valid JSON on the real CLI, reads files under `dontAsk` with an empty allow list, and a seeded vulnerability (e.g. string-built shell command) comes back `high` and returns to Dev.
