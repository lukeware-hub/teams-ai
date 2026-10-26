# Features

Feature items, one at a time, in this order. Bugs stay in `BACKLOG.md`.

## 1. Redeploy the running container

Status: pending. The commits `53e0d6e`, `5fc44cb` and `fcf73fe` are not in the running container yet.

Redeploy only when no agent is running in the container, because a redeploy stops the running steps.

## 2. Mobile: Flutter for Android, end to end

Status: partial.

Done: the stack `flutter`, a gate image with a pinned Android toolchain, the install step in that image, and a debug APK built offline by the gate.

Pending:
- Delivery kind `mobile`: the APK is the artifact, with no container and no port.
- A download route and a download link on the validation screen.
- A release workflow that builds the APK.
- A JUnit report for `flutter test`, so the test gate gives evidence per criterion.

## 3. Mobile: Expo for Android, end to end

Status: pending. Expo is a Node stack that builds the Android app with Gradle, so it needs the Android toolchain without Flutter.

## 4. Chromium in the agent image

Status: pending. The visual check at deploy (`uiCheckPack`) runs in the agent image, which has no browser. Playwright and Chromium must be pinned there.

## 5. Autonomy

Status: pending.
- Retry until green within the token budget. Today: three attempts, one replan, then block.
- Notice on the project screen when a run blocks or waits for validation.
- Fallback decision when the Jev service is down. Today: refinement halts.
- Confirm the model each role runs. The agent frontmatter says `opus`, the config runs `sonnet`.

Cost: alert only, the run never stops (decided by the owner).

## 6. Back end stacks and test services

Status: pending.
- Runtimes and sandbox allowlists for Java, .NET, Ruby and PHP.
- Test services on demand: Redis, MySQL, MongoDB and RabbitMQ.
- Remove the hard-coded npm from the Dev and Test allowlist and from the dependency scan, per stack.

## 7. Delivery and operations

Status: pending.
- README and RUNBOOK in the default post-phase, not a separate run.
- Pin Claude Code and osv-scanner in `scripts/wsl/setup-ubuntu.sh`.
- `docs/superpowers/ROADMAP.md` is cited by `plans/README.md` but missing. Restore it or remove the citation.
- Resource limits (CPU and memory) on the platform containers.

Public deploy target: out of scope for now (the owner works locally).

## 8. Spec Kit: a builder records its deviation from the plan or Spec Kit

Status: pending. A builder has no structured field for a departure from the task, `plan.md` or `tasks.md` (`server/agents/outputs.ts:145-160`), and review has no category for a plan contradiction (`server/agents/outputs.ts:168-176`). Add a deviation field to the dev output and a matching review category, both journaled.

## 9. Spec Kit: `tasks.md` shows the delivered tasks

Status: done. When a spec's tasks have merged, the orchestrator marks each delivered Spec Kit task `[X]` in `tasks.md` (`server/orchestrator/phases/speckit.ts`), in the same docs change as the convergence verdict, so the repository shows what was delivered.

## 10. Spec Kit: the PO and the SM answer the open questions from the documents

Status: done, except a switch in the settings screen: the internet suggestions are set in the configuration file for now. After each Spec Kit step, the PO answers the questions of `specify` and `clarify`, and the SM answers those of `constitution`, `plan` and `tasks`. They answer only from the six documents, and only with a quote that is found word for word in one of them (`server/refine/speckit-answers.ts`). The questions they cannot settle reach the owner with a card: the item, the context and the choices. The stage shows a button, "Pedir ao PO e ao SM", for the questions nobody has read yet, and the owner can replace any answer of an agent with his own.

Internet suggestions: search only, off by default. Set `decisions.speckitResearch` to `true` in the configuration file to turn them on. A question the documents leave open may get one suggestion from a web search. The suggestion is one more option, and the owner confirms it. The search never opens a page, and it never runs for a confidential project. The spike in `docs/superpowers/spikes/2026-10-26-web-tools.md` explains why pages are not opened.
