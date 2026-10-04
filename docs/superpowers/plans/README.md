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
| 12 | [`2026-09-24-teams-ai-12-phases-4-6-validation-ui.md`](2026-09-24-teams-ai-12-phases-4-6-validation-ui.md) | Implemented and unit-tested; live-checked on docker-local through the deploy-failed path only — phases 4 (verification + one fix round), 5 (deploy, rollback, smoke gate, deploy-fix tasks), 6 (report merged with awaiting-validation), `spec complete`, Validation screen (see the plan's Findings). |

Note: plan 6 (knowledge) was originally numbered plan 5, duplicating the decision-layer plan's number; it was
renumbered to 6 in commit `134bcf3` ("docs: renumber the knowledge plan to 06 (two plans carried the number 05)").
Plan 9 (jev-decisions-phase3a) was out of the `01..08` numbering sequence with no plan number in its filename or
title; it has been renamed and retitled to `09` here since it is the next unused number and depends on plan 5's
decision layer and plan 7's orchestrator.

## Outstanding work

Ordered by what unblocks what. Spec references are to `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md`.

- **Golden run comparison (spec §1.3) — only run 1 done.** Plan 7 records one live baseline run on hello-app
  (`hello-001-r1`, decisions off, $3.33). Run 2 (OmniRoute for Test/DevOps, decisions off) and run 3 (decisions
  on) have not been executed. `decisions.enabled` defaulting to `false` (`server/config/config.ts:108`) is by
  design for runs 1–2 — it is not a bug; run 3 flips it per run, not in the default.
- **Decision 8 (CLI error classification) — deterministic rules only.** `classifyFailure`
  (`server/runner/step.ts:69`) falls through to `code`; the spec says System 1 runs "when rules do not match" with
  default `other`. Low value until a real run shows misclassified failures; leave for after run 3.
- **Decision 12 (rank candidate plans) — blocked on the SM contract.** `server/contracts/plan.ts` and
  `server/agents/outputs.ts` have no notion of multiple candidate plans; the SM authors exactly one. Needs a
  contract change first.
- **Decisions 2–4 (Gate 1 readiness, question dedup, contradiction) — blocked on the refinement flow.** No
  Gate 1 / refinement loop exists in `server/orchestrator/` (spec UI screen 2 "Refinement"); only contracts and
  config mention it.
- **Decision 7 (validation report routing) — call site now exists** (Validation → `continue { report }`); the
  System 1 question that routes the text to PO or SM first is still unwired.
- **Plan 12 — happy path not live-checked, and one defect.** `deploy-fix` loops uselessly when `plan.commands.smoke` is missing; see the plan's Findings.
- **Plan 10 — items not covered by the live check.** A run has not yet been started, stopped and resumed from
  the browser (the live check replayed the recorded `hello-001-r1` journal only, to avoid a $3 run); whether
  SIGTERM reaches the orchestrator through the `tsx` wrapper is therefore unverified — see plan 10 Findings.
- **`local-logprobs` backend (spec §10A.2a, phase 2) — client built, server not set up.**
  `server/decide/local-logprobs.ts` talks to a llama.cpp server (`/completion`, one grammar-constrained token per
  question, probabilities from `top_logprobs`); `createDecider` wires it when `decisions.local.enabled` is true,
  the stub otherwise. Still to do on the host: build llama.cpp with CUDA in WSL2, download a 7–9B instruct GGUF
  (suggested start: Qwen2.5-7B-Instruct Q4_K_M), start `llama-server -np 4 -c 8192`, run a real smoke, then let
  the evals pick the model and the `local` threshold.
- **Decision evals (spec §10A.6) — not built.** Labeled fixtures are meant to grow from `DECISION_MADE` journal
  records; the eval harness (accuracy, Brier, ECE, escalation rate, latency per decision and model) does not exist.
  Depends on having enough journal records, i.e. run 3.
- **Plan 8 — two live-verification items still open** (see the plan's `## Findings` section):
  1. A real `claude auth login` transcript (URL line, paste-prompt wording, time to `loggedIn`) has not been
     recorded on a fresh host / after `claude auth logout` — the live run tested a host that was already logged in.
  2. The real `gh` device-flow walkthrough (auto-Enter behaviour) has only been exercised by the fake-CLI test,
     not a real device-flow run.
