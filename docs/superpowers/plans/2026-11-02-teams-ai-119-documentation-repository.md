# Plan 119: the documentation repository (real-time commits, one start marker)

Status: in progress. Branch `feat/docs-repo-119`, draft pull request on `lukeware-hub/teams-ai`, started 2026-11-02.
Progress is the share of the checkboxes below, weighted by increment size (S 1, M 2, L 3; the total is 27).
Each checkbox is ticked only with evidence: a test name, a command result, a commit or a probe output.

## Context

Refinement and development agents write duplicated and wrong files into the project repository.
The evidence is `lukeware-kayron-hub/live-skill`: `docs/` holds `architecture.json`, `architecture.md`, `backlog.md`,
`project.json`, `specs.json`, `specs/<alias>/spec.json`, `preplan.json`, `plan.json`, `tech-spec.md`, and the plan is named
`implementation-plan.md` under a flat `docs/specs/<alias>/`.

Root causes, checked in the code:

1. Phase 0 copies the whole draft tree into the repository at the start (`server/orchestrator/phases/bootstrap.ts:26`, copy loop at `:99-122`).
2. The development phases add more files by docs pull request: `tech-spec.md` (Phase 1), `plan.json` (Phase 2), `report.json` and the README, RUNBOOK and API documents (Phase 6).
   `publishServiceDocs` (`bootstrap.ts:194`) copies the five documents and the architecture files into every service repository.
3. Several generators write overlapping views of one fact: JSON and Markdown pairs, four task lists, two briefings, two spec renderers.
4. `git merge-file --union` (`server/git/merge-doc.ts:50-57`) keeps both sides of an overlapping edit, so text is duplicated.
5. Nothing is committed during refinement, so the history has no step-by-step record.

Owner, 2026-11-02: implement 100% of this plan, on a new branch from `main`, with a draft pull request that lists what it contains.

## Owner decisions

The answers below are the owner's words, in Portuguese, as given during refinement.

| # | Question | Answer (verbatim) |
|---|---|---|
| D-1 | Are `spec`, `plan` and `task` of one spec in one folder or in separate aliases? | "Mesma pasta (Recomendado)": one alias folder per spec. |
| D-2 | What to do with the extra files of the example repository? | "o live-skill e apenas um exemplo do nao fazer... vamos seguir repo monolitico" |
| D-3 | Name of the central documentation repository | "artefacty fixo" |
| D-4 | How to mark where development starts | "Commit + tag (Recomendado)" |
| D-5 | Steps 1 to 6 of the stepper, before the architecture decides the repository | "vamos deixa do jeito que esta e vamos fazer tudo na etapa 7." |
| D-6 | Refinement of a project that already started development | "Sempre direto na main" |
| D-7 | `tech-spec.md`, `plan.json` and `report.json` | "Parar de gerar a tech-spec" |

The owner's layout, as pasted:

- Monolith or monorepo, in the project repository: `docs/project.md`, `docs/flow.md`, `docs/briefing.md`, `docs/design.md`,
  `docs/stack.md`, `docs/specify/<alias>/spec.md`, `docs/specify/<alias>/plan.md`, `docs/specify/<alias>/task.md`.
- Multi-repo microservices, in the central repository `artefacty`: the same five documents in `docs/`, plus
  `docs/<service>/specify/<alias>/{spec,plan,task}.md` for each microservice, worker, mobile app and web app.

Each service name ends with one of the suffixes in `server/core/ids.ts` (`api`, `jobs`, `web`, `mobile`, `workflow`).
The owner listed four kinds; `workflow` stays because the code and the confirmed reform decisions already use it.

## Corrections to the approved plan

- C-1. Every machine file (`project.json`, `architecture.json`, `specs.json`, `spec.json`, `preplan.json`, `plan.json`,
  `report.json`) lives in the local mirror `<ws.root>/state/docs/`. The earlier wording `<ws.root>/specs/<alias>/` for
  `plan.json` and `report.json` is superseded by this one place.
- C-2. Microservices: `ws.repo` is the project hub repository `<owner>/<projectId>`, which Phase 0 already creates today. It receives
  the README, RUNBOOK and API documents of Phase 6. `artefacty` holds only the eight kinds, as the owner decided (D-2). This replaces
  the earlier choice that sent the three delivery documents to `artefacty`.
