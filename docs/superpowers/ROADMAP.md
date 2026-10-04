# teams-ai — Roadmap and backlog

The single list of what is left until the POC is done. Plan history lives in `plans/README.md`; specs in `specs/`.

## Definition of done

The golden run criteria in spec §1.3 (`specs/2026-09-23-teams-ai-poc-design.md`):

- Three runs on the reference spec (`test/fixtures/todo-api`): 1 baseline (Claude only, decisions off),
  2 mixed (OmniRoute for Test/DevOps, decisions off), 3 full (OmniRoute + System 1 decisions on).
- Zero human interaction between Start and `awaiting-validation`.
- Every acceptance criterion `passed` in JUnit.
- Green deploy and smoke tests on both `docker-local` and `kind`.
- Zero duplicate PRs; `main` green after every merge.
- The three runs compared on tokens, retries, wall time, blocked tasks and escalation rate.

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

**R1.1** — Golden run 1 on `todo-api` (in progress).

## Pause log

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

### R1.1 Golden run 1 on `todo-api`, `docker-local` — `in progress`

- Plan: `TEAMS_AI_GH_OWNER=<owner> TEAMS_AI_FIXTURE=todo-api npx tsx scripts/integration/orchestrator.ts`
  on WSL, defaults (decisions off, OmniRoute off). Creates `<owner>/teams-ai-todo-api`. Expected cost: more than
  $3 (`hello-001-r1` on hello-app cost $3.33).
- Checks: reaches `awaiting-validation` with no human input; every AC `passed`; deploy and smoke green; no
  duplicate PRs; `main` green. Also confirms live the `sec` gate inside a run (plan 13) and the report step that
  failed in plan 12's live run.
- Started 2026-10-04 as run `todo-001-r1` (approved by the human).
- Outcome: _pending_.

### R1.2 Deploy the run 1 result to `kind` — `in progress`

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
- Progress: command, `Run.deployOnly()` and the no-fix-task option implemented with unit tests (734 passing,
  2026-10-04). Left: the e2e on kind, which needs the R1.1 result.

## Stage 2 — Browser checks (cheap, on the run 1 result)

### R2.1 "Report problem" from the Validation page (plan 12) — `todo`

- Reopens refinement with the report; with decisions on, `brief.md` shows the decision 7 hint.

### R2.2 Start, stop and resume a run from the browser (plan 10) — `todo`

- SIGTERM through `tsx` is already verified (2026-10-04); the orchestrator's `requestStop()` path under a real run is not.

### R2.3 Real logins on a logged-out host (plan 8) — `todo`

- `claude auth login`: URL line, paste prompt wording, time to `loggedIn`.
- `gh` device flow: only the fake CLI has exercised the auto-Enter behaviour.

## Stage 3 — Golden run 2

### R3.1 OmniRoute up on the host — `blocked` (human step)

- `scripts/wsl/omniroute`; `omniroute.enabled` for the run only.
- 2026-10-04: container `omniroute` 3.8.51 up and healthy on `http://localhost:20128` (`OMNIROUTE_VERSION=3.8.51
  bash scripts/wsl/omniroute/up.sh`; the script's old example tag 4.12.0 does not exist on Docker Hub and was fixed).
- Blocked on the human: open the dashboard, add a free provider (needs an account with that provider), pin a model,
  create an API key with compression disabled, and save it as `OMNIROUTE_TOKEN` in `~/.teams-ai/secrets`.

### R3.2 Golden run 2 on `todo-api` (OmniRoute for Test/DevOps, decisions off) — `todo`

## Stage 4 — System 1 ready for run 3

### R4.1 Decisions 2–4 (Gate 1 readiness, question dedup, contradiction) — `in progress` (unit done, e2e left)

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

### R4.2 Decision 12 (rank candidate plans) — `done` (unit); live check in R5.1

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

### R5.1 Golden run 3 on `todo-api` (decisions on) — `todo`

- Flip `decisions.enabled` for this run only; the `false` default is by design for runs 1–2.

### R5.2 Three-run comparison — `todo`

- Tokens, retries, wall time, blocked tasks, escalation rate. Closes the POC.

### R5.3 Decision evals (spec §10A.6) — `in progress` (harness done; data from R5.1)

- Harness (2026-10-04): `server/decide/evals.ts` joins `DECISION_MADE` records with hand labels
  (`{runId, seq, question, label}`) and computes per decision: accuracy, multiclass Brier, ECE (10 bins),
  escalation rate, latency p50/p95. CLI: `npx tsx scripts/evals/decisions.ts --runs ~/.teams-ai/runs --labels <file>`.
  Unit tests in `test/decide/evals.test.ts`; checked end to end on a synthetic journal.
- Left: label the run 3 decisions and record the metrics here; then pick the `local` model and threshold.

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
