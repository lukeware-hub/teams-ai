# Plan 54 - Readable English ids for projects, specs, backlog items, tasks and runs

Status: done (2026-10-08). Roadmap item R11.12. Commits: slice 1 `8a171ac`, slice 2 `562d1bf`, slice 3 `f9e37f5`,
slice 4 `5cf3902`. Live check: `/api/names/suggest` answered `order-portal` + `create-order` and `add-health-check`
(~11 s each, small tier); legacy runs of `r11p-svc` still list and open after the deploy. Browser check of the screens
not done (Chrome extension not connected).

Open: two backlog drafts of one project that both use the same key would give two specs one id (slice 2 only guards
key == draft id). A spec name typed by hand is still not checked for English.

## Goal

Human, 2026-10-08, looking at the run breadcrumb `Projetos › r11p-svc › r11p-svc-001-r1`: the generated names are hard
to understand. Every id teams-ai creates (project, spec, plan task, backlog item, run) must be an intuitive English
kebab-case name that says what the thing is. Human decisions:

- Generate readable ids (server side), not only prettier labels in the UI.
- Project and spec ids are proposed by an AI agent from the name/description; the human can edit before creating.
- Target shape (chosen preview): `Projetos › order-service › add-health-check › run-1`, run URL
  `/runs/order-service--add-health-check--run-1`.

Existing ids keep working (old runs, drafts, branches are never renamed).

## Where ids come from today (impact map, 2026-10-08)

- projectId: typed (`web/src/pages/Projects.tsx:73`); slug-checked in `server/refine/registry.ts`.
- First spec of a new project: code builds `${projectId}-001` (`server/refine/registry.ts`, `newProject`). This is the
  `-001` in `r11p-svc-001`.
- New spec: typed (`web/src/pages/ProjectHub.tsx:104`).
- Backlog item specs: code builds `${draftId}-${key}` (`server/refine/item-spec.ts:44`, `detail-cycle.ts:148,166`);
  keys come from the PO agent with no naming rule beyond the slug schema (`.claude/agents/po.md:26-33`).
- Plan tasks: `T<n>` from the SM agent; the schema allows `T<n>-<slug>` (`server/core/ids.ts:2`) but nothing asks for it.
- Runs: `nextRunId` builds `<prefix>-r<n>` (`server/orchestrator/workspace.ts:78-90`), prefixes `<spec>`,
  `<spec>-complete`, `<spec>-readme`, `<spec>-deploy`. Runs live in one global folder, keyed only by runId, so two
  projects with the same specId share run numbers, and project delete can remove the other project's runs
  (`server/api/run-routes.ts:232`, `server/api/run-index.ts:207`). Short readable spec ids make that collision likely,
  so the run id must carry the project.
- Parsers of the run format: `workspace.ts:67` (`specRuns`), `run-index.ts:172,210,227,238`,
  `web/src/pages/ProjectHub.tsx:29` (`includes('-complete-')`).

## Slices (in order, each committed and pushed on its own)

### Slice 1 - AI-suggested project and spec ids

- New agent step kind `name` (role `po`, cheapest model tier): input kind (`project` | `spec`), name, description,
  existing ids of that project; output `{ id }`, schema SLUG, max 40 chars. Prompt: 2-4 English words, kebab-case,
  names the product or the outcome (`order-service`, `add-health-check`), never numbers, dates or the project name
  repeated inside a spec id.
- `POST /api/names/suggest` returns the id, de-duplicated against existing ids by the server (`-2`, `-3`).
- UI: project and spec forms gain "Sugerir ID" (filled automatically once the description is typed, editable).
- First spec of a new project: suggested from the project description instead of `${projectId}-001`.
- Cost: one small model call per creation.
- Verify: unit tests for the route, the dedup and the slug guard (agent stubbed); browser check of both forms.

### Slice 2 - Backlog item specs named by their key

- `po.md` backlog rule: an item key is 2-4 English words, kebab-case, naming the outcome (`user-login`), never a
  number or the project name.
- New item specs get `specId = key` instead of `${draftId}-${key}`; if that id already exists in the project, fall back
  to `${draftId}-${key}`. Existing drafts keep their stored specIds.
- Verify: unit tests in `test/refine` for the new id, the collision fallback and an unchanged old draft.

### Slice 3 - Plan task ids carry a slug

- SM plan prompt + plan output schema: `T<n>-<slug>` (`T1-create-endpoint`), slug 1-4 English words. The contract
  pattern stays as is so old plans, `T0-scaffold`, `T900-fix-N`, `T950-deploy-fix-N` and replan `-rN` ids still load.
- Verify: plan validator tests; the agent JSON schema rejects a bare `T1`.

### Slice 4 - Run ids carry project and spec

- New format `<projectId>--<specId>--run-<n>`, variants `--complete-run-<n>`, `--readme-run-<n>`,
  `--deploy-run-<n>`. `--` never occurs inside a slug, so the parts split without ambiguity.
- One module (`server/core/ids.ts`) builds and parses run ids, both formats (new and legacy `-r<n>`); every parser in
  the impact map switches to it.
- Run breadcrumb shows `Projetos › <project> › <spec> › run 1` (spec part links to the project hub until a spec page
  exists).
- Fixes the cross-project collision: run numbering, project delete and the crashed-run listing filter by project.
- Verify: unit tests for build/parse (both formats), `nextRunId` numbering per project, delete scope; full root and web
  suites; browser check of the run and project pages after a clean-export deploy.

## Out of scope

- Renaming existing ids, folders or branches.
- Branch names (`task/<specId>-<taskId>` already reads well once the parts are readable).
- Step, attempt and acceptance-criterion ids (`s00001`, `T1-a1`, `AC-001`): internal, not shown as names.
