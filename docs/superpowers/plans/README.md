# teams-ai — Plans Index

Audited against the codebase (`server/`, `web/`, `test/`) on 2026-09-24, re-audited for plans 14-48 on 2026-10-06.
Specs live in `docs/superpowers/specs/`:
`2026-09-23-teams-ai-poc-design.md` (POC design), `2026-09-24-orchestrator-phases-1-3-design.md`, and
`2026-09-24-web-ui-onboarding-design.md` — all three are design companions to the plans below and match what
was implemented. Web UI block A (`2026-09-24-run-api-execution-ui-design.md`) is implemented by plan 10, block B
(`2026-09-24-refinement-ui-design.md`) is implemented by plan 11, block C
(`2026-09-24-phases-4-6-validation-ui-design.md`) by plan 12.

| # | Plan | Status |
|---|------|--------|
| 1 | [`2026-09-23-teams-ai-01-core-engine.md`](2026-09-23-teams-ai-01-core-engine.md) | Done, implemented and merged to main — contracts, event store, task state machine, scheduler, validators, evidence. |
| 2 | [`2026-09-23-teams-ai-02-environment-cli-spike.md`](2026-09-23-teams-ai-02-environment-cli-spike.md) | Done, implemented and merged to main — tool report + CLI findings recorded at `docs/superpowers/spikes/2026-09-23-cli-findings.md`. |
| 3 | [`2026-09-24-teams-ai-03-runner-agents-budget.md`](2026-09-24-teams-ai-03-runner-agents-budget.md) | Done, implemented and merged to main — runner, agents, budget/quota modules. |
| 4 | [`2026-09-24-teams-ai-04-execution-plane.md`](2026-09-24-teams-ai-04-execution-plane.md) | Done, implemented and merged to main — gate runner, git/GitHub merge queue, docker-local and kind deploy. |
| 5 | [`2026-09-24-teams-ai-05-decision-layer-phase1.md`](2026-09-24-teams-ai-05-decision-layer-phase1.md) | Done, implemented and merged to main, but disabled by default — `decisions.enabled` defaults to `false`. |
| 6 | [`2026-09-24-teams-ai-06-knowledge.md`](2026-09-24-teams-ai-06-knowledge.md) | Done, implemented and merged to main — lookup, code graph (graphify), BM25 retrieval, context-pack builder. |
| 7 | [`2026-09-24-teams-ai-07-orchestrator-phases-1-3.md`](2026-09-24-teams-ai-07-orchestrator-phases-1-3.md) | Done, implemented and merged to main, live-tested against a hello-app run. |
| 8 | [`2026-09-24-teams-ai-08-web-ui-onboarding.md`](2026-09-24-teams-ai-08-web-ui-onboarding.md) | Done, implemented and merged to main, live-tested — 4 of 6 findings items confirmed live; 2 still need a live run (see Outstanding work). |
| 9 | [`2026-09-24-teams-ai-09-jev-decisions-phase3a.md`](2026-09-24-teams-ai-09-jev-decisions-phase3a.md) (renamed from `2026-09-24-jev-decisions-phase3a.md`) | Partially implemented — 4 of the additional decisions (merge-gate triage, attempt progress, PR risk, model tier/effort) are wired; several are explicitly out of scope (see Outstanding work). |
| 10 | [`2026-09-24-teams-ai-10-run-api-execution-ui.md`](2026-09-24-teams-ai-10-run-api-execution-ui.md) | Done, implemented — run API, SSE journal stream with `Last-Event-ID` replay, Projects and Execution screens, graceful stop on SIGTERM; live-checked in WSL against the recorded `hello-001-r1` journal (see the plan's Findings). |
| 11 | [`2026-09-24-teams-ai-11-refinement-ui.md`](2026-09-24-teams-ai-11-refinement-ui.md) | Done, implemented and unit/integration tested — Gate 1 refinement session (derive/refine cycle, questions, doc patches, secrets), Phase 0 bootstrap, Refinement screen; live-checked in WSL through the derive step's real failure path, blocked by account quota before the happy path (see the plan's Findings). |
| 12 | [`2026-09-24-teams-ai-12-phases-4-6-validation-ui.md`](2026-09-24-teams-ai-12-phases-4-6-validation-ui.md) | Done, implemented and live-checked on docker-local (deploy-failed and awaiting-validation -> done paths) — phases 4 (verification + one fix round), 5 (deploy, rollback, smoke gate, deploy-fix tasks), 6 (report merged with awaiting-validation), `spec complete`, Validation screen (see the plan's Findings). |
| 13 | [`2026-10-04-teams-ai-13-security-review.md`](2026-10-04-teams-ai-13-security-review.md) | Done, implemented, unit-tested and live-checked with a single `sec` step (seeded command injection returns `critical`; full hello-app run not done) — read-only `sec` agent reviews each task diff after Test and before merge; critical/high findings go back to Dev; findings reach the report, Validation screen and task detail. Design: `specs/2026-10-04-security-review-design.md`. |
| 14 | [`2026-10-04-teams-ai-14-k8s-stack.md`](2026-10-04-teams-ai-14-k8s-stack.md) | Implemented, then removed — the whole stack ran as Kubernetes pods in one namespace; dropped 2026-10-05 (ROADMAP R6.1, "superseded... the platform runs as ONE container from docker-compose.yml, no Kubernetes"). `deploy/k8s/` no longer exists (commit `9c17f6c`). |
| 15 | [`2026-10-04-teams-ai-15-api-auth.md`](2026-10-04-teams-ai-15-api-auth.md) | Done, implemented — bearer-token auth for the UI/API server (`server/api/auth.ts`); ROADMAP R7.2 "done, unit" with open caveats (`isAllowedHost` still 403s any non-loopback Host; token not wired into the manifests; no browser check). |
| 16 | [`2026-10-04-teams-ai-16-supervisor.md`](2026-10-04-teams-ai-16-supervisor.md) | Done, implemented, unit-tested — `server/supervisor/supervise.ts`; ROADMAP R7.3 "done, unit" ("not run live; a run stopped, hand-resumed, then crashed is never auto-resumed"). |
| 18 | [`2026-10-04-teams-ai-18-ci-e2e.md`](2026-10-04-teams-ai-18-ci-e2e.md) | Done, implemented — `.github/workflows/ci.yml`, `test/e2e/pipeline.e2e.test.ts`; ROADMAP R7.5 "done" (furthest milestone reached without Docker). |
| 20 | [`2026-10-04-teams-ai-20-runner-security.md`](2026-10-04-teams-ai-20-runner-security.md) | Done, implemented, current — `server/runner/sandbox-policy.ts` (`sandboxPolicyViolation`/`unsafeNoSandbox`) matches the plan; ROADMAP R7.4 confirms live (audit C1, H3, M2). |
| 21 | [`2026-10-04-teams-ai-21-api-security.md`](2026-10-04-teams-ai-21-api-security.md) | Done, implemented, current — `server/api/security.ts` (CSP, `frame-ancestors 'none'`, `allowedHosts`) matches the plan; ROADMAP R7.4 confirms (audit H2, M1, M3-M5, L1-L6). |
| 22 | [`2026-10-04-teams-ai-22-k8s-job-runner.md`](2026-10-04-teams-ai-22-k8s-job-runner.md) | Implemented, then removed — the k8s `GateExecutor`/Job runner for gates and smoke; ROADMAP: "Removed: `deploy/k8s`, the Job gate executor and the `executor` config." No `kubectl`/k8s executor remains in `server/exec/gate-runner.ts` (only `dockerGateExecutor`). |
| 23 | [`2026-10-04-teams-ai-23-k8s-deploy.md`](2026-10-04-teams-ai-23-k8s-deploy.md) | Implemented, then removed — registry build path, hardened images, agent-step network isolation for k8s; `deploy/k8s/` and the `kind` target are gone with the Kubernetes drop. |
| 24 | [`2026-10-04-teams-ai-24-orchestrator-fixes.md`](2026-10-04-teams-ai-24-orchestrator-fixes.md) | Done, implemented, current — `status: 'blocked'` `DevOutput` branch with required `reason` (`server/agents/outputs.ts`); ROADMAP confirms. |
| 25 | [`2026-10-04-teams-ai-25-api-leftovers.md`](2026-10-04-teams-ai-25-api-leftovers.md) | Done, implemented, current — SSE idle/lifetime timeouts and clone-host-resolution refusal (`server/api/server.ts`, `run-routes.ts`); ROADMAP confirms. |
| 26 | [`2026-10-04-teams-ai-26-gate-logs.md`](2026-10-04-teams-ai-26-gate-logs.md) | Implemented, then removed — k8s gate stdout/stderr split; added in commit `bec1402`, removed in commit `9c17f6c` with the rest of the k8s Job executor. |
| 27 | [`2026-10-04-teams-ai-27-supervise-test.md`](2026-10-04-teams-ai-27-supervise-test.md) | Partially implemented, partially superseded — the supervise-loop unit tests exist (`test/supervisor/supervise.test.ts`); the docker-compose hardening this plan added was later superseded by plan 40's rootless `dind` approach. |
| 28 | [`2026-10-04-teams-ai-28-r8-1-delivery-contract.md`](2026-10-04-teams-ai-28-r8-1-delivery-contract.md) | Done (unit) — `plan.delivery` required-artifacts contract; ROADMAP R8.1. |
| 29 | [`2026-10-04-teams-ai-29-r8-3-github-actions.md`](2026-10-04-teams-ai-29-r8-3-github-actions.md) | Done (unit) — CI/release workflows for the generated repo; ROADMAP R8.3. |
| 30 | [`2026-10-04-teams-ai-30-r8-6-docs-gate.md`](2026-10-04-teams-ai-30-r8-6-docs-gate.md) | Done (unit) — documentation gate (README/RUNBOOK/API docs validators); ROADMAP R8.6. |
| 31 | [`2026-10-04-teams-ai-31-k8s-cutover.md`](2026-10-04-teams-ai-31-k8s-cutover.md) | Dropped, never completed — cutover to Kubernetes-only; superseded 2026-10-05 by the single-compose-container decision (ROADMAP Stage 6, "`dropped`, replaced by a single compose container"). Only residue: `Bash(kubectl:*)` permission strings and a comment in `server/exec/command.ts`; no live k8s code remains. |
| 32 | [`2026-10-04-teams-ai-32-r8-5-security-tooling.md`](2026-10-04-teams-ai-32-r8-5-security-tooling.md) | Done (unit) — prescribed security gates (gitleaks, osv-scanner/npm audit, semgrep, trivy); ROADMAP R8.5. |
| 33 | [`2026-10-04-teams-ai-33-r8-2-compose-enforced.md`](2026-10-04-teams-ai-33-r8-2-compose-enforced.md) | Done (unit) — Docker infra (Dockerfile + docker-compose.yml) enforced for docker-local; ROADMAP R8.2. |
| 34 | [`2026-10-04-teams-ai-34-r8-4-e2e-gate.md`](2026-10-04-teams-ai-34-r8-4-e2e-gate.md) | Done (unit) — required blocking `e2e` gate for the generated project; ROADMAP R8.4. |
| 35 | [`2026-10-04-teams-ai-35-e2e-evidence-and-scope.md`](2026-10-04-teams-ai-35-e2e-evidence-and-scope.md) | Done — `attachE2e` (`server/evidence/matrix.ts`), `e2eExemptions` (`server/validators/e2e.ts`); open gap: no `runPhase6` test shows the e2e rows in the report yet. |
| 36 | [`2026-10-04-teams-ai-36-deploy-lifecycle-gaps.md`](2026-10-04-teams-ai-36-deploy-lifecycle-gaps.md) | Done — `destroy()` teardown logic (`server/deploy/target.ts`, `phases/deploy.ts`); open gap: a failure in the apply stage of a first deploy is not torn down. |
| 37 | [`2026-10-04-teams-ai-37-image-scan-archive.md`](2026-10-04-teams-ai-37-image-scan-archive.md) | Done — `IMAGE_ARCHIVE` + `trivy config`/`trivy fs` gate, verifiable tool install (`server/orchestrator/phases/deploy.ts`); open gap: pinned-installer checksums never actually run live. |
| 38 | [`2026-10-04-teams-ai-38-drain-and-auth-race.md`](2026-10-04-teams-ai-38-drain-and-auth-race.md) | Done — clean drain on stop, `syncBackCredentials` (`server/runner/step-home.ts`) and `AUTH_TEXT` (`server/runner/step.ts`) for the credential-refresh race; open gap: only tested with a fake claude, 15s-kill-on-stop limitation remains. |
| 39 | [`2026-10-05-teams-ai-39-remove-omniroute.md`](2026-10-05-teams-ai-39-remove-omniroute.md) | Done — OmniRoute provider removed entirely (human decision 2026-10-05); ROADMAP R3.1. |
| 40 | [`2026-10-05-teams-ai-40-security.md`](2026-10-05-teams-ai-40-security.md) | Done (code), live-check open — rootless `dind` sidecar in `docker-compose.yml`; status update recorded in `docs/superpowers/security/2026-10-04-system-audit.md`; open: live `docker compose up` + dind check and the agent-reach probe (egress intentionally left unrestricted). |
| 41 | [`2026-10-06-teams-ai-41-service-links.md`](2026-10-06-teams-ai-41-service-links.md) | Done, implemented (2026-10-06, approved same day) — published service card, links, status and start. |
| 42 | [`2026-10-06-teams-ai-42-doctor-and-start.md`](2026-10-06-teams-ai-42-doctor-and-start.md) | Done — `task doctor`/`task start`; ROADMAP R9.1. |
| 43 | [`2026-10-06-teams-ai-43-windows-installer.md`](2026-10-06-teams-ai-43-windows-installer.md) | Done, not run end to end — Windows prerequisites installer; ROADMAP R9.2. |
| 44 | [`2026-10-06-teams-ai-44-quickstart-docs.md`](2026-10-06-teams-ai-44-quickstart-docs.md) | Done — quickstart docs and GitHub token link; ROADMAP R9.3. |
| 45 | [`2026-10-06-teams-ai-45-new-spec-description.md`](2026-10-06-teams-ai-45-new-spec-description.md) | Done, with follow-ups — optional description when creating a project/spec; ROADMAP R9.7. |
| 46 | [`2026-10-06-teams-ai-46-agent-routing-and-skills.md`](2026-10-06-teams-ai-46-agent-routing-and-skills.md) | Done — tasks route to the owning role (`front`/`devops`/`dev`), agent prompts repaired, skill guidance distilled; ROADMAP R10.1. |
| 47 | [`2026-10-06-teams-ai-47-absolute-quality-gates.md`](2026-10-06-teams-ai-47-absolute-quality-gates.md) | Done — stack-agnostic coverage/lockfile/pinned-image/license-scan rules; ROADMAP R10.2. |
| 48 | [`2026-10-06-teams-ai-48-ui-demo-run.md`](2026-10-06-teams-ai-48-ui-demo-run.md) | Planning — not yet approved for implementation; ROADMAP R9.5. |
| 51 | [`2026-10-06-teams-ai-51-spec-and-preplan-per-item.md`](2026-10-06-teams-ai-51-spec-and-preplan-per-item.md) | Code done, live check pending — a spec and a pre-plan for every backlog item; ROADMAP R11.2. |
| 60 | [`2026-10-11-teams-ai-60-services.md`](2026-10-11-teams-ai-60-services.md) | Slice R12.1 done (contracts and validation) — any architecture, one repository per service, one spec across several services; ROADMAP stage 12. |
| 61 | [`2026-10-11-teams-ai-61-run-per-service.md`](2026-10-11-teams-ai-61-run-per-service.md) | Done — runs go through service views: each task runs and merges in its service's repository, one verification verdict across repositories; ROADMAP R12.2. |
| 62 | [`2026-10-11-teams-ai-62-service-repositories.md`](2026-10-11-teams-ai-62-service-repositories.md) | Done — each service gets its GitHub repository and clone, new services get their workflows, a resumed run reconciles per repository; ROADMAP R12.3. |
| 63 | [`2026-10-11-teams-ai-63-deploy-services.md`](2026-10-11-teams-ai-63-deploy-services.md) | Done — the platform the docs declare and every service deploy on the project's shared network, each with its own port, suites and rollback; ROADMAP R12.4. |

Plans 17 and 19 never existed (not a gap in this audit - no file was ever created at those numbers).

Note: plan 6 (knowledge) was originally numbered plan 5, duplicating the decision-layer plan's number; it was
renumbered to 6 in commit `134bcf3` ("docs: renumber the knowledge plan to 06 (two plans carried the number 05)").
Plan 9 (jev-decisions-phase3a) was out of the `01..08` numbering sequence with no plan number in its filename or
title; it has been renamed and retitled to `09` here since it is the next unused number and depends on plan 5's
decision layer and plan 7's orchestrator.

## Outstanding work

Moved to [`../ROADMAP.md`](../ROADMAP.md): the staged backlog to the golden run, the System 1 decision status, and
the plan-before-implementing workflow.
