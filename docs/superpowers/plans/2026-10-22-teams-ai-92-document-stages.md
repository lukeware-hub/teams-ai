# Refinement in five document stages: risk analysis and plan

## Context

The user wants to split today's refinement (one heavy pass over five documents, then the backlog, then execution) into five sequential document stages: flow.md, project.md, briefing.md, stack.md, design.md. In each stage the user attaches or types the file, refines only that document against the earlier ones, may validate it with the Jev, and may stay as long as wanted or advance with no lock. After the last stage execution starts.

The goal is refinement that catches problems before development, so fewer bugs reach the generated software. The user also asked to improve the screen: the per-document score cards in the screenshot (percentage plus four checks) become the stage view.

The user asked for the risks first. This file is that analysis, the decisions already taken with the user, and the recommended way to build it. Nothing is built yet.

The attachments numbered 1 and 3 and the pasted texts numbered 2 and 4 did not reach the analysis. They are assumed to show the Jev panel and its four checks (complete, concrete, consistent, scoped).

## Decisions made with the user (2026-10-22)

1. **Backlog: always free.** After stage 5 "Quebrar o backlog" is available even with open gaps. The gaps go to the backlog agents as known gaps and show beside the start button. A start still needs a vision and one persona in project.md and a backlog whose items cite every flow.md heading (point 14 below); below that floor the final pass asks the owner instead of deriving.
2. **Documents: reconcile.** The user's descriptions and the agents' charter become one text:
   - flow.md: the complete business flow as one Mermaid diagram: states, events, branches, error paths, who acts.
   - project.md: what the project is, its goals, what it must deliver (capabilities, not behavior), responsibilities and authority, constraints, principles, deploy target.
   - briefing.md: how it works in detail: behavior of each capability, business rules, acceptance criteria, out of scope, external dependencies, decisions, and the written explanation of each flow step (never a new order of steps).
   - stack.md: technologies, versions, services, data models, contracts, security mechanisms, plus the rules of use: what not to use and best practices.
   - design.md: unchanged.
   Acceptance criteria stay in the briefing because tests and backlog coverage depend on them.
3. **Confidential: visible switch, Jev off until answered.** Stage 1 shows "Projeto confidencial: sim ou não". With no answer no Jev call is made.
4. **Screen: steps in the document panel.** Five numbered steps with their score at the top of the documents panel; below them the editor, the score card of the current document (the one in the screenshot), the line "Alinhado com os documentos anteriores", and Voltar and Continuar. The existing three-step bar and the review and checklist panels stay as they are. Mockup approved:

```
Refinar documentos ── Backlog ── Executar   (bar of today, unchanged)

┌ Documentos do projeto ─────────────────────────────────────────┐
│ ①flow.md ✓82%  ②project.md ●44%  ③briefing  ④stack  ⑤design    │
│ Etapa 2 de 5 · project.md · base: flow.md                      │
│ [Anexar arquivo] [Sugerir] [Copiar]                            │
│ ┌ editor ────────────────────────────────────────────────────┐ │
│ └────────────────────────────────────────────────────────────┘ │
│ Nota do Jev · project.md 44%                                   │
│ completo 21% · concreto 78% · consistente 53% · escopo 25%     │
│ Alinhado com flow.md: não (2 divergências)                     │
│ ⚠ flow.md mudou depois desta nota                              │
│ [← Voltar]        [Avaliar com agentes]        [Continuar →]   │
└────────────────────────────────────────────────────────────────┘
```

## How it works today (checked in the code)

