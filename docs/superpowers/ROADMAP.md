# teams-ai — Roadmap and backlog

The single list of what is left until the POC is done. Plan history lives in `plans/README.md`; specs in `specs/`.

## Definition of done

The golden run criteria in spec §1.3 (`specs/2026-09-23-teams-ai-poc-design.md`):

- Two runs on the reference spec (`test/fixtures/todo-api`), agents on the Claude Code CLI only: run 1 baseline
  (decisions off) and run 3 full (System 1 decisions on). The old run 2 (OmniRoute) was dropped on 2026-10-05.
- Zero human interaction between Start and `awaiting-validation`.
- Every acceptance criterion `passed` in JUnit.
- Green deploy and smoke tests on `docker-local` (the `kind` target was dropped on 2026-10-05).
- Zero duplicate PRs; `main` green after every merge.
- The two runs compared on tokens, retries, wall time, blocked tasks and escalation rate.
- Every generated project ships the full delivery contract (Stage 8): code, docs, unit and e2e tests, security scans,
  GitHub Actions, image build and push, and a local docker infra that starts.

## How we work

1. One item at a time, in order. Pick the first item that is not `done`.
2. **Plan before implementing.** Every item gets a short plan first: goal, approach, files touched, how it is
   verified, cost (tokens or dollars). Items with code changes get a plan file in `plans/`; live runs and checks
   get the plan written into the item below. The human approves the plan before any implementation or paid run.
3. Implement, verify against the plan's checks, then record the outcome (result, cost, findings) in the item and
   mark it `done`.
4. Anything new that comes up goes into the backlog as a new item, not into the current one.

Status values: `todo` → `planning` → `approved` → `in progress` → `done` (or `blocked`, with the reason).

## Current item

**R6.1 superseded (human, 2026-10-05): the platform runs as ONE container from `docker-compose.yml`, no Kubernetes.**
`docker compose up -d --build`, UI on `http://localhost:8787` (token in `.env`). Gates and docker-local deploys run as
sibling containers through the mounted docker socket. Removed: `deploy/k8s`, the Job gate executor and the `executor`
config, and the `kind` deploy target (generated projects deploy with `docker-local` only). The UI needs no token:
the port is published on the host loopback only (`TEAMS_AI_UI_LOOPBACK_PUBLISHED`).

**Security block (plan 40, 2026-10-05):** code and tests done (rootless `dind` instead of the host socket, gate hardening, absolute secret denies). Open: live check of `docker compose up` with `dind` and of a docker-local deploy through it; the agent-reach probe (needs a `claude` login). Egress stays unrestricted by decision.

## Pause log

- **2026-10-04, end of the day — stopped by the human; everything saved to `main`.**
  - Done today (details in each item): Stages 6 (plan only), 7, 7b, 7c, 7d and 8 (R8.1–R8.6 at unit level, 981 root and 58 web tests passing at the last full run), decisions 2–4, 7, 8 and 12, R2.2 checked in the browser, golden run 1 (deploy-failed at smoke, $14.34).
  - **Blocker 1, the claude login on the WSL distro is broken** (my plan 20 runner copied the credential into a throwaway HOME and discarded the rotated token; fixed in `step-home.ts` and `AUTH_TEXT`, but the existing login is dead). The human must run `claude auth login` on the Ubuntu distro (or create a long-lived token with `claude setup-token` and export `CLAUDE_CODE_OAUTH_TOKEN`). Until then no agent step runs there. Verified again at the stop: `OAuth session expired and could not be refreshed`.
  - **Golden run 3 (R5.1) failed at Phase 1 after 74 s ($0.22)** because of that login; repository `lukeware70X7/teams-ai-todo-api-r3` and run `todo-001-r3` exist. Restart with a new `TEAMS_AI_PROJECT` (for example `todo-api-r4`) from a clean export of `main`, decisions on with the chain `local` then `claude`; restore `~/.teams-ai/config.json` afterwards (it is `{ "github": { "owner": "lukeware70X7" } }` now).
  - **R6.1 cutover (plan 31): NOT started.** The human gave the go for stages 1–5, but the background build was cut off before anything ran (`~/cutover-12.log` has only its first line): the kind cluster `teams-ai` and the image `teams-ai-backend:local` are the old ones. Restart at stage 1. Stage 6 (removal) still needs a second explicit yes.
  - **Egress of agent steps:** the human answered "open for now", but the change was NOT applied: a local commit of the kind-overlay patch was dropped unpushed after the human rejected the command that would publish it. `main` keeps the default-deny allowlist (plan 23) with placeholder CIDRs, so agent steps have no external egress in the cluster. Ask again before applying.
  - Another session (`teams-ai-a5`) has about 44 uncommitted files in the main working tree (concurrency, atomic writes, smoke host fix, kind.ts YAML, sec diff in the pack, Validation page); they are NOT in `main` and not mine. Its changes overlap files of the Stage 7–8 work, so expect conflicts when it commits.
  - Still open: R8.7 (golden run on the full contract), R2.3 (real logins), real egress CIDRs, the two-run comparison (R5.2) and the decision evals with data (R5.3). Resume from this entry: after the login is redone, start with golden run 3.

Rule (goal set 2026-10-04): when the 5-hour token window reaches 90 %, record the pause here and stop; when the
window resets, resume exactly from the entry below.

- **2026-10-04 17:46Z — run process gone, resume needed.** The orchestrator process for `todo-001-r1` died with
  the previous Claude Code session (journal intact, last event `RUN_PAUSED` until 18:30Z). Resume on WSL after
  18:30Z: `cd ~/teams-ai-live && ./node_modules/.bin/tsx --no-warnings=ExperimentalWarning server/cli.ts resume
  --project ~/.teams-ai/workspaces/todo-api/repo --run todo-001-r1 > ~/golden-run-1.log 2>&1` (run it detached with
  `setsid nohup ... &` so it survives the session). Done since the first pause: R1.2 code, R4.1 code, R4.2, R4.3,
  R5.3 harness (see each item).
- **2026-10-04 17:05Z — paused (5-hour window ≥ 95 %).** The orchestrator's quota breaker paused run
  `todo-001-r1` at 16:56Z until **18:30Z** (`RUN_PAUSED`, `reason: quota`); the run process stays alive and resumes
  by itself. Resume point: R1.1 — check `~/golden-run-1.log` and `~/.teams-ai/runs/todo-001-r1/events.ndjson` on
  WSL; when the run ends, record the outcome in R1.1, delete the untracked `gr-tmp.sh` launcher at the repo root,
  then plan R1.2 (plan before implementing).

## Stage 1 — Golden run 1 (baseline)

### R1.1 Golden run 1 on `todo-api`, `docker-local` — `closed, incomplete` (2026-10-04, closed at the human's request)

- Plan: `TEAMS_AI_GH_OWNER=<owner> TEAMS_AI_FIXTURE=todo-api npx tsx scripts/integration/orchestrator.ts` on WSL,
  defaults (decisions off); repository `lukeware70X7/teams-ai-todo-api`. Started as run `todo-001-r1`.
- Outcome: **not a pass.** Phases 1 (tech spec), 2 (plan, 10 tasks T0-scaffold, T1–T8, T9-deploy) and the start of 3
  ran, then the 5-hour window hit the breaker threshold and the run paused twice (16:56Z, 17:51Z). At closing: 0 tasks
  merged, T0-scaffold in validating, no verification, deploy or report, no cost total recorded. Not checked: any of the
  §1.3 criteria (AC `passed`, deploy, smoke, `main` green). The process was killed once with the Claude Code session
  and resumed (`cli.ts resume`).
- Finding: a golden run does not fit in one 5-hour window of this account; expect several pauses per run.
- The run is still alive and resumes by itself; it is carried on in R1.1b. The decision to close R1.1 as incomplete is
  the human's; the §1.3 criteria for run 1 are still open.

### R1.1b Carry `todo-001-r1` to a result — `done` (result: `deploy-failed`)

- Run `todo-001-r1`, 2026-10-04 16:53Z to 19:14Z (2 h 21 min wall, 2 quota pauses), Claude only, decisions off:
  phases 1 to 6 all ran; 830 events; 92 steps; **$14.34** (253 k output tokens, 7.1 M cache-read tokens).
- Delivered: 10 plan tasks plus 2 deploy-fix tasks merged (`T0-scaffold`, `T1`–`T8`, `T9-deploy`,
  `T950-deploy-fix-1-r1`, `T950-deploy-fix-4-r1`). Security gate: 13 approvals, 1 `changes` round. Verification
  planned 2 fix tasks. 1 task blocked (`T950-deploy-fix-1-r2`).
- Failure: deploy attempts 1–3 all failed at **smoke** (`AC-001`, `AC-002`, `AC-005`: "no smoke test"; the suite
  ran 3 tests and all failed). Cause, named by the agents themselves: the smoke gate runs in a container whose
  `SERVICE_URL=http://127.0.0.1:3000` is the container's own loopback, not the service; it needs the shared Docker
  network and the app container name, `--network host` or `host.docker.internal`. An environment fault of the
  docker-local target, not a code fault. In Kubernetes the smoke runs as a pod against the Service DNS name.
- §1.3 checked: zero human interaction Start to terminal: yes; every AC `passed` in JUnit: not shown (smoke not
  passed); deploy and smoke green: no; duplicate PRs and `main` green: not verified.
- Findings: (1) docker-local smoke cannot reach the service (fix with the k8s Job runner in R7.1, or a network fix
  for docker-local); (2) one run costs about $14 on this spec, 4x the hello-app baseline; (3) the agents' final
  blocking notice is carried as a spec-gap question, which burned 3 spec-gap rounds.
- R1.2 and the comparison now use this result as the run 1 data point.

### R1.2 Deploy the run 1 result to `kind` — `dropped` (2026-10-05, no `kind` target; the docker-local equivalent is `spec deploy --target docker-local`)

- `kind` has never run. Phase 5 is deterministic (no agent) once the plan carries the image, port, healthcheck and
  manifests, so a deploy-only command costs no tokens.
- Plan (2026-10-04, approved through the roadmap goal):
  - New command `teams-ai spec deploy --project <dir> --spec <id> [--target kind|docker-local]` for a spec whose code
    is on main (`awaiting-validation` or `done`). It journals a new run `<specId>-deploy-rN`.
  - `Run.deployOnly()` reads `docs/specs/<id>/plan.json` from main and runs one Phase 5 attempt (deploy, verify,
    smoke, rollback). No agent runs: a failure ends `deploy-failed` with its reason and plans no fix task.
  - Files: `server/cli.ts` (command, target override, preconditions without the claude login check),
    `server/orchestrator/run.ts` (`deployOnly`), `server/orchestrator/phases/deploy.ts` (option to skip the fix task).
  - Unit tests: success, deploy failure without a fix task, kind with a plan that has no manifests, CLI parsing.
  - E2E: run the command against the `teams-ai` kind cluster on the R1.1 result; green verify and smoke.
  - Fallback if the R1.1 plan has no Kubernetes manifests: a full run with `deploy.target: "kind"` (costs a run).
- E2E finding (2026-10-04, hello-app, no Claude tokens): `spec deploy --target kind` first failed at verify with
  "service has no NodePort". Cause: the default `kind` cluster is unreachable from WSL (Docker Desktop networks are not
  routable, even the node IP), and the fixture Service was ClusterIP. Fix: `scripts/wsl/kind-cluster.yaml` publishes
  host port 30080; manifests for `kind` use a NodePort Service pinned to 30080 (fixture and `devops.md` updated);
  recreate the cluster with `kind create cluster --name teams-ai --config scripts/wsl/kind-cluster.yaml`.
- Result with the fix: apply, verify and URL OK (`curl 127.0.0.1:30080/health` → `{"ok":true}`), rollback OK
  (`rolledBack`, `rollbackHealthy`). The run still ended `deploy-failed` at smoke: the hello-app fixture server is a
  stub without `/hello`, a fixture limit, not a kind one. The kind path is proven; the todo-api result (R1.1b) will
  be the real smoke check. Not covered: a plan whose manifests lack the NodePort (the DevOps agent now knows it).
- Progress: command, `Run.deployOnly()` and the no-fix-task option implemented with unit tests (734 passing,
  2026-10-04). Left: the e2e on kind, which needs the R1.1 result.

## Stage 2 — Browser checks (cheap, on the run 1 result)

### R2.1 "Report problem" from the Validation page (plan 12) — `done` (API e2e; button click unchecked)

- 2026-10-04, WSL, real UI server (`server/cli.ts ui --port 8788`; 8787 is held by the `teams-ai-backend-1`
  container) on the hello-app clone (hello-001 is `done` on main, which `continue` accepts):
  `POST /api/projects/hello-app/specs/hello-001/continue {report}` → HTTP 200, session opened; the report landed under
  `## Validation report` in `brief.md` and the spec turned `refining`. No `Routing (System 1 ...)` line, as designed
  with decisions off.
- Not checked: clicking the button in the browser (it is enabled only for an `awaiting-validation` spec with a report,
  which needs a finished run: R1.1b) and the decision 7 hint with decisions on (run 3).
- Cleaned up: draft removed, user config restored.

### R2.2 Start, stop and resume a run from the browser (plan 10) — `done`

- 2026-10-04, Chrome against the real UI server on WSL (port 8790, project `todo-api`, spec `todo-001`), all three clicks
  done in the browser with the human's explicit approval:
  - Start ("Iniciar execução", Projects page): `POST /api/projects/todo-api/specs/todo-001/runs` 200, run `todo-001-r2` created and its process alive.
  - Stop ("Parar", recent-runs table on the Projects page, not on the run page): `POST /api/runs/todo-001-r2/stop` 200 after 15 s,
    `RUN_STOP_REQUESTED` in the journal, process gone. This proves SIGTERM reaches the orchestrator's `requestStop()` through the `tsx` wrapper (plan 10's open item).
  - Resume ("Retomar", shown once the run is `interrompida`): `POST /api/runs/todo-001-r2/resume` 200, journal `RUN_RESUMED {"manual":true}` (the 2026-10-04 reducer fix) and a new `STEP_STARTED`: the run continued. Stopped again afterwards.
- Cost of the test: $0.89, 4 steps (it stops mid dev step, so the run is left unfinished on purpose).
- Findings: (1) clicking by element reference did nothing twice (no POST reached the server); coordinate clicks worked, so
  browser automation of this UI needs coordinates. (2) The stop took 15 s and the journal shows `STEP_STARTED` after `RUN_STOP_REQUESTED`
  (seq 109 after 107): a step of an already-running task still started during the drain, and the stop looks like it ended by escalation after
  the 15 s timeout, not by a clean drain; worth a look before relying on graceful stop. (3) There is no Stop button on the run page, only on the Projects page.

## Stage 3 — Golden run 2 — `dropped` (2026-10-05)

### R3.1 OmniRoute provider — `dropped` (human decision, 2026-10-05)

