# teams-ai operator runbook (Kubernetes)

`NS` is the namespace, `teams-ai` the Deployment. Data lives on the PVC mounted at `/root/.teams-ai`.
Related: `deploy/k8s/ops/restore-runbook.md`, `deploy/k8s/ops/secret-rotation-runbook.md`, `deploy/k8s/ops/backup.yaml`.

## Start and stop the service
- Start: `kubectl -n NS scale deploy/teams-ai --replicas=1`, then `kubectl -n NS rollout status deploy/teams-ai`.
- Stop: `kubectl -n NS scale deploy/teams-ai --replicas=0`. Active runs are interrupted (the pod's SIGTERM asks
  them to drain); the journal is append-only, so nothing is lost beyond the step in flight.
- UI/API: `kubectl -n NS port-forward deploy/teams-ai 8787:8787`, then open `http://localhost:8787`.
  The API only accepts `Host: localhost|127.0.0.1|[::1]`.

## Runs
- Start a run from the UI (Start), or `teams-ai run --project <dir> --spec <id>` inside the pod.
- Stop a run: Stop in the UI (drains: finishes the step, then ends).
- Resume a run: a spec whose run shows `interrupted` offers Resume in the UI; CLI:
  `teams-ai resume --project <dir> --run <runId>` run inside the pod through `kubectl -n NS exec` (use the
  CLI entry point your image exposes).
  After a pod restart or a restore, delete stale lock files first:
  `find /root/.teams-ai/workspaces -name '*.ndjson.lock' -delete` (the image CMD already does it on boot).
- `paused:auth`: run `claude auth login` in the pod, then resume.

## Quota pauses
The quota breaker pauses runs when a subscription window reaches 95 percent utilization or a step is rejected;
status `paused:quota`. The pause ends by itself when the window resets (or after a probe backoff of 5, 10, 20,
40, 60 minutes); the run continues without action. Check how many are paused: `teams_ai_quota_paused` in
`/metrics`. Do not resume by hand while paused; the orchestrator refuses to start steps until the breaker closes.
If it is urgent, switch the provider (OpenRouter/OmniRoute) in the project config and resume.

## Reading the journal
Each run has `runs/<runId>/events.ndjson` (one JSON event per line: `seq`, `at`, `type`, `kind`, `data`),
`state.json` (snapshot: status, tokens, cost) and `pid`.
- Tail: `kubectl -n NS exec deploy/teams-ai -- tail -n 50 /root/.teams-ai/runs/<runId>/events.ndjson`
- Failures: `... | grep -E '"type":"[A-Z_]*(FAILED|BLOCKED|PAUSED)[A-Z_]*"'`
- The UI streams the same journal live (run page, events tab). Status values: `running`, `paused:quota`,
  `paused:auth`, `draining`, `interrupted`, `blocked`, `deadlocked`, `phase-failed`, `done`.

## Health and metrics
- `GET /healthz` returns `{"status":"ok"}`. `GET /metrics` is Prometheus text: `teams_ai_runs{status}`,
  `teams_ai_tokens_total`, `teams_ai_cost_usd_total`, `teams_ai_quota_paused`.
- Probe snippets for the Deployment container. The API rejects foreign Host headers, so the probe must send
  `Host: localhost` (kubelet would otherwise send the pod IP and get 403):
  ```yaml
  livenessProbe:
    httpGet: { path: /healthz, port: 8787, httpHeaders: [{ name: Host, value: localhost }] }
    initialDelaySeconds: 20
    periodSeconds: 20
    failureThreshold: 3
  readinessProbe:
    httpGet: { path: /healthz, port: 8787, httpHeaders: [{ name: Host, value: localhost }] }
    periodSeconds: 10
  ```
- Scrape: the same Host constraint applies; use a sidecar or relabel the Host header, or query through
  `kubectl port-forward`.

## Incident basics
1. `kubectl -n NS get pods; kubectl -n NS describe pod -l app=teams-ai; kubectl -n NS logs deploy/teams-ai --tail=200`.
2. Pod crash-looping: check the PVC is bound (`kubectl -n NS get pvc`) and not full (`df -h /root/.teams-ai` in the pod).
3. Run stuck: check the status in `/metrics` or the UI, read the journal tail, then Stop and Resume.
4. Auth failures: see the secret rotation runbook.
5. Data damage: stop the service, restore from backup (restore runbook), resume runs.
6. Backups: `kubectl -n NS get cronjob,job` to confirm the nightly job succeeded; run one on demand with
   `kubectl -n NS create job --from=cronjob/teams-ai-backup manual-$(date +%s)`.
