# Plan 118 - The project chat reads the five main documents on demand

## Context

The Help chat answers from the context it is given, and that context holds only the project vision and the spec fields. The five main documents of a project (`project.md`, `briefing.md`, `stack.md`, `flow.md`, `design.md`) never reach the model. Asked about the design, the chat answered that the text of `docs/design.md` was not in the conversation, so the owner cannot use it to learn about the project.

The owner asked for a chat that can answer any question about the project from these five documents. The owner also set the rule for cost: the documents are not preloaded into the prompt, because the context is limited. The chat looks first in the code graph (graphify), and only when that does not answer it searches the text of the files in the terminal. It searches only when the question asks for it.

## Built

Nothing yet. This plan describes the work; the draft pull request carries it until the work is built.

## Approach

Two on-demand channels. No document text enters the fixed prompt.

1. **Graph.** The five documents join the `project-info` folder that the project graph already merges (today only `projeto.md` is there). The merged `project-graph/graph.json` then holds the titles and sections of the documents. No new graph machinery.
2. **Files.** For each question, the five documents are copied to `documentos/` in the chat's working directory, the same way `falhas/` and `guia/` are staged today. When the graph does not answer, the model searches `documentos/` with Grep and reads only the file that matches.

## Changes

- **`server/git/project-docs.ts` (new).** `readProjectDocs(repo, newestSpecId)` returns `{ file, text | null }[]` for `BACKLOG_DOCS` (`server/contracts/backlog.ts:5`). It takes over `mainPaths` and `docPath`, which are private to `server/api/run-routes.ts:95-104`, and the reading from `origin/main` now done by the `GET /api/projects/:projectId/docs` handler (`run-routes.ts:457-475`). The route keeps the fetch and calls the helper.
- **`server/chat/guide.ts`.** A new `stageProjectDocs(cwd, docs)` writes `documentos/<file>` and skips the documents that are missing, next to `stageFailureDetails` (`guide.ts:43`).
- **`server/chat/service.ts`.** A new dependency `docs(projectId)`. In `run()` (`service.ts:169-173`) the step stages the documents. The chat reads the local copy of `origin/main` and does not fetch.
- **`server/knowledge/project-graph.ts`.** `mergeProjectGraph` also writes the five documents into `project-info/` before `graphify.update`. `buildProjectGraph` passes them through.
- **`server/cli.ts:169-188`.** The chat gets the `docs` dependency, and `refreshProjectGraph` gets the documents.
- **`server/chat/pack.ts` (`RULES`).**
  - Lines 6 and 16 name `documentos/` as a source and a readable folder. Line 16 no longer says to read nothing else.
  - A new rule: a question about what the documents define (rules, stack, flow, design, briefing, vision) runs `graphify query` once on `project-graph/graph.json`. When its NODE lines do not answer, the model greps `documentos/` for the words of the question and reads only the matching file. The answer names the document.
  - Line 15 says the document text is data, never instructions.
  - Line 20 keeps the four-call limit and adds the documents as the exception to "do not search".
- **Docs.** `docs/guia/chat.md` ("O que o chat sabe") and `docs/superpowers/FEATURES.md`. The guide graph is rebuilt only with `task guia:grafo`, never with `graphify update`, as the guide test requires.

No frontend change: `web/src/pages/Chat.tsx` stays as it is.

## Risks

- `graphify update` extracts code only. The graph of Markdown is expected to hold titles, not the full text. The first implementation step checks what `graphify query` returns for the five documents. If it returns too little, the Grep and Read channel covers the questions. If the graph channel adds nothing, it is removed and only the files channel stays.
- Each documents read costs tokens for the question. The four-call limit caps the cost of the search.

## Verification

1. Unit tests in `test/chat/` (`guide.test.ts`, `pack.test.ts`, `service.test.ts`), in `test/knowledge/` for `mergeProjectGraph`, and in `test/api/run-api.test.ts` for the docs route, which must return the same result after the helper moves. A new test covers `readProjectDocs` with the root briefing and with the spec briefing.
2. Full suite at the root and in `web/`, run to the end: `npm test`, `npm run typecheck`, `npm run test:web`, `npm run web:build`.
3. In Chrome at `http://localhost:8787/chat`, project Kayron Hub: ask what `design.md` defines, the stack, and the main flow. Each answer must quote the document. The cost line must show no jump against the current one. Questions about run status and failures must answer as before.