1. The same five documents already exist (`DocFile`, server/refine/draft.ts:36), and a new project's tabs already show them in the wanted order: flow, project, briefing, stack, design (web/src/pages/Refinement.tsx:434). Their set and order are written by hand in more than fifteen places (draft.ts:36, :41; suggest.ts:15; cycle.ts:139; server/contracts/backlog.ts:5; server/api/refine-routes.ts:99, :118; web/src/refine/doc-labels.ts:4).
2. One refinement round runs, in this order: the Jev preflight, one agent call that derives project.json and the spec (before the backlog exists), a reorganization pass over changed documents, the Front review, the PO and SM reviews in parallel, then moves, findings, contradictions, questions, the checklist and the Jev score (server/refine/cycle.ts:274-747). That is four or five Claude calls, each carrying all five documents (cap of 70000 tokens, server/refine/docs-view.ts:12). Reviewers only propose patches, which the human accepts; moves are applied at once (cycle.ts:636-693). Each role patches only its own documents (server/refine/packs.ts:44, :50); any role may move content between any two documents (packs.ts:53).
3. The cards in the screenshot are the Jev score: four yes or no checks per document, each a probability; a check passes at 80%; the document score is the mean; each document is judged alone (server/refine/jev-scoring.ts:16-36; readiness.ts:4-53). The project score is the mean of five, and an empty document counts as zero (jev-scoring.ts:79-82, :99). Any edit hides every card until the next score (web/src/refine/ReadinessBanner.tsx:39-41), and the banner is not shown while an evaluation runs. The calibration on seven document sets scored 53% to 57% on average and no document reached 80% (commit a8940a6). One scoring run costs about US$ 0.005 and no Claude call.
4. Cross-document checks exist but run only over all five documents together and are never shown as a score: the Jev preflight (six checks, among them "documents agree" and "flow.md covers the scope", server/refine/jev-validation.ts:25-56; its result only advises the agents) and the PO contradiction check (packs.ts:28, server/refine/contradictions.ts), which reaches the screen as one line of the checklist.
5. The step bar has three steps: documents, backlog, execution (web/src/refine/stages.ts). A new project cannot start before its backlog is enabled and detailed (server/refine/state.ts:205-209), and the backlog is enabled only when the checklist is all green (session.ts:396-399); the screen hides the manual backlog button for new projects (Refinement.tsx:309). Nothing stops a start with an empty backlog: the start then fails after the attempt (registry.ts:208-212).
6. The human's answers to blocking questions are written into briefing.md under "## Decisões" (session.ts:434-445, server/refine/decisions.ts:72). Suggestions rank "decisions in the briefing first, then flow.md" (server/refine/suggest.ts:23). The description typed when a new project is created also lands in the briefing (draft.ts:193-206).
7. One charter fixes what each document holds, and the Jev questions, the move rule and every role prompt quote it (server/agents/document-charter.ts:4-19; server/agents/registry.ts:105-146). Today project.md holds vision, personas, constraints, authority, legal rules and deploy target. The briefing holds objectives, features, acceptance criteria and out of scope. flow.md is one Mermaid diagram with the order of steps and branches. stack.md lists no rules about what not to use.
8. State is the replay of an append-only journal with no version number (server/refine/draft.ts:70; server/store/event-store.ts:15); the page replays it with the same function (web/src/refine/reducer.ts:1). It is global: one round counter against the limit of 50 (session.ts:337), one `stale` flag (state.ts:105), one score record replaced whole by each score and one `outdated` flag (state.ts:127, :302, :350). Every step's cache key is a hash of all five documents (cycle.ts:277-279; draft.ts:352).
9. There is no file attach for documents. The user types or pastes in a text area saved on blur; "Sugerir" drafts the other four from flow.md (suggest.ts:6); image attach exists for design.md only (Refinement.tsx:441-454).
10. Agents cannot run without the Jev unless the project is confidential (cycle.ts:301-305). A project counts as confidential only when a project.json says so: the one in the repository, the derived one, or the backlog's (cycle.ts:105-109). A new project has none until its first derive, and unknown counts as not confidential.
11. After refinement the five documents do not travel whole. Backlog items cite sections of them; the spec step reads project.md plus the cited sections; the pre-plan reads project.md plus stack.md; a build task gets the spec, project.json, 6000 characters of the tech spec and the top five search chunks of docs (server/refine/detail-packs.ts:81, :102; server/orchestrator/run.ts:487-496). No role prompt tells the Dev, Test or Security agent to read the documents.
12. Real numbers: one project spent US$ 43.87 over 34 rounds and 688 agent steps, with documents of 274 thousand characters (plan 91, docs/superpowers/plans/2026-10-20-teams-ai-91-jev-document-scores.md:11, :13). Refinement steps run on Sonnet 5.5 at low effort (server/config/config.ts:22-35).
13. The running instance already holds one live new project at round 16 with a Jev score of 55%. Whatever ships must open it unchanged.
14. Hard floor before a start: the derive needs a vision and one persona in project.md (server/contracts/project.ts:32-33); the backlog needs at least one item with sources and a citation for every flow.md heading (server/validators/backlog.ts:57-59); "ready" also needs a Mermaid fence in flow.md (cycle.ts:707-710).

