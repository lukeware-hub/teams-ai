# Features

Feature items, one at a time, in this order. Bugs stay in `BACKLOG.md`.

## 1. Redeploy the running container

Status: done on 2026-10-28. The container runs commit `5cbc45a7` (the Superpowers cut-over, plan 107), built from a clean export, and the stage 7 screen shows "Preparar os planos" in the served bundle.

Redeploy only when no agent is running in the container, because a redeploy stops the running steps.

## 2. Mobile: Flutter for Android, end to end

Status: partial. Built 2026-10-28 (plan 108): JUnit from `flutter test` and the APK release workflow. Left: the Flutter CI setup and a release signing key (owner decision).

Done: the stack `flutter`, a gate image with a pinned Android toolchain, the install step in that image, and a debug APK built offline by the gate.

Pending:
- Delivery kind `mobile`: the APK is the artifact, with no container and no port.
- A download route and a download link on the validation screen.
- A release workflow that builds the APK.
- A JUnit report for `flutter test`, so the test gate gives evidence per criterion.

## 3. Mobile: Expo for Android, end to end

Status: pending. Expo is a Node stack that builds the Android app with Gradle, so it needs the Android toolchain without Flutter.

## 4. Chromium in the agent image

Status: done on 2026-10-28. The agent image carries `@playwright/cli` 0.1.22 and the Chromium of Playwright 1.64.0-alpha-1790635538000, both pinned to the skill's versions; `playwright-cli open` opens the live app as the `node` user. Chromium keeps its sandbox on: the teams-ai service runs with seccomp and apparmor unconfined, which lets the sandbox use user namespaces. The owner chose this on 2026-10-28 over `--no-sandbox`.

## 5. Autonomy

Status: in progress (2026-10-28, owner authorized).
- Done: retry within a token budget (plan 112): `retry.taskTokenBudget` in the config; unset keeps the old rule of three attempts, one replan, then block.
- Done: the model of each role is set in Settings per project, default manual Haiku 5.5 at low effort; the `model` lines in the agent frontmatter stay, because the agent loader requires them; the runner ignores them.
- Pending: a notice on the project screen when a run blocks or waits for validation (needs an approved mock).
- Pending: the fallback when the Jev service is down (today refinement halts); a decision is needed on what replaces the halt.

Cost: alert only, the run never stops (decided by the owner).

## 6. Back end stacks and test services

Status: pending.
- Runtimes and sandbox allowlists for Java, .NET, Ruby and PHP.
- Test services on demand: Redis, MySQL, MongoDB and RabbitMQ.
- Remove the hard-coded npm from the Dev and Test allowlist and from the dependency scan, per stack.

## 7. Delivery and operations

Status: pending.
- README and RUNBOOK in the default post-phase, not a separate run. Checked 2026-10-28: Phase 6 (`phases/report.ts`) already writes both. The separate `spec readme` run and the button "Gerar README com o sm" on the run screen remain; removing that button is a screen change and waits for the owner's approval of a mock.
- Done 2026-10-28: Claude Code is pinned to 2.1.295 and osv-scanner to v2.7.0 in `scripts/wsl/setup-ubuntu.sh`; the missing roadmap citation is replaced by a pointer to this file and to BACKLOG.md.
- Done 2026-10-28: the platform containers have caps: teams-ai 4 CPUs and 8 GiB, dind 4 CPUs and 6 GiB, goproxy 1 CPU and 512 MiB (`docker-compose.yml`).

Public deploy target: out of scope for now (the owner works locally).

## 8. Plan: a builder records its deviation from the implementation plan

Status: done. The dev output lists its `deviations` (`server/agents/outputs.ts`), a review finding has a `category` (`plan` for a contradiction with the plan of its spec), and the commit event `DEV_COMMITTED` journals the deviations.

## 9. Plan: the merged tasks show in the journal

Status: done, and replaced by the migration (plan 107). The orchestrator no longer marks `tasks.md`: the journal knows which plan tasks merged, and the repository keeps one implementation plan per spec at `docs/specs/<spec>/implementation-plan.md`.

## 10. Plan: the questions of the plan step, and the owner's answers

Status: replaced by the migration (plan 107). The plan step writes its plan with the Superpowers `writing-plans` skill, asks nothing, and records each unknown as an assumption with its reason. The PO and the SM no longer answer questions of a plan step, and the internet suggestions setting (`decisions.speckitResearch`) is removed with them.

## 11. Autonomous refinement: agents decide, the owner decides only scope

Status: in progress. Plan 95 is built: the refinement journal keeps each decision whole, and `scripts/evals/refine-replay.ts` measures the owner's agreement with the recommendation on deliberate answers. Plan 96 is done: a document save states the hash it was typed over, so a save over a file another change moved is refused. Plan 97 is built: every patch proposal states whether it adds or removes structure, journaled only. Plan 98 is built: a Spec Kit step repairs the criteria it left out, and a failed item stops only its own lane. Plan 99 is built: a heal driver starts again a cycle or preparation that a restart or a schema or timeout failure stopped, behind `refine.heal.enabled` (off by default). Plan 100 is built: the stage review pack carries the answers, skips and open questions of the draft and the patches it rejected, read from the journal. Plan 101 is built and measured on a copy of the live draft: the resolver replay and the evidence replay show that no stratum clears the gate on the DEV data, so the master plan's estimates need the owner's decision before the next build (see plan 101). The rules are frozen as `r2`, and the holdout starts at the commit. Plan 105 is built, first slice: every agent carries the question rules, and the Spec Kit asker sees the earlier questions of its item with their answers. Plan 102 is built for the Spec Kit questions: a question that repeats a decided one must name the real difference in `distinctFrom`; otherwise it is repaired once, then dropped and shown in the backlog screen, where the owner can ask for it again. Plan 103 is built: the same guard covers the stage reviews and the full rounds, which drop a repeat of a decided question and show it in the stage panel or the final review, with "Perguntar de novo". Plan 106 is built, in shadow: the ask caps (one per Spec Kit command, stage review and round) are counted on the journal by `scripts/evals/refine-replay.ts`, and not enforced. On the live journal 401 of 598 Spec Kit non-blocking questions would move to recorded decisions, most from plan and tasks at cap 0; the owner decides those caps before enforcement. The effort A/B and the interview-skill change wait for a scratch run. Next, in order: the resolver and the autopilot, each behind a flag and after the owner approves its screen. Plan 107 replaces the Spec Kit preparation with the Superpowers plan step, so the Spec Kit names in the plans above describe the removed engine.

Owner decisions (2026-10-27): autonomy at maximum; only a scope change (adding or cutting functionality, changing backlog priority) always reaches the owner; legal, money and security/access are per-project switches, off by default; Iniciar desenvolvimento stays a manual click. Plan of record: `docs/superpowers/plans/2026-10-27-teams-ai-95-autonomy-measurement.md`.
