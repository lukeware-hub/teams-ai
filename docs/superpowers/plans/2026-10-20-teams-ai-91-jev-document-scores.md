# Plan 91 - The Jev scores every document and says whether the project is ready to develop

## Context

The owner asked why teams-ai says a project is "ready" when it is not, and asked for a new function on the refinement screen: the Jev reads the documents one by one, averages the scores, and above 80% the project is ready to develop. The verdict is shown highlighted at the top of the screen with the start button enabled.

What the investigation of the live data showed (container `teams-ai-teams-ai-1`, journals copied read-only):

- "Ready" today is decided by Claude grading its own documents: eight PO/SM checklist items, no blocking question, a detailed backlog, a current list (`computeStatus`, `server/refine/state.ts:172`; `canStartRun`, `web/src/refine/ProgramPanel.tsx:59`). After 5 rounds the start opens even with failed items (`released`, `state.ts:204`).
- The Jev already judges the documents every round (six cross-document checks, `server/refine/jev-validation.ts`), but its result is only a hint to the agents ("Automatic and often wrong, never a verdict", `jevHint`). The screen never shows the scores and nothing stops on them.
- `kayron-hub-001`: 34 rounds, US$ 43.87, 688 agent steps. The Jev said `blocked` in all 34 rounds (mean check 0.34 to 0.41, worst check ~0.10). The checklist was green from round 27, so the screen said "ready".
- `agendamento-de-consultas-v4-001`: Jev `blocked` in all 4 rounds (mean 0.22 to 0.34, `stack.md` has 331 characters); the checklist was green, the program ran (US$ 12.74) and its first deploy attempts failed on missing smoke tests and a migrations folder missing from the image, until later fix runs repaired them.
- The Jev numbers on the large project are low partly by construction: 274 thousand characters are read in 9 windows of 32 thousand and the consistency check takes the weakest window (`jev-validation.ts:125`). So the existing six checks are not a fair gate; a per-document score is.

## Reading taken (redirect at review)

1. The gate protects the start of a backlog program (new project, imported backlog). Single-spec flows (new spec, continue) are untouched.
2. Document score = mean of four Jev checks on that document alone. Overall score = mean of the five documents. Ready = overall at or above 80% (rounded to a whole percent, so the number on screen is the number that decides).
3. Below 80% the start stays closed, with no override. The way out is cheap: a new button, "Avaliar com o Jev", scores the current documents without running any agent and without spending a round, so it still works after the round limit. (Alternatives, decided at the checkpoint with real numbers: let the round limit open the start anyway; or an env knob for the percentage.)
4. The score is shown from the first evaluation on, but only gates the start once the backlog exists. The documents-to-backlog step is not gated.
5. Confidential projects never send documents to the Jev: no score, and the start follows today's rules. Sessions older than this feature have no score and keep today's rules until their first score.
6. The existing "Iniciar análise" button stays where it is; the new banner adds its own copy of the button when the project is ready.

## Design

**Rubric** (`server/refine/jev-scoring.ts`). One request per window of one document, four independent yes/no checks, each with explicit criteria, like the current validator. Every check names the document and quotes its charter (`DOCUMENT_PURPOSE`, split out of `server/agents/document-charter.ts` with the charter string unchanged):

| id | Question to the Jev | UI label |
|----|---------------------|----------|
| `complete` | Does the document hold everything its charter says it must hold for this product? A part declared "not applicable" counts as present. | Completo |
| `concrete` | Is every statement concrete and verifiable (exact values, names, limits, observable behavior; no vague words, placeholders or open questions)? | Concreto e verificável |
| `consistent` | Is the document free of statements that contradict each other? | Sem contradições |
| `scoped` | Does the document hold only what its charter assigns to it? | Só o que cabe no documento |

