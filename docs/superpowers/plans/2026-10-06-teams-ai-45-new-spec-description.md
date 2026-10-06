# Plan 45 - Describe the project or the new spec when creating it

Status: proposed, waiting for approval. Roadmap item R9.7.

## Goal
Smaller than first drafted (human, 2026-10-06: "do not change much, only improve usability"). Two cases:
1. **New project from scratch** and 2. **new spec in an existing project**: the user writes a detailed description in a text
   area while creating; the existing refinement (agents validate, ask questions, propose patches) does the rest.

## What already works (no change)
- New spec already loads project.md, brief/stack/flow/design of `origin/main` into the draft (`createFromRepo`, `draft.ts:127`).
- The agents already validate the docs and keep asking questions; the human accepts patches.
- No new file (`spec.md` dropped), no prompt changes, no change to what Phase 0 copies to `main`.

## Change
1. **API:** `POST /api/projects` and `POST /api/projects/:id/specs` accept an optional `description` (string, trimmed, max
   ~20 kB). Registry `newProject` / `newSpec` pass it to the draft creation.
2. **Draft:** the description is written at the top of the draft `brief.md` as a `## Description` section (new spec:
   above the blank template; new project: above the project brief template). Empty description = today's behaviour.
3. **UI:** a "Descrição (opcional)" text area with a pt-br hint in the "Novo projeto" dialog and next to the ID in
   "Nova spec" (`Projects.tsx`), sent through `refineApi` (`web/src/api.ts`). After creating, the refinement page opens
   on the `brief.md` tab, where the text is.
4. **Tests first:** `test/refine/draft.test.ts` (description lands in brief.md; empty keeps the template),
   `test/api/refine-api.test.ts` (both POSTs, size limit), `web/src/pages/Projects.test.tsx` (field is sent).

## Open point
- A free `## Description` section in `brief.md` must not break the derive step or the brief validators; the PO agent reads
  the docs as text, but this is checked with a test and one real evaluation in the browser before calling it done.

## Verify
`npm test` for the files above, `npm run test:web`, then in the browser: create a spec with a description on `hello-d12`
and see it in the brief tab; click Avaliar once (spends a little quota) and check the agents use it.
