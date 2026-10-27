# Plan 96 - A save states the hash it was typed over

## Context

The refinement page saved a document with its whole text and no check. A change made by something else in the meantime, such as an accepted patch or a later automatic step, was overwritten by a save typed over an older copy. Step 2 of plan 95 closes this before any automatic change exists.

## Change

1. The snapshot carries the sha256 of each document as it is on disk (`hashes`, `server/refine/session.ts`).
2. `PUT /api/refine/:projectId/:specId/docs/:file` takes `baseHash`. A stale hash is a 409 with the message "O documento mudou desde que você o abriu. Recarregue a página antes de salvar."; nothing is written. A save without `baseHash` keeps the old behaviour (`server/api/refine-routes.ts`).
3. The save returns the hash of the file it wrote. The page keeps that hash as the base of its next save, and resets the bases from every snapshot, so two saves in a row never conflict with the page's own first save (`web/src/pages/Refinement.tsx`).

## Verification

- Unit tests: the session keeps the text of a file another change moved (`test/refine/session.test.ts`), the API answers 409 and 400 (`test/api/refine-api.test.ts`), and the page sends the hash it had, then the one the save returned (`web/src/pages/RefinementPage.test.tsx`).
- Full root and web suites, exit 0: root 251 files and 2809 tests; web 48 files and 510 tests.
- The live container was recreated from a clean export of commit b5080f92 plus this change. On the live draft `kayron-hub-001`, a save with a stale hash returned 409 and left the file as it was. In Chrome, the same conflict forced through the page showed the message in the top banner, and the file's hash was the same before and after the test. The test was recorded as a GIF, `cas-conflito-salvar-flow-md.gif`.
- A successful save, over real HTTP, on a temporary server: the save with the hash the page read is written, and the answer carries the hash of the file as saved (`test/api/refine-api.test.ts`).
- Not exercised on the live draft: a successful save. It would change the owner's draft, and a document save marks the later stages stale. Covered by the unit tests and the HTTP test above.

## Not in this plan

- The scope flag of the patch proposals, which came next (plan 97).
- After a conflict the owner's unsaved text stays in the editor until the page reloads. The owner copies it before reloading.
