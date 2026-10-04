# Plan 16: supervisor

Goal: `teams-ai supervise --project <dir> [--interval s]` keeps a project's runs alive: any run that is
interrupted (process dead, no RUN_FINISHED) is resumed, with backoff, until it finishes.

Approach:
- `server/supervisor/supervise.ts`: `superviseTick` (one scan) and `supervise` (loop). Scan uses `listRuns`
  from run-index (pid / pid.gone liveness, RUN_FINISHED status). Only status `interrupted` is resumed;
  `paused:auth` needs a human login and is left alone. A journal with RUN_STOP_REQUESTED and no RUN_FINISHED
  is an intentional stop and is never resumed.
- Resume reuses `spawnRun(..., mode: 'resume')` + `writePid`, exactly as the UI route does.
- At most one resume per run: a resumed run has a live pid, so it is `running`, not `interrupted`. Per-run
  backoff (interval * 2^attempts, capped at 1h); attempts reset when the run is seen alive.
- Every action is logged.

Files: server/supervisor/supervise.ts, server/cli.ts (command + usage), test/supervisor/supervise.test.ts.

Verification: unit tests with fake liveness and a fake spawner; tsc; full vitest.
