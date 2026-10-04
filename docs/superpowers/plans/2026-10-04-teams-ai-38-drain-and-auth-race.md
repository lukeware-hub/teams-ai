# Plan 38: clean drain on stop, and the credential refresh race

## 1. Drain (R2.2 finding)

Cause: `Run.loop()` restarted every active task whenever the run was `running` or `draining`. A task's `advance()` runs one step and returns
in the next active state (implementing -> validating -> reviewing -> merging), so after a stop the loop kept starting the next step of each
task (`STEP_STARTED` seq 109 after `RUN_STOP_REQUESTED` seq 107) until the task finished, well past the API's 15 s window; `stop()` then
escalated to SIGKILL.

Fix (`server/orchestrator/run.ts`): the restart block runs only when `running`, or when draining for a budget exhaustion
(`!state.stopOnly`, existing contract: active tasks run to their end). After a stop request only in-flight steps finish; the run ends
`RUN_FINISHED drained`. Tasks stay in their active state; resume continues them. `run-control.ts stop()` documents the window: a single
agent step longer than 15 s is still killed and the run shows as interrupted.

Tests (`test/orchestrator/run.test.ts`): no `STEP_STARTED` after `RUN_STOP_REQUESTED`, last event `RUN_FINISHED drained`
(verified failing before the fix); the older drain test now expects the task is not carried to `merged`.

## 2. Credential refresh race

Decision: a per-process mutex, not a warm-up step. A warm-up costs a real claude call per near-expiry and the refresh already happens
in the first real step. `withRefreshGate` (`server/runner/step.ts`) wraps copy + step + write-back. It only takes the lock when the host
token's `expiresAt` is within 5 minutes (or past); each waiter re-reads the token after its turn, so once one step refreshed and wrote
it back the rest run in parallel again. Fresh tokens, omniroute steps and `CLAUDE_CODE_OAUTH_TOKEN` never lock. Limit: per process;
two orchestrator processes on one host are not covered.

Tests (`test/runner/step-refresh.test.ts`, fake claude that refreshes inside its HOME): two concurrent steps on an expired token log
exactly one `refresh` and one `fresh`; a fresh token takes no lock.

## 3. CLAUDE_CODE_OAUTH_TOKEN passthrough

If set on the host, claude steps get it in their environment (`invocation.ts`) and the credential file is not copied nor written back
(`step-home.ts`). Not passed to omniroute steps. Create one with `claude setup-token` (long-lived, subscription), then
`export CLAUDE_CODE_OAUTH_TOKEN=<token>` before starting teams-ai. Tests: the file is not copied, the child env has the token, omniroute
does not get it.
