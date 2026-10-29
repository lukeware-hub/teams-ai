# Plan 115 - Agents decide blocks per project, and a blocked run asks the owner

## Context

A blocked run showed a generic cause ("Tarefa bloqueada", "Abra a tarefa para ver o motivo") and offered Reprocessar, which repeats the same failure. The owner now chooses, per project, whether the agents decide blocks themselves. The choice lives in Settings, and it changes what a block does.

## Built

- **The switch.** "Autorizo os agentes a tomar decisões?" in Settings, per project, No by default. Commit `817a43a9`.
- **Yes: the SM decides a blocked Dev.** A Dev that reports blocked gets the SM's decision as a spec-gap answer and resumes. The SM may overrule an owner decision that cannot be met here, and it names the decision in the assumption. Commit `958ec393`.
- **Yes: shell and web for the steps that do not judge.** Every step except review, security, ui-check and gaps may run any shell command and search or fetch the web. The deny rules stay: gh, git push, docker, kubectl and the credential stores. The web reaches the sandbox through the `WebFetch(domain:*)` allow rule. A real agent in the container checked it: curl is blocked without the rule and reaches example.com with it. Commit `773d5624`.
- **The run screen.** An unknown block shows the first sentence of its reason as its title. The cause rows wrap instead of cutting. With Yes, no reprocess is offered and no hint asks for one. Commit `a0babb68`.
- **No: the owner answers one question.** A block the agents cannot finish asks the SM for one question and 2 to 4 choices the repository can carry out (step `block-options`). The run screen shows them, with the recommended one picked, or a text of the owner's own. Submitting saves the answers per spec in `<project>/decisions/<spec>.json` and starts the next run, which reads each answer as a binding assumption. The spec hash does not change. Commit `31235648`.

## Decisions taken while building

- The question runs once per block, and only with No. If the question step fails, the block stays plain, as before.
- Judges (review, security, ui-check, gaps) never get the web or the shell, even with Yes.
- The owner's permission reaches the SM through the spec-gap pack, not through a separate note in every prompt. The SM agent file says when overruling is allowed.
- Answers are stored outside `docs/`, beside the repair notes, so Phase 0 never publishes them.
- The question step runs on the SM's model (Sonnet), not on Haiku. The owner's question is the text the owner reads, so quality comes first. The cost is one short call per block, and the run page shows its tokens. `routing.stepModels["block-options"]` sets another model in the config if the cost ever matters.

## Security review (2026-10-29)

Checked with real agent runs in the container, using a harmless canary and an allowed command.

- **Sandbox escape, fixed (all roles, not only Yes).** An allowed command that the sandbox blocked for the network was retried outside the sandbox with `dangerouslyDisableSandbox`. No prompt appeared, because the allow rule approves that retry. The check reached the network and read a newer version from the outside. Fix: the step settings set `allowUnsandboxedCommands: false`, so the retry is refused, and `failIfUnavailable: true`, so a missing sandbox stops the run instead of running the command bare. Re-run after the fix: the sandbox blocks the call, the retry does not happen, and normal sandboxed commands still work.
- **Environment of the agent, checked.** The agent process builds its environment from scratch: the host environment is not inherited, and only the API key the config chooses reaches it.
- **Interface, checked.** The compose file publishes the interface on `127.0.0.1` unless `TEAMS_AI_UI_BIND` is set. The interface has no login since 2026-10-23, so a non-local bind would expose Yes to anyone who reaches it.
- **Open, owner decision.** With Yes, non-judge steps may reach any host through `WebFetch(domain:*)`, and a command may send data out in a request. That is the authority you granted; it stays as approved, and the Settings help says so. To narrow it, the network could be limited to an allowlist of documentation hosts.

## Covered without tokens

- The No flow runs end to end in the orchestrator test suite, with the fake agent: a blocked Dev, the question journaled, the answer stored per spec, and the next run's Dev prompt carrying the answer (`test/orchestrator/loop.test.ts`).
- The run API stores an answer, shows it on the run, and refuses a task nobody asked about (`test/api/run-api.test.ts`).
- A block whose question step fails keeps the first sentence of its reason as its title. That sentence is cut at 100 characters, on a word boundary.

## Follow-ups closed the same day

- The backend suite runs on every push to `main` on CI, and the test time budget is checked there (`scripts/test-budget.ts`, limits in the file). A file over 60 s, or a run over 8 min, fails the CI job.
- The crash sweep tests one intent of each kind and the last by default; `TEAMS_AI_CRASH_SWEEP=full` runs every point, and `TEAMS_AI_CRASH_POINTS=13,14` reruns chosen ones.
- The git fixture retries a transient push under parallel load on Windows; Linux CI never showed it.