## Risks, most serious first

Each risk says what happens, the evidence, and what to do.

### A. Will the new flow really prevent bugs?

1. **Refined content reaches the builders only indirectly.** Point 11: a rule written in stack.md ("do not use X") reaches the Dev mostly through the pre-plan and the tech spec, and no prompt tells the Dev to open the files, although they are copied into the repository. Better documents help only as far as the derivation carries them. This is outside the five-stage split but sets its payoff. Do: open a separate backlog item so the rules sections of stack.md and design.md reach the build packs on purpose; keep documents structured by headings, because citations work by heading.

2. **No stage-level check that a document agrees with the earlier ones.** The promise "refine this document based on the earlier ones" is verified by nothing on the screen; the cross-document checks run only in the all-documents batch (point 4). Five documents can each score well and still disagree. Today's "flow.md covers the scope" check also points the other way: the new order makes flow.md the root, so the later documents must cover the flow. Do: run the preflight check "documents agree" and a "covers the earlier documents" check only over the earlier documents (as a digest) plus the stage document, and show one extra line on the stage, "Alinhado com os documentos anteriores". No new card, no new score.

3. **The Jev score is a weak signal, "100%" is impossible and even 80% is rare.** Each check is a probability and the pass line is 80% per check (readiness.ts:3, :53). On seven calibration sets no document reached 80% and clean seeds scored about the same as sets with a planted defect (53% to 57%, commit a8940a6); the screenshot's cards sit at 44% to 65%. A stage that waits for "ready" would never turn green. Do: treat the score as a progress hint; show what to fix (the checks under 80% already become agent goals, readiness.ts:56-63) and the change since the last score; mark a stage done when the user continues, not when the Jev agrees; calibrate the stage questions with scripts/evals/doc-readiness.ts before anything depends on them.

4. **No lock can let weak documents reach development.** The user chose no lock, and the product already advises only. Do: keep it and make the gaps visible and useful: a non-blocking gap summary beside the start button, the gaps handed to the backlog agents as known gaps (never invented facts), and the existing full pass kept as the final integration check of all five documents.

5. **No lock meets the backlog dependency and the derive floor.** Decided: the backlog action is always free. Two things follow. The start must also require at least one backlog item, or a start right after enabling fails late (state.ts:205-209, registry.ts:208-212). And below the floor of point 14 the final pass cannot derive and asks the owner, which is a stop that no screen switch removes.

6. **Editing an earlier document silently makes later ones stale.** Do: show "desatualizado: o flow.md mudou" on later stages; never rerun agents on their own.

### B. Product rules that collide with the new flow

7. **The user's description of the documents does not match the charter the agents apply.** The charter puts objectives, features and acceptance criteria in the briefing and keeps the order of steps only in flow.md (document-charter.ts:5-9). The move rule moves a feature or business rule found outside the briefing into the briefing and an order of steps out of any other file, so a briefing that explains the flow in detail would be moved back (packs.ts:53). The outline rule defers detail to the spec stage (packs.ts:61). Decided: the reconciled text above. Do: change the charter in one place and derive the Jev purpose lines and the move rule from it; keep acceptance criteria and out of scope in the briefing; add a test that fails when the texts diverge.

8. **Human decisions live in briefing.md, and a briefing attach would erase them.** Answers given in stages 1 and 2 are written into a document not refined yet, which breaks "only this document", and a stage-3 attach replaces the whole file, the creation description included (saveDoc, session.ts:264-268). Do: keep briefing.md as the decision ledger; make save and attach keep the "## Decisões" section and say so; allow decision records as the one write outside the stage document.

