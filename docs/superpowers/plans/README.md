# teams-ai — Plans Index

Audited against the codebase (`server/`, `web/`, `test/`) on 2026-09-24. Specs live in `docs/superpowers/specs/`:
`2026-09-23-teams-ai-poc-design.md` (POC design), `2026-09-24-orchestrator-phases-1-3-design.md`, and
`2026-09-24-web-ui-onboarding-design.md` — all three are design companions to the plans below and match what
was implemented. Web UI block A (`2026-09-24-run-api-execution-ui-design.md`) is implemented by plan 10, block B
(`2026-09-24-refinement-ui-design.md`) is implemented by plan 11, block C
(`2026-09-24-phases-4-6-validation-ui-design.md`) by plan 12.

| # | Plan | Status |
|---|------|--------|
| 1 | [`2026-09-23-teams-ai-01-core-engine.md`](2026-09-23-teams-ai-01-core-engine.md) | Implemented and merged to main — contracts, event store, task state machine, scheduler, validators, evidence. |
| 2 | [`2026-09-23-teams-ai-02-environment-cli-spike.md`](2026-09-23-teams-ai-02-environment-cli-spike.md) | Implemented and merged to main — tool report + CLI findings recorded at `docs/superpowers/spikes/2026-09-23-cli-findings.md`. |
| 3 | [`2026-09-24-teams-ai-03-runner-agents-budget.md`](2026-09-24-teams-ai-03-runner-agents-budget.md) | Implemented and merged to main — runner, agents, budget/quota modules. |
| 4 | [`2026-09-24-teams-ai-04-execution-plane.md`](2026-09-24-teams-ai-04-execution-plane.md) | Implemented and merged to main — gate runner, git/GitHub merge queue, docker-local and kind deploy. |
| 5 | [`2026-09-24-teams-ai-05-decision-layer-phase1.md`](2026-09-24-teams-ai-05-decision-layer-phase1.md) | Implemented and merged to main, but disabled by default — `decisions.enabled` defaults to `false`. |
| 6 | [`2026-09-24-teams-ai-06-knowledge.md`](2026-09-24-teams-ai-06-knowledge.md) | Implemented and merged to main — lookup, code graph (graphify), BM25 retrieval, context-pack builder. |
| 7 | [`2026-09-24-teams-ai-07-orchestrator-phases-1-3.md`](2026-09-24-teams-ai-07-orchestrator-phases-1-3.md) | Implemented and merged to main, live-tested against a hello-app run. |
| 8 | [`2026-09-24-teams-ai-08-web-ui-onboarding.md`](2026-09-24-teams-ai-08-web-ui-onboarding.md) | Implemented and merged to main, live-tested — 4 of 6 findings items confirmed live; 2 still need a live run (see Outstanding work). |
| 9 | [`2026-09-24-teams-ai-09-jev-decisions-phase3a.md`](2026-09-24-teams-ai-09-jev-decisions-phase3a.md) (renamed from `2026-09-24-jev-decisions-phase3a.md`) | Partially implemented — 4 of the additional decisions (merge-gate triage, attempt progress, PR risk, model tier/effort) are wired; several are explicitly out of scope (see Outstanding work). |
| 10 | [`2026-09-24-teams-ai-10-run-api-execution-ui.md`](2026-09-24-teams-ai-10-run-api-execution-ui.md) | Implemented — run API, SSE journal stream with `Last-Event-ID` replay, Projects and Execution screens, graceful stop on SIGTERM; live-checked in WSL against the recorded `hello-001-r1` journal (see the plan's Findings). |
| 11 | [`2026-09-24-teams-ai-11-refinement-ui.md`](2026-09-24-teams-ai-11-refinement-ui.md) | Implemented and unit/integration tested — Gate 1 refinement session (derive/refine cycle, questions, doc patches, secrets), Phase 0 bootstrap, Refinement screen; live-checked in WSL through the derive step's real failure path, blocked by account quota before the happy path (see the plan's Findings). |
| 12 | [`2026-09-24-teams-ai-12-phases-4-6-validation-ui.md`](2026-09-24-teams-ai-12-phases-4-6-validation-ui.md) | Implemented and live-checked on docker-local (deploy-failed and awaiting-validation -> done paths) — phases 4 (verification + one fix round), 5 (deploy, rollback, smoke gate, deploy-fix tasks), 6 (report merged with awaiting-validation), `spec complete`, Validation screen (see the plan's Findings). |
| 13 | [`2026-10-04-teams-ai-13-security-review.md`](2026-10-04-teams-ai-13-security-review.md) | Implemented, unit-tested and live-checked with a single `sec` step (seeded command injection returns `critical`; full hello-app run not done) — read-only `sec` agent reviews each task diff after Test and before merge; critical/high findings go back to Dev; findings reach the report, Validation screen and task detail. Design: `specs/2026-10-04-security-review-design.md`. |

Note: plan 6 (knowledge) was originally numbered plan 5, duplicating the decision-layer plan's number; it was
renumbered to 6 in commit `134bcf3` ("docs: renumber the knowledge plan to 06 (two plans carried the number 05)").
Plan 9 (jev-decisions-phase3a) was out of the `01..08` numbering sequence with no plan number in its filename or
title; it has been renamed and retitled to `09` here since it is the next unused number and depends on plan 5's
decision layer and plan 7's orchestrator.

## Outstanding work

Roadmap to "done". Done means the golden run criteria in spec §1.3
(`docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md`): three runs on the reference spec, zero human
interaction between Start and `awaiting-validation`, every AC `passed` in JUnit, green deploy and smoke on both
`docker-local` and `kind`, zero duplicate PRs, `main` green after every merge, and the three runs compared on tokens,
retries, wall time, blocked tasks and escalation rate. Stages are in order; each one unblocks the next.

### Stage 1 — Golden run 1 (baseline: Claude only, decisions off) — in progress

- Reference spec: `test/fixtures/todo-api` (TODO REST API, 5 ACs, docs only; agents write the code).
- Run `todo-001-r1` started 2026-10-04 on WSL:
  `TEAMS_AI_GH_OWNER=<owner> TEAMS_AI_FIXTURE=todo-api npx tsx scripts/integration/orchestrator.ts`
  (repository `<owner>/teams-ai-todo-api`). The earlier `hello-001-r1` ($3.33) was on hello-app, not on the reference spec.
- The same run also checks, live: the `sec` gate inside a run (plan 13) and the report step that failed in plan 12's
  live run.
- Deploy target is `docker-local`. `kind` is still never run: deploy the same result to `kind` (second run with
  `deploy.target: "kind"`) before calling stage 1 done.

### Stage 2 — Browser checks (cheap; after stage 1, on its result)

- Plan 12: "Report problem" from the Validation page (reopens refinement; with decisions on, shows the decision 7 hint).
- Plan 10: start, stop and resume a run from the browser.
- Plan 8: a real `claude auth login` on a logged-out host (URL line, paste prompt, time to `loggedIn`) and a real
  `gh` device-flow walkthrough (only the fake CLI has exercised it).

### Stage 3 — Golden run 2 (OmniRoute for Test/DevOps, decisions off)

- Needs OmniRoute up on the host (`scripts/wsl/omniroute`) and `omniroute.enabled` for the run.

### Stage 4 — System 1 ready for run 3

- Decisions 2–4 (Gate 1): pick the approach first, see the decision table below.
- Decision 12: needs the SM contract to allow several candidate plans (`server/contracts/plan.ts`,
  `server/agents/outputs.ts`). Optional for run 3.
- `local-logprobs` backend (spec §10A.2a): client built (`server/decide/local-logprobs.ts`); host still needs
  llama.cpp with CUDA in WSL2, a 7–9B instruct GGUF (start with Qwen2.5-7B-Instruct Q4_K_M) and
  `llama-server -np 4 -c 8192`. Optional: Jev alone covers run 3.

### Stage 5 — Golden run 3 (decisions on) and the comparison

- Flip `decisions.enabled` for this run only (the `false` default is by design for runs 1–2).
- Write the three-run comparison (tokens, retries, wall time, blocked tasks, escalation rate).
- Decision evals (spec §10A.6): harness not built; fixtures come from `DECISION_MADE` records of run 3.

### System 1 decisions (spec §10A.5)

| # | Decision | Status |
|---|----------|--------|
| 1 | Gate failure triage | Wired (`gate-triage`) |
| 2 | Gate 1 readiness per AC / checklist item | Not wired. A single JEV consistency check (`server/refine/jev-validation.ts`) covers part of it, outside the decider |
| 3 | Question dedup | Deterministic only (normalized text, `server/refine/cycle.ts:154`) |
| 4 | Contradiction with history | Not wired; partly covered by the same JEV check |
| 5 | PR risk | Wired (`pr-risk`) |
| 6 | Attempt progress | Wired (`attempt-progress`) |
| 7 | Validation report routing | Wired 2026-10-04 as a hint in `brief.md` (`report-routing`); never changes the flow |
| 8 | CLI error classification | Wired 2026-10-04 (`cli-error`: quota / auth / schema / code; never escalates to Claude) |
| 9 | Scope drift | Wired (`scope-drift`) |
| 10–11 | Model tier and effort per task | Wired (`model-tier`) |
| 12 | Rank candidate plans | Blocked on the SM contract |
