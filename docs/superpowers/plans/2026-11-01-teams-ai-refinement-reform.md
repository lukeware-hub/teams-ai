# Refinement reform by repository: status

Plan: `~/.claude/plans/pasted-content-id-a9d6-revis-o-crystalline-swan.md` (not in the repository). Branch `feat/refinement-reform`, PR #35 (draft).

Status on 2026-11-01: about 70% of the plan. The plan is not complete.

| Increment | Status | Evidence |
|---|---|---|
| 0 Base and standing rules | Done | `PRODUCT.md`, Frontend section in `.claude/CLAUDE.md`, ignore rules |
| A Stage order | Done, with gaps | `server/refine/session.ts`, `test/refine/stage-order.test.ts` |
| B Document graph | Done, with gaps | `server/knowledge/doc-graph.ts`; isolation probe passed on 2026-11-01 (output not saved) |
| C Architecture | Done, with gaps | `server/refine/architecture-step.ts`; architecture step follows the role setting (`9f79a562`) |
| D Backlog and specs per repository | Done | `test/refine/backlog-repository.test.ts` |
| E Plans and tasks | Done, with caveats | `server/refine/plan-prepare.ts`; task journaling fix (`17b63df3`) |
| F Skills | Not done | Front probe, skill clauses, "no tools" lines and the 90% rule remain |
| G Closing | Done, with gaps | `server/refine/state.ts`; contradiction check not explicit |
| H Read models and routes | Done, with gaps | `server/api/repositories.ts`; fix and deploy-fix tasks not counted apart |
| I user interface | Partial | Components and web tests exist; Chrome captures incomplete; closing dialog not captured; final review pending |
| J Follow-on drafts | Done | `test/refine/follow-on-stamp.test.ts`, `test/api/refine-api.test.ts` (`94769e27`, `562dcbfd`) |
| K Docs and rollout | Partial | Guide and graph (`cf19028c`, `b484c010`); README paragraph added; closing audit found open items |

Open decisions and blockers:

- The start button fix (`8feeca1c`) is committed but not deployed; it waits for owner authorization.
- The live check project `live-repo-e` stopped on three blocking product owner questions.
- The closing audit lists 14 uncovered items across A, B, C, G, H and K.