9. **Cross-document agent features contradict "only this document".** Reorganization over all five (cycle.ts:139, :419-446), moves between any pair (packs.ts:53), findings on all five (packs.ts:58), pair comparison (packs.ts:28). Do: in a stage, patch only the stage document, move content only forward, never into earlier documents, and report findings and contradictions only between the stage document and the earlier ones.

10. **flow.md must be a Mermaid diagram, and its structure drives the backlog.** The check is deterministic (cycle.ts:707) and the SM fills only a blank template (cycle.ts:640), so "type it" at stage 1 invites prose nobody turns into a diagram. Every `%% N.` comment or heading of flow.md must be cited by a backlog item (server/validators/backlog.ts:17-23), so a complete business flow means a large backlog. Do: hint that typing means Mermaid, or let "Sugerir" draw the diagram from prose at stage 1 (ask later).

11. **Not every project has a screen or a stack to refine.** project.json takes stack, services and platform from stack.md (draft.ts:318-325). The pipeline is built for services: a plan needs a deploy port and a health path, and there is no path for a command-line tool or a library (server/contracts/plan.ts:130-137). The Front agent reviews design.md in every full round even without a screen (cycle.ts:449). Do: give design.md a one-click "not applicable" (the Jev already counts a part marked not applicable as present: jev-scoring.ts:20) and let derivation accept template-only documents.

12. **Other modes and the Jev outage.** Stages are for new projects only; new spec, continue and backlog keep today's flow (readiness.ts:77, Refinement.tsx:820). With the Jev down or the project confidential there is no score; the stage must say so and still let the user advance.

### C. Privacy and technical risks

13. **A confidential project can leak its documents before anyone marks it confidential.** The mark is read only from a project.json, and a new project has none until its first derive (point 10). Stage cycles skip the derive, so for five stages the Jev preflight and the score would read the documents of a confidential project, flow.md first. Today only the first round and a manual score before it have this gap, and an earlier audit rated this class of leak critical (docs/superpowers/BACKLOG.md, critical items). The backlog detail already treats unknown as confidential (server/refine/detail-cycle.ts:125). Decided: a visible switch kept in the journal, Jev off until answered; the answer is merged into the derived project.json (true wins), and a live project with a derived project.json keeps today's rule.

14. **The state assumes five documents at once, and old journals must still replay.** The last rename blanked the page (commit 9b60ce6; shim at state.ts:217-220). The score card reads `docs[file].score` for every document and throws on a missing one (web/src/refine/ReadinessBanner.tsx:61-65), so a score that carries one document would blank the page the same way. A score event replaces the whole record (state.ts:350), the page hand-copies the state and snapshot types (web/src/api.ts:376, :394), and every step's cache key hashes all five documents (cycle.ts:277-279). A live project exists. Do: merge scores per document, derive per-document outdated from the journal, which already records each edit with file and hash (session.ts:267); keep old fields; give the stage cycle its own hash; count rounds per stage; test with old-format journals.

15. **Blast radius.** The largest function is cycle.ts `runCycleSteps` (about 480 lines). The refinement area has 41 root test files (486 tests) and about a dozen web test files; some tests assert prompt text (test/agents/registry.test.ts, prompts.test.ts, test/refine/packs.test.ts), which a charter change breaks on purpose. Five guide files, the README and design.md also describe today's process. Do: leave `runCycleSteps` untouched and add a small stage cycle beside it that reuses its helpers; run `task check` after every phase.

16. **Attach is new.** Size, encoding and overwrite loss; the server also refuses a save while an evaluation runs (session.ts:224-228). Do: accept text files only, read as UTF-8, confirm before replacing a filled document.

### D. Cost and time

17. **Cost and time are an estimate, not a measure.** Today about US$ 1.30 and 20 agent steps per round (point 12). A stage round should be cheaper: about two or three Claude calls with only the earlier documents instead of four or five with all of them, and one document scored instead of five. But there are five serial waits and the number of rounds may rise, and the last stage is not cheaper by itself because the earlier documents add up. Do: pass earlier documents as a digest (`docDigest` in docs-view.ts), and measure tokens per stage from the journal (session.ts:252-260) on a throwaway project before and after.

