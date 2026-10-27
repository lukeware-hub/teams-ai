# Plan 98 - A Spec Kit step repairs what it left out, and one item's failure stops only its own lane

## Context

Step 3 of plan 95. On `kayron-hub-001`, 20 of the 26 Spec Kit preparations failed the same way: a plan step left acceptance criteria out of its file, the run stopped, and the owner had to press "Tente de novo". The first failing item also stopped every lane of the preparation (a shared halt flag), so one item's failure held back all the others. Not one of the 26 preparations completed.

## Change

1. **Repair.** A step whose file leaves out acceptance criteria of its item runs again, up to two times, with the file and the missing ids named in its note (`server/refine/speckit.ts`, `runStep`). Each repair is journaled as `SPECKIT_STEP_REPAIRED` with its file, its ids and its number. After the second repair the step fails with the message the owner has always read.
2. **Lane isolation.** A failed step stops its own item's lane only. The other items run on, and their finished steps stay for the next run. The preparation fails once every lane has ended, and `SPECKIT_FAILED` lists each failure in `failures`: the command, the item, the kind (`agent`, `blocked`, `open-markers`, `dropped-criteria`, `files-missing`, `feature-missing` or `internal`), the reason and the detail. The reason is still the first failure's message; with more than one, it says how many other steps stopped too.
3. The reducer keeps `failures` as an optional field of the speckit state (`server/refine/state.ts`). Journals written before this change have none, and read as before.

## Deviations from the plan

- **Tier escalation on the third failure (decision D4) is not in this step.** It changes the model pinned for the project (`steps.ts`), which is the tier work of plan 95's roadmap. The repair fails with the same message as before after its two repairs.
- **The legacy-journal shim (`kindOfLegacyReason`) is not in this step.** Nothing reads the kind yet; the heal driver (step 4) is its first reader and brings the shim with it.
- **Tests:** the plan named three tests to update (:761, :920, :999). Eight changed, all for the same reason: the other items now run on to their end, so the calls, the last finished step and the resumed calls differ. Each of the eight keeps its intent; one new test covers a repair that works on the second attempt.

## Review

A read-only workflow reviewed the diff: two reviewers and one verifier. It gave eight candidate findings, and the verifier confirmed all eight. Fixed here:

- The note of a repair was lost when the dropped run also had answers, because the answer round continued before the note was set. The note now names the missing ids to the next run whichever way it is reached.
- An abort was not checked before a repair or an answer round, so a stopped preparation could start another agent run.
- An abort rethrew at once, so the failures other items had already recorded were dropped from the reason. A failure recorded before an abort is now the one reported, as it was before the lane isolation.
- The preparation could settle while another lane was still running after an abort. Every lane now ends before the preparation does.
- A failed constitution step was not listed in `failures`.
- No test covered the reason with several failures, the abort, or a repair that carries an answer. Each has a test now, and the name of one test said the opposite of what it proves.

Found and not fixed here, pre-existing: a finished step reused from an earlier preparation skips the criteria check, so a criterion added later passes. It is a bug item in `docs/superpowers/BACKLOG.md`.

## Verification

- The Spec Kit test file, with the eight updated expectations described above, and the state, session, cycle and stage tests: green.
- Full root suite: 251 files, 2814 tests, exit 0. Full web suite: 48 files, 510 tests, exit 0.
- Not checked in Chrome: the Spec Kit screen shows the same reason and detail, so there is no visual change to check.
