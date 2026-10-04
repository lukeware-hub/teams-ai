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

Moved to [`../ROADMAP.md`](../ROADMAP.md): the staged backlog to the golden run, the System 1 decision status, and
the plan-before-implementing workflow.
