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

## Not done

- A live run with a real blocked Dev and No (the question, the answer and the next run) has not run end to end. The path is covered by unit tests. A live run costs tokens and time, so it waits for the owner's go-ahead.
- A block whose question step fails keeps the first sentence of its reason as its title, which can be long.
- `FEATURES.md` item 5 lists more pending items than this plan covers. They were not reviewed here.
