# Plan 116 - Global agent rules for every project teams-ai builds

## Context

The agents of teams-ai build software for target projects. Their rules lived in three places: a language line in each role file, `QUALITY_RULES` and `ERROR_RULES` appended by `loadAgents`, and `QUESTION_RULES` on stdin. The owner asked for one central set of global rules, mandatory for every agent in every project, that outranks project instructions, agent files, skills and owner decisions. On 2026-10-30 the owner added rules on accuracy, official sources, faithful behavior, communication, documentation sync, tests and a checklist, and changed the language policy: code in 100% English, project documents in Brazilian Portuguese.

## Built

- **One place for the rules.** `server/agents/global-rules.ts` exports `GLOBAL_RULES` (eight numbered rules and a final directive, in English, because the constant is code) and `SKILL_NOTICE`.
- **One injection point.** `buildInvocation` writes `GLOBAL_RULES` before the role text in the definition file that `--agents` reads. Every step of every kind and every project goes through it. `agentDefinition` and `agentsPath` are required; a call without them throws.
- **The language line left the role files.** The eight `.claude/agents/*.md` no longer name a language, and `parseAgentFile` rejects a role file that does.
- **Skills carry a notice.** `copySkill` puts `SKILL_NOTICE` after the frontmatter of every installed `SKILL.md`: pinned skills, the first-party language skills and the SM's private drafts.
- **A language check for the reviewer.** `server/validators/language.ts` reads the added lines of the task diff (`git diff -U0 origin/main...HEAD`) and the task's commit messages, and renders the Portuguese it finds as hints in the review pack, under "Language check". It never blocks a task.
- **ERROR_RULES in English** (2026-10-30): the error rules are technical text the code gives the agents, so rule 7 covers them.
- **Two pack texts follow the rules.** The readme step asks for Brazilian Portuguese headings (for example Executar, Testes, Variáveis de ambiente, Arquitetura, Pipeline), which the docs gate already accepts; owner decisions are followed within the global rules.

## Decisions taken while building

- The check flags a diacritic inside a word, or one of 27 Portuguese words, on added lines only. URLs, hashes and encoded blobs are skipped. Markdown documents are exempt, together with locale folders, snapshots and lock files. The check covers code and commit messages.
- Recall is limited: the check catches accented Portuguese and the listed words, and misses Portuguese written in plain ASCII without them. It is a tripwire; the reviewer judges the rest.
- Injection lives in `buildInvocation`, not in `loadAgents`, so the scripts that call `runStep` without `loadAgents` get the rules too.
- The CLI may keep the system prompt of a resumed session. No flag was added for it.
- **Language policy, 2026-10-30:** project documents (README, runbook, API docs, ADRs, technical spec and the owner's documents) are Brazilian Portuguese. This replaces the earlier rule that technical documents are English. Code and commit messages stay English. The check does not cover documents, so the open question about the documents the phases write is closed.
- **Coverage:** the 90% target is an instruction to the agents (rule 6). The platform's coverage gate still uses 80% (`MIN_LINE_COVERAGE_PCT` in `server/exec/coverage.ts`). Raising it changes the approval of every project, so it waits for the owner's decision.

## Verification

First delivery (commit 5eeadbe6):

- Before the change, on the same tree: root 2983 passed and 1 failed (the guard test of the role files, which the change makes pass); web 555 passed.
- After the change: root 272 files and 3066 tests passed, 7 skipped (the same skips as before); web 50 files and 566 tests passed; web build passed; `npm run typecheck` passed.
- New tests: `test/agents/global-rules.test.ts`, `test/validators/language.test.ts`, `test/infra/agent-funnel.test.ts` (the only callers of the agent spawn are the step runner and one probe), and one `it.each` over every step kind that checks the rules come first.
- End to end: `test/orchestrator/loop.test.ts` runs a whole plan with the real agent files, real git and the fake claude. Every step writes an agent definition that starts with the global rules, and the reviewer's pack lists the Portuguese the task adds. `test/orchestrator/task-runner.test.ts` checks the same pack with real git.
- Deployed locally from a clean export: the container runs the new code, `/healthz` answers 200, and no agent process was running at recreate time. The previous image is kept as `teams-ai:rollback-pre-global-rules`.

Eight-rule change: see the commit that records this section.

## Not done

- `docs/guia` is not edited: a change there fails `test/chat/guide.test.ts` until `task guia:grafo` runs with the platform up and a valid Claude login.
- The live check with the real model is blocked: the Claude OAuth session in the container expired, so `claude auth status` still reports logged in but a real call fails. The owner renews it with `task login:claude`.
- The coverage gate stays at 80%, pending the owner's decision (see Decisions).
- The Portuguese identifiers the platform writes into target repositories (the `-ajuste` spec keys and the `Ajuste aprovado:` heading) stay as they are. A rename breaks existing keys, branches and owner documents, so it needs a compatibility plan and the owner's decision.
- Portuguese UI copy and Portuguese file names in teams-ai stay as they are; they were kept out of the plan when it was approved.