Rules: split each document with `splitSections` (`server/decide/windows.ts`, 32,000 characters like the validator); a check's score is the mean over windows weighted by window length; a window prompt says it sees "part i of n" and must not penalize what lies outside it; an empty document scores 0 with no call; any failed window makes the whole result `available: false` (no partial numbers, same rule as `createJevValidator`); secrets are redacted before sending (`redactSecrets`); token usage is summed into the result.

**Event and state.** New event `RefineEvent.DocsScored = 'REFINE_DOCS_SCORED'` with `{ cycle, available, skipped?, model, average, docs: { [DocFile]: { score, checks } }, usage }`, all scores 0 to 1. The shared reducer (`applyRefineEvent`, used by the server and the page) keeps `state.readiness` (optional, so older journals and test literals still type-check) and sets `readiness.outdated = true` on every `DocEdited` (every document write emits it, including moves and autofill, `cycle.ts:162,616`), cleared by the next `DocsScored`. Old servers ignore the unknown event.

**Pure module** `server/refine/readiness.ts` (browser-safe, the page imports it the way it imports `released`): types, `READY_PERCENT = 80`, `percentOf`, `scoresDocs(mode)` (`new-project` and `backlog`), `jevVerdict(state)` returning `none | skipped | unavailable | outdated | below | ready`, and `jevBlocksStart(state)` (backlog enabled and verdict is unavailable, outdated or below). One definition for the server and the page, unlike the stale rule that exists twice today.

**When it runs.**
- At the end of every cycle of a scoring session, just before `Evaluated` is journaled (`cycle.ts:716`), through a new exported `scoreDocuments(deps, cycle)`. It reads the five documents fresh (moves and autofill may have changed them), skips when `readiness` is available and not outdated (chain cycles 2 to 4 of one click reuse it), writes `skipped: 'confidential'` for confidential projects without calling the Jev, and never fails the cycle: a Jev error becomes `available: false` (Reavaliar or the new button retries). The confidential test now inline at `cycle.ts:264` is extracted to one helper and used by both places.
- On demand: `RefineSession.score()` (same guard as other actions, takes the `running` lock, no `CycleStarted`, so no round is spent), `POST /api/refine/:projectId/:specId/score`, `refineApi.score`. A no-op when the score is current.
- Wiring: `scoreDocs` is a new optional dependency next to `validateDocs` (`cli.ts:126`, `registry.ts:31,104`, `SessionDeps`, `cycleOnce`). `createJevScorer` shares one `openJev(cfg, apiKey)` factory with `createJevValidator` instead of copying its backend setup.

**Chain stays as is.** `status` and `computeStatus` do not change, so `evaluateChain` still stops at `ready` and never loops cycles only because the Jev says no (putting the Jev inside `computeStatus` would make the chain spend up to four cycles per click; rejected).

**The gate** (phase D, after the checkpoint). `freezeProgram` (`session.ts:536`) adds `|| jevBlocksStart(state)` with a pt-BR 409 per verdict. The page: `canStartRun` adds the same predicate; `stageOf`/`stageAction` take a `jevBlocks` input; the next-step text gets a Jev branch and the round-limit text points to the new button. `registry.list()` reports a ready draft the gate blocks as `drafting`, so the hub chip does not say "pronto para iniciar". Because `Refinement.tsx:810` and `:301` will both go through the same helper, the stage bar can no longer show "Backlog" active while Iniciar is on (a bug seen in the investigation).

**Banner** (`web/src/refine/ReadinessBanner.tsx`), rendered by `RefinementSession` between `StageBar` and `ProcessingBanner`; hidden while evaluating and after the start; shown for new-project and backlog sessions. Uses the tokens of `StageBar`/`ProcessingBanner` (`good`, `warn`, `bad`). Mock (approve or redirect here; the screen is also checked in the browser before the UI commit):