- C-3. The FEATURES entry for this plan is item 20; item 19 already exists.

## Target layout

| | Monolith or monorepo | Microservices |
|---|---|---|
| Project repository (`ws.repo`) | `<owner>/<projectId>`: the project itself, and the store clone is a second clone of it | `<owner>/<projectId>`: the hub, with README, RUNBOOK and API |
| Documentation repository (store) | `<owner>/<projectId>` | `<owner>/artefacty` |
| Five documents | `docs/{project,flow,briefing,design,stack}.md` | same, in `artefacty` |
| Per spec | `docs/specify/<alias>/{spec,plan,task}.md` | `docs/<service>/specify/<alias>/{spec,plan,task}.md` |
| Service code repositories | not applicable | code only, no document copies |

- The list of specs of a repository is the directory listing of `specify/`. Order, priority and dependencies are in the header of `spec.md`.
  There is no index file.
- The allowlist of the store is exactly: the five documents, and `spec.md`, `plan.md`, `task.md` per alias. Nothing else is committed.
- Commits happen at boundaries of the refinement, not at every save. Each commit subject is `docs(<scope>): <label> [skip ci]`.
- The start marker is a closing commit plus an annotated tag `dev-start/<alias>` for each authorized spec.

## Design

D1. Layout seam. `server/docs/layout.ts` is pure (no file system, no git, safe to bundle for the web). It owns the paths of the eight kinds,
the allowlist, the alias rules (lowercase slug, at most 40 characters, Windows device names refused), the target repository
of a project, the tag name and the GitHub owner parse. The draft tree does not move. The store projects the draft onto the allowlist at each flush.
Legacy output is byte-identical, so the existing tests stay unedited.

D2. Stamp and flag. A new project is stamped `docsRepo` in its `Created` event only when the environment flag
`TEAMS_AI_DOCS_REPO_LAYOUT` is on (default off). A project without the stamp keeps the legacy behavior. The marker
`<ws.root>/state/docs-store.json` records the layout, the target, the style and the first pushed commit.

D3. State mirror. The machine files live in `<ws.root>/state/docs/` with the legacy relative paths. Phase 0 (docs-repo branch), Phase 2,
Phase 6 and the completion write them. A reader that used to read `origin/main` reads the mirror for docs-repo projects.
The mirror is written before any remote effect.

D4. Bind at step 7. Steps 1 to 6 make no git and no gh call. The only trigger is the explicit `enableBacklog` of a docs-repo session.
`evaluateChain` cannot bind, because it enables the backlog by itself when an evaluation ends ready. The bind runs a read-only preflight
(token, owner, private, not archived, write permission, empty or ours), then writes the marker, creates the local store and makes the initial commit.
The remote part creates the private repository only when GitHub reports it missing, adopts an existing repository only when it is empty or its history contains the local commit,
and pushes without force. The target and the style are fixed at the first remote effect.

D5. Store, flush and push. One store per project, at `<ws.root>/docs-store`. It is never `ws.repo`, because `afterMerge` resets `ws.repo` to `origin/main` under the repository lock
(`server/orchestrator/merge-steps.ts:123-134`). The flush projects the drafts onto the allowlist and is level-triggered: it writes only paths the draft owns.
The five documents are written by compare-and-set: a conflict sets `diverged` and nothing is merged. An alias folder belongs to the draft that
committed it first (trailer `Refine-Draft`). A started or delivered alias is immutable. Pushes are non-force, with a short debounce. A rejected push
resets to `origin/main` and recomputes the flush; there is no union merge and no `rebase -X theirs`.

D6. Closing and tags. `beginStart` takes the `starting` flag before any await and keeps it until the start is marked or failed. Closing: flush,
a closing commit (empty, with trailers), push until the commit is an ancestor of `origin/main`, then a detached snapshot worktree at `<ws.root>/docs-at/<draftId>`.
Nothing launches if the push fails. Tags are created after the launch, annotated, at the closing commit; a name taken at another commit gets the next free suffix `.N`.
A tag failure never fails the start; `tickDocs` retries it. Started and delivered states come from the mirror and the run state, never from tags.

