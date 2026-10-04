# Secret rotation runbook

## Where secrets live
teams-ai reads one file per secret from `<data>/secrets/<NAME>` (upper-case names only, mode 0600, trimmed;
`server/core/secrets.ts`). In Kubernetes this directory is on the data PVC (written by the onboarding UI) or
a Secret mounted there. Secrets are loaded when a run or session starts, not cached for the process lifetime
by the API, so a new value is picked up by the next run/step without a restart. Exceptions are noted below.

| Secret | Used for | Rotate at |
|---|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | clone, push, PR creation by the agents | GitHub (fine-grained PAT) |
| `OPENROUTER_API_KEY` | System 1 decider and judge calls via OpenRouter | OpenRouter dashboard |
| `OMNIROUTE_TOKEN` | OmniRoute provider auth | OmniRoute admin |
| Claude auth (`claude auth login`, in the Claude config dir on the PVC) | Claude CLI steps | re-run login |

## Zero-downtime procedure (any file-based secret)
1. Create the new credential at the provider; keep the old one valid.
2. Write the new value without a window of an empty file. Either use the onboarding UI (atomic temp file +
   rename), or from a pod: `kubectl -n NS exec deploy/teams-ai -- sh -c 'umask 077; printf %s "$NEW" > /root/.teams-ai/secrets/.NAME.tmp && mv /root/.teams-ai/secrets/.NAME.tmp /root/.teams-ai/secrets/NAME'`
   (read `NEW` from a file or stdin, never put it on a command line that is logged).
   If the secret comes from a Kubernetes Secret volume, update the Secret; kubelet refreshes the mount
   within about a minute (not for `subPath` mounts, which require a rollout).
3. Verify: start or resume a small run, or call the provider with the new value. Confirm the next step
   authenticates (journal has no auth failure; the run is not `paused:auth`).
4. Revoke the old credential at the provider.

## What restarts
- Running orchestrator processes keep the environment they started with. A run already in flight uses the
  old secret until its next step reload; since the old credential is still valid (step 1), nothing breaks.
  If a run was spawned with the secret in its environment, resume it after revoking (stop + resume).
- No pod restart is needed for the file-based path. Restart (`kubectl -n NS rollout restart deploy/teams-ai`)
  only if the secret is injected as an environment variable, or a `subPath` Secret mount; the rollout is
  safe when no run is active (check `/metrics`, `teams_ai_runs{status="running"} 0`).
- Claude login: run `kubectl -n NS exec -it deploy/teams-ai -- claude auth login`, then resume any run
  that reports `paused:auth`.

## Emergency (leaked secret)
Revoke first at the provider, then do steps 1 to 3 with the new value; resume runs that pause on auth.
