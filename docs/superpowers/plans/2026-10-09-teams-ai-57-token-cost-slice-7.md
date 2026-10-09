# teams-ai plan 57: Dev retries resume the previous session (R11.13 slice 7)

**Goal:** an attempt after the first no longer rebuilds the Dev's whole context. The Dev's CLI session is kept per task and the retry resumes it, sending only the feedback; the context is read from the prompt cache.

**Checked live before building (2026-10-09, Haiku, cents):** `claude -p --session-id X` in one step HOME, copy `.claude/projects` to a fresh HOME, then `claude -p --resume X` there works with `--agents`, `--agent`, `--json-schema` and `--setting-sources user`: the second call read the whole first context from the cache (`cache_read` 1657, `cache_creation` 217) and kept the session id (no fork). Also confirmed there: `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` shows up as `ephemeral_5m_input_tokens`.

## Design

- `server/runner/session-store.ts`: `saveSession` copies the step HOME's `.claude/projects` into a per-task store after the step (also after a failed one), `restoreSession` copies it into the next step's HOME, `hasSession` is true only for the same session id and the same cwd (the CLI finds a transcript by cwd).
- `runStep`: `sessionStore` on the request; with `resume`, restore before spawning; always save before the HOME is deleted.
- `runAgentStep`: `session: { id, resumePrompt }`. If the store has that session for this cwd, the step resumes it and the prompt is `resumePrompt` instead of the pack; otherwise it starts the session under that id with the full pack (`--session-id` replaces `--no-session-persistence`). Needs `AgentStepDeps.sessionDir`; without it the request behaves as before.
- `TaskRunner.sessionFor`: one session id per (role, model/effort overrides, task definition). A replan, another tier or another role starts a new session.
- `devResumePrompt(feedback)`: the feedback of the attempt that ended, plus "read a file again before editing it".
- Store: `<run>/sessions/<taskId>/`, next to the run's steps.

## Not done

- Live measurement on a run (cost of attempts 2+ vs. r9 or a run with a failing task); needs a real run with at least one retry.
- Cleanup of `sessions/` when the run is pruned; it lives with the run directory.
- Only the Dev step. Reviews are fresh on purpose (a reviewer must not inherit the Dev's reasoning).
