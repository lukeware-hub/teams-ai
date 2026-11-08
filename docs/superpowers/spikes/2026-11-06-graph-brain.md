# Spike: the graph as the brain of Teams AI (2026-11-06)

What was checked before writing the code of the brain, with the real graphify of the container and the real data of the hello-word project.

> The global brain was removed on 2026-11-08: it merged projects that were never queried together, and the per-project graph covers what the agents use. Section 1 is kept only as a record.

## 1. Merging project graphs into one global graph

`graphify merge-graphs` over the project graphs of `hello-word` (1285 nodes) and `live-skill` (285 nodes) gave 1570 nodes and 2342 edges.

- Every node id gets the folder name of its input graph in front: `hello-word::hello-word::docs_api`. The first part is the project, the second is the repository tag the project graph already had. All 1570 ids are unique, so projects never collide.
- The `repo` field keeps the old repository tag. For a project whose own repository has the same name as the project, `repo` equals the project. So the project of a node is the first part of its id, never `repo`.
- 30 nodes had no `repo` (the project description nodes).

Decision: the global brain stages each project graph under the folder name of the project id and reads the project of a node from the first part of its id.

## 2. Links from notes to code

`graphify update` makes a `references` edge from a Markdown heading to a code symbol only when the Markdown file and the code are extracted in the same folder. With the notes in the same folder, the heading `T1 registrar nome` linked to `NewHandler()` and `.Greet()`. A file name in backticks (`handler.go`) did not link by itself.

Extracting the notes and the code in separate folders and merging the two graphs gave zero links between them (7 nodes, 6 edges, 0 across).

Decision: the notes are plain Markdown nodes, and a small step of our own adds the `references` edges after the merge: each task note points to the file nodes of its `affectedPaths` and `changedFiles`, found by `source_file`. This does not depend on how graphify reads backticks, and a missing file only means a missing edge.

## 3. Events for the run history

The run journals (`events.ndjson`) of hello-word hold, among others: `RUN_STARTED` (spec), `RUN_FINISHED` (result, reason, blocked), `TASK_PLANNED` (title, description, criteria, affected paths), `TASK_STATE_CHANGED`, `TASK_BLOCKED` (reason), `DEV_COMMITTED` (summary, changed files), `PR_MERGED` (handoff), `PHASE_FAILED` (reason), `VERIFICATION_FAILED` (uncovered criteria), `DEPLOY_FAILED` (stage, detail), `REPORT_READY` (result). These are the sources of the history notes. Costs come from `server/usage/cost-facts.ts`.

## 4. Size

The project graph of hello-word is about 1.2 MB. The merge of two projects took a few seconds and wrote about 1.6 MB. The notes are text with a cap per kind, so they add little next to the code nodes.

## 5. Reading by the agents

The deny rules of the step settings cover only the credential stores and the step home (`role-settings.ts`), not the workspaces folder. The agents already run `graphify query` against the repository graph under the workspaces folder (33 calls seen), so they can read the project graph and the global graph in the same area.
