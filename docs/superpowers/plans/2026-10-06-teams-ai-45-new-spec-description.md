# Plan 45 - Describe the project or the new spec when creating it

Status: done (2026-10-06), with the two follow-ups below. Roadmap item R9.7.

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

## Follow-ups done in the same plan (human approved, 2026-10-06)
- **Overlapping patches:** accepting a patch now drops the pending patches it made stale (journal `PATCH_DROPPED`), and the
  conflict message is in Portuguese (`server/refine/session.ts`). Before, PO and SM edits to the same text left red
  "no longer applies" errors on click.
- **Blank stack.md / flow.md are filled by the SM on the first evaluation**, with no question to the human: the SM prompt
  asks for one patch per blank file (`server/refine/packs.ts`) and `runCycle` writes it straight away when the file still
  equals the template (`server/refine/cycle.ts`, journal `DOC_EDITED` with source `autofill`). The PO is told not to touch them.
- Checked live on a throwaway project: both files filled, no question about them, the Mermaid fence kept. The first
  evaluation of that project failed once in the Front agent step ("no JSON object in the agent result") and passed on the
  retry; not reproduced, cause not established (the failed text is stored cut at 500 characters).
