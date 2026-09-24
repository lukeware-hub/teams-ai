# teams-ai — Plans Index

Audited against the codebase (`server/`, `web/`, `test/`) on 2026-09-24. Specs live in `docs/superpowers/specs/`:
`2026-09-23-teams-ai-poc-design.md` (POC design), `2026-09-24-orchestrator-phases-1-3-design.md`, and
`2026-09-24-web-ui-onboarding-design.md` — all three are design companions to the plans below and match what
was implemented.

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

Note: plan 6 (knowledge) was originally numbered plan 5, duplicating the decision-layer plan's number; it was
renumbered to 6 in commit `134bcf3` ("docs: renumber the knowledge plan to 06 (two plans carried the number 05)").
Plan 9 (jev-decisions-phase3a) was out of the `01..08` numbering sequence with no plan number in its filename or
title; it has been renamed and retitled to `09` here since it is the next unused number and depends on plan 5's
decision layer and plan 7's orchestrator.

## Outstanding work

- **`decisions.enabled` is `false` by default** (`server/config/config.ts:108`) — the System 1 decision layer
  (plan 5) and the phase-3a decisions (plan 9) exist and are wired, but do not run in a live orchestrator run
  until an operator flips this flag.
- **Plan 9 — decisions 2–4, 7, 9, 12 not wired.** They depend on refine/validation flows not yet built into
  `server/orchestrator/`.
- **Plan 9 — Evals (spec §10A.6) not built.** Labeled fixtures are meant to grow from `DECISION_MADE` journal
  records these decisions now produce, but the eval harness itself does not exist yet.
- **Plan 8 — two live-verification items still open** (see the plan's `## Findings` section):
  1. A real `claude auth login` transcript (URL line, paste-prompt wording, time to `loggedIn`) has not been
     recorded on a fresh host / after `claude auth logout` — the live run tested a host that was already logged in.
  2. The real `gh` device-flow walkthrough (auto-Enter behaviour) has only been exercised by the fake-CLI test,
     not a real device-flow run.
