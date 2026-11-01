# Features

Feature items, one at a time, in this order. Bugs stay in `BACKLOG.md`.

## 1. Redeploy the running container

Status: done on 2026-10-28. The container runs commit `5cbc45a7` (the Superpowers cut-over, plan 107), built from a clean export, and the stage 7 screen shows "Preparar os planos" in the served bundle.

Redeploy only when no agent is running in the container, because a redeploy stops the running steps.

## 2. Mobile: Flutter for Android, end to end

Status: partial. Built 2026-10-28 (plan 108): JUnit from `flutter test` and the APK release workflow. Done: the Flutter CI setup (plan 113). Decided 2026-10-28: the APK keeps the debug signing key for now; a release key is a later decision.

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

Status: done (2026-10-29). Plan 115 covers the per-project switch, the owner's question and the security review; the sandbox escape found in the review is closed.
- Done: retry within a token budget (plan 112): `retry.taskTokenBudget` in the config; unset keeps the old rule of three attempts, one replan, then block.
- Done: the model of each role is set in Settings per project, default manual Haiku 5.5 at low effort; the `model` lines in the agent frontmatter stay, because the agent loader requires them; the runner ignores them.
- Done: a yellow notice on the project screen when a run blocks or waits for the owner (commit `479bda3d`).
- Done: a Jev outage no longer stops the refinement cycle (commit `ad5817ac`).
- Done 2026-10-29 (plan 115): the per-project switch "Autorizo os agentes a tomar decisões?" (No by default). Yes: the SM decides a blocked Dev, and the steps that do not judge get the shell and the web. No: a block asks the owner one question with its choices on the run screen, and the answer starts the next run as a binding assumption. With Yes, the run screen offers no reprocess.

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

## 12. Run recovery: retry a failed verification in the same run

Status: built 2026-10-29. Commit `0870f940` (resume and reopen) and the Retomar button on the run screen, approved as a mock the same day. Pending: the full cycle on a real run (run-6 of kayron-hub) with the owner's click.

Done:
- The resume route accepts `verification-failed`. Retomar restarts only the blocked tasks and journals `RUN_REOPENED`.
- A reopened run shows as running until its next `RUN_FINISHED`.
- The run screen shows Retomar with the hint that only the blocked tasks restart.

Decided 2026-10-29:
- Settings and autonomy kept: agents decide `Sim` for kayron-hub; 3 attempts per task; 3 spec-gap rounds in a row; 2 gate fixes per gate per run; 2 verification rounds; cost is an alert only.
- Standalone runs do not repair themselves: Retomar is manual. Program runs keep the automatic repair (2).

Pending:
- The project hub (`project-shared.tsx`) does not offer Retomar for a failed verification yet; the approved mock covers only the run screen.
- A spec with a refinement session: Retomar does not update its program item; use the program's retry for those.

## 13. Language skills for the role agents: not adopted now

Status: decided 2026-10-30. The fifteen language skills of the agents-migration repository stay out of teams-ai. Three reasons, from the code and the run data. A step loads a skill when its prompt or role file names it, and the steps set the flag that, according to the Claude Code binary, drops the attachment that would list the skills; none of the five skills already installed was used in about 570 steps. Formatting, vetting and build never failed in 17 runs, and language-level causes are 5 to 15 percent of review findings and extra steps, while most loops come from plan and gate conventions. A 5,000-token skill adds 6 to 17 percent to one implement step, so it pays back only if it prevents 8 to 30 percent of retried attempts. The reopen criteria are in `docs/superpowers/spikes/2026-10-30-language-skills.md`. The defects found in the same review are in `BACKLOG.md`, under "From the language skills spike (2026-10-30)".

## 14. Evidence links: each test opens its line on GitHub

Status: built 2026-10-30, pending the owner's check on the run screen.

- The Evidências card links each test name to its line in the repository of its service, at the commit of origin/main in the clone.
- The server finds each test with one `git grep` per repository, from the function name or the quoted title with its criterion tag; a test that is not found, or that matches two places, stays plain text.
- The new route `GET /api/runs/:runId/test-links` answers on demand, so the run screen's seven-second refresh does not search the code.
- Not done: the commit that a verification ran on is not recorded, so a link follows the current main and a test moved after its run has no link.
- Not done: only Go was checked on a real run; the other stacks are covered by tests with real git repositories.