```
READY
┌──────────────────────────────────────────────────────────────────────────┐
│ ✔ Pronto para desenvolver                         Nota do Jev  86%       │
│   Mínimo 80%                                    [ Iniciar análise ]      │
│ project.md 91%  briefing.md 88%  stack.md 84%  flow.md 85%  design.md 82% │
└──────────────────────────────────────────────────────────────────────────┘
NOT READY
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚠ Ainda não está pronto                           Nota do Jev  61%       │
│   Mínimo 80%. Melhore os documentos abaixo do mínimo   [ Avaliar com o Jev ]│
│ project.md 82%  briefing.md 74% (mais fraco: Concreto…)  stack.md 52% …   │
└──────────────────────────────────────────────────────────────────────────┘
```
Other states: no score yet ("Sem nota do Jev. Clique em Avaliar com o Jev."), documents changed after the score ("Os documentos mudaram depois da nota"), Jev did not answer ("confira a chave do OpenRouter"), confidential ("o Jev não lê os documentos; sem nota"), score approved but something else still open ("Nota aprovada; veja o próximo passo abaixo"). The button "Avaliar com o Jev" is enabled only when the score is missing, outdated or unavailable.

## Tasks

Order on purpose: A and B first show real scores without changing who can start; C proves the scores on real documents; D turns the gate on only after the owner has seen the numbers. Branch `feat/jev-document-scores`; each task test-first (the test must fail for the right reason), then commit and push (`Co-Authored-By` line as the session asks). Task 0: copy this plan to `docs/superpowers/plans/2026-10-20-teams-ai-91-jev-document-scores.md` and add its row to `docs/superpowers/plans/README.md`.

**Phase A: score core. Nobody's start rules change.**
- A1 `server/refine/readiness.ts` + `test/refine/readiness.test.ts`: `percentOf` rounding (79.6% is 80), verdict table, `jevBlocksStart` truth table (no readiness, not backlog, skipped, unavailable, outdated, 79, 80).
- A2 `document-charter.ts`: `DOCUMENT_PURPOSE`; test that `DOCUMENT_CHARTER` is byte-identical to the current text.
- A3 `jev-validation.ts`: extract `openJev`; the existing `jev-validation.test.ts` stays green untouched.
- A4 `jev-scoring.ts` + `test/refine/jev-scoring.test.ts` (fetch stub as in `jev-validation.test.ts`): one request per window with four checks and the document's charter; weighted mean; five-document mean; empty document makes no call; failed window gives `available: false`; no key gives `available: false`; secrets redacted; usage summed.
- A5 event + reducer in `events.ts`/`state.ts` + `test/refine/state.test.ts`: score stored, `DocEdited` outdates it, next score clears it, old journal gives `readiness` undefined.
- A6 `cycle.ts` (`scoreDocuments`, confidential helper, hook before `Evaluated`) + wiring + `test/refine/cycle.test.ts`: one event per scored cycle with the post-move documents; skip on unchanged documents; rescore after an edit; confidential never calls the scorer; Jev error does not fail the cycle; not called for `new-spec`/`continue`; a ready session blocked only by a low score spends exactly one cycle per click.
- A7 `RefineSession.score()`, route, `refineApi.score`, `readiness?` on the page's `RefineState` type in `web/src/api.ts` + tests in `test/refine/session.test.ts` and the refine-routes API test: guard while evaluating or started, no round spent, journal gets the event, no-op when current.

**Phase B: the screen.**
- B1 `ReadinessBanner.tsx` + `ReadinessBanner.test.tsx` (every state above, button enabled/disabled rules) and wiring in `RefinementSession` (`onScore` through `act`, same pattern as Reavaliar); update `jevInfo` copy in `Refinement.tsx`. Existing page tests have no `readiness`, so they keep their layout. Check in Chrome (replica with the deployed CSS per the UI playbook) and show a screenshot.

