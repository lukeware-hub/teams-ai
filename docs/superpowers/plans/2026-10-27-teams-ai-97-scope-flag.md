# Plan 97 - A patch proposal states whether it changes scope

## Context

Step 2 of plan 95 needs a guard for patches that add or remove structure: a heading, a list item, an acceptance criterion id, a priority or a dependency line. Before any patch is applied on its own, the journal must say which proposals change scope. On the live journal of `kayron-hub-001`, 114 of the 313 proposed patches change structure, and 112 of the 306 the owner accepted are among them.

## Change

1. `server/refine/scope-guard.ts`: `structureOf(text)` lists the structure of a document, and `patchChangesScope(find, replace)` tells whether replacing one with the other adds or removes any of it. Repeats count, so a duplicated item is a change too. A list item edited in place counts as one removed and one added, which is the conservative reading.
2. Every `PATCH_PROPOSED` event carries `scopeChange`: the design patches of the front agent, the design heading fixes, the patches accepted for an adjusted spec, the approval of an adjustment, and the stage review proposals. The reducer copies it into the patch row as an optional field (`server/refine/patches.ts`).
3. Nothing reads the flag yet. Patches apply exactly as before.

## Verification

- Unit tests of the guard (`test/refine/scope-guard.test.ts`) and of the stage review that proposes a changed heading (`test/refine/stage-cycle.test.ts`). The proposal tests of the cycle, the state and the stage alignment stay green.
- Replay on the local journal: 114 of 313 proposals change scope; 112 of the 306 accepted ones are among them.
- Full root and web suites, with the real exit codes recorded in the commit.

## Not in this plan

- Applying the safe patches on their own, which reads this flag (plan 95, step 12).
- The scope fingerprint of the backlog (plan 95, step 2, later part).