### E. The screen

18. **Visual rules and the user's past rejection.** design.md is the source of truth for the screen ("document wins over code") and bans a card inside a card and same-size cards of icon, heading and text as page structure; new components need all seven states. On 2026-10-15 the user rejected layout changes they had not asked for. Decided: the mockup above. Do: reuse the onboarding stepper pattern and the existing score tile, keep cards visible with a "desatualizado" tag instead of hiding them, update design.md sections 26 and 30.

Benefits to keep: a stage reads fewer documents, so fewer "pack too large" failures; unchanged documents are not re-read; the stage is scored on one to three windows of 32000 characters instead of five documents; the full pass stays as the final check.

## Recommended approach and critical files

Keep the existing machinery and the existing full pass. The full pass becomes the last step (derive, checklist, backlog). A stage is one document. The current stage lives in the page address; a small journal event records each "Continuar" so the done marks survive a reload. A stage cycle is a small new function beside `runCycleSteps`: Jev preflight over earlier documents (digest) plus the stage document, reorganize the stage document only, owner review that patches only the stage document, questions, then the score of that document. No derive, no checklist.

Phase 0, charter and calibration (no visible change):
- server/agents/document-charter.ts (`DOCUMENT_CHARTER`, `DOCUMENT_PURPOSE`), server/refine/packs.ts (move rule, outline rule), .claude/agents/po.md, sm.md, front.md if they restate placement; tests test/agents/registry.test.ts, test/agents/prompts.test.ts, test/refine/packs.test.ts; one new test that the Jev purpose lines and the charter agree.
- Calibrate the stage questions with scripts/evals/doc-readiness.ts on sets of different shapes. Real Jev calls and reading the OpenRouter key need the owner's go, as in plan 91.

Phase 1, server, additive (nothing calls it yet):
- New server/refine/doc-stages.ts: `DOC_STAGES` and `earlierDocs(file)`; the web imports it as it imports readiness and the start rule.
- server/refine/jev-scoring.ts: score only the documents asked for. server/refine/jev-validation.ts: preflight over the documents asked for plus the "covers the earlier documents" check.
- server/refine/events.ts, state.ts, readiness.ts: scores merge per document; per-document outdated and "earlier document changed"; events for "Continuar" and for the confidentiality answer; keep `readiness` working.
- server/refine/cycle.ts (`isConfidential`, `recordScore`): unknown is confidential for a new project with no derived project and no answer; merge the answer into the derived project.json.
- server/refine/session.ts and limits.ts: `score({doc})`, per-stage round count, `saveDoc` keeps the briefing's decisions section, `suggest` from earlier documents only; state.ts `canStart` also needs at least one backlog item.
- server/api/refine-routes.ts: optional `doc` on score and evaluate; routes for the "Continuar" mark and the confidentiality answer. web/src/api.ts types.
- Tests: state, readiness, jev-scoring, jev-validation, session, limits, refine-api, and an old-journal fixture (five-document score, brief.md names, no confidentiality field).

Phase 2, stage view, delivery 1 (no agents per stage yet):
- web/src/refine/stages.ts and a new stepper beside StageBar (reuse its classes), doc-labels.ts order, ReadinessBanner.tsx as the per-stage card that stays visible with "desatualizado" and tolerates a missing document.
- web/src/pages/Refinement.tsx: tabs become stages; attach file; "Sugerir" from earlier documents; Voltar and Continuar never disabled; gap summary beside the start; "Quebrar o backlog" from stage 5; confidentiality switch; next-step copy and per-file help text (lines 48-62).
- design.md sections 26 and 30, the five guide files, README.md. Chrome check on two throwaway projects.