D7. Run side. For docs-repo projects Phase 1 does not run: `plan.md` is the technical specification, the technical text of the pack is empty and
the pack gets a `stack:` line. Phase 0 checks, without network, that the five documents and each alias `plan.md` and `task.md` exist in the snapshot.
Microservices do not get document copies in service repositories.

D8. Agent access. Agents read documents from the pinned snapshot `docs-at/<draftId>` through a read-only grant. `sourceFiles` keeps store-relative names,
checks existence under the snapshot, and fails the step when a required document is missing (no silent skip). A monolith build task
that changes anything under `docs/`, except README, RUNBOOK and API, fails the scope check. The monolith merge queue tolerates a `main` that moved only by allowlisted document paths.

D9. Follow-on drafts. All drafts of a project share the store and commit directly to `main`. A follow-on draft reads the five documents from the store and the JSON from the mirror.
Discarding a draft that did not start removes the aliases it committed. Restarting keeps them.

D10. Safety. A flush is refused when a document contains a known secret value of 12 or more characters, or a token of a known shape (GitHub, Anthropic, OpenRouter, AWS, Slack, PEM, JWT).
The refusal names the document, never the value. Git and gh error text passes through `redactSecrets` before it reaches the UI or the journal.
The gh environment keeps the hardening of the git environment: `withGitConfig` appends the entries at the current count, which fixes the lost `hooksPath` and `fsmonitor`.

D11. Lifecycle. Deleting a project, or discarding the last draft of a project that did not start, releases the store, the snapshots, the marker and the mirror.
Importing a repository that holds only documents is refused with a plain message.

## Increments

Gate for every increment, run in the background and reported with its real result:
`npm run typecheck`, `npm test`, `npm run test:web`, `npm run web:build`, and the test budget (60 seconds per file, 480 seconds for the suite).
Each increment is one or more commits pushed to the branch. Commit messages are in English and end with the attribution lines of the session.

## I0 - Plan in the repository (size S, weight 1)

- [x] This plan is in the repository with the owner decisions, the corrections and the increments.
- [x] `docs/superpowers/plans/README.md` lists plan 119.
- [x] FEATURES item 17 matches the code (the flow is on for new projects, `REPOSITORY_FLOW`), and item 20 describes the documentation repository.
- [x] BACKLOG lists the stale comments and the service repository contradiction as open items.

## I1 - Layout seam (size M, weight 2)

Goal: one pure module owns every document path; legacy output does not change.

- [x] `server/docs/layout.ts`: paths of the eight kinds, allowlist, alias rules, target, owner parse, tag name.
- [x] `server/docs/project-state.ts`: store, mirror, marker, snapshot and closing paths; marker read and write; environment flag reader.
- [x] Characterization tests: `planFileOf` and `taskFileOf` return the legacy strings; the docs-repo tables are tested.
- [x] Layout seam guard: no code outside `layout.ts` builds a `docs/specify` path.
- [x] `planFileOf` and `taskFileOf` delegate to the legacy layout, output unchanged.
- [x] Gate green, and no existing test edited.

## I2a - Git and GitHub primitives, probe (size M, weight 2)

- [x] `server/git/git.ts`: non-force push to `main` with classified failures, optional timeout per call, ancestor check, ahead count, annotated tag helpers, peeled tag lookup, atomic tag push.
- [x] `server/git/github.ts`: repository information from `gh repo view --json`, private repository creation without `--source` and `--push`.
- [x] `server/git/auth.ts`: `withGitConfig` (appends the entries at the current count) and `withGhAuth` (gh receives the token).
- [x] `server/core/redact.ts`: `findCredential` for the high-confidence token shapes and known secret values.
- [x] Unit tests with real git on bare origins, and a fake for gh.
- [x] Probe script `scripts/probes/docs-store.ts` written.
- [ ] Owner-gated: the probe runs on a throwaway owner and its output is saved under `docs/superpowers/probes/`.

## I2b - Documentation store (size L, weight 3)