## 15. Global agent rules for every project

Status: built 2026-10-30, pending the owner's check on a real run.

- Every agent step of every project receives the global rules first (`server/agents/global-rules.ts`), through the one function that builds the agent invocation; a call without an agent definition fails.
- Code is English in every project: names, comments, logs, errors and commit messages. Project documents (functional, technical, architectural and operational, including README, runbook, API docs, ADRs and the technical spec) are Brazilian Portuguese. Text for people stays pt-BR; text the product shows its users follows the owner's documents.
- On 2026-10-30 the owner added rules on accuracy (at least 90% confidence before proposing a solution), official sources, faithful behavior, communication, documentation sync, tests (a 90% coverage target), language and a checklist before finishing. They are in `GLOBAL_RULES`.
- The language line left the eight role files, and a role file that names a language is rejected.
- Every installed skill carries a notice that the global rules outrank it.
- The Test reviewer gets a "Language check" block: the Portuguese found in the task's added lines and commit messages, as hints it judges.
- Not done: `docs/guia` is not edited, since a change there needs `task guia:grafo` with the platform running and a valid Claude login. The coverage gate still accepts 80%; the 90% target is an instruction to the agents until the owner decides.

## 16. The chat explains what blocks a spec, from the recorded facts

Status: built 2026-10-31 (plan 117), pending the owner's check on a real run.

- The Help chat reads each spec in play from the journals: the status of its latest run in plain words, the causes of its blocks with the tasks each one holds and the tasks waiting on it, the owner's pending questions, the earlier runs and the run that can resume. A replanned task's cause is the one its failed attempt recorded, never the Scrum Master's guess.
- Each spec has a detail file the chat can search (`falhas/<spec>.md`); the recorded texts are redacted and clipped before the model reads them.
- The chat answers a question about a problem in three parts: what is happening, why (the recorded cause and who must act), and what the person can do. A fact the record does not hold is said to be missing, with the record that would hold it.
- One web search per question, to explain a recorded error, for projects the owner has not marked confidential. The answer lists its sources and never opens a correction.
- Agent records are more complete: a failed gate keeps its exit code and the end of its output, an environment failure reruns under its own name and keeps its cause, a timed-out step says how it ended, and a replan opens with the recorded cause.

## 17. Repositories: the refinement organizes the specs by repository

Status: built 2026-10-31 (plan a9d6), committed on `feat/refinement-reform` (PR #35), behind the repository flow. The flow is off for new projects until the rollout; a project with an architecture takes it in its follow-on drafts.

- The five documents are refined one at a time, in order, and each is added to the Graphify graph before the next starts.
- The architecture step decides whether the system is one application (a monolith, one repository named after the project) or microservices (one repository per service, named with the suffix of its type). Every repository cites a quote from the documents, and the decision is checked by rules before the owner sees it.
- The backlog, the specs, the plans and a task list (`task.md`) belong to a repository. A plan and its task list reach only the repository their spec changes.
- Before the start, the owner reads a summary with seven checks, each repository's counts and the assumptions taken. The start carries the hash of that summary.
- The project page shows a card per repository, and each card opens its dashboard: its specs, its tasks, its integrations, its blockers and its history.
- Not done: the live check on two throwaway projects, the deploy by clean export, the Chrome check on the deployed app, the rollout of the flow for new projects, and the reconstruction of the guide graph. The architecture is a card in the backlog step, not its own stepper node. The dashboard does not yet list the program's item reasons or the pending questions and secrets as blockers.

## 18. The chat reads the five main documents of the project

Status: in progress (plan 118), draft pull request.

- The Help chat can answer questions about the project's five main documents (vision, briefing, stack, flow and design). Each question gets the documents main has, as searchable files in its working folder, and nothing is loaded into the prompt.
- The chat answers from the project graph first and searches the file text only when the graph does not cover the question.
