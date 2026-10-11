# Plan 62 - Service repositories (roadmap R12.3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: done, 2026-10-11: whole suite 1471 passed and 4 skipped, type check clean. Roadmap item R12.3, stage 12 (plan 60).

**Goal:** Every service the project lists has its own GitHub repository and a clone in its workspace before planning starts, a new service repository gets its CI and release workflows, and a resumed run checks each merge step against the repository it ran in.

**Architecture:** After the docs reach main, Phase 0 walks `project.services`: a clone whose origin answers is only fetched; otherwise the repository is cloned from GitHub, or created there from an empty first commit when GitHub does not have it. The workflow bootstrap runs once per new service, on a docs branch and journal keys named after the service. Merge steps write the repository they ran in into their intents, and reconciliation reads it from there, falling back to the project repository for journals written before.

**Tech Stack:** TypeScript on Node (ES modules), vitest, local git remotes and a scripted `gh` in tests.

**Spec:** `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (sections "Design" and "Slices", item R12.3).

## Global Constraints

- A project without `services` behaves exactly as today: no `gh` call, no new journal event, same paths; every existing test passes unchanged.
- No technology is fixed in code; service names come from `project.json`, repository names are `<projectId>-<service>`.
- Error messages that exist today keep their exact wording.
- Code follows `QUALITY_RULES` (`server/agents/registry.ts`): one-sentence comments, smallest working solution, no duplicated logic.
- Focused test: `npx vitest run <file>`; whole suite: `npx vitest run`; types: `npx tsc --noEmit`.
- Out of scope: the agent writing services plans and the Phase 2 check of which services are new (R12.6); deploy (R12.4); screens (R12.5); the deferred minors of the R12.2 review.

## Review Focus

1. A second run over services whose clones exist makes no `gh` call (Task 1).
2. A service repository that GitHub already has is cloned, never created again (Task 1).
3. Two new services each get their workflows in their own repository, and a service that is not new gets none (Task 2).
4. A resumed run confirms a service task's push, pull request and merge against that service's repository, not the project's (Task 3).
5. A journal written before this plan, whose intents carry no repository, still reconciles against the project repository (Task 3).

## Where the code stands (after plan 61)

- Per-service workspaces, the scaffold rule per service and merges per repository are done (R12.2); this plan only creates and clones what those paths expect.
- `server/core/ids.ts:29`: `repoName(projectId)` returns the project id and nothing calls it.
- `server/orchestrator/run.ts`, `executePhase0`: the docs of the project reach main (draft) or are fetched; nothing creates service repositories.
- `server/orchestrator/run.ts`, `executeWorkflows`: a services plan gets no workflows ("R12.3" comment).
- `server/orchestrator/phases/bootstrap.ts`, `runWorkflowBootstrap`: branch `docs/<spec>-workflows` and journal key `<spec>-7`, which two service repositories in one run would share.
- `server/orchestrator/merge-steps.ts`, `common()`: the push, pull request, merge and worktree removal intents do not say which repository they ran in.
- `server/orchestrator/reconcile.ts:85,96,107-108,125`: those four intents are checked against `deps.ws.repo`, the project repository.

---

### Task 1: Every service of the project has its repository and clone

**Files:**
- Modify: `server/core/ids.ts` (`repoName`)
- Modify: `server/orchestrator/phases/bootstrap.ts` (`ensureServiceRepos`)
- Modify: `server/orchestrator/run.ts` (`executePhase0`)
- Modify: `test/core/ids.test.ts`
- Create: `test/orchestrator/service-repos.test.ts`

**Interfaces:**
- Produces: `repoName(projectId: string, service: string | null = null): string`; `ensureServiceRepos(deps: PhaseDeps & { ghExec: Exec }, owner: string | undefined): Promise<PhaseResult>`, exported from `bootstrap.ts`.

- [ ] **Step 1: Write the failing tests**

`test/core/ids.test.ts`, below the existing `repoName('todo-api')` assertion:

```ts
    expect(repoName('shop', 'orders')).toBe('shop-orders');
    expect(() => repoName('shop', 'Orders')).toThrow(InvalidIdError);
```

`test/orchestrator/service-repos.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { ensureServiceRepos } from '../../server/orchestrator/phases/bootstrap.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { serviceWorkspace, type Workspace } from '../../server/orchestrator/workspace.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
let projectRemote: Remote;
let ordersRemote: Remote;
let journal: Journal;
let ws: Workspace;

