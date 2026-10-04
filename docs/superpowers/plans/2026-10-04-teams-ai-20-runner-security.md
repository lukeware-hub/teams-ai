# Plan 20: Runner security (audit C1, H3, M2)

## Goal
Close audit findings C1 (sandbox off, credentials reachable), H3 (bypassable deny rules) and M2 (worktree `.claude/` persistence) for agent steps.

## Verified against the code
- C1 true: `config.example.json` shipped `sandbox.enabled=false`; `buildInvocation` passed the host `HOME` through `ENV_ALLOWLIST`, so `~/.teams-ai/secrets`, `~/.config/gh` were reachable.
- H3 true: `ALWAYS_DENIED` are prefix rules; roles front/dev/test were allowed `node`, `npm`, `npx`, `find`.
- M2 true: `--setting-sources project` loaded the agent-writable `<worktree>/.claude/settings.json`; `Edit(.claude/**)` only covers the edit tools.

## Approach
1. C1
   - `sandbox.unsafeNoSandbox` config flag (default false). `sandboxPolicyViolation` (`server/runner/sandbox-policy.ts`) refuses `enabled=false` unless that flag AND `TEAMS_AI_UNSAFE_NO_SANDBOX=1` are set; `runStep` returns an `environment` failure before anything is created or spawned. `config.example.json` now ships `enabled: true`.
   - Auth choice: the `claude` CLI (subscription login) reads `$HOME/.claude/.credentials.json`; omniroute steps authenticate with `ANTHROPIC_AUTH_TOKEN` already in the child env. So each step gets a fresh empty HOME (`mkdtemp` under the run's settings dir, outside the worktree) containing only a mode-0400 copy of the host `.claude/.credentials.json` (claude provider only; none for omniroute) and a `tmp/` dir used as TMPDIR. Removed after the step. Trust (`hasTrustDialogAccepted`) is now recorded in the step HOME's `.claude.json`, so the host `~/.claude.json` is no longer modified.
   - The copied login file stays readable by the agent (Read deny rule remains); egress is limited by the sandbox network allowlist. Residual risk documented, not eliminated.
2. H3: drop `Bash(find:*)`; add `NESTED_DENIED` (node -e/--eval/-p/--print, npm exec/x, npx gh/kubectl, contains-rules for git push, kubectl, docker, gh) to role deny rules and `--disallowed-tools`. These are defense in depth: `node script.js` can still spawn anything. The real boundary is the empty HOME (no gh/kube/docker credentials) and the sandbox.
3. M2: `--setting-sources user` (never `project`), so the worktree `.claude/` is not loaded; all policy comes from `--settings`. HOME is empty, so `user` loads nothing. Additionally deny shell writes via `Bash(*.claude/*)`.

## Files
`server/runner/{sandbox-policy,step-home,step,invocation,role-settings}.ts`, `server/agents/registry.ts`, `server/config/config.ts`, `config.example.json`, minimal edit `server/orchestrator/run.ts` (pass `unsafeNoSandbox`), tests `test/runner/runner-security.test.ts`, `test/runner/step.test.ts`.

## Verification
`npx tsc --noEmit`, `npx vitest run`. Live behavior of `--setting-sources user` with `--settings` and an empty HOME is not verified (no real claude steps allowed).
