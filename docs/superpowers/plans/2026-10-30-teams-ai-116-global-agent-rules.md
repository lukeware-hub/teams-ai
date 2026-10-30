# Plan 116 - Global agent rules for every project teams-ai builds

## Context

The agents of teams-ai build software for target projects. Their rules lived in three places: a language line in each role file asking Portuguese for comments and docs, `QUALITY_RULES` and `ERROR_RULES` appended by `loadAgents`, and `QUESTION_RULES` on stdin. The owner asked for one central set of global rules, mandatory for every agent in every project, that outranks project instructions, agent files, skills and owner decisions: code in 100% English, and text for people in Brazilian Portuguese.

## Built

- **One place for the rules.** `server/agents/global-rules.ts` exports `GLOBAL_RULES` and `SKILL_NOTICE`.
- **One injection point.** `buildInvocation` writes `GLOBAL_RULES` before the role text in the definition file that `--agents` reads. Every step of every kind and every project goes through it. `agentDefinition` and `agentsPath` are required; a call without them throws.
- **The language line left the role files.** The eight `.claude/agents/*.md` no longer name a language, and `parseAgentFile` rejects a role file that does.
- **Skills carry a notice.** `copySkill` puts `SKILL_NOTICE` after the frontmatter of every installed `SKILL.md`: pinned skills, the first-party language skills and the SM's private drafts.
- **A language check for the reviewer.** `server/validators/language.ts` reads the added lines of the task diff (`git diff -U0 origin/main...HEAD`) and the task's commit messages, and renders the Portuguese it finds as hints in the review pack, under "Language check". It never blocks a task.
- **Two pack texts follow the rules.** The readme step asks for English names; owner decisions are followed within the global rules.

## Decisions taken while building

- The check flags a diacritic inside a word, or one of 27 Portuguese words, on added lines only. URLs, hashes and encoded blobs are skipped. Exempt paths are the owner documents (project, stack, flow, design, briefing), locale folders, snapshots and lock files. The technical spec, the ADRs (`docs/adr`), the README and the runbook are checked.
- Recall is limited: the check catches accented Portuguese and the listed words, and misses Portuguese written in plain ASCII without them. It is a tripwire; the reviewer judges the rest.
- Injection lives in `buildInvocation`, not in `loadAgents`, so the scripts that call `runStep` without `loadAgents` get the rules too.
- The CLI may keep the system prompt of a resumed session. No flag was added for it.
- The check covers task diffs and commit messages. The documents the phases write (README, runbook, API docs, ADRs, technical spec) are not checked by it; they follow the rules through the prompt only. This is an open decision (see BACKLOG, "From the global agent rules").

## Verification

- Before the change, on the same tree: root 2983 passed and 1 failed (the guard test of the role files, which the change makes pass); web 555 passed.
- After the change: root 272 files and 3056 tests passed, 7 skipped (the same skips as before); web 50 files and 555 tests passed; web build passed; `npm run typecheck` passed.
- New tests: `test/agents/global-rules.test.ts`, `test/validators/language.test.ts` (25 cases), `test/infra/agent-funnel.test.ts` (the only callers of the agent spawn are the step runner and one probe), and one `it.each` over every step kind that checks the rules come first.

## Not done

- `docs/guia` is not edited: a change there fails `test/chat/guide.test.ts` until `task guia:grafo` runs with the platform up.
- `ERROR_RULES` stays in Portuguese, and the Portuguese identifiers the platform writes into target repositories stay as they are. Both are backlog items.
