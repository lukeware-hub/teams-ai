# Teams AI operator runbook (Docker Compose)

The platform is one compose stack (`docker-compose.yml`): `teams-ai` (orchestrator, API and web UI), `dind` (the nested
rootless Docker daemon where gates and deploys run) and `goproxy` (the Go module proxy of the agent sandboxes).
Everything below was written by reading the compose file, the Taskfile and the code. The backup and restore were
not run live against real volumes.

## Where the data lives
- `teams-ai-data` is mounted at `/home/node/.teams-ai`: configuration, workspaces, runs and their journals. It is also mounted in `dind` at the same path.
- `teams-ai-claude` is mounted at `/home/node/.claude`: the Claude login.
- `teams-ai-gh` is mounted at `/home/node/.config/gh`: the GitHub login.
- `dind-data` is mounted in `dind`: images and containers of the nested daemon; it can be rebuilt, so it is not part of `task backup`.
- Only `teams-ai-data` has a fixed name; the other three are prefixed by the compose project name (the folder name by default), for example `teams-ai_teams-ai-claude`. Check with `docker volume ls`.

## Start and stop
- Start: `task start` (checks the prerequisites, starts the stack, waits until it is healthy, opens `http://localhost:8787`).
- Stop: `task down`. Data, logins and workspaces stay in the volumes; a run in progress is interrupted and can be resumed.
- Restart only the orchestrator: `task restart`. Status: `task ps`. Logs: `task logs` (orchestrator) or `task logs:dind`.
- Never use `task reset`: it deletes every volume, including the logins.
- The UI listens on `127.0.0.1:8787` only, and the API accepts only `Host: localhost`, `127.0.0.1` or `[::1]`.

## Runs
- Start a run from the UI (Start), or `task cli -- run --project <dir> --spec <id>`.
- Stop a run: Stop in the UI; it finishes the step in flight, then ends.
- Resume a run: a spec whose run shows `interrupted` offers Resume in the UI; from the terminal, `task cli -- resume --project <dir> --run <runId>`.
- Resume every interrupted run until it finishes: `task cli -- supervise --project <dir>`.
- Stale lock files after a crash or a restore are deleted by the image on boot; to do it by hand, run `docker compose exec teams-ai find /home/node/.teams-ai/workspaces -name '*.ndjson.lock' -delete`.
- `paused:auth`: run `task login:claude`, then resume.

## Quota pauses
- The quota breaker pauses runs (status `paused:quota`) when a subscription window reaches 95 percent or a step is rejected.
- The pause ends by itself when the window resets, or after a probe backoff of 5, 10, 20, 40 and 60 minutes, and the run continues without action.
- Count the paused runs with `teams_ai_quota_paused` in `/metrics`.
- Do not resume by hand while paused; the orchestrator refuses to start steps until the breaker closes.
- There is no second agent provider, so wait for the reset.

## Reading the journal
Each run has `runs/<runId>/events.ndjson` (one JSON event per line: `seq`, `at`, `type`, `kind`, `data`), `state.json` (status, tokens, cost) and `pid`.
- Last events: `docker compose exec teams-ai tail -n 50 /home/node/.teams-ai/runs/<runId>/events.ndjson`
- Failures: `docker compose exec teams-ai grep -E '"type":"[A-Z_]*(FAILED|BLOCKED|PAUSED)[A-Z_]*"' /home/node/.teams-ai/runs/<runId>/events.ndjson`
- The UI streams the same journal live in the run page, events tab.
- Status values: `running`, `paused:quota`, `paused:auth`, `draining`, `interrupted`, `blocked`, `deadlocked`, `phase-failed`, `done`.

## Health and metrics
- Compose health comes from the image `HEALTHCHECK` in the `Dockerfile`: it requests `/` every 30 seconds and passes below status 500. `task start` waits for it.
- `GET /healthz` returns `{"status":"ok"}`; `GET /metrics` is Prometheus text with `teams_ai_runs{status}`, `teams_ai_tokens_total`, `teams_ai_cost_usd_total` and `teams_ai_quota_paused`.
- Both answer on `http://localhost:8787` from the host, for example `curl -s http://localhost:8787/healthz`.

## Backup and restore
Not run live: written from reading the compose file and the Taskfile; try it on a spare machine before you rely on it.

### With the tasks
- Back up: `task down`, then `task backup`. It writes `backups/<date>/` with one `.tar.gz` per volume (`teams-ai-data`, `teams-ai-claude`, `teams-ai-gh`); git ignores `backups/`.
- Restore: `task down`, then `task restore DIR=backups/<date> FORCE=yes`, then `task start`.
- Both tasks refuse to run while any container of the stack is up. Restore also refuses without `FORCE=yes`, because it first deletes everything in the three volumes.
- Keep the backup folder somewhere outside this machine: it holds the Claude and GitHub logins.

### By hand, one volume
Replace `<volume>` with the real volume name from `docker volume ls`, with the stack stopped (`task down`).
- Back up: `docker run --rm -v <volume>:/data:ro -v "$PWD":/backup alpine tar czf /backup/<volume>.tar.gz -C /data .`
- Restore into an empty volume: `docker run --rm -v <volume>:/data -v "$PWD":/backup:ro alpine tar xzf /backup/<volume>.tar.gz -C /data`
- `dind-data` follows the same recipe, but it only holds images that the platform pulls or builds again.

## Incident basics
1. `task ps`, then `task logs`; add `task logs:dind` when a gate or a deploy fails.
2. The orchestrator restarts in a loop: check the disk space of Docker (`docker system df`) and read the last log lines.
3. A run is stuck: check its status in the UI or `/metrics`, read the journal tail, then Stop and Resume.
4. Authentication fails: `task login:claude` for Claude, `task login:gh` for GitHub, or set `CLAUDE_CODE_OAUTH_TOKEN` and `GITHUB_TOKEN` in `.env` and run `task restart`.
5. Data is damaged: `task down`, restore the last backup as above, `task start`, then resume the interrupted runs.