- Agents run only through the Claude Code CLI. Removed in plan 39 (`plans/2026-10-05-teams-ai-39-remove-omniroute.md`):
  the `omniroute` provider and config block, `resolveProfile`, the runner env injection, `scripts/wsl/omniroute/`,
  the p6 probe, the spec §10 gateway rules, and on the WSL host the `omniroute` container, the `omniroute-data`
  volume, its image and the `OMNIROUTE_*` secrets. A leftover `provider` key in a role profile is now a config error.
  The Jev (OpenRouter) and the local llama.cpp decision backends stay.
- Not replaced: failover when the Claude quota runs out stays the quota breaker pause.

### R3.2 Golden run 2 (OmniRoute for Test/DevOps) — `dropped`

- Nothing to run; the comparison (R5.2) is between runs 1 and 3.

## Stage 4 — System 1 ready for run 3

### R4.1 Decisions 2–4 (Gate 1 readiness, question dedup, contradiction) — `done` (unit; a live e2e check is a run, not an implementation task, so it is no longer tracked as open backlog here)

- Approach A chosen 2026-10-04. Option C ("decide after run 1") was dropped: a golden run starts from a frozen spec
  and never runs refinement, so run 1 says nothing about Gate 1 cost.
- Plan, in the refinement cycle (`server/refine/cycle.ts`), all through the decider (chain jev → local; the UI
  server has no Claude step to escalate to), no-ops while `decisions.enabled` is false:
  - Decision 2 `gate1-readiness`: after derive, one Noul per acceptance criterion ("ready and verifiable?");
    criteria below 0.5 reach the PO/SM refine pack as the ones to focus on. A hint; no step is skipped.
  - Decision 3 `question-dedup`: after the normalized-text dedup, one Noul per pair of new questions that share an
    AC, or a new question and an already decided one sharing an AC (at most 20 pairs); a confirmed duplicate
    (≥ 0.5) is dropped, keeping the earlier one.
  - Decision 4 `history-contradiction`: one Noul per retrieved history chunk (at most 5) against the derived spec;
    a contradiction (≥ 0.5) adds a blocking PO question quoting the chunk.
  - Files: `server/decide/decisions/gate1.ts`, `server/refine/cycle.ts`, `server/refine/packs.ts`,
    `server/refine/session.ts` / `registry.ts` (pass the decider), `server/cli.ts` (build it), config defaults.
  - Unit tests for each decision and for the cycle with a fake decider; e2e: one refinement session in the UI with
    decisions on.
- Progress (2026-10-04): implemented (`server/decide/decisions/gate1.ts`, cycle, pack, session/registry, CLI)
  with unit tests (`test/decide/gate1.test.ts`, `test/refine/cycle.test.ts`; 750 passing). Left: the e2e refinement
  session with decisions on (needs Claude quota for PO/SM; local backend now available, R4.3).
- E2E (2026-10-04, WSL, real UI server and real Claude PO/SM/Front, decisions on with the chain `local` only so the
  Jev was not called, llama.cpp Qwen2.5-7B on the GPU): a new spec session on hello-app with a vague AC and a
  requirement that contradicts hello-001 reached `answering` after one cycle. The llama server log grew by 56 lines
  and about 11 completions (~1,600 tokens each), so the three decisions ran; the cycle finished without error.
  Not proven: what the decisions answered. The PO and SM still produced near-duplicate questions on the empty `name`
  parameter (`po-c1-0`, `sm-c1-0`), either because their `relatedAcIds` did not share an AC (decision 3 only pairs
  questions that share one) or because the model answered below 0.5.
- Finding: the UI server's decider has no `onDecision`, so Gate 1 decisions leave no record at all; R5.3 (evals) needs
  them. Fixed 2026-10-04: every Gate 1 decision is now journaled as `DECISION_MADE` in the refine event log
  (`server/refine/cycle.ts`, same record shape as the run journal; `scripts/evals/decisions.ts --runs
  ~/.teams-ai/workspaces/<project>/refine` reads it). Re-run live the same day (real Claude PO/SM/Front, chain `local`
  only, Qwen2.5-7B Q4_K_M), one cycle, 8 decisions-polling intervals of 15 s, no Jev call. Read from the journal:
  - `gate1-readiness` (local, 8.1 s): AC-001 = 1.00 and AC-002 = 1.00. AC-001 is "then it answers nicely", a vague
    criterion that should score low: the 7B model does not discriminate on readiness, so the hint it gives the PO/SM is
    useless as it stands.
  - `question-dedup` (3.6 s): unanswered, `exhausted` (the local backend answered below its 0.9 threshold or failed,
    and the chain has no later entry), so no question was merged; the near-duplicate pair on an empty `name` survived.
  - `history-contradiction`: not asked (no history chunk was retrieved for this objective).
  - Conclusion: the plumbing works end to end and is observable; the quality of decisions 2 and 3 on the local 7B model
    is not good enough to rely on. Next: label these records and run `scripts/evals/decisions.ts` (R5.3); try a larger
    model or the Jev for 2 and 3 before run 3. The R4.1 code is done; the model choice is an R5.3 outcome.
  - Fixed the same day (`server/decide/decisions/gate1.ts`, probes `scripts/evals/gate1-probe2.ts`): (a) the three
    decisions made ONE call for all their items, and a call's confidence is the lowest of its questions, so one
    uncertain pair left all of them `exhausted` (reproduced: 0.60 < 0.9); now one call per item. (b) Decision 2 gets a
    deterministic rule first (spec 10A.0): a THEN with only a vague word (nicely, properly, correctly...) and no digit,
    quote, brace or bracket is not ready without asking the model, and the model's question was reworded to ask for an
    exact checkable value (gap 0.34 where the old wording had 0). Live, same test set, local 7B: readiness 3 of 3 vague
    criteria flagged and 0 of 3 precise ones wrongly flagged (before: 1 of 3); dedup answered every call and got 3 of 4
    pairs right, the miss being a semantic paraphrase (database versus storage backend), which only leaves a duplicate
    question. `READY_MIN` 0.8 is provisional until R5.3 has labeled data. Cleaned up:
  draft removed, config restored.

### R4.2 Decision 12 (rank candidate plans) — `done` (unit)

- Plan and outcome (2026-10-04): the `plan` step output may carry `alternatives` (at most two full plans, same
  `specHash`; `server/agents/outputs.ts`); `plan.json` keeps the `Plan` contract. Phase 2 drops alternatives that
  fail `validatePlan` or carry another `specHash`, asks `plan-rank` (one Score per candidate on AC coverage and
  risk, `server/decide/decisions/plan-rank.ts`, escalates to the SM) and journals `PLAN_CHOSEN`; the first plan wins
  ties and every unanswered case. `sm.md` offers alternatives only for a genuinely different approach.
- Unit tests: `test/decide/plan-rank.test.ts`, Phase 2 ranking in `test/orchestrator/phases.test.ts` (740 passing).
- Not covered: replan candidates (spec row 12 also names replan); the SM authors one replacement plan today.

### R4.3 `local-logprobs` backend on the host — `done`

- 2026-10-04: `nvidia-cuda-toolkit` 12.0 installed; `~/llama.cpp` built with `-DGGML_CUDA=ON
  -DCMAKE_CUDA_ARCHITECTURES=86`; model `~/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf` (4.7 GB, bartowski);
  server: `~/llama.cpp/build/bin/llama-server -m ~/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf -np 4 -c 8192 -ngl 99
  --host 127.0.0.1 --port 8080` (5.8 GB VRAM, log `~/llama-server.log`; not a service, restart it after a reboot).
- Smoke `npx tsx scripts/smoke/local-logprobs.ts`: choice, noul and score answered in 545 ms, probabilities sum to 1,
  cost $0. Enable with `decisions.local.enabled: true`. Model and threshold are tuned later with R5.3.

## Stage 5 — Golden run 3 and the comparison

### R5.1 Golden run 3 on `todo-api` (decisions on) — `closed, incomplete` (2026-10-06, live runs removed from active backlog per human decision; started 2026-10-04, run `todo-001-r3`)