- [x] `server/docs/store.ts`: open and heal, projection of the eight kinds, atomic writes, allowlist check, secret block.
- [x] Ownership by compare-and-set for the five documents, alias ownership by trailer, started aliases immutable, owned aliases only are retired.
- [x] Commit with trailers, push cycle with reset and recompute, bounded retries, plain messages for protected branch, auth and offline.
- [x] Bind: marker first, initial commit, private repository only when missing, ownership ladder, target locked after the first push.
- [x] Close: closing commit, detached snapshot, tags after launch with `.N` suffix, release.
- [x] Three test files, each under 60 seconds, with `test/fixtures/fake-gh-repos.ts`.

## I3 - Draft writers and spec renderer (size S, weight 1)

- [x] Atomic writes in the four draft writers of allowlisted files (`draft.ts`, `plan-prepare.ts`, `detail-cycle.ts`).
- [x] Projector-only renderer of `spec.md` for the store; `renderSpecMd`, `renderSpecsMd`, `renderBriefMd` and `planBasis` stay byte-identical (golden tests).
- [x] Docs-repo variants of the plan and task text: relative links, "never create other doc files"; legacy text byte-identical.
- [ ] Alias rules in `validateBacklog` (stamped sessions only) and in the registry slug. The validator rule is done; the registry slug check moves to I5 with the stamp.
- [x] `KIND_WRITE_DIRS` unchanged: the draft tree does not move (decision D1), so no write rule changes.

## I4 - Mirror and run side (size L, weight 3)

- [x] `readState`, `writeState`, `updateState` over `writeFileAtomic`; mirror at `<ws.root>/state/docs/`.
- [x] For docs-repo projects, every read of machine JSON from `origin/main` moves to the mirror: preconditions, startsAsDraft, specOnMain, startedOnMain, readDocs, run.ts, deploy.ts, report.ts, the service rules, run-routes plan and report reads (`startedOnMain` stays unchanged: only the legacy copy loop calls it).
- [x] Phase 0 for docs-repo: strict check of the draft docs folder (the snapshot check arrives with I7), mirror writes, no document copies, `publishServiceDocs` not called.
- [x] Phase 1 skipped for docs-repo; technical text empty; stack line in the plan pack; ADRs empty.
- [x] Phase 2, Phase 6 and completion write to the mirror; no docs pull request for `plan.json` and `report.json`.
- [x] Legacy projects keep their path; existing tests keep every assertion (additions only) and stay green.

## I5 - Bind at step 7 (size M, weight 2)

- [x] Flag `TEAMS_AI_DOCS_REPO_LAYOUT` and the `docsRepo` stamp for new projects only; default off.
- [x] `ghExec` in `RegistryDeps`, built through `withGhAuth`.
- [x] Read-only preflight and bind only from the explicit `enableBacklog`; `evaluateChain` cannot bind.
- [x] Spy test: steps 1 to 6 make no git and no gh call.
- [x] `decideArchitecture` cannot change the style after publication; it journals `ArchitectureFailed`.
- [x] `newProject` refuses projectId `artefacty` and an existing marker (with the flag off the marker is not read; the project folder, draft and workspace checks still refuse).

## I6 - Commits at each boundary (size M, weight 2)

- [x] Journal hook after `push()`: synchronous, never awaited, silent on replay.
- [x] Boundary table: BacklogEnabled, BacklogDerived, SpecDerived, PlansStepDone, PlansPrepared; document edits ride the next boundary.
- [x] Level-triggered flush at open; `tickDocs` retries on the existing tick.
- [x] `Snapshot.docsSync` in memory; no journal fact per retry.
- [x] Burst test: six SPEC_DERIVED facts in one tick give one commit.

## I7 - Closing, tags, Phase 0 narrowed (size L, weight 3)

- [x] `beginStart` holds `starting` until the start is marked or failed; discard refused while starting. The legacy single-spec leak is fixed in its own commit with its own test.
- [x] `syncWithMain` no longer clears `starting`.
- [x] Closing: flush, closing commit with trailers, push until ancestor of `origin/main`, detached snapshot; nothing launches on failure.
- [x] Tags after launch: annotated, `dev-start/<alias>` or `.N`, pushed atomically, retried by `tickDocs`; a tag failure never fails the start.
- [x] Microservices: `ws.repo` is the hub repository, which receives the delivery documents (C-2).

