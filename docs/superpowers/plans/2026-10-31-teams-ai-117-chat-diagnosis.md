# Plan 117 - The project chat explains what blocks a spec, from the recorded facts

## Context

The Help chat could not say why a spec of a real project had stopped. Asked five times about one stuck spec ("which impediment?", "what is the cause and the reason of the errors?", "which tools failed to install?", "investigate", "and how do I fix it?"), it answered that the context did not say. The journals did say: the install gate failed with `go.mod requires go >= 1.27.3`, and the record of the first block was a git worktree error. The chat saw only the task titles and states, cut at 240 characters, and it repeated a replan description written by an agent ("the tools installation failed") as if it were the cause. It also named a run that the resume rule refused, because it did not look at which run leads the spec.

The owner asked for a chat that explains what really happens and how to proceed, in plain words; that searches the project's own records and, when needed, researches to detail an error; that never invents. The owner also asked whether the agents record errors in enough detail for the chat to collect them.

## Built

- **One place for the plain-language stop rules.** `server/orchestrator/stop-explain.ts` holds the rules that name a run or task stop, its owner and its next step. The web selectors re-export them, so the run and validation screens did not change. A failed install of the verification gate has its own rule.
- **The chat reads the recorded failures.** `server/chat/failures.ts` builds, from one read of the journal, a digest for the context (status, causes ranked by the tasks they hold and the tasks waiting, the owner's pending question, the run stop, the replanned tasks with their recorded cause, the verification gaps, the earlier runs) and a detail file per spec (`falhas/<spec>.md`) that the chat can search.
- **Every run status has its words.** `server/chat/status.ts` covers the sixteen statuses; a stopped run says so. The run that can resume leads the spec's section.
- **Grounded answers.** `server/chat/pack.ts` makes the recorded facts outrank agent text, asks for a three-part answer to a problem, says when a fact is not recorded, and allows four tool calls per question.
- **One web search per question, for a recorded error.** `server/runner/step.ts` gives a step the `WebSearch` tool and its allow rule when it asks for them; `server/chat/web-access.ts` refuses confidential projects and refinements that have not answered the question; `server/chat/sources.ts` keeps only the addresses the search returned and ends the answer with them. An answer that searched opens no correction.
- **Records that say why.** A failed phase 4 gate keeps its exit code, its time and the end of its output; an environment failure of an agent reruns under its own name and keeps its cause; a step that printed nothing says how it ended; a replan opens each replacement with the cause its attempt history states; the scope check ignores the sandbox build cache under `.tools`; the budget event keeps its numbers; an unexpected error is masked before it is journaled.
- **Help and docs.** The help beside the chat, the user guide (`docs/guia`, with a rebuilt graph), the README, FEATURES item 16 and the backlog.

## Decisions taken while building

- The focus run is the one holding the spec, unless it stopped and a later run exists: only the latest run of a spec resumes.
- A replanned task's cause is the last attempt feedback recorded before its replan. The Scrum Master's description goes only to the detail file, under a label that says it is an agent's text.
- Limits: quotes 350 characters in the digest and 1,800 in the detail file; a spec's digest takes at most 5,000 characters and at least 1,200; a detail file takes 20,000; the detail names five earlier runs, the digest three.
- The confidentiality check fails closed: a record that cannot be read counts as confidential.
- The chat keeps Haiku. The spike ran `claude -p --model haiku` with `WebSearch` only and the subscription login: one search, a sourced answer, US$ 0.014 for the spike question including the search.
- The shared module lives in `server/orchestrator/`, outside the Docker layers that install the pinned skills, so a change to it does not start a network install at build time.
- Two names differ from the first draft: `pairDecisions` became `ownerAnswer` (the pairing core, now reused by the run routes), and `confidential.ts` is `web-access.ts`.

## Verification

- `npm run typecheck`: passed.
- Root suite (`npx vitest run`): 278 files, 3146 tests passed, 7 skipped (3153), exit 0, at the final commit of the branch, after the second review.
- Web suite (`npm run test:web`): 50 files, 578 tests passed.
- Web build (`npm run web:build`): passed (`tsc --noEmit` and the Vite build).
- Guide graph: rebuilt with `task guia:grafo` against the running platform; `test/chat/guide.test.ts` passes. The first rebuild produced English node labels, which the Portuguese search does not match; the second one produced Portuguese labels and was kept.
- Web search spike: `claude -p --model haiku --tools WebSearch --settings <WebSearch only> --permission-mode dontAsk` inside the platform container answered with one `WebSearch` call and its sources.
- Live check on the real platform (the container of the local compose, rebuilt from a clean export of each commit, with no agent step running at each deploy): the new code is served, `/healthz` answers, the rollback image is kept as `teams-ai:rollback-pre-chat-failures`. Five plan questions and five more were asked through the chat API, then the chat history of the real project was restored byte for byte from its backup.
  - Pass: the answer names the latest run and its stop reason, the blocked tasks, the next step and who acts; a question with no recorded answer says so and names the record that would hold it; a count is the whole count (fifteen runs with a failed verification, one with a failed phase, two interrupted, from eighteen runs); no invented owner question remained after the origin labels were added.
  - Partial: a question about a failed install named the most similar recorded failure of an earlier run, not the Go toolchain error of run 14, which is in the record file of the spec. The answer said so and did not invent a cause.
  - Web search: an explicit request searched the web once, and the answer ended with the server-built sources; the page shows the sources as links and the usage line.
- Chrome check (desktop width, 1538 px): the chat page shows the three labelled paragraphs, the sources list, the usage line and the new help text on hover. Phone width was not checked in this session.

## Not done

- The golden questions of the evaluation (the real project's questions, with the facts each answer must hold) are run on the live platform and reported in the pull request; they are not automated.
- Full gate output is still not kept once its container is removed: a log store is a separate change.
- The worktree "already exists" failure of a real project repeats and its root cause is not known (see the backlog).
- The web search queries are checked by the rules and by a log line, not by a code filter.

## Status after the second round (2026-10-31)

Done since the first delivery:

- The web search check is `isConfidential` in `server/chat/confidential.ts`, wired as `ChatDeps.confidential`; a failing or missing check means no search.
- `failureReport` and `readRun` replace `failuresOf` and `tasksOf`; the report is built in tiers so the facts survive a tight budget; the digest holds a total budget across the specs in play, and a spec left without room keeps a pointer to its record.
- Each cause says since when it holds its tasks and how many attempts it spent; a question waiting for the owner says it came from an agent; a reopened run is counted; a failed phase reads in plain words; a verification names the gate beside it; the earlier runs' verification failures are named in the digest.
- `pairDecisions` is the shared pairing for the run screen and the chat.
- Tests added for every item above, the three record fixes not yet covered, the confidentiality check, the staging of the record and the denied paths. The build cache under `.tools` was seen failing without its fix and passing with it.
- Full suites on the committed head: root 279 files / 3165 tests passed, 7 skipped; web 50 files / 578 tests passed; web build and typecheck passed; `test:budget` exited 0 with its local over-budget notice.
- Live: the new image deployed from a clean export; the chat answers 30 golden questions three times (see the results below); the chat page renders at 390 px and 1440 px with no horizontal overflow and no page errors.

Not yet done, against the plan:

- A question about why an install failed does not yet surface the recorded `go.mod requires go >= 1.27.3` cause of run 14 in 3 of 3 answers. The detail file holds it; the digest names only the verification line of run 15.
- A question with no recorded answer ("quanto tempo falta?") says it is not recorded in 3 of 3 answers but does not name the record that would hold it in any of them.
- One answer in the first round of 30 had no labelled paragraphs.
- The fixes W1 to W4 and W7 were not seen in a live failing run; they are covered by tests only.
- The branch is pushed as a draft; `/code-review low` runs only when the development is complete, so it has not been run on the last commits.

## Status after the third round

- The install cause is now in the answers: the recorded `go.mod requires go >= 1.27.3` cause of an earlier run (a block replanned later kept its cause out of the earlier run's record; fixed) is cited in 6 of 6 install answers, and the digest names the earlier verification failures.
- A question with no recorded answer names the record that would hold it in 2 of 3 answers (the third says "o registro" without naming it).
- One answer of 15 in the last round has no labelled paragraphs.
- The W1 to W4 and W7 fixes still have no live failing run; they are covered by tests only.
- `/code-review low` not run: the development is not yet 100% by the criteria above.

## Known limitation (accepted 2026-10-31)

- "Quanto tempo falta para terminar?": the answer says the records hold no forecast, but in 3 measured rounds it did not name the record that would hold one (1 of 3 mentioned a record, without tying it to the forecast). A fixed sentence naming a record was rejected: it could name the wrong record, which the no-invention rule forbids. The rule that asks for the record by name stays in the prompt.
- Otherwise every answer on what happened, why and what to do gives the recorded cause, the owner and the next step; the install cause (`go.mod requires go >= 1.27.3`) appears in 6 of 6 install answers.