Phase 3, stage cycle, delivery 2:
- server/refine/cycle.ts: `runStageCycle` beside `runCycleSteps`, reusing `applyMoves` (add the forward-only guard), `jevGoals`, `reorganizePack`, a `refinePack` variant over earlier documents, `checkPatch`, and a stage hash.
- server/refine/packs.ts: scoped packs; patch rights limited to the stage document; findings and contradictions between the stage document and the earlier ones.
- server/refine/session.ts: `evaluate({doc})` picks the stage cycle; the chain for the final pass is unchanged. The page's "Avaliar" runs the stage cycle.
- Tests: cycle, packs, moves, session, page.

Phase 4, docs and release:
- docs/guia files and `task guia:grafo`, `.env.example`, docker-compose.yml and README wording for the per-stage limit, plan 92 copied to docs/superpowers/plans/ with a row in the plans README, measure tokens per stage, deploy by clean export when no agent runs.

Each phase ends with `task check` green, a commit and a push.

## Decisions made by the plan (the user may redirect)

- Cross-document alignment reuses the existing Jev preflight check and the PO contradiction check, scoped to the earlier documents plus the stage document. No fifth card line.
- A stage is done when the user continues. The Jev score is information only: no goal, no gate and no threshold per stage. The owner has not decided the 80% minimum (2026-10-22), so it is not used.
- The round limit counts per stage.
- Stages apply to new projects only.
- Two deliveries: the stage view first, the stage cycle second.
- The user's text names the Jev from stage 2 on; stage 1 gets the same card too, because flow.md has a card in the screenshot.
- "Stay until 100%" is read as "stay as long as wanted"; nothing waits for a percentage.

## Noticed, out of scope

- design.md section 30.6 says the Jev never blocks, but the code fails the cycle when the Jev is unavailable (cycle.ts:301-305).
- A score label rounds (79.6 shows as 80%) while the orange test uses the raw value (ReadinessBanner.tsx:67).
- The guide says the start is free at any moment; a new project still needs its backlog first. Plan 91 (line 19), the plans README row 91 and the refinement UI spec (lines 82 and 114) still say the start needs a ready list.
- Four preflight checks assume an HTTP service (routes, status codes, health route, port; jev-validation.ts:36-55).
- po.md:61 and sm.md:63 cite PRODUCT.md, which commit e8e4bad deleted.

## Verification

- `task check` (typecheck, root tests, web tests, web build) in full after each phase, watched to the end and reported as it ended, a killed run included.
- Old-journal test: replay a journal written before the briefing rename and one with a five-document score; the page must not blank.
- Chrome check at http://localhost:8787 on a throwaway new project with a screen and one without (API only): every stage, the outdated marker, the alignment line, the confidentiality switch and the start.
- Guide: update docs/guia/refinamento.md, visao-geral.md, estados-e-papeis.md, criar-projeto.md and execucao.md, run `task guia:grafo`, then test/chat/guide.test.ts; update README.md and design.md sections 26 and 30.
- Cost: compare tokens per stage with today's single pass.
- Deploy only from a clean export and only when no agent runs (playbook in memory); the live project at round 16 must open unchanged.

---

## Execution plan

Executed inline with superpowers:executing-plans. Phase 0 runs first; Phase 1 is planned when Phase 0 is green.

- Worktree: `.claude/worktrees/refine-document-stages`, branch `worktree-refine-document-stages`, base `022d82c` (origin/main).
- Ledger: `.superpowers/sdd/2026-10-22-teams-ai-92-document-stages/progress.md` (git-ignored).

### Global Constraints

- Work only in the worktree. Each commit ends with the trailers `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_018y6SD9cCnY4PsucJ1ufyXW`.
- Code, comments, identifiers and commit messages are in English; a comment is one short sentence. Product copy (UI and `docs/guia`) stays in pt-BR.
- Behavior changes are TDD: write the failing test, run it, see it fail for the right reason, then make it pass.
- After each code task run `task check` (typecheck, root tests, web tests, web build) to the end and read the tail. A run that fails records nothing.
- No real Jev or OpenRouter call, no read of the OpenRouter key, no deploy. Those wait for the owner's go.

### Task 1: Record plan 92 in the repository

Files: this file (plan 92); `docs/superpowers/plans/README.md` (one row after plan 91).