Notes from the I7 review: the start flag is taken after the main sync, because the sync guard would refuse otherwise (a characterization test pins it); the run deps read the docs marker twice on load, and that stays open.

## I8 - Development side (size L, weight 3)

- [x] Agents read documents from `docs-at/<draftId>` through the read-only grant; `sourceFiles` keeps store-relative names. The run wiring waits for I7, which creates the snapshot.
- [x] A required document missing from the snapshot fails the step.
- [x] Monolith: a build task that changes `docs/` (except README, RUNBOOK, API) fails the scope check as frozen.
- [x] Monolith merge queue tolerates a `main` moved only by allowlisted document paths.
- [x] Charters and packs are layout-neutral; legacy goldens byte-identical.
- [ ] Knowledge indexer, chat documents, graph input and main-docs read the store for docs-repo projects. Open: chat documents still read the project repository (I9).

## I9 - Follow-on drafts on direct main (size M, weight 2)

- [x] `MainView`: five documents and `docs/briefing.md` from store HEAD; JSON from the mirror.
- [x] A follow-on draft without the mirror project is refused; an alias already present is refused.
- [x] Closing sync is a three-way merge without union; conflict markers refuse the start.
- [x] Discarding a draft that did not start removes its aliases; restarting keeps them.
- [x] Two drafts on one store keep a linear history.

Notes from the I9 review: a continuation discard keeps every folder that main already had (the retire skips aliases of the base copy); a discard whose removal push was refused is published by the next flush, not by a retry of the discard; the main fallback for an unbound docs-repo project stays non-strict (open).

## I10 - Web: documents notice and backlog button (size S, weight 1, owner-gated)

- [ ] Owner-gated: text of the design section written in `design.md` first.
- [ ] Owner-gated: wireframe approved before code.
- [ ] `DocsSyncNotice` component, its tests, and the `Snapshot.docsSync` type.
- [ ] Architecture card button calls `enableBacklog`, with the disclosure line approved by the owner.
- [ ] Chrome check at 1440 and 390 pixels, dark and light, next to the reference screen; detector run once.

## I11 - Live check, guide, runbook, deploy, flag (size M, weight 2, owner-gated)

- [ ] `scripts/live-check/repo.mjs` prints the documentation commits per step, the tags and the allowlist check.
- [ ] README, runbook and FEATURES are final.
- [ ] Owner-gated: the guide graph is rebuilt with `task guia:grafo`, and `test/chat/guide.test.ts` is green.
- [ ] Owner-gated: live check on two throwaway projects passes (quota, real repositories), and both are deleted afterwards.
- [ ] Owner-gated: deploy by clean export with no agent running, then the Chrome check of the deployed application.
- [ ] Owner-gated: the flag is turned on by the owner's yes.
- [ ] Closing audit by a fresh read-only reviewer reports no open item.

## Owner-gated steps

- The probe of I2a creates and deletes a private repository. It needs a throwaway owner and the token scope to delete repositories.
- The design text and the wireframe of I10 need the owner's approval before code, by the frontend rule of the project.
- I11 spends Claude quota, creates real repositories, needs the platform running for the guide graph, and the flag change is the owner's decision.

## Verification

- Per increment: the gate above, with tests written first where the increment changes behavior.
- Legacy: the existing suites are the regression test. A legacy test that must change means the seam leaked.
- Live: the check of I11 counts commits per step, checks the tags, pushes offline and restarts, and checks two drafts editing the same section.

## Decisions taken

- O-1. Only the eight kinds go to the documentation repository. Delivery documents go to the hub (C-2).
- O-2. Commits at boundaries, not at every save.
- O-3. Legacy projects are untouched; there is no migration code. Published test repositories are not migrated.
- O-4. Discarding a draft that did not start removes its committed aliases; restarting keeps them.
- O-5. Phase 1 stops only for docs-repo projects.
- O-6. The bug where nothing writes `project.confidential` is out of scope; it is a separate security fix.
- O-7. Increments are pushed to the branch; the draft pull request collects them.
- Dropped on purpose: a local-first store before step 7, one branch per draft, union merge, a trailer fingerprint for ownership, `rebase -X theirs`, a tag before the launch, moving the draft tree into the repository layout.