beforeEach(async () => {
  projectRemote = await makeRemote({ 'docs/README.md': '# docs\n' });
  ordersRemote = await makeRemote({ 'README.md': '# orders\n' });
  const root = path.join(projectRemote.root, 'ws');
  ws = { projectId: 'shop', root, repo: projectRemote.repo, worktrees: path.join(root, 'wt'), graph: path.join(root, 'graph'), knowledgeDb: '', secrets: path.join(root, 'secrets'), runs: path.join(projectRemote.root, 'runs') };
  journal = await Journal.open({ file: path.join(projectRemote.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
});
afterEach(async () => {
  await journal.close();
  await projectRemote.cleanup();
  await ordersRemote.cleanup();
});

/** GitHub already has shop-orders; shop-inventory exists only once `gh repo create` made it from a bare origin. */
function github(): { exec: FakeExec; created: string[] } {
  const created: string[] = [];
  const inventoryOrigin = path.join(projectRemote.root, 'inventory.git');
  const exec = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .onArgs('gh', ['repo', 'view'], (s) => {
      if (s.args[2] === 'o/shop-orders') return { stdout: JSON.stringify({ nameWithOwner: 'o/shop-orders', url: ordersRemote.origin }) };
      if (s.args[2] === 'o/shop-inventory' && created.length > 0) return { stdout: JSON.stringify({ nameWithOwner: 'o/shop-inventory', url: inventoryOrigin }) };
      return { exitCode: 1, stderr: 'Could not resolve to a Repository' };
    })
    .onArgs('gh', ['repo', 'create'], async (s) => {
      created.push(s.args[2]!);
      await fs.mkdir(inventoryOrigin, { recursive: true });
      await git(inventoryOrigin, ['init', '-q', '--bare', '-b', 'main'], execCommand);
      await git(s.cwd!, ['remote', 'add', 'origin', inventoryOrigin], execCommand);
      await git(s.cwd!, ['push', '-q', '-u', 'origin', 'main'], execCommand);
      return { stdout: 'https://github.example/o/shop-inventory\n' };
    });
  return { exec, created };
}

const deps = (exec: FakeExec, services?: string[]) => ({ journal, ws, spec, project: makeProject({ projectId: 'shop', services }), exec: exec.exec, ghExec: exec.exec }) as unknown as PhaseDeps & { ghExec: FakeExec['exec'] };

describe('ensureServiceRepos', () => {
  it('clones a service repository GitHub already has and creates a missing one from an empty first commit', async () => {
    const { exec, created } = github();
    expect(await ensureServiceRepos(deps(exec, ['orders', 'inventory']), 'o')).toEqual({ ok: true });
    expect(await git(serviceWorkspace(ws, 'orders').repo, ['ls-tree', '--name-only', 'origin/main'])).toBe('README.md');
    expect(created).toEqual(['o/shop-inventory']);
    expect(await git(serviceWorkspace(ws, 'inventory').repo, ['log', '--format=%s', 'origin/main'])).toBe('chore: create shop-inventory');
    expect(journal.events.find((e) => e.type === OrchEvent.RepoBootstrapped)!.data).toMatchObject({ service: 'inventory', created: true });
  });

  it('only fetches the clones on a second run', async () => {
    const { exec, created } = github();
    await ensureServiceRepos(deps(exec, ['orders', 'inventory']), 'o');
    const calls = exec.lines('gh').length;
    expect(await ensureServiceRepos(deps(exec, ['orders', 'inventory']), 'o')).toEqual({ ok: true });
    expect(exec.lines('gh')).toHaveLength(calls);
    expect(created).toEqual(['o/shop-inventory']);
  });

  it('touches nothing for a project without services', async () => {
    const { exec } = github();
    expect(await ensureServiceRepos(deps(exec), 'o')).toEqual({ ok: true });
    expect(exec.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/core/ids.test.ts test/orchestrator/service-repos.test.ts`
Expected: FAIL; `repoName('shop', 'orders')` returns `shop`, and `ensureServiceRepos` is not a function.

- [ ] **Step 3: Write the implementation**

`server/core/ids.ts`, replacing `repoName`:

```ts
/** The GitHub repository of a project, or of one of its services: `<projectId>-<service>`. */
export function repoName(projectId: string, service: string | null = null): string {
  assertSlug(projectId, 'projectId');
  return service === null ? projectId : `${projectId}-${assertSlug(service, 'service')}`;
}
```

`server/orchestrator/phases/bootstrap.ts`: import `repoName` from `../../core/ids.js`, `headSha` with `git` from `../../git/git.js`, and `serviceWorkspace` from `../workspace.js`; then below `runPhase0`:

```ts
/** R12.3: every service of the project gets its GitHub repository and a clone in its workspace before planning. */
export async function ensureServiceRepos(deps: PhaseDeps & { ghExec: Exec }, owner: string | undefined): Promise<PhaseResult> {
  for (const service of deps.project.services ?? []) {
    const { repo } = serviceWorkspace(deps.ws, service);
    try {
      // A clone whose origin answers is ready.
      if ((await isRepo(repo)) && (await gitFetch(repo, deps.exec).then(() => true, () => false))) continue;
      await cloneOrCreate(deps, service, repo, owner);
      await gitFetch(repo, deps.exec);
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err; // CrashInjected (test hook) must still kill the process
      const reason = `service ${service}: ${(err as Error).message}`;
      await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 0, reason });
      return { ok: false, reason };
    }
  }
  return { ok: true };
}

/** Clones the service's repository, or creates it on GitHub from an empty first commit on main when GitHub does not have it. */
async function cloneOrCreate(deps: PhaseDeps & { ghExec: Exec }, service: string, repo: string, owner: string | undefined): Promise<void> {
  const name = repoName(deps.project.projectId, service);
  const gh = (args: string[]) => deps.ghExec({ bin: 'gh', args, cwd: deps.ws.root, timeoutMs: 60_000 });
  const login = owner ?? (JSON.parse((await gh(['api', 'user'])).stdout) as { login: string }).login;
  const view = await gh(['repo', 'view', `${login}/${name}`, '--json', 'nameWithOwner,url']);
  if (view.exitCode !== 0 && !NOT_FOUND.test(view.stderr)) throw new Error(`gh repo view failed: ${view.stderr.trim()}`);
  await fs.mkdir(path.dirname(repo), { recursive: true });
  if (view.exitCode === 0 && !(await isRepo(repo))) {
    await git(path.dirname(repo), ['clone', '-q', (JSON.parse(view.stdout) as { url: string }).url, path.basename(repo)], deps.exec);
    return;
  }
  if (!(await isRepo(repo))) await git(path.dirname(repo), ['init', '-q', '-b', 'main', path.basename(repo)], deps.exec);
  if ((await headSha(repo, deps.exec).catch(() => null)) === null) await git(repo, ['commit', '-q', '--allow-empty', '-m', `chore: create ${name}`], deps.exec);
  if (deps.journal.isConfirmed(Intent.RepoCreate, name)) return;
  await deps.journal.intent(Intent.RepoCreate, name, { owner: login, name });
  const created = await ensureRepo({ owner: login, name, private: true, cwd: repo }, deps.ghExec);
  await deps.journal.confirm(Intent.RepoCreate, name, created);
  await deps.journal.fact(OrchEvent.RepoBootstrapped, { ...created, service });
}
```

`server/orchestrator/run.ts`: import `ensureServiceRepos` from `./phases/bootstrap.js` (beside `runWorkflowBootstrap`, through `./phases/index.js` if it re-exports), and replace `executePhase0` with:

```ts
  /** Phase 0: the docs reach main (a draft) or are fetched, then every service gets its repository; public so tests can drive it without scripting Phases 1–3. */
  async executePhase0(): Promise<PhaseResult> {
    // Phases 1 and 2 read the docs from origin/main; a later run must see what was merged since the last one.
    const docs = this.deps.bootstrap ? await runPhase0({ ...this.phaseDeps(), ghExec: this.deps.ghExec }, this.deps.bootstrap) : await gitFetch(this.deps.ws.repo, this.deps.exec).then((): PhaseResult => ({ ok: true }));
    if (!docs.ok) return docs;
    return ensureServiceRepos({ ...this.phaseDeps(), ghExec: this.deps.ghExec }, this.deps.bootstrap?.owner ?? this.deps.project.github.owner ?? this.deps.cfg.github.owner);
  }
```

and export `ensureServiceRepos` from `server/orchestrator/phases/index.ts` beside `runPhase0`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/core/ids.test.ts test/orchestrator/service-repos.test.ts test/orchestrator/phase0.test.ts && npx tsc --noEmit`
Expected: PASS; the Phase 0 tests (no services) pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/core/ids.ts server/orchestrator/phases/bootstrap.ts server/orchestrator/phases/index.ts server/orchestrator/run.ts test/core/ids.test.ts test/orchestrator/service-repos.test.ts
git commit -m "feat(phase0): every service of the project gets its repository and clone"
```

### Task 2: A new service's repository gets its workflows

**Files:**
- Modify: `server/orchestrator/phases/shared.ts` (`PhaseDeps.service`, `docsCommitKey`)
- Modify: `server/orchestrator/phases/bootstrap.ts` (`runWorkflowBootstrap` branch)
- Modify: `server/orchestrator/run.ts` (`executeWorkflows`)
- Modify: `test/orchestrator/run-services.test.ts`

**Interfaces:**
- Consumes: `wsOf`, `firstSpecOf`, `mergeDeps(view)`, `singlePlan` (`run.ts`, plan 61).
- Produces: `PhaseDeps.service?: string`, the service whose repository `ws` is; `docsCommitKey(deps, phase)` returns `<spec>-<phase>-<service>` when it is set, and `runWorkflowBootstrap` uses the branch `docs/<spec>-<service>-workflows`.

- [ ] **Step 1: Write the failing test**

In `test/orchestrator/run-services.test.ts`, import `CI_PATH` and `RELEASE_PATH` from `../../server/orchestrator/workflows.js`, and add to `describe('Run with a services plan', ...)`. The file's `plan` has no scaffold task, so neither of its services is new; each test adds the scaffolds it needs.

```ts
  const scaffold = (service: string) => makePlanTask({ id: `T0-scaffold-${service}`, service, affectedPaths: ['package.json'] });
  const filesOnMain = async (service: 'orders' | 'inventory') => {
    await git(services[service].repo, ['fetch', '-q', 'origin']);
    return git(services[service].repo, ['ls-tree', '-r', '--name-only', 'origin/main']);
  };

  it('commits the workflows to the repository of each new service, each under its own journal key', async () => {
    const run = await Run.create(await deps());
    expect(await run.executeWorkflows({ ...plan, tasks: [...plan.tasks, scaffold('orders'), scaffold('inventory')] })).toEqual({ ok: true });
    for (const service of ['orders', 'inventory'] as const) {
      expect(await filesOnMain(service)).toContain(CI_PATH);
      expect(await filesOnMain(service)).toContain(RELEASE_PATH);
    }
    expect(run.journal.events.filter((e) => e.kind === 'confirm' && e.type === 'DOCS_COMMIT').map((e) => e.intentId)).toEqual(['DOCS_COMMIT:spec-001-7-orders', 'DOCS_COMMIT:spec-001-7-inventory']);
    await run.close();
  });

  it('leaves a service that is not new without workflows', async () => {
    const run = await Run.create(await deps());
    expect(await run.executeWorkflows({ ...plan, tasks: [...plan.tasks, scaffold('inventory')] })).toEqual({ ok: true });
    expect(await filesOnMain('inventory')).toContain(CI_PATH);
    expect(await filesOnMain('orders')).not.toContain(CI_PATH);
    await run.close();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/run-services.test.ts`
Expected: FAIL on both new tests, because `executeWorkflows` returns early for a services plan and no repository gets workflow files.

- [ ] **Step 3: Write the implementation**

`server/orchestrator/phases/shared.ts`: last field of `PhaseDeps`:

```ts
  /** The service whose repository `ws` is; absent for the project repository. */
  service?: string;
```

and:

```ts
export const docsCommitKey = (deps: PhaseDeps, phase: 0 | 1 | 2 | 6 | 7) => `${deps.spec.specId}-${phase}${deps.service ? `-${deps.service}` : ''}`;
```

`server/orchestrator/phases/bootstrap.ts`, in `runWorkflowBootstrap`:

```ts
  const branch = `docs/${spec.specId}${deps.service ? `-${deps.service}` : ''}-workflows`;
```

`server/orchestrator/run.ts`, `executeWorkflows`:

```ts
  /** R8.3: CI and release workflows land on main of a bootstrapped repository, and of every new service's; public for tests. */
  async executeWorkflows(plan: AnyPlan): Promise<PhaseResult> {
    const single = singlePlan(plan);
    if (single) return this.deps.bootstrap ? runWorkflowBootstrap(this.phaseDeps(), single) : { ok: true };
    for (const view of servicePlans(plan).filter((v) => this.firstSpecOf(v))) {
      const r = await runWorkflowBootstrap({ ...this.phaseDeps(), ws: this.wsOf(view), service: view.service!, mergeDeps: this.mergeDeps(view) }, view.plan);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/orchestrator/run-services.test.ts test/orchestrator/workflow-bootstrap.test.ts && npx tsc --noEmit`
Expected: PASS; the existing workflow tests (project repository) pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases/shared.ts server/orchestrator/phases/bootstrap.ts server/orchestrator/run.ts test/orchestrator/run-services.test.ts
git commit -m "feat(run): each new service's repository gets its CI and release workflows"
```

### Task 3: A resumed run reconciles each merge step in its own repository

**Files:**
- Modify: `server/orchestrator/merge-steps.ts` (`common()` intents)
- Modify: `server/orchestrator/reconcile.ts`
- Modify: `test/orchestrator/reconcile.test.ts`

**Interfaces:**
- Produces: the `PUSH`, `PR_CREATE`, `PR_MERGE` and `WORKTREE_REMOVE` intents carry `repo`, the repository the step ran in; `reconcile` reads it and falls back to `deps.ws.repo`.

- [ ] **Step 1: Write the failing test**

In `test/orchestrator/reconcile.test.ts`, add inside `describe('reconcile', ...)`:

```ts
  it("checks a service task's push, pull request and merge in the repository the intent names", async () => {
    const service = await makeRemote({ 'README.md': '# orders\n' });
    const wt = path.join(service.root, 'wt', 'task__spec-001-T1');
    await createWorktree(service.repo, wt, BRANCH, 'origin/main');
    await fs.writeFile(path.join(wt, 'a.txt'), 'a');
    await commitAll(wt, 'feat: a');
    await push(wt, BRANCH);
    const serviceGh = new FakeGh();
    serviceGh.prs.push({ number: 9, head: BRANCH, base: 'main', state: 'MERGED', headRefOid: await headSha(wt), title: 'T1', body: '' });
    const routed = new FakeExec();
    serviceGh.install(routed);
    const d = deps();
    const ghExec: ReconcileDeps['ghExec'] = (s) => (s.cwd === service.repo ? routed.exec(s) : d.ghExec(s));
    await journal.intent(Intent.Push, `${BRANCH}@x`, { worktree: wt, branch: BRANCH, repo: service.repo });
    await journal.intent(Intent.PrCreate, BRANCH, { branch: BRANCH, title: 'T1', repo: service.repo });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'merging' });
    await journal.intent(Intent.PrMerge, `${BRANCH}@y`, { branch: BRANCH, number: 9, taskId: 'T1', repo: service.repo });
    await journal.intent(Intent.WorktreeRemove, BRANCH, { worktree: wt, repo: service.repo });
    const r = await reconcile({ ...d, ghExec });
    expect(r.redo).toEqual([]);
    expect(journal.state.tasks.get('T1')!.state).toBe('merged');
    await expect(fs.access(wt)).rejects.toThrow();
    await service.cleanup();
  });
```

The existing tests write intents without `repo` and keep checking the project repository: they are the regression for old journals.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/orchestrator/reconcile.test.ts`
Expected: FAIL; reconcile looks for the push, the pull request and the merge in the project repository and redoes them, and it removes the worktree through the project repository.

- [ ] **Step 3: Write the implementation**

`server/orchestrator/merge-steps.ts`, in `common()`: add `repo` to the data of the four intents (`{ worktree, branch, sha, repo }`, `{ branch, title, repo }`, `{ branch, number, sha, taskId, repo }`, `{ worktree, repo }`).

`server/orchestrator/reconcile.ts`: below `keyOf`:

```ts
/** The repository a merge step ran in; journals written before R12.3 name none, and those ran in the project repository. */
const repoOf = (d: Record<string, unknown>, ws: Workspace): string => (typeof d.repo === 'string' ? d.repo : ws.repo);
```

and use `repoOf(d, deps.ws)` in place of `deps.ws.repo` in the `Push` (`ls-remote`), `PrCreate` (`cwd`), `PrMerge` (`findMergedPr` and `prState` `cwd`) and `WorktreeRemove` (`removeWorktree`) cases.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/orchestrator/reconcile.test.ts test/orchestrator/merge-steps.test.ts && npx tsc --noEmit`
Expected: PASS; the existing reconcile and merge-steps tests pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/merge-steps.ts server/orchestrator/reconcile.ts test/orchestrator/reconcile.test.ts
git commit -m "feat(reconcile): a resumed run checks each merge step in the repository it ran in"
```

### Task 4: Record R12.3

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R12.3)
- Modify: `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (R12.3 bullet)
- Modify: `docs/superpowers/plans/README.md` (row 62)
- Modify: this plan's status line

- [ ] **Step 1: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, with the test count of before plus the new tests.

- [ ] **Step 2: Mark R12.3 `done` and correct its text**

The roadmap entry and plan 60's bullet still list per-service workspaces, the scaffold rule and per-repository merges, which R12.2 delivered; replace them with what this plan built, its tests and the whole-suite count, and keep open: which services are new is decided in Phase 2 from these repositories (R12.6).

- [ ] **Step 3: Add row 62 to `plans/README.md`, update this status line and commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/2026-10-11-teams-ai-60-services.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-11-teams-ai-62-service-repositories.md
git commit -m "docs(roadmap): R12.3 done, service repositories"
```