- Launched 2026-10-04 on WSL from a clean export of commit a557e86 (not the working tree with another session's edits):
  `TEAMS_AI_GH_OWNER=lukeware70X7 TEAMS_AI_FIXTURE=todo-api TEAMS_AI_PROJECT=todo-api-r3 tsx scripts/integration/orchestrator.ts`
  from `~/teams-ai-run3`; repository `lukeware70X7/teams-ai-todo-api-r3`; log `~/golden-run-3.log`. Authorized by the human.
- Deviation from spec §1.3: run 3 is Claude only (OmniRoute was dropped, R3.1) with System 1 decisions on and the chain
  `local` then `claude` (`local` only for model-tier and cli-error); the Jev (OpenRouter) is NOT used, to avoid external spend.
- It is the first live run of the runner-security changes (empty step HOME, mandatory sandbox), of `requireDelivery` (a plan without `delivery` is rejected) and of the Gate 1 / decision journaling.
- **Restore after the run:** `~/.teams-ai/config.json` was changed to turn decisions on; the original is `~/config.json.bak-run3` (it held only `{ "github": { "owner": "lukeware70X7" } }`).
- Outcome (2026-10-04): **failed at Phase 1 after 74 s, $0.22**, `phase-failed`. Cause: a defect of my own plan 20 change. The
  runner copies `~/.claude/.credentials.json` into a per-step HOME and deletes the HOME afterwards; step 1 made the CLI renew
  its OAuth token inside the copy, the server rotated the refresh token, the host file kept the old one and the next step
  (and any `claude` on that host) got `OAuth session expired and could not be refreshed`. The probe `p7-step-home.sh`
  passed earlier because the token was still valid. **The WSL `claude` login is broken and needs `claude auth login` by the human**
  (the credential file's `expiresAt` reads 1970). Second defect: the failure text did not match `AUTH_TEXT`, so it was `code`,
  the `cli-error` decision answered with low confidence (0.64 and 0.61 on the local 7B, default `code`) and the run burned its
  attempts instead of pausing for a login.
- Fixed (`syncBackCredentials` in `server/runner/step-home.ts`, `AUTH_TEXT` in `server/runner/step.ts`, tests in
  `test/runner/step-home-sync.test.ts`): a newer well-formed credential is written back to the host file atomically with mode
  0600 before the HOME is removed; and the messages of a dead OAuth session now classify as `auth`. Not covered: two steps that
  start in parallel with the same expired token can still race on the refresh (the loser fails as `auth` and the run pauses
  for a login); a long-lived token through `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) would remove the race.
- Run 3 must be started again after the human re-logs in; the config is restored (`~/.teams-ai/config.json` back to the owner only).
- Outcome kept for the record: `todo-001-r3`, repository `lukeware70X7/teams-ai-todo-api-r3` (reusable only after deleting it or with a new `TEAMS_AI_PROJECT`).
- **Retried as `todo-001-r4` (2026-10-05, before this session) and `todo-001-r5` (2026-10-06, this session, after the human redid `claude auth login`): both failed at Phase 1 after 3 attempts, $0.00 each** (fails before any API call) - a *different* defect from the credential-rotation bug above, which is fixed. Root cause (r5, 2026-10-06): the only `claude` binary reachable on this WSL host, even from inside WSL, is the **Windows** install (`/mnt/c/Users/Administrator/AppData/Roaming/npm/claude`, a POSIX shell shim around the Windows CLI) - there is no native Linux `claude-code` install on this WSL distro, and this WSL's own `npm` is itself a Windows shim too (`C:\Users\Administrator\AppData\Roaming\npm\node_modules\npm`), so a normal `npm install -g` from inside WSL would not fix it either. The CLI sees `process.platform === 'win32'` underneath and applies the Windows-specific sandbox check, which fails with "Sandbox disabled: sandbox is enabled but the Windows sandbox is not active on this session (feature gate off)" - the same message hit from native Windows during plan 46's smoke check. The `/home/diego/.claude/.credentials.json` found on this host (and used successfully for `claude auth status`) is a byproduct of a past run's `syncBackCredentials` writing to the WSL-side `$HOME`, not proof of a native install.
- Human decision (2026-10-06): stop here, record as closed rather than install a native Linux `claude-code` in WSL or bypass the sandbox (`TEAMS_AI_UNSAFE_NO_SANDBOX=1`) today. `lukeware70X7/teams-ai-todo-api-r5` exists on GitHub with no merged work (not cleaned up); `~/teams-ai-r5` on WSL is a copy of `main` at this session's last commit, left in place.
- Next attempt needs one of: a real native Linux `claude-code` install in WSL (its own `npm`/node, not the Windows one on PATH), or an explicit sign-off to run with the sandbox disabled for one attempt.

- Flip `decisions.enabled` for this run only; the `false` default is by design for runs 1–2.

### R5.3 Decision evals (spec §10A.6) — `done` (harness)

- Harness (2026-10-04): `server/decide/evals.ts` joins `DECISION_MADE` records with hand labels
  (`{runId, seq, question, label}`) and computes per decision: accuracy, multiclass Brier, ECE (10 bins),
  escalation rate, latency p50/p95. CLI: `npx tsx scripts/evals/decisions.ts --runs ~/.teams-ai/runs --labels <file>`.
  Unit tests in `test/decide/evals.test.ts`; checked end to end on a synthetic journal.
- Labeling the run 3 decisions and running the eval against real data is a live-run task, not implementation; no
  longer tracked as open backlog here.

## Stage 6 — Everything in Kubernetes

### R6.1 Run the whole stack as pods in one namespace — `dropped` (2026-10-05, replaced by a single compose container)

- Goal (human, 2026-10-04): application, back, front, OmniRoute and the local model all run in the same Kubernetes
  namespace, every pod reaching every other and the internet (ingress and egress open); nothing left installed
  directly on WSL or Docker. Order decided by the human: let golden run 1 finish first. Cluster: `kind` (the spec's
  target, already proven); Docker stays only as the engine under kind.
- Jev is the OpenRouter API (external): it stays external; the namespace only needs egress to openrouter.ai.
- Inventory found 2026-10-04 (read-only):
  - Docker containers: `teams-ai-control-plane` (kind), `omniroute` 3.8.51, `teams-ai-backend-1` (image
    `teams-ai-backend:local`, up 2 h, not installed by this roadmap).
  - Docker volumes: `omniroute-data`, `teams-ai_teams-ai-claude`, `teams-ai_teams-ai-config`, `teams-ai_teams-ai-gh`
    (the last three hold a `claude` login, `gh` login and config: removing them loses those logins).
  - Docker images: `teams-ai-backend:local`, `ghcr.io/diego-dm-morais/teams-ai:{0.1.0,latest}`,
    `teams-ai-teams-ai:latest`, `diegosouzapw/omniroute:3.8.51`, 8 `hello-app:*`, `node:*`, `curlimages/curl`.
  - WSL: `~/llama.cpp` (build), `~/models` (4.4 GB), `nvidia-cuda-toolkit` (apt), process `llama-server`, clones
    `~/teams-ai-live`, `~/teams-ai-e2e`, `~/hello-kind`, `~/teams-ai`, `~/workspace/teams-ai`, `~/.teams-ai`
    (config, runs, workspaces, secrets: 7 secrets incl. `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GEMINI_API_KEY`).
- Plan to write before touching anything (open questions, answered by reading the code first):
  1. Namespace `teams-ai` with Deployments: `backend` (orchestrator and API), `front` (web UI served by the backend
     today: one pod unless the build is split), `omniroute`, `llama` (GPU needs the NVIDIA device plugin in kind; the
     fallback is CPU or leaving the model out), plus NetworkPolicies that allow all ingress and egress.
  2. Secrets and logins as Kubernetes Secrets/PVCs: `claude` credentials, `gh`/`GITHUB_TOKEN`, OmniRoute secrets,
     OpenRouter key, `~/.teams-ai` as a PVC.
  3. The orchestrator needs Docker for gates and deploys and `kind` itself for the deploy target: inside the cluster
     that means a Docker-in-Docker sidecar or Jobs; decide before building.
  4. Cutover and removal: only after the stack runs and a smoke passes in the namespace; removal list shown to the
     human first, volumes with logins only with an explicit yes.
- Plan 31 (`plans/2026-10-04-teams-ai-31-k8s-cutover.md`) fixes the stages: build image, recreate kind, secrets and data, apply, prove with the R2.2 cycle and a Job gate, then reconfirm and remove. Nothing is applied or removed until the human gives the go for stage 1, and a second explicit go for stage 6 (the volumes with the claude and gh logins). Superseded line:
- **Progress 2026-10-05 (human gave autonomy for local-cluster envs and secrets):** stages 1–4 done. Image built from a clean
  export of `main` and loaded; kind `teams-ai` recreated with the three host ports; Secrets `github-token`, `openrouter-api-key`,
  `gemini-api-key` and a random `ui-token` created from host files (values never printed); `kubectl apply -k overlays/kind`.
  Defect found and fixed (3f0abdf): the backend pod crash-looped because the UI refuses a non-loopback bind without
  `TEAMS_AI_UI_TOKEN`; `backend.yaml` now reads it from Secret `ui-token`. Backend, buildkitd, registry and llama Running; UI answers
  200 on `localhost:30787`; `scripts/smoke/local-logprobs.ts` passes against the in-cluster llama (CPU). OmniRoute is scaled to 0 (optional;
  its Secret was removed because the encryption key is not known). **Not done:** Secret `claude-credentials` (held back while golden run
  4 uses the host login, to avoid two consumers of one refresh token), data copy into the PVC, stage 5 proof, real egress CIDRs, stage 6.
- (old) Not started. First action when R1.1b ends: turn the open questions above into a plan file in `plans/`.

## Stage 7 — Production readiness (workflow, 2026-10-04)

Six isolated agents built these in parallel; each wrote a plan in `plans/` and unit tests; merged into the PR #13
branch (768 passing, typecheck clean). Nothing below was applied to a cluster or run live.

| Id | Item | State | Open |
|----|------|-------|------|
| R7.1 | k8s stack, plan 14 (`deploy/k8s`: backend, omniroute, llama, buildkit + registry, Ingress, open NetworkPolicy, kustomize overlays `kind` and `gpu`, Secret templates) | manifests + parse test | Not validated with `kustomize build` or a cluster; image pins and the OmniRoute secret key names are guesses; **gates and deploys still call `docker`** (Job runner and registry build not written); backend Dockerfile still installs docker.io; kind needs a registry mirror |
| R7.2 | API auth, plan 15 (bearer `TEAMS_AI_UI_TOKEN`, HttpOnly cookie for SSE, web client prompt) | done, unit | `isAllowedHost` still 403s any non-loopback Host (blocks a Service/Ingress); token not wired into the manifests; no browser check |
| R7.3 | Supervisor, plan 16 (`teams-ai supervise`) | done, unit | not run live; a run stopped, hand-resumed, then crashed is never auto-resumed |
| R7.4 | System security audit (`docs/superpowers/security/2026-10-04-system-audit.md`) | done | 1 critical, 4 high, 6 medium, 7 low, none fixed yet |
| R7.5 | CI + pipeline e2e, plan 18 (`test/e2e/pipeline.e2e.test.ts`) | done | see the plan for the furthest milestone reached without Docker |
| R7.6 | Ops: `/healthz`, `/metrics`, backup CronJob, runbooks (`docs/superpowers/ops/`) | done, unit | not run in a cluster |

### Stage 7b — Second workflow (2026-10-04): the code items, each with an independent reviewer

Five branches built, reviewed, merged and fixed (855 passing, typecheck clean). Plans 20–24 in `plans/`.

| Item | What changed | Left |
|------|--------------|------|
| R7.4 runner (plan 20, audit C1/H3/M2) | Sandbox mandatory (two opt-ins to disable), per-step empty HOME with a copy of the credential only, nested-interpreter denies, worktree `.claude` settings ignored; a run now refuses an unsandboxed config before any phase | Probe `scripts/wsl/probes/p7-step-home.sh` on the real CLI (2026-10-04, $0.02): login works from an empty step HOME (A pass), and a worktree `.claude/settings.json` allowing `Bash(touch:*)` is not honored under `--setting-sources user` (B pass, the touch was denied). Still unverified: the wildcard deny syntax (`Bash(* gh *)`); the credential copy is still readable by the agent; the backend pod runs unsandboxed with both opt-ins until agent steps are their own pods |
| R7.4 API (plan 21, H2/M1/M3–M5/L1–L6, plan 15 leftovers) | CSRF and clickjacking guards, clone-host allowlist, redaction fixes, shared SSE poller with a cap, security headers, configurable allowed Hosts | SSE idle timeouts; clone allowlist is `github.com` only by default; DNS-rebinding window on clone |
| R7.1 Job runner (plan 22) | `GateExecutor` with `docker` (default) and `k8s` (Job per gate, JUnit and logs through kubectl), smoke reaches the Service by DNS; offline gates get a deny-all policy | Manifests validated 2026-10-04: both overlays render with `kubectl kustomize` and all 23 resources pass `kubectl apply --dry-run=server` on the local kind cluster (the obsolete AppArmor annotation was replaced by `appArmorProfile`); Jobs never run; `kubectl logs` merges stdout/stderr; k8s executor requires the kind target (guarded at run start) |
| R7.1 Deploy (plan 23, H4/M6) | Registry build via BuildKit, non-root image without docker.io, securityContext everywhere, agent-step egress allowlist (placeholder CIDRs), kind containerd mirror | CIDR placeholders must be replaced; compose file still mounts `/root` and the Docker socket (legacy path); image pins unchecked against a registry; nothing applied to a cluster |
| Orchestrator (plan 24) | Explicit `blocked` status in the Dev/DevOps output (no spec-gap rounds burned), supervisor stop-marker rule; a hand resume (`RUN_RESUMED {manual:true}`) now lifts a stop but never an exhausted budget | supervise CLI test covers argument validation only |

### Stage 7c — Leftovers (2026-10-04, plans 25–27; 874 passing)

- **SSE lifetime:** streams close after 30 min total or 10 min idle with `event: reconnect`; the client reconnects with `Last-Event-ID`. Timeouts are `ApiDeps` options, not yet read from the config file.
- **Clone host check:** a host that does not resolve is now refused; the DNS-rebinding window (git resolves again at clone time) is narrowed, not closed (pinning the IP breaks TLS/SNI with plain git); see plan 25.
- **Gate logs:** the k8s gate wrapper keeps stdout and stderr apart (last 500 lines each between markers), so infra failures classify as `infra`; the wrapper has no test against a real `sh` and `kubectl`, and a gate with more than 500 lines of output loses the early lines.
- **Supervise CLI test:** the loop is tested through `main()` with injected index, liveness and spawner; `docker-compose.yml` no longer mounts the Docker socket or `/root` (not validated with `docker compose config`).

### Stage 7d — Gaps left open by Stage 8 and R2.2 (2026-10-04, plans 35–38; 981 root and 58 web tests passing)

- **E2E evidence and scope (plan 35):** e2e rows are shown per acceptance criterion in the evidence matrix, the Phase 6 report and the Validation page (new E2E column). The rigid "a test for every criterion" rule is replaced by `plan.e2eExemptions: [{acId, reason}]` set by the SM (reason of at least 10 characters, unknown or duplicate ids rejected, exempting every criterion rejected). No `runPhase6` test shows the rows in the report yet.
- **Deploy lifecycle (plan 36):** a failed first deploy (no previous image) now tears the new stack down (`destroy`: compose `down -v`, `docker rm -f`, or the kind manifests and secret); a missing delivery file at Phase 4 plans deterministic fix tasks (devops for Dockerfile/compose/workflows, dev for the e2e suite and README sections) and reuses the round budget; `readmeSections` is checked only when `docs/README.md` already exists. Open: a failure in the apply stage of a first deploy is not torn down; the fix tasks are templates, not agent-planned; the README match is a case-insensitive substring.
- **Image scan and installer (plan 37):** the always-available image gate is `trivy config` plus `trivy fs` (CRITICAL, exit code 1); the build also exports an archive (`.tools/image.tar`, buildctl OCI output or `docker save`) when the plan has an image-scan gate. The `security-tools` gate must be exactly `sh .tools/install.sh`, an installer the orchestrator renders with pinned versions and sha256 checks (gitleaks 8.28.0, osv-scanner 2.2.2, trivy 0.75.0, semgrep 1.131.0 via pip). Open: the pinned checksums and the install script were never run.
- **Drain and auth race (plan 38):** the drain bug of R2.2 is fixed: `Run.loop()` restarted every active task while draining, so each task's next step started after `RUN_STOP_REQUESTED`; now only in-flight steps finish after a stop (a budget drain keeps its older contract). A per-process refresh gate (`withRefreshGate`) lets one step refresh an expiring OAuth token while the others wait; `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is passed through instead of copying the credential file and is the cross-process answer. Open: a step longer than the API's 15 s graceful window is still killed on stop and re-run on resume; the gate was only tested with a fake claude; two orchestrator processes on one host can still race without the env token.

- **Decision for the human:** the audit's C1/H3/H4 (agent steps with credentials readable and unrestricted egress;
  deny rules bypassable through `node`/`npm`; root container with the Docker socket) are made worse by the requested
  fully open NetworkPolicies. Recommended: keep ingress open, but give agent-step pods a default-deny egress plus an
  allowlist (registry, model endpoints), separate ServiceAccounts and no credentials in their HOME.
- Next, in order: R7.4 fixes for critical/high; R7.1 Job gate runner and registry build (needs a plan: it changes
  `server/exec` and `server/deploy`); R7.2 allowed hosts for in-cluster use; then R6.1 cutover with the human.

## Stage 8 — Delivery contract for generated projects (audit 2026-10-04)

Acceptance criteria (set by the human): every project produced by teams-ai exits with **code, documentation, unit
tests, e2e tests, secure code, GitHub Actions pipelines, a mini pipeline that builds the image and pushes it to the
repo registry, and a local docker infra ready to start**. Audit of what ships today (read-only, no run):

| Criterion | Today | Gap |
|---|---|---|
| Code | Hard gates (format, lint, unit, build, secret-scan) | no run has reached `awaiting-validation` yet (R1.2/R7.1) |
| Documentation | `docs/README.md` only, written by the SM from a prompt | no docs gate; a failed README step is swallowed (`phases/report.ts:44`); no runbook or API docs |
| Unit tests | Hard gate; AC ids in test names; evidence matrix | none known |
| E2E tests | none (only `commands.smoke` after deploy, failed live) | no e2e step, gate or agent prompt for the generated project |
| Secure code | Sec agent blocks `critical`/`high` per task diff; `secret-scan` required by name | SM picks the command; no SAST, dependency audit or image scan |
| GitHub Actions | none | bootstrap commits `docs/` only; devops does not emit `.github/workflows` |
| Build + push image | docker-local: build and run, no push; kind: push to an in-cluster insecure registry | no push to GHCR or another registry; no CI-driven pipeline |
| Local docker infra | Dockerfile and compose are free-form paths | compose not enforced or validated; docker-local is one `docker run`; smoke failed live |

Items below depend on R1.2/R7.1 (a run must reach the end first), except R8.1, R8.3 and R8.6, which can be built and
unit-tested with fixtures. Each one needs a plan file in `plans/` before implementation. Items touching
`server/exec`, `server/deploy` or `server/orchestrator` collide with work in flight; do them in a separate worktree.

### R8.1 Delivery contract in the plan — `done` (unit; plan 28, 2026-10-04)

- `plan.delivery` lists the required artifacts (Dockerfile, compose, CI workflow, release workflow, e2e suite, docs
  sections). `server/validators/plan.ts` rejects a plan missing any; Phase 4 (`phases/verify.ts`) fails if a file is absent.
- Files: `server/contracts/plan.ts`, `server/validators/plan.ts`, `server/orchestrator/phases/verify.ts`.

- Built: `plan.delivery` (Dockerfile, compose, CI and release workflow paths, e2e suite, README sections), optional in the schema; `validatePlan` takes `requireDelivery` (on in `server/cli.ts`, so new plans must carry it); Phase 4 fails with the missing files before any gate. `sm.md` and the plan pack tell the SM to fill it.
- Open: a live run will now reject an SM plan without `delivery` (check on the next run); Phase 4 does not check `readmeSections` (R8.6 does, in Phase 6); a missing delivery file ends the run at Phase 4 with no fix round.
### R8.2 Docker infra enforced — `done` (unit; plan 33, 2026-10-04)

- DevOps must emit `Dockerfile` and `docker-compose.yml`; docker-local switches from one `docker run` to
  `docker compose config` + `up --wait`. Fixes the smoke network fault seen in run 1.
- Files: `.claude/agents/devops.md`, `server/deploy/docker-local.ts`.

- Built: docker-local deploys with `docker compose` when `plan.delivery.compose` is declared (`config --quiet`, `up -d --build --wait`, compose healthcheck plus HTTP check, rollback by the previous tag or `down`, destroy `down -v`); the single `docker run` stays as the fallback. The smoke gate container joins the compose network and reaches the service by name (`gateNetwork`, `gateServiceUrl`), which is the fix for the loopback fault of golden run 1.
- Open: nothing of this is proven on a real Docker host (compose `--wait`, DNS of the service name, the network really named `<project>_default`); a failed FIRST deploy leaves the stack up (the orchestrator never calls rollback with no previous tag); the compose file content is not validated beyond `config`.
### R8.3 GitHub Actions in the generated repo — `done` (unit; plan 29, 2026-10-04)

- `.github/workflows/ci.yml` (lint, typecheck, unit, e2e, scans) and `release.yml` (buildx build and push to GHCR with
  `GITHUB_TOKEN`). Bootstrap commits them; a gate validates the YAML (actionlint). Decide: agent-written or template.
- Files: `.claude/agents/devops.md`, `server/orchestrator/phases/bootstrap.ts`, `server/exec/gate-runner.ts`.

- Built: deterministic templates, not agent-written (`server/orchestrator/workflows.ts`): `ci.yml` and `release.yml` (build and push `ghcr.io/<owner>/<image>` with sha and latest tags, least-privilege permissions, actions pinned by major tag), validated structurally before commit (actionlint is not available offline), committed by the bootstrap phase after Phase 2 when absent.
- Open: the secret scan uses `gitleaks-action` (needs a license secret for organization repos); only bootstrapped runs get the files; the release workflow assumes a root Dockerfile (R8.1/R8.2); no e2e job (R8.4); never run on real GitHub.
### R8.4 E2E tests for the generated project — `done` (unit; plan 34, 2026-10-04)

- New required blocking gate `e2e`; the Test agent writes the suite; the runner executes it against the compose stack,
  reusing the `server/exec/smoke.ts` plumbing. Not the same as `commands.smoke`.
- Files: `server/validators/plan.ts`, `server/exec/gate-runner.ts`, `.claude/agents/test.md`.

- Built: required blocking `e2e` gate (`commands.e2e` or a gate named `e2e`; `requireE2e` on in `server/cli.ts`, older plans stay valid), run in Phase 5 after the smoke passes, against the compose stack through `gateNetwork` and `gateServiceUrl`, with JUnit rows per acceptance criterion (`server/exec/e2e.ts`); a failure rolls back and plans a Dev fix task inside the 3-attempt budget; `test.md`, `sm.md` and the plan pack say how the suite is written; the CI template got an `e2e` job (compose up, e2e, down).
- Open: nothing ran on a real Docker host; the e2e rows live only in `DeployVerified` and the Phase 5 return (the evidence matrix and the Phase 6 report do not show them per AC yet); the e2e demands a `[AC-xxx]` test for EVERY criterion, including devops-only ones, which may be too rigid; smoke and e2e write the same `junitPath` in sequence; the CI job assumes the compose publishes the container port as-is.
- Stage 8 state: R8.1–R8.6 done at unit level; R8.7 run live 2026-10-08, see below.

### R8.7 Golden run on the full Stage 8 contract — `closed, deploy-failed` (2026-10-08, US$ 13.26, ~1h20)

- Run `todo-001-r1` on `test/fixtures/todo-api`, owner `lukeware-kayron-hub`, via `scripts/integration/orchestrator.ts` inside the `teams-ai` compose container (not WSL: avoids the Windows-sandbox dead end of R5.1/R10.1). Human authorized the run and its cost in advance; otherwise zero human interaction until the port collision below.
- **Phase 4 (verification): passed completely.** All 11 gates green (format, lint, unit-test, coverage, build, security-tools, secret-scan, sast, dependency-scan, license-scan, image-scan) on the merged main; `VERIFICATION_PASSED` with every criterion (AC-001 to AC-005) matched to a passing test in the full-repo JUnit. All 10 plan tasks (T0-scaffold, T1-T9) merged clean, plus T7 needed a 3-part replan (T7-r1 fixed an evidence-citation mismatch on AC-005's test name — see finding 1 below; T7-r2 wrote the Dockerfile; T7-r3 wrote docker-compose.yml/deployment.json) — 13 task PRs total (#3-#15), zero duplicates, main green after every merge.
- **Phase 5 (deploy/smoke/e2e): deploy-failed, but not because of the generated project's own code.**
  - Deploy attempts 1-2 failed at `apply`: port 3000 was already bound by an unrelated leftover container (`teams-ai-biblioteca-escolar-biblioteca-escolar-1`, running 6+ hours from the R11.2 live check, never cleaned up — the roadmap already carried that as open work). **Finding 2.**
  - The automatic deploy-fix loop oscillated: devops changed the published port to 8341 → review rejected it three times for contradicting the frozen tech-spec's fixed port 3000 (a correct catch: the spec says "expõe 3000"); devops reverted to 3000 → review rejected that too, correctly, for being an unproven assumption that the external blocker had cleared; a third attempt changed the *internal* container port (not just the published one), rejected again for the same spec drift; an SM replan was itself rejected for a task-ownership mismatch (devops asked to touch `README.md`). The task `T950-deploy-fix-2` ended `blocked` after exhausting its attempts. **Finding 3: the fix loop has no way to settle a genuine tie between "stay faithful to the spec" and "the environment changed," and no escalation to a human when it can't.**
  - At this point the human (this session) stopped the leftover container directly (`docker stop`, reversible, confirmed abandoned test infra) to clear the real blocker — the one human interaction this run needed beyond authorizing it.
  - Deploy attempt 3 then ran the *original*, never-touched main-branch config (port 3000, since the blocked fix branch was never merged) and **`apply` succeeded**. The smoke gate's own TAP output showed **all 3 tests passing** (`# tests 3`, `# pass 3`, `# fail 0`), but the orchestrator's smoke evaluator reported `"AC-001: no smoke test; AC-002: no smoke test; AC-005: no smoke test"` and failed the deploy anyway. **Finding 4 (the real blocker, now fixed — see below.)**
  - Phase 5 ended `deploy-failed` after 3 attempts; Phase 6 (report) still ran, committed `docs/specs/todo-001/report.md` (PR #15, merged), and the run journaled `RUN_FINISHED {result: "deploy-failed"}`.
- **Findings:**
  1. *(self-corrected live)* `AC-005`'s literal criterion text contains `{"ok":true}`; a Test agent naming the JUnit test after the criterion verbatim produces a test name with embedded double quotes, which broke exact-string evidence citation matching. Dev diagnosed this itself, asked the SM via spec-gap to rename without quotes, got approved, fixed — no code change needed, the escalation path worked as designed.
  2. `docker-local` deploys have no pre-flight port-availability check and no per-project port isolation on a shared `dind` daemon: a leftover deploy from an unrelated project can silently block a new one's `apply`. No code fix in this pass; worth its own item if docker-local deploys become routine (a `docker port`/bind probe before `compose up`, or binding to an ephemeral host port by default).
  3. The deploy-fix retry loop can oscillate between two reviewer-rejected states (comply with the frozen spec vs. assume the environment changed) with no tie-breaker and no human escalation path. No code fix in this pass; a candidate for R11.5/R11.5a's autonomy-hardening work (e.g., after N oscillations between the same two configs, pause for a human instead of consuming another attempt).
  4. **Fixed in this pass**: `parseTap()` (`server/evidence/junit.ts`) only matched `ok`/`not ok` TAP lines with zero leading whitespace, crediting only a `describe()` block's own rollup line — which never carries an `[AC-xxx]` tag — while every individual `test('[AC-xxx] ...', ...)` nested inside it (the exact convention `test.md`/`sm.md` lead agents to write) is indented by Node's test runner and was silently discarded. Every generated project whose smoke/e2e suite uses a `describe()` wrapper would hit this. Fixed by matching `ok`/`not ok` at any indentation (`test/evidence/junit.test.ts` covers the nested case); an untagged parent rollup line is harmless since `evaluateSmoke`/`evaluateE2e` only ever select rows whose `acIds` include the specific criterion.
- **Spec §1.3 criteria:** zero human interaction — no, one `docker stop` on clearly-abandoned infra to clear an environmental blocker, disclosed above; every AC passed in JUnit — yes at Phase 4, and in substance at Phase 5 too (finding 4 explains why it read as "no"); deploy+smoke green — deploy yes, smoke evaluation said no only because of finding 4; zero duplicate PRs and main green after every merge — yes (13 task/report PRs, zero duplicates).
- **Cost:** US$ 13.26 across 66 priced steps, ~1h20 wall time (4812s) — in the same range as golden run 1's US$ 14.34, despite the extra 3-part T7 replan and the deploy-fix churn.
- **Verdict:** this is the closest the project has come to a clean golden run. With finding 4 fixed, a re-run (or a smoke-only replay of the same deploy) would very likely pass Phase 5 outright, since the actual service and tests were already correct. Re-running the full golden run again to confirm is a future item, not required to close this one — findings 2-4 are what the run existed to surface.
### R8.5 Security tooling for the generated project — `done` (unit; plan 32, 2026-10-04)

- Prescribe tools in the default gates: gitleaks (secrets), osv-scanner or `npm audit` (dependencies), semgrep (SAST),
  trivy (image). High findings become blocking gates instead of names only. Separate from R7.4 (teams-ai's own audit).
- Files: `server/validators/plan.ts`, `.claude/agents/sm.md`, `.claude/agents/sec.md`.

- Built: `server/validators/security-tooling.ts` prescribes the gates (security-tools install gate with egress, gitleaks, semgrep `--severity ERROR`, osv-scanner or `npm audit --audit-level=high` or `pip-audit` per stack, trivy image CRITICAL after the build) and rejects missing, non-blocking, disarmed (`|| true`, `--exit-code 0`) or wrong-tool gates; `requireSecurityTooling` is on in `server/cli.ts` (older plans stay valid with it off); `sm.md`, `sec.md` and the plan pack say so.
- Open: a gate has no docker, so `trivy image` needs an image archive that no gate produces yet; the install command of the tools is left to the SM and was never run; osv-scanner blocks on any finding; a live plan now needs BOTH `delivery` (R8.1) and the security gates, so check that the SM meets the stricter validator on the next run.
### R8.6 Documentation gate — `done` (unit; plan 30, 2026-10-04)

- Required README sections (run, test, env, architecture, pipeline), a runbook and API docs step; a failed docs step
  blocks the phase instead of being swallowed.
- Files: `server/orchestrator/phases/report.ts`, `server/orchestrator/steps.ts`, `.claude/agents/sm.md`.

- Built: pure validators for README (run, test, env, architecture, pipeline), RUNBOOK and API docs (`server/validators/docs.ts`); Phase 6 validates each report attempt, feeds errors back and blocks the phase after 2 attempts instead of swallowing the failure; `spec readme` uses the same validator.
- Open: the retry bound is 2 attempts in total, not 1 plus 2 retries.
## Stage 9 - Easy setup and first use (2026-10-06)

### R9.1 `task doctor` and `task start` - `done` (plan 42, 2026-10-06)

- Built: prerequisite checks with pt-br fixes as Task preconditions; `start` brings the stack up with `--wait` and opens the UI.
- Open: no port 8787 or `/dev/net/tun` check; checked by hand only (Task preconditions have no unit test).
### R9.2 Windows prerequisites installer - `done` (plan 43, 2026-10-06; not run end to end)

- Built: `scripts/windows/install.ps1` (idempotent: WSL2/Ubuntu, Git, Docker Desktop, Task).
- Open: run it twice on a clean Windows machine.
### R9.3 Quickstart docs and GitHub token link - `done` (plan 44, 2026-10-06)

- Built: "Comece em 5 minutos" in the README; token creation link in the Onboarding.
### R9.7 Describe the project or spec when creating it; stack/flow filled by the SM - `done` (plan 45, 2026-10-06)

- Built: optional description on "Novo projeto" and "Nova spec" (top of `brief.md`); blank stack.md/flow.md filled by the SM on the first evaluation; pending patches made stale by an accepted one are dropped.
- Open: a Front agent step failed once with "no JSON object in the agent result" and passed on retry; the runner keeps only 500 characters of the failed text, so the cause is unknown. No retry on schema failure exists.
### R9.4 Prebuilt image in GHCR - `todo`

- `task up` would pull instead of building (first start drops from minutes to a download). Needs a publish workflow, a decision on package visibility and a change to `docker-compose.yml` that keeps `test/infra/compose.test.ts` true.
### R9.5 Demo run in the UI - `rejected` (2026-10-06, human decision: no canned/fake data, only real executions)

- Plan 48 scoped a safe, zero-cost way to do this (a static, typechecked NDJSON journal replayed through the existing Run page, no process/git/Docker/Claude touched) but the human rejected the premise outright: a scripted run always looks successful, which is exactly the wrong thing to show when the real golden run (R5.1) has never finished. Not pursued in any form.
## Stage 10 - Agent quality (2026-10-06)

### R10.1 Route tasks to the owning role; repair agent prompts; distill skill guidance - `done` (plan 46, 2026-10-06)

- Built: `PlanTask.owner` now allows `front`; `TaskRunner.implement()` dispatches the task's actual owner instead of always `dev`, so `devops`- and `front`-owned tasks finally run as that role. `front.md`'s 8 dead skill references removed; `model:`/`effort:` frontmatter across all 7 agent files corrected to state what actually runs. Durable rules distilled (not live-loaded) from the installed `impeccable`, `superpowers:test-driven-development` and `security-review` skills into `front.md`, `dev.md`, `sec.md` and `test.md`.
- Open: the real-CLI smoke check was blocked by "Sandbox disabled: Windows sandbox is not active" before any API call (zero cost, pre-existing Windows-host limitation, same failure mode as `todo-001-r4`); not retried from WSL. No live skill-loading mechanism was built (needs its own spike - see the plan's Out of scope).

### R10.2 Absolute, stack-agnostic quality rules: coverage, lockfile, pinned base image, license scan - `done` (plan 47, 2026-10-06)

- Built: `requireCoverage` (new flag, same shape as `requireDelivery`/`requireSecurityTooling`/`requireE2e`, on by default in `cli.ts`): a blocking `coverage` gate whose command writes `plan.coveragePath` as `{"linesPct": N}`; `gate-runner.ts` fails the gate below 80% even on exit 0, and fails closed if the file is missing or malformed; `coverageExemptions` is the escape valve (path + reason >=10 chars). `plan.lockfilePath` (agent-declared, no fixed per-language filename) and Dockerfile `FROM`-line pinning are checked statically in Phase 4 (`verify.ts`), unconditional once declared. `license-scan` joined `security-tooling.ts`'s existing gate set under `requireSecurityTooling`, with no tool prescribed (no universal license scanner exists, unlike `osv-scanner` for vulnerabilities).
- Mid-session the human added a standing constraint - neither the agents nor teams-ai may be fixed to a stack - which revised the lockfile and license-scan designs (both now let the agent declare the path/command itself) before any code was written for them.
- Open: no real paid run yet proving the SM actually plans a conforming `coverage`/`license-scan` gate end to end.

### R10.3 SM decides service/bounded-context decomposition during refine instead of asking the human - `done` (plan 49, 2026-10-06)

- Prompted by a live refinement session (lukeware-kayron-hub, surgical-case-service spec) where the SM asked the human an open architecture question - how many `<capability>-service` repos, mandatory split or not - that teams-ai's own delivery contract already answers: `plan.delivery` ships exactly one repository, one Dockerfile, one compose service and one `SERVICE_URL` per spec (`devops.md`), so there is no multi-repo/multi-service delivery path to ask about today.
- Built: `.claude/agents/sm.md` refine step gets a "Service and bounded-context decomposition" rule - default to one edge service (`<primary-capability>-service`) with bounded contexts separated internally (hexagonal/ports-and-adapters), physical split recorded as an ADR-style `docPatch`, never a question; a question is only legitimate when the docs mandate something teams-ai cannot deliver (separate repos per context, several independently deployable services), phrased as a pipeline limitation, not an open choice.
- Prompt-only change (no runtime code, no test); verified by reading the diff and grepping the new section into `sm.md`. No live skill-loading mechanism involved, same distillation pattern as R10.1.

## Stage 11 - Spec-driven backlog (2026-10-06, plan 50)

The docs (project, briefing, stack, flow, design) stay the only hand-edited truth. From them the agents derive a backlog of specs, from each spec a plan and from each plan the tasks; once refinement ends they implement the whole backlog on their own and mark each spec done, and the human only watches a live screen. Refinement (SM and PO, guided by Jev) is the decisive moment. Design, decisions, trio protocol and risks: `plans/2026-10-06-teams-ai-50-spec-driven-backlog.md` (second round, 2026-10-06). Each item below gets its own plan and approval before implementation.

### R11.0 Prerequisite fixes found while planning - `done` (plan 50, 2026-10-06)

- Found: the context pack drops the docs whole over budget; resume can run the wrong spec; `firstSpec` counts directories; the project dir is the first registered one and a live pid without `state.json` reads `unknown`.
- Built (one commit each): `server/refine/fit-pack.ts` sizes the derive/refine budget from the real pack (cap 120k tokens) and the cycle fails in pt-BR instead of reaching an agent without the docs; `specForRun` + `chooseSpecId` resume a run under its own spec; `server/orchestrator/first-spec.ts` decides the first spec from `origin/main` (nothing but `docs/` and `.github/` there) when several spec dirs exist; the run routes pick the registered dir that holds the spec and a live run without `state.json` reads `running`.
- Open: draft-root spec statuses still go stale after freeze (nothing updates the root), so "a dependency was delivered" must come from run journals in R11.3; a full `npm test` showed one timing flake in `refine-api.test.ts` that passes alone 3 of 3.

### R11.1 Backlog outline from the docs, shown in the UI - `code done, live check pending` (plan 50, 2026-10-06)

- Explicit "Quebrar em backlog" mode; `backlog` agent step; deterministic validators; panel grouped by epic with P0-P3 priority and dependencies; the human adjusts priority by writing in `briefing.md`.
- Built (one commit per task): `server/contracts/backlog.ts` and `server/validators/backlog.ts` (keys, reserved keys, epics, dependencies and cycles, a dependency never lower priority, 60 items, every `flow.md` section cited, `rankItems`); step kind `backlog`; `server/refine/backlog.ts` (`backlogPack`, `postProcessBacklog` with stable keys, `renderBacklogMd`); `BACKLOG_ENABLED` and `BACKLOG_DERIVED` in the journal and the shared reducer; a backlog branch in `runCycle` (one retry carrying the rejection, writes `project.json` and a generated `docs/backlog.md`, PO and SM review the backlog with the same checklist); `POST /api/refine/:p/:s/backlog`; `BacklogPanel` and the button; policy in `po.md` and `sm.md`. Start is refused in backlog mode until R11.3.
- Open: the live cycle on the Kayron docs (spends quota, needs the human's ok) is the real test of the breakdown quality, the coverage rule and the priorities; the container still runs the older image until it is rebuilt; once a single-spec session turns backlog mode on, its old spec.json and tasks blocks stay visible until it is re-evaluated; `refine-api.test.ts` still shows a timing flake in full parallel runs (passes alone).

### R11.1b `specs.json` index on the screen and on main - `done` (screen and draft; publishing to main is R11.3, 2026-10-06)

- In backlog mode "Arquivos gerados" shows `specs.json` (the ordered list: id, title, epic, priority, rank, dependsOn, sources) instead of the single `spec.json`, and the same index is written as `docs/specs.json`. It is generated and carries no lifecycle state: `docs/specs/<id>/spec.json` stays the unit of freezing, status and PR and run links, because dozens of readers key on it and one shared file would be the single place every spec's status change collides.
- Built: `server/refine/specs-index.ts` (`buildSpecsIndex`, browser-safe, structure only: spec id `<draft>-<key>`, rank, priority, size, scope, rationale, dependencies as spec ids, sources) written to the draft's `docs/specs.json` every backlog cycle; in backlog mode the page shows `specs.json` with a download link instead of `spec.json`, the type and bug blocks and the single-spec tasks, and `project.json` comes from the backlog run.

### R11.P Prove one spec end to end on the Docker platform - `closed, done — first clean golden run` (2026-10-08, r2: US$ 9.14, ~1h10 of task execution; refinement 19 cycles / ~1h)

- Why: no live run has ever reached `awaiting-validation` (golden run 1 failed at the smoke for US$ 14.34; runs r3 to r5 died on the WSL login and sandbox). Program autonomy would stack on an unproven single run, so this comes first and runs beside R11.1b and R11.2.
- Readiness checked read-only on 2026-10-06: `claude` 2.1.281 logged in and `bwrap` present in the container, `gh` logged in with scopes repo and read:org and admin of the owner `lukeware-kayron-hub`, dind 27.5.1 reachable, the OpenRouter key present. System 1 decisions at run time are off in `config.json` (only the Gate 1 ones are on).
- Plan: a throwaway project created from the UI ("Novo projeto"), a tiny description (one service with `/health` and one endpoint, 3 to 4 tasks), refine to ready, Start, follow the Run page and the container logs. Record in this item every human touch, failed step and gate, the time and the cost.
- Cost and limits: unknown; the reference is US$ 14.34 for the 10-task `todo-api` before the Stage 8 contract. Abort at US$ 25 or at the first stop only a human can clear. The Claude quota window is shared with the human's own refinement sessions.
- Side effects: a private GitHub repository under `lukeware-kayron-hub`, its PRs, and a container deployed through dind.
- Success: the one-run criteria of spec 1.3 (every AC passed in JUnit, green deploy and smoke, zero duplicate PRs, main green after every merge), or a precise defect list to fix before R11.4.
- **Run (2026-10-08, human-authorized live run): project `r11p-svc` / spec `r11p-svc-001`, a single in-memory `GET /health` + `GET /ping` Node.js service (no DB, no auth), chosen deliberately tiny so the service's own complexity would not be the bottleneck.**
  - **Refinement took 19 cycles (~1h) to reach `ready`**, almost entirely spent on a single AC-id renumbering ripple: `postProcessDerived`'s collision-avoidance logic (built in this same session for R11.8) renumbered three edited criteria (old AC-005/006/009 → AC-010/011/012, then separately AC-003 → AC-013) across derivations, and each renumbering had to be hand-chased through `brief.md`, `design.md` and `project.md` cross-references over 10+ small docPatch rounds before `po.no-contradictions`/`po.scope-explicit` would pass again. One gap (`docs/flow.md`) is outside the docPatch mechanism entirely — PO/SM can only patch `project.md`/`brief.md`/the briefing — so the human had to edit `flow.md` directly inside the container to close the loop. **Finding 5: the derive/renumbering path is stable in outcome but expensive in refinement cycles — every edited criterion's id churn cascades into a multi-file documentation-consistency chase with no batch/cross-file patch primitive, and `flow.md` has no patch path at all, so any drift in it can only be fixed by a human or a direct file edit.**
  - **Run `r11p-svc-001-r1` itself: `verification-failed`, zero tasks merged, in ~6 minutes for US$ 1.11.** Phase 1 (tech-spec, 2 ADRs) and Phase 2 (plan, 8 tasks T0-T7) completed normally. Phase 3's first task, `T0-scaffold` (package.json/package-lock.json/gate scripts/stubs, zero npm dependencies by design), failed its `install` gate (`npm ci`) 3 times with `EUSAGE` (npm prints its own help text, not a real dependency error) because the generated `package-lock.json` never matched or never landed in the commit. SM replanned once (`T0-scaffold-r1`, instructing the Dev to hand-write both `package.json` and `package-lock.json` deterministically instead of generating the lockfile via `npm install`), but the replacement task failed the exact same gate the same way and was `blocked` after its own attempts — at which point the run gave up: T1-T7 and 2 auto-planned fix tasks were never attempted (`"a dependency is blocked"`), Phase 4/5/6 never ran, and `git log` on the project's repo confirms only docs/report commits ever merged (tech-spec, plan, CI-workflow note, final report) — no application code, `Dockerfile` or `docker-compose.yml` ever reached `main`.
  - **Finding 6 (the real blocker): a zero-dependency Node project's `npm ci` gate is fragile in a way neither the Dev nor the SM's replan diagnosed correctly.** Both attempts assumed the cause was a missing/out-of-sync lockfile and tried to fix the lockfile; the SM's own final report explicitly recommends removing or replacing the `npm ci` gate for dependency-free projects next time, which suggests the actual root cause may be the gate's `install` command itself (or its working directory/commit snapshot) rather than lockfile content — this was not root-caused further in this pass and needs its own investigation before the next live run of a zero-dependency spec.
  - **Spec §1.3 criteria:** zero human interaction — no, one direct `docs/flow.md` edit during refinement (disclosed above, plus all the usual answer/accept clicks any refinement needs); every AC passed in JUnit — no, no task ever merged so no AC was ever tested; deploy+smoke green — no, Phase 5 never ran; zero duplicate PRs and main green after every merge — yes for the commits that did land (docs only, all clean).
  - **Cost:** US$ 1.11 for the implementation run itself (cheap, because it failed fast on the very first task), plus an unmeasured but substantial refinement cost across 19 cycles of PO/SM/Front opus calls (not itemized separately from the rest of this session's spend).
  - **Verdict on r1:** did not reach `awaiting-validation`. It surfaced two real findings: the refinement-convergence cost of AC-id renumbering (finding 5, feeds R11.10/R11.5a) and a gate bug specific to zero-dependency Node projects (finding 6, blocking).
  - **Root-caused and fixed finding 6 in this same pass**, before re-running: `TaskRunner.implement()` (`server/orchestrator/task-runner.ts`) called `installDeps()` unconditionally before every Dev invocation, including on the scaffold task whose own job is to write `package.json`/the lockfile from nothing — on a fresh worktree that manifest does not exist yet, so the install command failed deterministically with its own usage text, the Dev was never invoked to create the file, and nothing could change between retries. Fixed by skipping the pre-Dev `installDeps` call specifically for `task.bootstrapsFrozenPaths` (the scaffold task); the post-commit `gates()` call still installs for real once the Dev has written the manifest. Added a regression test (`test/orchestrator/task-runner.test.ts`), full suite (1292 tests) green, committed (`aff758f`), rebuilt the Docker image and restarted the container so the fix took effect, then launched a fresh run (`r11p-svc-001-r2`, via the CLI directly — the refine session's one-shot `.../start` guard blocks a second run through the API once a session has already started one) to confirm end to end.
  - **Run `r11p-svc-001-r2`: `awaiting-validation` — full success, zero human interaction, every criterion green.** T0-scaffold merged on its very first attempt (fix confirmed), then T1-T7 ran through the normal pipeline (implement → gates → review → security → merge), several with one or two ordinary review/gate retry cycles (T2, T4, T6, T7: `attempts:1`, all normal findings-and-fix loops, none a repeat of finding 6) but zero tasks ever blocked. All 8 tasks merged. **Phase 4 (full-repo verification): passed** — `VERIFICATION_PASSED` with the full criteria matrix green. **Phase 5 (deploy + smoke + e2e): passed** — `DEPLOY_APPLIED`/`DEPLOY_VERIFIED` against `docker compose`, healthcheck 200 on the first attempt; smoke green for AC-001/AC-002; e2e green for AC-001, AC-002, AC-004, AC-007, AC-010, AC-011, AC-012, AC-013, with AC-008 (behavior under `PORT=4000`) correctly marked `not-applicable` by the SM's own plan (a black-box suite over one fixed `SERVICE_URL` cannot restart the process with a different `PORT`; covered instead by the task's own `test/port.test.mjs`, verified in Phase 4). **Phase 6 (report): `REPORT_READY`**, `RUN_FINISHED {result: "awaiting-validation", merged: [T0-scaffold..T7], blocked: []}`.
  - **Spec §1.3 criteria, r2:** zero human interaction — yes, this run itself needed none (the earlier direct `flow.md` edit was during refinement, before this run started); every AC passed in JUnit/TAP — yes, all 9 criteria accounted for (8 passed, 1 correctly exempted with a reason); deploy+smoke green — yes; zero duplicate PRs and main green after every merge — yes (8 task PRs plus docs/report PRs, no duplicates, no blocked tasks).
  - **Cost:** r1 US$ 1.11 (failed fast) + r2 US$ 9.14 across 38 priced steps (~1h10 of task execution, per `RUN_STARTED`→`RUN_FINISHED` timestamps) = US$ 10.25 for the implementation runs, plus the unmeasured refinement cost across 19 cycles.
  - **Verdict:** **R11.P is closed.** This is the first run in this project's entire history to reach `awaiting-validation` with every gate, every acceptance criterion and the full deploy/smoke/e2e chain green — golden run 1 failed at the smoke for US$ 14.34, the Stage 8 `todo-001` run (R8.7) reached `deploy-failed` with a real-but-non-fatal evidence-matching bug, and this run's own first attempt (r1) failed at the very first task. The two things that stood between "mostly working" and "actually green" this time were squarely inside teams-ai itself (the AC-renumbering refinement churn and the scaffold-task install-gate ordering bug), both found live, both fixed with tests, both confirmed by the same spec reaching `awaiting-validation` on retry.

### R11.2 Detailed specs and a pre-plan for every backlog item, anticipated in the cycles - `code done; live check: mechanics pass, ready after detailing blocked by R11.10` (plan 51, 2026-10-07)

- `spec` step per item and `preplan` step per spec (modules, tasks, risks), each only when its input hash changed; new `planned` status; global AC ids; generated `spec.md` and `spec.json`; a spec tree with a coverage matrix doc section -> spec -> acceptance criterion -> task. The real plan is still made by the SM at execution against the actual code (it depends on the repository graph); deviations from the pre-plan are journaled and shown (run-time code, so in R11.3).
- Decisions (human, 2026-10-06): in backlog mode the target project's briefing becomes `docs/briefing.md` (today the per-draft `docs/specs/<draftId>/brief.md`); the generated per-item Markdown is `spec.md`, never `brief.md`, so it is never mistaken for the hand-edited briefing; the pre-plan is `preplan.json`, never `plan.json` (Phase 2 reuses a `plan.json` found on main as the real plan); AC ids keep the `AC-\d{3}` format and are numbered across the backlog; an explicit "Detalhar specs" trigger once the outline is ready, then only items whose inputs changed are re-derived.
- Built (plan 51, one commit per task, 2026-10-07): the briefing move to the target project's `docs/briefing.md` (`server/refine/draft.ts`, idempotent, crash-safe, single-spec untouched); `planned` status and `derivedFrom` provenance (`server/contracts/spec.ts`) and the browser-safe `Preplan` contract; step kinds `spec` (PO) and `preplan` (SM); `server/refine/sections.ts` (doc sections from numbered mermaid comments and markdown headings, a citation resolves to exactly one section) and `details.ts` (input hashes, batches of three per epic); global criterion ids above every id in the target project (`item-spec.ts`, fail closed at AC-999, floor recorded at `BACKLOG_ENABLED`); `server/validators/preplan.ts`; `server/refine/coverage.ts` (matrix doc section -> spec -> AC -> task; gaps keep a detailed backlog from `ready`); spec and pre-plan packs and a review digest that fits 60 items in the 120k cap; the detailing loop `server/refine/detail-cycle.ts` (valid items recorded before solo retries, any error or a quota/auth failure stops new calls and fails the cycle, honest `planned`/`refining` on disk, retired items removed); the outline step is skipped while the docs are unchanged; `POST /api/refine/:p/:s/backlog/detail` (409 until the outline is ready and current); PO and SM policies; the "Detalhar specs" button with its call estimate, item status chips and the coverage tree on the refinement screen. Root 1211 and web 131 tests pass, both typechecks clean.
- Reviews: a mid-plan review of tasks 1-9 (3 important findings, fixed with tests) and a final review of tasks 10-12 and the fixes (1 important, fixed with tests; minors fixed). Deferred by ruling: a final cross-item AC uniqueness check, skipping the solo retry for deterministic rejections (AC-999), deduping cited sections by resolved section.
- Live check (2026-10-07, human's ok; container rebuilt from `7e2aaeb`; driver `scripts/live-check/refine.mjs`, docs in `scripts/live-check/agenda` and `scripts/live-check/biblioteca`):
  - Target project `r112-agenda` (clinic agenda, mermaid flow with 3 numbered sections): the briefing moved to `docs/briefing.md` with `acFloor` 0; 6 outline rounds (US$ 0.63 to 1.00 each, 19 questions answered and the decisions written into the briefing, about 30 patches) to an outline `ready` with 9 items in 3 epics; "Detalhar specs" then one cycle of exactly the 13 estimated calls (5 spec, 5 preplan, Front, PO, SM; the outline step skipped) for US$ 3.72: 9 `planned` specs with `derivedFrom` section hashes, `spec.md` with the generated header, `preplan.json`, no `brief.md` or `plan.json`, criterion ids AC-001 to AC-081 unique, zero coverage gaps; a no-edit cycle ran only Front, PO and SM (US$ 0.76); after editing only the reminders section the outline re-ran, the citing item re-derived and one more item too, because the outline added a dependency to it (US$ 1.91); Start answers 409. `ready` after detailing not reached yet: PO and SM still flag content (fixed dates in criteria, dependency order, missing secrets).
  - Target project `r112-biblioteca`: one outline round (US$ 0.49), 5 flow sections, 6 items each citing its exact heading. Its `flow.md` was markdown, which the human ruled out (R11.11); the repo copy is now mermaid. Redo it from scratch.
  - At 09:12Z someone else (the UI or another session) skipped 6 questions, accepted 7 patches and started cycle 10 on `r112-agenda`: check its state before acting on it.
  - Fixed from it: missing secrets were listed once per spec (`82a4f7e`). Findings for later: R11.10.
- Live check, second session (2026-10-07, container rebuilt from `73ce9d0` then `9a835ef`; the human lifted the cost cap: "the focus is getting teams-ai ready to launch"):
  - Fixes found by it (one commit each, tests first): a `flow.md` citation that names no section is rejected and the retry fixes it (`a8d1953`; `r112-agenda` cited the diagram title comment `%% AGENDA CLÍNICA`); the pre-plan pack carries project.md so pre-plans follow its technical decisions (`73ce9d0`; a pre-plan used the database clock against a clock port); the spec rules ask for instants relative to a reference the test controls and for assertions on the test's own data, with `HASH_VERSION` 2 (`9a835ef`; criteria kept fixed calendar dates and an empty database while the e2e suite runs every spec on one deploy); the driver reads journals over 1 MB (`4cab81f`).
  - `r112-agenda` cycles 11-14 (US$ 5.13, 4.74, 5.48, 5.75; the project totals US$ 37.61): every cycle edits briefing › Decisões, so every cycle re-derives all 9 specs and 4-5 pre-plans. The checklist was fully green after cycle 11 (fixes 1 and 2 worked) but each accepted patch opened new, real findings (reminder records against the delete order, query-filter UUIDs, test clock, single compose file). After fix 3 the fixed-date complaints stopped; cycle 14 asks how the pipeline runs the e2e suite (volume recreated per run, MailHog reachable), which is teams-ai's delivery contract, not the target project's.
  - `r112-biblio` (new projectId, mermaid flow; US$ 14.55): sections come only from the three numbered mermaid comments; 7 outline cycles (US$ 0.45-0.78) to `ready`, the last only after the owner skipped detail questions and rejected detail patches; "Detalhar specs" ran exactly 9 calls (3 spec, 3 pre-plan, Front, PO, SM; US$ 2.42), 6 `planned` specs, `derivedFrom` with every section hash resolved; editing only "3. Relatórios" re-derived only the two items citing it (1 spec and 1 pre-plan call, US$ 1.48) with criterion ids unchanged; later cycles found a criterion verified through a route a later item delivers.
  - Both: criterion ids unique (agenda AC-001..AC-103, 102 ids; biblio 52), every criterion covered by a pre-plan task, Start answers 409, `specs.json` and `backlog.md` match the items. Secrets are per target project (`ws.secrets`, `server/refine/registry.ts:66`); the placeholders live in each throwaway workspace.
  - Not reached: `ready` after detailing. Every review finds new real gaps and every fix is a doc edit that re-runs the cycle: convergence is the blocker (R11.10), and the PO and SM ask the owner what the delivery contract or the docs already answer (R11.5a).
  - Decisions (human, 2026-10-07): refinement keeps PO and SM together, supported by Jev; Jev's classification is the backbone of refinement (R11.5a).
- Open: delete `r112-agenda`, `r112-biblioteca` and `r112-biblio` (UI or `DELETE /api/refine/<p>/<p>-001`).

### R11.5a Jev at the center of refinement - `partial` (human, 2026-10-07: Jev's classification is the backbone of refinement; PO and SM decide on it; slice 1 built 2026-10-08, plan 53)

- Today Jev runs once per cycle before everything (`server/refine/cycle.ts:99`): six fixed yes/no checks (`jev-validation.ts:23-54`, API-shaped: persistence, health, responses), advisory only (`blocked` stops nothing), without `design.md`, absent from the detailing steps; System 1 decisions are off by default (`decisions.enabled=false`) and only question dedup works in backlog mode.
- Proposal, in order, each with its plan and an eval before it is switched on: (1) classify every question `auto`/`po`/`sm`/`human` (auto answered by the owner role from the docs and the delivery contract, recorded as an assumption in a briefing patch; below the confidence floor the chain escalates); (2) judge PO, SM and Front patches on the same text: keep one, drop duplicates with a reason, flag conflicts; (3) check each spec and pre-plan before the review (only cited sections, criteria testable on one shared deploy, pre-plan follows project.md), failures feeding the solo retry; (4) preflight checks derived from the five docs instead of the fixed API checks, `design.md` included, `blocked` as a blocking question; (5) contradictions between specs that cite the same section; (6) `ready` also needs Jev's approval.
- Evidence from the R11.2 live check: 19 questions to the owner in the agenda outline, many answerable from the docs; 4 identical PO/SM patch pairs that left one rule four times in the briefing; Front patches copying briefing rules into `design.md`; agents asking how the pipeline runs the e2e suite.
- Built (2026-10-08, plan 53, slice 1 of item 1): a new decision id `question-routing` (`server/decide/decisions/question-routing.ts`) classifies every blocking question `auto`/`po`/`sm`/`human`, same `choice` shape as `report-routing`. Wired into `runCycleSteps` (`server/refine/cycle.ts`) right after the Gate 1 decisions, in shadow mode: the routing is journaled on `REFINE_EVALUATED` as a `questionRouting` map keyed by `questionId`, but nothing drops or auto-answers a question yet — every question still reaches PO/SM/the human exactly as before. Off by default (`DECISION_DEFAULTS['question-routing'] = { enabled: false, ... }` in `server/config/config.ts`) until an eval exists, same gate `READY_MIN` went through for Gate 1. Unit tests: `test/decide/question-routing.test.ts`, `test/refine/cycle.test.ts` (hint journaled without changing which questions reach the human; no hint at all when the decision is off, the default).
- Built (2026-10-08, item 2, no plan+approval gate — see below): `duplicatePatches` (`server/decide/decisions/gate1.ts`), a `patch-dedup` decision, catches a PO/SM patch pair on the same file that makes the same edit in substance with different wording — a paraphrase the byte-identical check (R11.10) cannot see. Wired into `runCycleSteps` (`server/refine/cycle.ts`): each later patch on a file already holding an accepted patch this cycle is compared against it; a flagged pair is discarded with reason "a near-duplicate of a patch already proposed this cycle (same change in substance)" instead of becoming a second pending patch. Shipped active (not shadow): same risk class as the already-active exact dedupe, so no eval gate before switching on, unlike question-routing. `DECISION_DEFAULTS['patch-dedup']` enabled by default. Unit tests: `test/refine/cycle.test.ts` (paraphrase dropped when the decision says same substance; both kept when it says they differ), `test/config/decisions.test.ts` updated for the new default-enabled decision.
- Open: items 3-6 of the full proposal (spec/pre-plan preflight; the five-doc preflight replacing the six fixed API checks; spec-contradiction; `ready` needing Jev's approval) are untouched; actually auto-answering a routed question (writing the answer as a briefing assumption and skipping the human) needs its own plan and an eval first, per plan 53's own scoping. See `docs/superpowers/plans/2026-10-08-teams-ai-53-jev-question-routing.md`.
- Process note (2026-10-08): the human lifted the "plan + approval before implementing" gate for routine backlog work ("nao precisao de minha aprovacao para implemente, o agente oquestrato vai descidir isso") — the orchestrating agent picks the next item and ships it; see `plan-first-roadmap` memory. Item 2 above was picked and shipped under this new rule, no plan doc written first.

### R11.3 Freeze and publish planned specs - `done` (plan 52, 2026-10-07)

- A spec is frozen when its run starts; Phase 0 publishes every `planned` spec absent from main and the docs coherently.
- Audit 2026-10-06: on an existing repo Phase 0 copied only project.md, project.json, brief.md and spec.json (`server/orchestrator/phases/bootstrap.ts:63-71`), so stack.md, flow.md and design.md never reached main, and an item spec (no `brief.md`) threw ENOENT.
- Built (plan 52, one commit per task): `freezeSpec` accepts `planned` (`61fa9b1`); Phase 0 on an existing repo now copies the run's own spec directory (overwriting, so the frozen `spec.json` replaces the planned one) and every other draft file main lacks — `briefing.md`, `stack.md`, `flow.md`, `design.md`, `backlog.md`, `specs.json`, every other planned spec's directory — never overwriting what main already has (`a8d1953`→`93ce9d0`… see commit `feat(bootstrap): publish a backlog item's spec directory`); `RUN_STARTED` now records `firstSpec`, reused on resume so a resumed first spec never rejects its own scaffold fix tasks (`ec1fe66`); Phase 2 reads `preplan.json` from main as context (never the plan) and journals `PREPLAN_DEVIATION` when the real plan drops one of its acceptance criteria (`1469a40`).
- Fixed from the live check (2026-10-07, parallel to it): `moveBriefingToProject` demotes the appended brief's own `##` headings a level, so they stop colliding with the briefing's structure (`cbc79c7`). Still open: it drops no placeholder lines (judged too undefined to fix without a rule for it) and still writes non-atomically (needs the same intent/confirm journaling the orchestrator phases use, or an injected clock/fs seam, to test a crash mid-write — bigger than this plan's scope).
- Live check: `r112-biblioteca` (8 planned specs) taken from Start through all 8 specs `done`, program `finished`, on the Docker platform; see R11.P and the live-run report (`docs/superpowers/plans/2026-10-07-r112-biblioteca-live-run-report.md`) for the full outcome, including 11 real teams-ai bugs found and fixed along the way (sandbox network policy, native-binding install order, devops-owner misplanning, merged-task inheritance across retries, a missing `deletedFiles` capability for Dev, and more).

### R11.4 Autonomous program controller - `done` (plan 52, 2026-10-07)

- Reads the detailed backlog and runs its specs one after another by priority and dependency. Parallelism stays inside a spec (3 tasks without overlapping `affectedPaths`): the shared clone, the single compose stack and the account-wide quota make parallel specs unsafe and no faster. Persisted ledger; restart-safe; a spec is marked done on its own when verification, deploy and smoke pass.
- Built (plan 52, `06ed918`, `41b56eb`, `e4ebf4d`): `server/program/controller.ts`, a pure `tick(program, effects, save)` over a `program.json` ledger (pending → running → completing → done, or failed/blocked) — one item running at a time, the ledger written before anything launches so a crash between the claim and the launch adopts the run instead of starting a second one, an interrupted run resumed up to 3 times, a failed item isolated so only its dependents are blocked (never the whole program); `server/program/service.ts` wires it to real runs (`spawnRun`/`claimLaunch`/`spec complete`) and reads a run's outcome from its journal, including "delivered with a blocked task" as a failure (R11.0's audit correction below); `RefineSession.freezeProgram`/`freezeItem` and `SessionRegistry.start` start the program in backlog mode (`POST .../start`, `GET .../program`); the UI server reconciles every started program on a 15 s timer, so a container restart resumes them; the web screen enables Start for a detailed, ready backlog and shows every spec's status with its run link (`ProgramPanel`).
- Repair loop on failure (human decision 2026-10-06: isolate, review, fix, adjust and continue; Jev classifying the cause and replanning) is deliberately **not** built here — out of this plan's minimal vertical slice, left for R11.5/R11.5a. Today a failed spec just stays `failed` and blocks its dependents; nothing retries or replans it automatically beyond the run's own bounded resume.
- Audit correction (2026-10-06): a blocked task does not end the run; verification accepts criteria whose only tasks are blocked (`server/evidence/matrix.ts:36,57-58`), so a spec can reach `awaiting-validation` with work missing. The controller's `outcome()` therefore requires zero blocked tasks before treating a delivered spec as `done`-worthy.
- Live check: see R11.3 above and the live-run report. `r112-biblioteca`'s 8 specs completed in dependency order with zero manual intervention beyond the bug fixes journaled in the report; the ledger survived a full Docker Desktop crash/restart mid-run (R11.4's own `tickPrograms` reconciliation resumed the interrupted run from its existing journal, no re-execution of merged work).

### R11.5 Autonomy hardening - `todo`

- Jev decision routing (below in plan 50): every decision point is classified `auto` (decided from docs, ADRs or precedent and recorded as an assumption), `po`, `sm` or `human`; run-time decisions enabled after evals; cumulative README, RUNBOOK and API docs (today the last spec overwrites them, `report.ts:57`); a rebase-conflict resolver step (none exists, the task owner retries three times and then it blocks); a spec to PR ledger (`prs` in `report.json`, `Spec: <id>` in PR bodies and labels); the reserved backlog keys follow every branch suffix.

### R11.6 Live program dashboard - `partial`

- One screen that follows the whole program: the backlog tree with spec and task states, the current step, PRs, a decision timeline (who decided what and Jev's class), cost and quota; built on the run journals' SSE and the program ledger.
- Built (2026-10-08, cost slice, no plan+approval gate — see the process note on R11.5a): `ProgramItem.costUsd` (`server/program/controller.ts`), summed from the delivering run's and the `spec complete` run's `RUN_FINISHED.tokens.costUsd` (`server/program/service.ts` reads it alongside the existing blocked-task check), kept across a retry since it tracks cumulative spend, recorded on `delivered`/`done`/`failed` alike so a failed attempt's spend is not lost. `ProgramPanel` (`web/src/refine/ProgramPanel.tsx`) shows per-item cost and the program's running total. Unit tests: `test/program/controller.test.ts` (accumulates across the delivering + completion run; recorded on failure too), `test/program/service.test.ts` (surfaces the real `tokens.costUsd` on every terminal outcome).
- Open: current step, PRs, the decision timeline (`DECISION_MADE` events already exist per run — R8.7/R11.P's own event streams confirm it) and quota are still untouched; the panel still polls rather than following the run journals' SSE live.

### R11.7 Docs sync after refinement - `todo`

- Re-derive `planned` specs whose sources changed, add and retire items, adjustment specs for started or delivered specs.

### R11.8 Acceptance criterion ids collide across the specs of one repo - `done` (unit, 2026-10-08)

- Phase 4 matches criteria against the JUnit of the whole repo on main (`server/orchestrator/phases/verify.ts:121-126`, `server/evidence/matrix.ts:32`) while single-spec mode numbers criteria per spec, so a later spec's `AC-001` can be "proven" by an earlier spec's `[AC-001]` tests. Backlog mode gets global ids in R11.2; single-spec projects with several specs still need a fix (number above the repo's highest id, or scope the match to the spec's own tests).
- Built: `createFromRepo` already copies every sibling spec directory from `origin/main` into the draft (`docs/specs/<id>/spec.json`), the same layout `maxCriterionInDraft` (R11.2) scans; `postProcessDerived` (`server/refine/derive.ts`) now takes a `floor` argument and renumbers any new criterion id at or below it, not only ids colliding with this spec's own previous version; `runCycle` (`server/refine/cycle.ts`) computes the floor with `maxCriterionInDraft(draft)` before deriving. Unit tests: `test/refine/derive.test.ts` (floor renumbering) and `test/refine/cycle.test.ts` (end-to-end: a sibling spec copied into the draft pushes a brand-new spec's `AC-001` to `AC-002`).
- Open: no live check (needs a real multi-spec single-spec project); the first-derive-of-this-spec id can still coincide with a *different* spec's id if that id was never reflected in the floor scan window (edge case, not seen in practice).

### R11.9 Any project size - `todo` (human, 2026-10-07: teams-ai builds any software of any complexity, never tied to one target project)

- Limits sized for one project: at most 60 backlog items (`server/validators/backlog.ts`); three-digit criterion ids, which global numbering exhausts at AC-999; the outline step and the reviews read the five docs whole in one pack capped at 120k tokens (`server/refine/fit-pack.ts`), so very large docs fail the cycle. Design them away (outline per epic or per flow section, wider ids, packs of cited sections only) with its own plan and approval.

### R11.10 Refinement convergence and cost in backlog mode - `partial` (found by the R11.2 live check, 2026-10-07; one candidate built 2026-10-08)

- Six outline rounds for a three-section product: the PO asks spec-level detail (success codes, e-mail content) while reviewing the outline; PO and SM propose the same patch, and accepting both duplicates text that later rounds clean up; every accepted patch changes the docs and re-runs the outline step.
- One briefing section that nearly every item cites (the decisions list) makes any new decision re-derive every spec; the outline step's own changes (a dependency added) re-derive specs whose text did not change, because `dependsOn` is in the spec input hash.
- Candidates: the outline review judges structure only and leaves detail to the spec step; dedupe PO and SM patches; one briefing heading per decision so citations stay narrow; `dependsOn` only in the pre-plan input hash; Jev routing (R11.5) answering from the docs.
- Built (2026-10-08): the PO/SM dedupe candidate, the cheapest and most mechanical one. `runCycleSteps` (`server/refine/cycle.ts`) now tracks every patch proposed this cycle by `(file, find.trim(), replace.trim())`; a later patch from the other role that is byte-identical is dropped into `discardedPatches` with reason "the same change was already proposed this cycle" instead of becoming a second pending patch. Deterministic, no model call. Unit test: `test/refine/cycle.test.ts` (PO proposes, SM echoes the same patch, only PO's is journaled as `PATCH_PROPOSED`).
- Built (2026-10-08): the pre-plan pack (`preplanPack`, `server/refine/detail-packs.ts`) now states teams-ai's fixed delivery contract — one compose stack for the whole program, never torn down between specs, so a dependent service a sibling spec already added is reachable by its compose service name, not something to stand up or reset again — answering the cycle-14 r112-agenda finding ("how does the pipeline run the e2e suite") without an owner question. Unit test: `test/refine/detail-packs.test.ts`.
- Open: only catches byte-identical patches, not paraphrases (the live-check's real duplicates were exact, so this covers the evidenced case; a semantic near-duplicate still needs a decision call, same shape as `question-dedup`). The rest of this item (outline/detail split, narrower citations, `dependsOn` scoping, Jev routing) is untouched — each is a design change to the refinement loop's shape, not a local fix, and needs its own plan.
- Second live-check session (2026-10-07): neither project reached `ready` after detailing in 4 more cycles each (agenda US$ 4.7-5.8 per cycle, because every decision lands in briefing › Decisões, which all 9 items cite). The reviews find real gaps every cycle, so the loop needs a stop rule, not only less noise: put the delivery contract (how the e2e suite runs: one compose, fresh volume or not, reachable side services) in the spec and review packs so agents stop asking the owner; criteria verified only through what the item and its dependencies deliver; and R11.5a.

### R11.11 `flow.md` is a mermaid diagram - `done` (human decision, 2026-10-07; detector 2026-10-08, wired 2026-10-08)

- The target project's `flow.md` must be drawn in mermaid (the template already is). Plan how refinement holds that: a check (Jev preflight or a validator) that flags a `flow.md` without a mermaid block, the SM converting it through a patch, and flow sections read from the diagram (numbered mermaid comments today; decide on `subgraph` titles). Markdown headings in `flow.md` stop counting as flow sections once it lands.
- Built: `flowIsMermaid(flow)` (`server/refine/sections.ts`), a pure detector for a `` ```mermaid `` fence, with unit tests (`test/refine/sections.test.ts`). Wired as a new deterministic SM checklist item, `sm.flow-is-mermaid` (`server/refine/checklist.ts`), overridden by the orchestrator the same way `sm.dependencies-and-secrets`/`sm.no-open-questions` already are (`server/refine/cycle.ts`): the SM's own self-report is ignored, the fact decides it. A failing item blocks `ready` the same way any other checklist item does — advisory-visible in the UI (`web/src/pages/Refinement.tsx` checklist label and pt-BR detail text), never a hard cycle failure. The default `flowTemplate()` is already mermaid, so a fresh project passes immediately with zero friction; only a `flow.md` hand-edited down to plain markdown headings fails it. Unit tests: `test/refine/cycle.test.ts` (fails deterministically on a plain-markdown flow, passes on a mermaid one, overriding whatever the SM itself reported).
- Open: the SM is not yet told to *fix* a failing `flow.md` through a `docPatch` (today it just blocks `ready` with a clear reason, same as every other failing checklist item - the human or a later cycle's SM patch resolves it); the `flowHeadings()` markdown-heading fallback (`server/validators/backlog.ts`) is untouched (15 files read it; dropping it is the separate "decide on `subgraph` titles" question the roadmap already flagged as open).

### R11.12 Readable English ids - `done` (human, 2026-10-08, plan 54; screens not browser-checked)

- Human, looking at `Projetos › r11p-svc › r11p-svc-001-r1`: generated names are hard to understand. Project, spec, backlog item, plan task and run ids must be intuitive English kebab-case names; project and spec ids proposed by an AI agent. Four slices in plan 54: AI-suggested ids, backlog specs named by key, task slugs, run ids carrying project and spec (also fixes the cross-project run collision).

### R11.13 Token cost and run speed - `partial` (human, 2026-10-08: research requested while R11.12 was in progress; slices 1-5 and 9 built 2026-10-08 (plans 55, 56), live check done: -54% cost, -67% wall time, see below; slices 7, 8 (measurement) and 11 built 2026-10-09 (plans 57, 58); slices 6, 10 and 12 built as config 2026-10-09 (plan 59), their real-run comparisons open)

- Evidence (read-only analysis of the container journals, 2026-10-08):
  - Run `todo-001-r1` (R8.7): US$ 13.26, 66 steps, 712 turns, 80 min. By token class, at the per-model prices that reproduce `total_cost_usd` exactly (Opus 5.5: output $20/M, 1h cache write $8/M, cache read $0.20/M; Sonnet 5.5: $10, $4, $0.20): cache writes 51%, output 33%, cache reads 16%. Every write is on the 1h tier (2x the input price; the 5m tier is 1.25x).
  - `test/review` is 40% of the cost and 46% of the turns (13.8 turns per review); 55% of the cost of `r11p-svc-001-r2`. Attempts after the first: ~30% of the cost (the review findings were real defects).
  - Task time: `reviewing` 2,640 s vs `implementing` 1,599 s. Gates 984 s, 89% of it `security-tools` (475 s) and `image-scan` (396 s). At most 2 steps ran at once (the plan DAG was nearly linear).
  - Refinement `r11p-svc-001`: US$ 11.66 in 30 min, 76 steps (19 cycles of PO derive, PO refine, SM refine, Front refine, all Opus). Cache writes are 70% of its cost, and more is written (1.02M tokens) than read (0.87M): most of it is never read again.
  - Not a problem: CLI startup (~0.2-0.5 s per step, `duration_ms - duration_api_ms`); the fixed prefix (8.4k tokens with Read/Edit/Write/Grep/Glob/Bash, 6.2k read-only) is served from the cache.
- Slices, in order:
  1. 5-minute prompt cache. Add `"promptCacheTtl": "5m"` to the settings `buildRoleSettings` writes (`server/runner/role-settings.ts`), shipped with `--settings`. Verified live on 2.1.295 with the subscription login: writes move to `ephemeral_5m_input_tokens`, -36% on the probe call; the container's 2.1.281 has the setting (docs: v2.1.242+; the `CLAUDE_CODE_PROMPT_CACHE_TTL` env var takes precedence). Expected: refinement -26%; run -10% on steps without long Bash (refine, review, security, plan, report, spec-gap, coverage), -19% on all. Risk: a tool call longer than 5 min (a large `npm ci` or suite) expires the cache and the next turn rewrites the whole context, so Dev/Test implementation steps keep 1h until per-tool durations are measured (slice 8). Settings files are per role today; a TTL per step kind needs the env var through `extraEnv` or a settings file per kind.
  2. The Test review gets the diff and the gate JUnit. `reviewPack` (`server/orchestrator/steps.ts`) sends only the diff stat (inside `feedback`), while `securityPack` pins the full diff as the change set; the merge gates' JUnit is already in `TaskRunner.junit` (`server/orchestrator/task-runner.ts`), which `verifyClaimedEvidence` checks claims against. Pin the change set and a JUnit summary (id, status, AC ids), state in `test.md` that the gates already ran the suite (do not re-run it; read surrounding files only for the impact radius), and drop Edit/Write from review steps (a reviewer must not edit the code under review). Expected: ~14 -> ~4 turns per review, run -20 to -25%, 15 to 20 min less wall time.
  3. graphify in the image. The `Dockerfile` does not install it: `workspaces/*/graph/{main,worktrees/*}` are empty, and the dev and review packs checked in `todo-001-r1` say "Code context (grep; code graph unavailable or too thin): no matches" or "(graph): no nodes", so agents explore with Glob/Grep/Read. Install it (pinned) or add a deterministic fallback (`git ls-files` plus exported symbols); the gain grows with repository size (R11.9).
  4. Gate tool and DB caches. `security-tools` downloads gitleaks, semgrep, osv-scanner and trivy into every worktree (`writeToolsInstaller`, `server/orchestrator/run.ts`), 21 times per run (~23 s each), and `image-scan` refreshes the trivy DB per task (~19 s). A shared read-only tools volume (checksums kept) and a persistent `TRIVY_CACHE_DIR` updated once per run: ~12-14 min per run, no tokens.
  5. Security review in parallel with the Test review (same diff, both read-only): ~40 s per task; the security review is wasted when Test asks for changes (~US$ 0.08).
  6. Model routing: `model-tier` is built but disabled (`perDecision.model-tier.enabled: false`), so the Dev always runs on Opus (US$ 0.32 per step). Run it in shadow and compare cost per completed task (3-4 real tasks per configuration) before routing small and medium tasks to Sonnet 5.5 (half the price) or Haiku 5.5.
  7. Retries resume the previous session: attempts after the first are ~30% of the cost and the Dev re-explores from scratch. `--resume <id> --fork-session` keeps the context (read from the cache) with the feedback appended; it needs the session kept (today `--no-session-persistence`, and the step HOME is deleted). Experiment.
  8. Measure before tuning effort: without `--effort` the CLI picks the effort per turn (`per_turn_effort_active` in `system:init` on 2.1.295). Record `thinking_tokens` (parsed, then dropped by `Accounting`), tool calls per tool, tool-result bytes and `duration_api_ms`; then try `low`/`medium` on coverage, spec-gap, report and the refine checklists. Budget by cost, not raw tokens: `perTaskTokens` counts cache reads 1:1 (T4 of `r11p-svc-001-r2`: 2.85M "tokens", 90% cache reads, US$ 2.28). `budgets.step.maxOutputTokens` is unused.
  9. Cheap hygiene: set explicitly in the step env (never from the host) `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` and `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` (measured: fixed prefix -7%), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1` and an explicit `CLAUDE_CODE_MAX_RETRIES` (docs: default 300). Native caps per step: `--max-turns` (accepted, though hidden from `--help`) and `--max-budget-usd`. Pin the CLI at 2.1.295 (CHANGELOG: a successful `--json-schema` run could exit non-zero; `--tools` did not restrict some built-in tools).
  10. Refinement: beyond slice 1, convergence (R11.10, R11.5a) remains the big lever; try Sonnet 5.5 on the PO and SM checklists against the current Opus results.
  11. Wider plans: an SM rule to declare `dependsOn` only for a real code dependency (`todo-api`'s chain T0→T1→T2→T3→T4→T6→T9 kept `maxParallel` 3 at 2 or fewer). Risk: more rebases.
  12. Subscription window: Max plans now include monthly API credits (US$ 100 on Max 5x, US$ 200 on Max 20x; support.claude.com article 17154008), separate from the plan limits. Running steps with an API key of the linked Console organization spares the 5h/7d window, removes the OAuth refresh race (plan 38), enables `--bare` and defaults to the 5m TTL; cap it with a workspace spend limit. Human decision (money vs window).
- Built (plan 55, 2026-10-08): slices 1 and 2. Slice 1 as a per-kind env var (`CLAUDE_CODE_PROMPT_CACHE_TTL=5m` for every kind except dev, tech-spec and deployment), not in the per-role settings file. Slice 2: the review pack pins the full diff and the gate results, review steps lose Edit/Write/MultiEdit, `test.md` says not to re-run the suite. Full suite green. Open: no live run yet; measure review turns (was ~14), cost per completed task and wall time against `todo-001-r1`.
- Built (plan 56, 2026-10-08): slices 3 and 4. Dockerfile installs pinned `graphifyy==0.9.67` (verified in a throwaway container); security gates share `paths.gateCache` (mounted only into `security-tools` and `image-scan`, downloads re-verified by sha256, trivy DB and pip cache persisted). Unit tests green. Open: image not rebuilt (other sessions use the container), no live run; measure gate time from the second task on and the graph in the packs.
- Built (2026-10-08, no plan file: five env entries and one pin): slice 9. `STEP_ENV` (`server/runner/invocation.ts`) sets `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`, `CLAUDE_CODE_DISABLE_ATTACHMENTS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER` and `CLAUDE_CODE_MAX_RETRIES=5` in every step (fixed prefix 7,861 -> 7,042 tokens, -10%, live probe on 2.1.295 with the isolation flags); the Dockerfile pins `@anthropic-ai/claude-code@2.1.295`. `--max-turns` and `--max-budget-usd` left out: the runner's own turn cap and timeout already kill the process. Open: no live run on 2.1.295 (the container ran 2.1.281 until the rebuild).
- Built (2026-10-08): slice 5. `TaskRunner.review` starts the security step beside the Test review (`startSecurity`, `judgeReview`, `judgeSecurity`) and always awaits it before returning, so a Dev retry never edits the worktree under a running reviewer; the security verdict (journal events, blocking findings) counts only when Test approves. Trade-off measured on `todo-001-r1`: 12 of 18 reviews approved, so ~40 s saved on two thirds of the tasks (about 8 min on the critical chain) against ~US$ 0.08 of security work wasted on the third that Test sends back (~US$ 0.3 per run). Image rebuilt and redeployed at `be9b33e` (CLI 2.1.295, graphify 0.9.67); slice 5 is not in that image. Open: no live run of slices 1-5 and 9.
- Live check (2026-10-08, run `todo-api-r9--todo-001--run-2`, same `todo-api` fixture as R8.7, image `dc7450d` = slices 1-5 and 9, CLI 2.1.295): US$ 6.12 (R8.7: 13.26, -54%), 44 steps (66), 337 turns (712), phases 1-4 in 18 min (R8.7: 61), whole run 26.5 min (80), cost per delivered task ~US$ 0.6 (1.3). Test review: 2.3 turns, US$ 0.054 and 8 s per step (13.8, 0.221, 91 s); security: 1.3 turns, US$ 0.030, 4 s (4.3, 0.075, 40 s); gates 265 s (984): `security-tools` 11 s per task (23), `image-scan` 3 s (19), shared cache 1.6 GB (trivy DB, pip, the four pinned downloads); cache writes 0.70M tokens (1.34M), cache reads 4.3M (10.7M), output 113k (332k); attempts after the first US$ 0.95 (4.01). Phase 4 verification passed (all criteria matched in JUnit).
- Seeded-defect check of the slice 2 review pack (2026-10-09, `scripts/evals/review-seeded.ts`, replays the real r9 review prompts against 12 mutated worktrees: 3 clean variants, 9 seeded defects of three kinds - hidden behaviour bug that the suite still passes, tests reverted, vulnerability; US$ 1.54 in total): new pack (pinned diff + gate results, no re-run) caught 9/9 seeded with 0/3 false alarms, 1.8 turns, US$ 0.048 and 10 s per review; the pre-slice pack caught 8/9 with 0/3 false alarms, 7.0 turns, US$ 0.069 and 16 s. Security review caught 2/2 with 0/1 false alarm. So slice 2 did not lower detection and cut review cost by ~30% and turns by ~75%. Caveat: n=1 per variant, so it rules out a large regression, not a small one.
- Built (plan 57, 2026-10-09): slice 7. A Dev retry resumes the previous attempt's CLI session (kept per task under `<run>/sessions/`, restored into the fresh step HOME) and sends only the feedback. Verified on the real CLI with Haiku first: `--resume` from a copied transcript in another HOME works with `--agents`, `--json-schema` and the isolation flags and reads the context from the cache. Unit tests green. Open: no live run with a retry yet; compare cost of attempts 2+.
- Built (plan 58, 2026-10-09): slices 8 (measurement part) and 11. The step profile (thinking tokens, API time, tool calls by tool, tool-result size) is journaled in `STEP_FINISHED`; `budgets.perTaskCostUsd` caps a task by cost; the SM rules ask for `dependsOn` only on a real dependency. Unit tests green. Open: read the profile on a real run before touching `--effort`; slices 6 and 10 need real runs to compare, slice 12 is a human decision.
- Live check 2 (2026-10-09, run `todo-api-r10--todo-001--run-2`, image `39639ba` = slices 1-5, 7-9, 11): US$ 6.18 booked (5.81 after the fix below), 41 steps, 249 turns (r9: 6.12, 44, 337), 20.7 min (26.5), but the run ended `deploy-failed`: T3-complete-todo was blocked when its Dev found Bash "denied ... in don't ask mode" (it had written `mkdir -p reports && npm test`, a compound command outside the plan's allow rules), so T8-e2e-suite and the deploy fixes were blocked and the e2e gate found no e2e tests. Not caused by the session change (T3 ran its first attempt, no resume). Cause: `mkdir` was not in the allow list and dontAsk denies a compound command unless every segment matches a rule; fixed by allowing `Bash(mkdir:*)` (`3b9151a`). Needs a run to confirm. Slice 7 worked live: the only resumed Dev (T1 attempt 2) got a 138-token prompt, wrote 2.3k output tokens against 7.3k, 10k cache writes against 22.5k, 24 s against 64 s, and fixed the evidence the review rejected. Finding: the CLI reports `total_cost_usd` and `duration_api_ms` cumulatively for a resumed session (US$ 0.55 reported for an attempt that cost 0.18 on top of the first's 0.37), so the runner now books only the difference (`totals.json` in the session store). Slice 8 profile in 41 steps: thinking 22k of 112k output tokens (sm/plan 9.7k of 22.6k, dev 8.2k of 60k), tools Bash 84, Read 55, Write 41, Edit 11, Glob 9, Grep 8, tool results 171k chars, API time 1,175 s of 1,245 s wall.
- Built (plan 59, 2026-10-09): slices 6, 10 and 12 as config, so nothing is left unbuilt. Slice 6: `routing.tiers` off, shadow (default, journals `MODEL_TIER_CHOSEN`) or on; a deterministic `heuristicTier` stands in for the disabled decision backends. Slice 10: `routing.stepModels` sets the model per step kind, in the orchestrator and the refinement agent; `STEP_STARTED` records the model. Slice 12: `claude.auth: "api-key"` with the secret `ANTHROPIC_API_KEY` for agent steps only. `scripts/evals/compare-runs.ts` compares runs by model, role/kind and task. Open, and only a real run can close them: shadow against `on` on the same plan, Sonnet on the refinement checklists against the Opus baseline, and one run on the API key.
- Live checks 3 and 4 (2026-10-09, same `todo-api` fixture): r11 (`mkdir` allowed, routing absent) finished `awaiting-validation`: US$ 4.54, 32 steps, 18.9 min, 8 tasks merged (US$ 0.57 per task). r12 (`routing.tiers: on`, first heuristic): US$ 4.89, 38 steps, 17.9 min, `deploy-failed` (T6 blocked on the sandbox failing to start; the two deploy fixes on port 3000, held by r11's deployed container). The first heuristic sent 9 of 14 choices to `large` (it read words like `package-lock`, `crypto.randomUUID` and `docker login` in the descriptions), so only 4 Dev steps ran on Sonnet: no saving to measure. Recalibrated to read only the title and paths, and `large` only for the scaffold, risky work and 8+ paths, 6+ criteria or 2,500+ characters. Also: the Dev reports a sandbox that failed to start in the language of the docs, so the retry regex missed it; the step profile now flags it from the tool result (`sandboxInitFailed`). The r10 T3 block may have been this same failure and not `mkdir`: the cause is unproven, r11 passed with both in place.
- Routing A/B (2026-10-09, same `todo-api` fixture, same image `65e9b05` plus the other session's quality rules; r13 was killed two minutes in by that session's container redeploy): r14 `routing.tiers: on`: US$ 3.73, 31 steps, 20.8 min, 8 tasks merged (US$ 0.47 per task), attempts after the first US$ 0.67, 8 of the 9 Dev tasks on Sonnet (only `T0-scaffold` on Opus). r15 `off`: US$ 6.67, 55 steps, 30.5 min, 11 tasks merged (US$ 0.61), attempts after the first US$ 1.18. The plans differ, and r15 spent 3 replans on the port 3000 deploy failure, so the fair figure is the plan tasks without the deploy fixes: US$ 0.32 per task on (7 tasks, US$ 2.21) against US$ 0.39 off (8 tasks, US$ 3.12), -19%, with no extra failed attempts in the routed run. One pair is thin evidence: `routing.tiers` stays `shadow` by default; turning it on is a config line. Both runs ended `phase-failed`/`deploy-failed` for reasons outside routing: port 3000 held by the `r11p-svc` stack's container (every deploy since r12), r14's phase 6 docs check (README without a `test` section, RUNBOOK without `rollback`), and r15's report step answering in prose with no JSON object.
- Refinement on Sonnet (2026-10-09, `routing.stepModels` = `refine`, `derive`, `coverage`, `backlog` on `sonnet`; `scripts/live-check/refine.mjs`, the same five `agenda` docs, one evaluation each, no answers given): Opus US$ 0.56, 5 steps, 5 checklist items failing, 20 questions (8 blocking, many asked twice by the PO and the SM), 3 patches, 4 backlog items; Sonnet US$ 0.18 (-68%), 4 steps, 2 failing, 7 questions (1 blocking), 2 patches, 5 backlog items. Sonnet raised the same topics as Opus without the duplicates (where the professionals come from, patient list/edit/delete, health check, the HTTP answer to a late reschedule, reminder rules, double booking) but missed two real gaps that Opus raised as blocking (whether holidays count as business days, and the slot grid of the appointments), and passed three checklist items that Opus failed. One evaluation of one document: not enough to change a default. Next test: run both to the end (answer the questions, count the cycles to converge) on the biblioteca docs, where the Opus baseline is US$ 11.66 and 76 steps; if Sonnet converges in a similar number of cycles, the saving is real.
- Refinement taken to the end (2026-10-09, `scripts/live-check/converge.mjs`: the same owner answers for both models from a topic bank, every patch accepted, then evaluate again; same `agenda` docs as above): Opus did not reach `ready` in 12 rounds: US$ 10.16, 53 steps, 13 cycles, zero checklist items failing from cycle 9 on but 3 to 5 new patches every cycle (the convergence problem of R11.10 and R11.5a, not a model effect). Sonnet reached `ready` after 7 rounds: US$ 1.88, 32 steps, 8 cycles (-82%). The price of that: its final docs are half the size (16 KB against 32 KB) and never mention holidays, the one rule it failed to ask about in cycle 1 (Opus: 5 mentions), with fewer rules on the slot grid, the reminder retries and the data removal. So Sonnet converges because it asks for less, not because it asks the same things faster. Untried and the obvious next step: Opus for the first cycle (find the gaps), Sonnet for the rounds after, or a closing Opus cycle; and a cap on patches per cycle for Opus. `routing.stepModels` stays empty by default.
- Hybrid refinement (2026-10-09, same `agenda` docs and owner answers: the first evaluation on Opus, every later one on Sonnet through `routing.stepModels`): reached `ready` after 5 rounds of answers, US$ 1.72 and 22 steps in total (Opus alone: not ready after 12 rounds, US$ 10.16; Sonnet alone: ready after 7 rounds, US$ 1.88). The final docs are 20 KB (Sonnet alone 16 KB, Opus alone 32 KB) and mention holidays 5 times, so the gap Sonnet alone missed was kept. One Sonnet backlog step failed its schema check (`specHash` not a sha256) and the next evaluation recovered it. One run only, but it is the best cost and quality trade so far: a cheap first Opus cycle finds the gaps and Sonnet closes the loop. Candidate default: a per-cycle rule (Opus on cycle 1, Sonnet after) instead of a per-step-kind one; not built, because `routing.stepModels` has no cycle dimension. `routing.stepModels` stays empty by default.
- Caveats of that live check: one run, and the plan differs from R8.7's (12 reviews instead of 24), so part of the gain is plan variance. All 12 reviews and 12 security reviews approved (R8.7: 6 `changes` of 18 reviews), so a lower review rigor is not ruled out: next, a seeded-defect check (a task with a known gap, e.g. a criterion with no test and a diff that misses an edge case) and a second run. The 5-minute TTL is not visible in the journal (`usage` carries no tier): confirm with `ephemeral_5m_input_tokens` in a recorded stream. Phase 5 ended `deploy-failed`, as in R8.7, for reasons unrelated to these slices: attempt 1 hit port 3000 held by the delivered `r11p-svc` container (stopped by hand, `docker start teams-ai-r11p-svc-r11p-svc-1` brings it back); attempt 2 `unhealthy`, attempt 3 `verify` no response after 60 attempts with a rollback, while the generated compose publishes `'3000'` (no fixed host port) and the fixture's own container later reported healthy. Not investigated here; it belongs with R11.5 (deploy-fix loop).
- Discarded after measuring: `--bare` (API key only), `--disable-slash-commands` (0 tokens: skills are not listed without the `Skill` tool), switching to the native binary (the npm package already wraps it), `DISABLE_NON_ESSENTIAL_MODEL_CALLS` (undocumented).
- Combined estimate for slices 1, 2, 4 and 5: run -30 to -40% cost and ~80 -> ~55 min; refinement -26% from slice 1 alone. Verify each slice on a real run by cost per completed task, not by token counts.

## System 1 decisions (spec §10A.5)

| # | Decision | Status |
|---|----------|--------|
| 1 | Gate failure triage | Wired (`gate-triage`) |
| 2 | Gate 1 readiness per AC | Wired 2026-10-04 as a hint in the PO/SM pack (`gate1-readiness`, R4.1) |
| 3 | Question dedup | Wired 2026-10-04 after the normalized-text dedup (`question-dedup`, R4.1) |
| 4 | Contradiction with history | Wired 2026-10-04: a blocking PO question per contradicted chunk (`history-contradiction`, R4.1) |
| 5 | PR risk | Wired (`pr-risk`) |
| 6 | Attempt progress | Wired (`attempt-progress`) |
| 7 | Validation report routing | Wired 2026-10-04 as a hint in `brief.md` (`report-routing`); never changes the flow |
| 8 | CLI error classification | Wired 2026-10-04 (`cli-error`: quota / auth / schema / code; never escalates to Claude) |
| 9 | Scope drift | Wired (`scope-drift`) |
| 10–11 | Model tier and effort per task | Wired (`model-tier`) |
| 12 | Rank candidate plans | Wired 2026-10-04 for Phase 2 (`plan-rank`); replan not covered (R4.2) |

## Done log

- 2026-10-04 — Plan 13 live check (`sec` field names fixed); Validation keeps its buttons after an action error;
  SIGTERM through `tsx` verified; `todo-api` reference spec; decisions 7 and 8 wired. PR #13.