**Phase C: calibration checkpoint. Needs the owner's go (real Jev calls, and reading the OpenRouter key into a local env var).**
- C1 `scripts/evals/doc-readiness.ts <docs dir>` runs the real scorer and prints per-check, per-document and overall numbers plus tokens and cost. Run on: kayron-hub docs, agendamento docs, the tiny seeds in `scripts/live-check/agenda` (sparse, expected low), and planted-defect variants (a contradiction, vague criteria, foreign content, a missing part). Expected: defects lower the matching check; refined documents score above sparse seeds. Open question the numbers answer: can an owner-approved document set reach 80%? Report to the owner with the numbers before phase D. Rubric wording is tuned here; the 80% is the owner's, not tuned silently.

**Phase D: the gate, after the owner's go on the numbers.**
- D1 `jevBlocksStart` wired into `freezeProgram` (+409 messages), `canStartRun`, `stageOf`/`stageAction`, next-step copy, `registry.list()`; tests in `test/refine/session.test.ts` (refuses below 80, allows at 80, allows for confidential and for sessions without a score, still refuses after the round limit), `ProgramPanel.test.tsx`, `stages.test.ts` (including the stage-bar case above), registry list test, and a banner test for the enabled start button.
- D2 docs in pt-BR (user-facing, plain, one point per sentence): `docs/guia/refinamento.md` (new section on the score, the new button, rounds untouched by the button, confidential projects; update the questions line at the top and the round-limits paragraph), then rebuild the guide graph with `task guia:grafo` (needs the container and the Claude login; `test/chat/guide.test.ts` guards a stale graph; never `graphify update`). Update section 3.1 of `docs/superpowers/specs/2026-09-24-refinement-ui-design.md` (definition of ready). Add to `docs/superpowers/BACKLOG.md`: the Jev cost is not booked anywhere (validation, scoring and decisions); the six cross-document checks score low by construction on large document sets.

## Impact (who calls the touched code, what stays)

- Start: `POST /start` → `registry.start` → `startProgram` → `freezeProgram`. Only backlog starts get the gate; `freeze()` (single spec) does not. The program service, supervisor and CLI never call the gate.
- Evaluate: `status`, `computeStatus`, `released`, the stale rules and `evaluateChain` are unchanged. A scoring cycle adds one Jev call per window of the five documents (5 for a small project, about 11 for the 274 thousand characters of kayron-hub), none when the documents did not change. The agents' cost is unchanged. The real Jev cost is not known today (the journal does not record it); the new event does, and C1 measures it.
- Other session states: `started` sessions untouched; `new-spec`/`continue` untouched; confidential projects unchanged; sessions from before the feature have no score and keep today's rules until they get one (they can start without a score; a known, small loophole closed by the first score). `kayron-hub-001` is one of them and is past the round limit, so the new button is its only way to get a score.
- Journal: one new small event; older servers ignore it; replays of old journals give `readiness` undefined.
- Screen: new banner and one new button; the review panel's buttons, tabs and columns keep their layout (the look is not otherwise touched). Hub chips change only for a ready draft the gate blocks.
- Security: documents are redacted before leaving, never sent when confidential, key never logged.

## Verification

- `npm test`, `npm run typecheck`, `npm run test:web`, `npm run web:build` all green; new tests listed above fail before their change.
- C1 numbers reported to the owner; D starts only after their go.
- Browser at http://localhost:8787 on `kayron-hub-001` (legacy, no score): banner shows "sem nota", click "Avaliar com o Jev", score appears, start behaves per the gate; and on a throwaway new project through `scripts/live-check/refine.mjs` for the full path (evaluate → score at the end → start refused below 80 with the 409 text). Real-cost step: runs only with the owner's go.
- Deploy only per the playbook (clean export, no `claude` or `cli.ts run|resume|spec` process in the container, `TEAMS_AI_IMAGE=teams-ai:local docker compose up -d --no-build --no-deps --wait teams-ai`); ask the owner to hard-refresh.

## Out of scope

Gating the documents-to-backlog step; gating single-spec flows; a per-document floor (the average can hide one weak document, so the banner marks every document under 80% instead); an env knob for the percentage; changing the six start-of-cycle cross-document checks; booking Jev cost in accounting; changing the round limits.
