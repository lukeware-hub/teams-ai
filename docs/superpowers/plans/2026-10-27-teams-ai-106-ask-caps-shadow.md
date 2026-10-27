# Plan 106 - The ask caps are measured in shadow before any enforcement

## Context

Increment 7 of the autonomy plan (approved 2026-10-27): the ask policy, one cap per Spec Kit command, per stage review and per full round, measured first and enforced later. The live journal shows the owner receives many questions per run, and plan steps ask most of them.

## Change

1. **The caps and the count.** `server/refine/ask-caps.ts` holds `ASK_CAPS` (constitution 0, specify 3, clarify 5, plan 0, tasks 0, stage review 3, round 5), reads the runs that asked (`askedRuns`) and counts each run against its cap (`capCounts`). A Spec Kit question counts once, on its first id, as the owner sees one card per id. A stage review and a round count every question they journaled. Blocking questions are never capped.
2. **The measurement.** `scripts/evals/refine-replay.ts` prints one block per scope after the resolver report: the runs, how many went over the cap, the non-blocking questions, and how many would move to recorded decisions. The script also refuses a missing journal path: before, `loadEvents` read a missing file as an empty journal, so a wrong path printed zeros and exited 0.
3. **No runtime change.** Nothing in the server reads the caps. The measurement reads the events the steps already journal, so it needs no new event.

## Measurement (live journal, read-only copy, 2026-10-27)

| Scope | Cap | Runs | Over cap | Non-blocking | Would move |
|---|---|---|---|---|---|
| constitution | 0 | 4 | 4 | 11 | 11 |
| specify | 3 | 35 | 16 | 124 | 49 |
| clarify | 5 | 43 | 9 | 155 | 33 |
| plan | 0 | 67 | 67 | 198 | 198 |
| tasks | 0 | 15 | 15 | 110 | 110 |
| stage review | 3 | 19 | 13 | 86 | 39 |
| round | 5 | 6 | 1 | 19 | 3 |

- Spec Kit: 598 non-blocking questions, 401 would move (67%). The autonomy plan's earlier replay said 487 of 604. This count is per run with each id counted once, so the two numbers measure different things.
- `plan` and `tasks` at cap 0 account for 308 of the 401.

## Decisions the owner takes before enforcement

- **plan and tasks at cap 0.** The upstream Spec Kit asks nothing there, so 0 matches the templates. The pack asks for every marker in every command (`speckit-pack.ts:65`), so enforcing 0 would turn most owner questions into recorded decisions. This is the largest change the caps would make.
- **constitution at cap 0.** The upstream asks in the constitution (`constitution.md:33` and `:99`), so 0 conflicts with the templates. The autonomy plan's 0 stands until the owner decides.
- **stage review 3 and round 5.** No upstream source exists. The numbers come from the autonomy plan and stay tunable.

## Deviations

- The effort A/B and the change to the interview skill in `po.md:53` and `sm.md:19` are not in this increment. Both change what the agents do, so they need real runs on a scratch project, and the time (about 44 minutes per item at max effort) needs the owner's go-ahead.

## Verification

- Typecheck, which includes `scripts/evals`. `test/refine/ask-caps.test.ts`: 7 tests on synthetic events only.
- The replay on the live copy exits 0 and prints the table above. A missing path exits 2.
- Full root and web suites: exit codes recorded in the commit.
