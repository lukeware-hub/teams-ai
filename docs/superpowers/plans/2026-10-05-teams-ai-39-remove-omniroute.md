# Plan 39 — Remove OmniRoute

Decision (human, 2026-10-05): agents run only through the Claude Code CLI. OmniRoute is removed from code, docs and
the WSL host. The System 1 decision layer (Jev via OpenRouter, llama.cpp `local`) stays as it is.

## Goal

No OmniRoute provider, config, script, container, volume or secret left. Every role runs `claude` with the
subscription login (or `CLAUDE_CODE_OAUTH_TOKEN`). `confidential` stays: it still keeps Jev off.

## Approach

### Code

- `server/config/config.ts`: the role profile becomes `RoleProfile = { model }` (strict object, so a stale
  `provider` key fails loudly instead of running Claude with a non-Claude model id); drop the `omniroute` block
  and `resolveProfile` (callers read `cfg.roles[role]`); fix the `modelTiers` comment.
- `server/orchestrator/run.ts`: no `omniroute` dep, no `localhost` in the sandbox allowlist, `tierModel` always
  returns the tier's model.
- `server/orchestrator/task-runner.ts`: `tierModel` returns `string`; drop the "off-profile" `null` branch.
- `server/orchestrator/steps.ts`, `server/refine/agent.ts`: `RoleProfile`, no `omniroute` field.
- `server/runner/invocation.ts`, `server/runner/step.ts`, `server/runner/step-home.ts`: drop the `omniroute`
  request field, the `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` branch and the OmniRoute token redaction; the
  `claudeLogin`/`withClaudeLogin` parameters become constant true, so they are removed; the accounting record
  books `provider: 'claude'`.
- `server/budget/accounting.ts`: provider union `'claude' | 'openrouter' | 'local'`.
- `server/decide/jev-openrouter.ts`: comment only.
- Scripts: delete `scripts/wsl/omniroute/` and `scripts/wsl/probes/p6-omniroute-env.sh`; `scripts/smoke/real-step.ts`
  loses `SMOKE_PROVIDER`; `run-all.sh` comment.
- Tests: update the profile literals; delete the OmniRoute-only cases (config `resolveProfile`, invocation env,
  runner-security "no credential file", step-refresh "not passed to omniroute", task-runner `tierModel: null`,
  step redaction of the OmniRoute token); the onboarding config-store tests use another unknown key.

### Docs

- Spec `2026-09-23-teams-ai-poc-design.md`: §1.3 drops run 2 (golden runs are 1 baseline and 3 decisions on),
  §10 becomes "Provider: Claude Code CLI only", plus the role table, `confidential`, sandbox allowlist, failure
  table, environment and open-questions lines.
- `ROADMAP.md`: definition of done, R3.1/R3.2 `dropped`, the R5.1 deviation note, R6.1 inventory line.
- `ops/runbook.md`: the "switch the provider" line.
- Older plans and spikes stay as history.

### Infra (WSL host, irreversible; list shown before deleting)

- `docker rm -f omniroute`, `docker volume rm omniroute-data`, `docker image rm diegosouzapw/omniroute:3.8.51`.
- `rm ~/.teams-ai/secrets/OMNIROUTE_*`.

## Verification

- `npm run typecheck` and `npm test` (root and web) pass.
- `git grep -i omniroute` hits only `docs/superpowers/plans/` (older than 39) and `docs/superpowers/spikes/`.
- `docker ps -a`, `docker volume ls`, `docker images` show nothing named omniroute; `ls ~/.teams-ai/secrets` has no
  `OMNIROUTE_*`.

## Cost

No agent run, no paid API call.
