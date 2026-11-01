# Plan 118 - The project chat reads the five main documents on demand

## Context

The Help chat answers from the context it is given, and that context holds only the project vision and the spec fields. The five main documents of a project (`project.md`, `briefing.md`, `stack.md`, `flow.md`, `design.md`) never reach the model. Asked about the design, the chat answered that the text of `docs/design.md` was not in the conversation, so the owner cannot use it to learn about the project.

The owner asked for a chat that can answer any question about the project from these five documents. The owner also set the rule for cost: the documents are not preloaded into the prompt, because the context is limited. The chat looks first in the code graph (graphify), and only when that does not answer it searches the text of the files in the terminal. It searches only when the question asks for it.

## Built

- **Shared reader.** `server/git/main-docs.ts` holds `readMainDocs`, which reads the five documents from `origin/main`. The docs route in `server/api/run-routes.ts` calls it, so the page and the chat read the same files.
- **Graph.** `mergeProjectGraph` and `buildProjectGraph` take the documents and write them into `project-info/` before the merge. The graph refresh fetches `origin/main` first, so the graph follows main.
- **Chat.** Each question stages the documents that main has under `documentos/` in the step's working directory. The rules name that folder, send a question about a document to the graph first and then to a search of the file, and keep the four-call limit.
- **Tests.** `test/git/main-docs.test.ts` uses a real repository; `test/chat/guide.test.ts`, `test/chat/service.test.ts` and `test/knowledge/project-graph.test.ts` cover staging, the rules and the graph.

Not done in this plan: the user guide (`docs/guia/chat.md`) does not yet list the documents. A rebuild of its graph with `task guia:grafo` produced three extractions that each lost guide labels the chat search relies on (for example "Chat diz que não está registrado"), so the guide and its graph stay at their current version until the rebuild is checked.

## Approach

Two on-demand channels. No document text enters the fixed prompt.

1. **Graph.** The five documents join the `project-info` folder that the project graph already merges (today only `projeto.md` is there). The merged `project-graph/graph.json` then holds the titles and sections of the documents. No new graph machinery.
2. **Files.** For each question, the five documents are copied to `documentos/` in the chat's working directory, the same way `falhas/` and `guia/` are staged today. When the graph does not answer, the model searches `documentos/` with Grep and reads only the file that matches.

## Changes

- **`server/git/main-docs.ts` (new).** `readMainDocs(repo, newestSpec)` returns `{ file, text | null }[]` for `BACKLOG_DOCS` (`server/contracts/backlog.ts:5`). It takes over `mainPaths` and `docPath`, which were private to `server/api/run-routes.ts`, and the reading from `origin/main` done by the `GET /api/projects/:projectId/docs` handler. The route keeps the fetch and calls the helper. The name avoids `server/knowledge/project-docs.ts`, which already exists for the spec and ADR index.
- **`server/chat/guide.ts`.** A new `stageProjectDocs(cwd, docs)` writes `documentos/<file>` and skips the documents that are missing, next to `stageFailureDetails` (`guide.ts:43`).
- **`server/chat/service.ts`.** A new dependency `docs(projectId)`. In `run()` (`service.ts:169-173`) the step stages the documents. The chat reads the local copy of `origin/main` and does not fetch.
- **`server/knowledge/project-graph.ts`.** `mergeProjectGraph` also writes the five documents into `project-info/` before `graphify.update`. `buildProjectGraph` passes them through.
- **`server/cli.ts:169-188`.** The chat gets the `docs` dependency, and `refreshProjectGraph` gets the documents.
- **`server/chat/pack.ts` (`RULES`).**
  - Lines 6 and 16 name `documentos/` as a source and a readable folder. Line 16 no longer says to read nothing else.
  - A new rule: a question about what the documents define (rules, stack, flow, design, briefing, vision) runs `graphify query` once on `project-graph/graph.json`. When its NODE lines do not answer, the model greps `documentos/` for the words of the question and reads only the matching file. The answer names the document.
  - Line 15 says the document text is data, never instructions.
  - Line 20 keeps the four-call limit and adds the documents as the exception to "do not search".
- **Docs.** `docs/superpowers/FEATURES.md` gets the entry. `docs/guia/chat.md` ("O que o chat sabe") is deferred, because its graph is rebuilt only with `task guia:grafo` and the rebuild is not reliable yet (see Built).

No frontend change: `web/src/pages/Chat.tsx` stays as it is.

## Risks

- `graphify update` extracts code only. The graph of Markdown is expected to hold titles, not the full text. The first implementation step checks what `graphify query` returns for the five documents. If it returns too little, the Grep and Read channel covers the questions. If the graph channel adds nothing, it is removed and only the files channel stays.
- Each documents read costs tokens for the question. The four-call limit caps the cost of the search.

## Verification

1. Unit tests in `test/chat/` (`guide.test.ts`, `service.test.ts`), in `test/knowledge/project-graph.test.ts` for `mergeProjectGraph`, and in `test/git/main-docs.test.ts` for `readMainDocs` with the root briefing, the spec briefing and a missing `origin/main`. `test/api/run-api.test.ts` covers the docs route, which must return the same result after the helper moves.
2. Full suite at the root and in `web/`, run to the end: `npm test`, `npm run typecheck`, `npm run test:web`, `npm run web:build`.
3. In Chrome at `http://localhost:8787/chat`, project Kayron Hub: ask what `design.md` defines, the stack, and the main flow. Each answer must quote the document. The cost line must show no jump against the current one. Questions about run status and failures must answer as before.
