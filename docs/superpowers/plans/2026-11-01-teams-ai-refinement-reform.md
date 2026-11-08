# Refinement reform by repository: status

Plan: `~/.claude/plans/pasted-content-id-a9d6-revis-o-crystalline-swan.md` (not in the repository). Branch `feat/refinement-reform`, PR #35 (draft).

Status on 2026-11-01: about 70% of the plan; increments F and I updated on 2026-11-08. The plan is not complete.

| Increment | Status | Evidence |
|---|---|---|
| 0 Base and standing rules | Done | `PRODUCT.md`, Frontend section in `.claude/CLAUDE.md`, ignore rules |
| A Stage order | Done, with gaps | `server/refine/session.ts`, `test/refine/stage-order.test.ts` |
| B Document graph | Done, with gaps | `server/knowledge/doc-graph.ts`; isolation probe passed on 2026-11-01 (output not saved) |
| C Architecture | Done, with gaps | `server/refine/architecture-step.ts`; architecture step follows the role setting (`9f79a562`) |
| D Backlog and specs per repository | Done | `test/refine/backlog-repository.test.ts` |
| E Plans and tasks | Done, with caveats | `server/refine/plan-prepare.ts`; task journaling fix (`17b63df3`) |
| F Skills | Done, scope narrowed by the owner on 2026-11-08 | Skills run in the plan and `task.md` steps (`skillClause` in `server/refine/superpowers-pack.ts`) and in Front work (`.claude/agents/front.md`); stage reviews and specs stay without tools, as #61 decided; `scripts/evals/skill-usage.ts` exists; the 90% rule is measured in the live check of K |
| G Closing | Done, with gaps | `server/refine/state.ts`; contradiction check not explicit |
| H Read models and routes | Done, with gaps | `server/api/repositories.ts`; fix and deploy-fix tasks not counted apart |
| I user interface | Done, with one gap (2026-11-08) | The six screens were captured at 1440 and 390 px, light and dark (`.impeccable/review/`, demo data injected in the browser for the screens no live draft reaches), the detector ran with no finding, and the finish review fixes were applied; the gap is the architecture style citing its document and section, which the architecture contract does not carry |
| J Follow-on drafts | Done | `test/refine/follow-on-stamp.test.ts`, `test/api/refine-api.test.ts` (`94769e27`, `562dcbfd`) |
| K Docs and rollout | Partial | Guide and graph (`cf19028c`, `b484c010`); README paragraph added; closing audit found open items |

Increment F, owner decision on 2026-11-08:

- Stage reviews and specs keep no tools, as PR #61 (`642857b5`) decided for time and cost, so they get no skill clause and keep their "no tools" lines.
- Front probe: only one catalog ships `impeccable` (`server/skills/catalog.ts`), so there is no duplicate to remove.
- Front probe: the Setup of the pinned `impeccable` runs `scripts/impeccable context`, which downloads a 21 MB launcher from github.com; the Bash rules allow it, but github.com is not in the sandbox network list of any stack, so `front.md` tells the step to skip Setup and read `design.md`.

Open decisions and blockers:

- The start button fix (`8feeca1c`) is committed but not deployed; it waits for owner authorization.
- The live check project `live-repo-e` stopped on three blocking product owner questions.
- The closing audit lists 14 uncovered items across A, B, C, G, H and K.