Steps:
1. Add this row after the row of plan 91: `| 92 | [\`2026-10-22-teams-ai-92-document-stages.md\`](2026-10-22-teams-ai-92-document-stages.md) | In progress — refinement in five document stages; Phase 0 (agent charter) first, then the stage view and the stage cycle. |`
   Expected: the table keeps one row per plan, in number order.
2. Commit `docs(plans): plan 92 for refinement in five document stages`.

Test command: `npm run typecheck`

### Task 2: The charter gives each document its reconciled content

Files: `server/agents/document-charter.ts` (DOCUMENT_CHARTER and DOCUMENT_PURPOSE); new `test/agents/document-charter.test.ts`.

Steps:
1. Write `test/agents/document-charter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DOCUMENT_CHARTER, DOCUMENT_PURPOSE } from '../../server/agents/document-charter.js';

describe('document charter', () => {
  it('flow.md is the complete business flow, as one Mermaid diagram', () => {
    expect(DOCUMENT_CHARTER).toMatch(/flow\.md: the complete business flow of the system, as one Mermaid diagram/);
  });

  it('project.md holds goals and deliverables; the briefing holds the detailed behavior and the explanation of each step', () => {
    expect(DOCUMENT_CHARTER).toMatch(/project\.md: what the product is: .*goals, the deliverables it must produce/);
    expect(DOCUMENT_CHARTER).toMatch(/briefing[^\n]*how the software works in detail[^\n]*a written explanation of each step of docs\/flow\.md/);
  });

  it('stack.md holds the rules of use: what must not be used and the best practices', () => {
    expect(DOCUMENT_CHARTER).toMatch(/stack\.md: [^\n]*the rules of use: what must not be used/);
  });

  it('a step drawn in flow.md keeps its explanation in the briefing; a new step or branch belongs to flow.md', () => {
    expect(DOCUMENT_CHARTER).toContain('A step, an order or a branch that docs/flow.md does not draw belongs to docs/flow.md');
    expect(DOCUMENT_CHARTER).toContain('a written explanation of a step that docs/flow.md draws stays in the briefing');
  });

  it('each Jev purpose names what the charter gives its document', () => {
    expect(DOCUMENT_PURPOSE['project.md']).toMatch(/goals.*deliverables/);
    expect(DOCUMENT_PURPOSE['briefing.md']).toContain('a written explanation of each flow step');
    expect(DOCUMENT_PURPOSE['stack.md']).toContain('the rules of use');
    expect(DOCUMENT_PURPOSE['flow.md']).toContain('the complete business flow of the system');
  });
});
```

2. Run `npm test -- test/agents/document-charter.test.ts`.
   Expected: FAIL. Each assertion of the new contract fails against the current charter.
3. Rewrite `server/agents/document-charter.ts`. Keep the import and both doc comments. DOCUMENT_CHARTER becomes:

```text
Project documents (paths as the agents see them) and what each one holds:
- docs/flow.md: the complete business flow of the system, as one Mermaid diagram: states, events, branches, error paths, the order of steps and who acts at each one. Does not hold visual tokens or layout (docs/design.md), technologies (docs/stack.md), or acceptance criteria and the written explanation of a step (the briefing).
- docs/project.md: what the product is: its vision, goals, the deliverables it must produce, personas, constraints, principles, who may perform each act and under what authority, legal and compliance rules, where the product runs (deploy target) and GitHub owner. Does not hold the detailed behavior of a deliverable (the briefing), the tools that build or run it (docs/stack.md), the order or conditions of steps (docs/flow.md) or visual rules (docs/design.md).
- The briefing (docs/specs/<spec>/briefing.md, or docs/briefing.md in backlog mode): how the software works in detail: the behavior of each deliverable, business rules and limits, acceptance criteria, out of scope, external dependencies, bug details, decisions, and a written explanation of each step of docs/flow.md. Does not hold the vision and goals (docs/project.md), technologies (docs/stack.md), the order or branches of steps (docs/flow.md) or visual rules (docs/design.md).
- docs/stack.md: the technologies the software is built with: runtime, language, frameworks, storage, tooling and the tools that run it locally, versions, ports, the split into services, data models, API contracts, security mechanisms, and the rules of use: what must not be used and the best practices to follow. Does not hold goals, business rules or who may act (docs/project.md and the briefing), the order of steps (docs/flow.md) or visual tokens (docs/design.md).
- docs/design.md: how the interface looks, feels and responds: brand, color and type tokens, spacing, breakpoints, component anatomy, visual states, motion, accessibility, and the list of screens or portals with what each one shows. Does not hold business rules, the order or conditions of a step (docs/flow.md), endpoints, data or technologies.
When one piece of content fits two documents: a rule that decides who may act belongs to docs/project.md; a business rule (a deadline, a limit, what is allowed) belongs to the briefing as its testable form, and docs/flow.md keeps only the branch that applies it; docs/design.md keeps only how the screen shows it. Where the product runs belongs to docs/project.md; the tool that builds or runs it belongs to docs/stack.md. A step, an order or a branch that docs/flow.md does not draw belongs to docs/flow.md; a written explanation of a step that docs/flow.md draws stays in the briefing.
```

   DOCUMENT_PURPOSE becomes:

```ts
export const DOCUMENT_PURPOSE: Record<DocFile, string> = {
  'project.md': 'what the product is: its vision, goals, the deliverables it must produce, personas, constraints, principles, who may act and under what authority, legal rules, deploy target and GitHub owner',
  'briefing.md': 'how the software works in detail: the behavior of each deliverable, business rules and limits, acceptance criteria, out of scope, external dependencies, bug details, decisions and a written explanation of each flow step',
  'stack.md': 'the technologies the software is built with: runtime, frameworks, storage, tooling, versions, ports, services, data models, API contracts, security mechanisms and the rules of use (what must not be used, best practices)',
  'flow.md': 'the complete business flow of the system, as one Mermaid diagram: states, events, branches, error paths, the order of steps and who acts at each one',
  'design.md': 'how the interface looks, feels and responds: tokens, spacing, breakpoints, component anatomy, visual states, motion, accessibility and the screens',
};
```

4. Run `npm test -- test/agents/document-charter.test.ts test/agents/registry.test.ts test/refine/jev-scoring.test.ts`.
   Expected: PASS. The three charter regexes at registry.test.ts:104-106 still match their lines.
5. Commit `refactor(agents): the charter gives goals and deliverables to project.md and step explanations to the briefing`.

Test command: `task check`

### Task 3: The move rule follows the charter

Files: `server/refine/packs.ts` (MOVE_RULE, one line); `test/refine/packs.test.ts`.

Steps:
1. Add to `describe('refinePack moves and findings')` in `test/refine/packs.test.ts`:

```ts
  it('the move rule follows the charter: product goals stay in project.md, a step explained in words stays in the briefing', () => {
    const feedback = refinePack({ ...base, role: 'po' }).feedback ?? '';
    expect(feedback).toContain('a goal or a deliverable named at product level stays in project.md');
    expect(feedback).toContain('a written explanation of a step that flow.md draws stays in the briefing');
    expect(feedback).toContain('that flow.md does not draw moves to flow.md');
  });
```

2. Run `npm test -- test/refine/packs.test.ts`.
   Expected: FAIL on the three new expectations. The existing move tests still pass.
3. In `server/refine/packs.ts`, replace two fragments of MOVE_RULE:
   - "a business rule or feature outside the briefing moves to the briefing, and a deadline" becomes "a business rule, a limit or the detailed behavior of a feature outside the briefing moves to the briefing, and a deadline".
   - "even when a step checks it; an order of steps, or a branch that picks the next step, outside flow.md moves to flow.md." becomes "even when a step checks it; a goal or a deliverable named at product level stays in project.md; an order of steps, or a branch that picks the next step, that flow.md does not draw moves to flow.md; a written explanation of a step that flow.md draws stays in the briefing."
4. Run `npm test -- test/refine/packs.test.ts test/refine/cycle.test.ts`.
   Expected: PASS.
5. Commit `refactor(refine): the move rule keeps product goals in project.md and step explanations in the briefing`.

Test command: `task check`
