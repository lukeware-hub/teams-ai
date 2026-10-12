import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../server/config/config.js';
import type { PlanTask } from '../../server/contracts/plan.js';
import { deliveredByPriorRuns, eventsFile, expandHome, firstSpecForRun, firstSpecForSpec, graphDir, mergedByPriorRuns, nextRunId, olderLiveRun, serviceWorkspace, specForRun, stepDir, workspacePaths, worktreeDir } from '../../server/orchestrator/workspace.js';
import { EventStore } from '../../server/store/event-store.js';

let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('workspace', () => {
  it('expands ~ against the given home and lays out the project directories', () => {
    expect(expandHome('~/.teams-ai/x', '/home/u')).toBe('/home/u/.teams-ai/x');
    const ws = workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u');
    expect(ws).toEqual({
      projectId: 'shop',
      root: '/home/u/.teams-ai/workspaces/shop',
      repo: '/home/u/.teams-ai/workspaces/shop/repo',
      worktrees: '/home/u/.teams-ai/workspaces/shop/worktrees',
      graph: '/home/u/.teams-ai/workspaces/shop/graph',
      knowledgeDb: '/home/u/.teams-ai/workspaces/shop/knowledge.sqlite',
      secrets: '/home/u/.teams-ai/workspaces/shop/secrets',
      runs: '/home/u/.teams-ai/runs',
    });
    expect(worktreeDir(ws, 'task/checkout-T1')).toBe('/home/u/.teams-ai/workspaces/shop/worktrees/task__checkout-T1');
    expect(graphDir(ws, null)).toBe('/home/u/.teams-ai/workspaces/shop/graph/main');
    expect(graphDir(ws, 'task/checkout-T1')).toBe('/home/u/.teams-ai/workspaces/shop/graph/worktrees/task__checkout-T1');
    expect(eventsFile(ws, 'checkout-r1')).toBe('/home/u/.teams-ai/runs/checkout-r1/events.ndjson');
    expect(stepDir(ws, 'checkout-r1', 7)).toBe('/home/u/.teams-ai/runs/checkout-r1/steps/s00007');
  });

  it('gives a service its own repository, worktrees and graph beside the project, and keeps the rest', () => {
    const ws = workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u');
    expect(serviceWorkspace(ws, null)).toBe(ws);
    expect(serviceWorkspace(ws, 'orders')).toEqual({
      ...ws,
      repo: '/home/u/.teams-ai/workspaces/shop/services/orders/repo',
      worktrees: '/home/u/.teams-ai/workspaces/shop/services/orders/worktrees',
      graph: '/home/u/.teams-ai/workspaces/shop/services/orders/graph',
    });
  });

  it('numbers runs per spec from the existing run directories', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    expect(await nextRunId(ws, 'checkout')).toBe('shop--checkout--run-1'); // creates the directory
    await fs.mkdir(path.join(dir, 'checkout-r2')); // a legacy run of the same spec: numbering carries on
    await fs.mkdir(path.join(dir, 'other-r9'));
    await fs.mkdir(path.join(dir, 'mall--checkout--run-7')); // another project's spec of the same id
    expect(await nextRunId(ws, 'checkout')).toBe('shop--checkout--run-3');
    expect(await nextRunId(ws, 'checkout', 'complete')).toBe('shop--checkout--complete-run-1');
  });

  it('hands concurrent callers distinct run ids and creates each run directory', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => nextRunId(ws, 'checkout')));
    expect([...ids].sort()).toEqual([1, 2, 3, 4, 5].map((n) => `shop--checkout--run-${n}`));
    expect((await fs.readdir(dir)).sort()).toEqual([...ids].sort());
  });

  it('creates the runs directory when it does not exist yet', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    expect(await nextRunId({ runs: path.join(dir, 'nested', 'runs'), projectId: 'shop' }, 'checkout')).toBe('shop--checkout--run-1');
  });
});

describe('olderLiveRun', () => {
  const setup = async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    return { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
  };
  // A run is live while its journal holds the lock on its event log; `projectId` stamps the RUN_STARTED the run writes first.
  const open = async (ws: Awaited<ReturnType<typeof setup>>, runId: string, projectId?: string) => {
    const store = await EventStore.open({ file: eventsFile(ws, runId), runId, specHash: 'h' });
    if (projectId) await store.append({ type: 'RUN_STARTED', data: { runId, projectId } });
    return store;
  };

  it('names an older run of the spec while its journal is open, and nothing once it is closed', async () => {
    const ws = await setup();
    const older = await open(ws, 'checkout-r1', 'shop');
    expect(await olderLiveRun(ws, 'checkout', 'checkout-r2')).toBe('checkout-r1');
    await older.close();
    expect(await olderLiveRun(ws, 'checkout', 'checkout-r2')).toBeNull();
  });

  it('ignores the run itself, newer runs, other specs and runs of another project', async () => {
    const ws = await setup();
    const stores = [
      await open(ws, 'checkout-r2'),
      await open(ws, 'checkout-r3'),
      await open(ws, 'checkout-complete-r1'),
      await open(ws, 'other-r1'),
      await open(ws, 'checkout-r1', 'elsewhere'), // run numbers are shared by every project that has a spec of this id
    ];
    expect(await olderLiveRun(ws, 'checkout', 'checkout-r2')).toBeNull();
    for (const s of stores) await s.close();
  });

  it('ignores a lock whose process is gone or that was taken on another host', async () => {
    const ws = await setup();
    const lock = `${eventsFile(ws, 'checkout-r1')}.lock`;
    await fs.mkdir(path.dirname(lock), { recursive: true });
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    await fs.writeFile(lock, `${gone}@${os.hostname()}`);
    expect(await olderLiveRun(ws, 'checkout', 'checkout-r2')).toBeNull();
    await fs.writeFile(lock, `${process.pid}@some-other-container`);
    expect(await olderLiveRun(ws, 'checkout', 'checkout-r2')).toBeNull();
    await fs.writeFile(lock, `${process.pid}@${os.hostname()}`); // control: the same file, held by a live process here
    expect(await olderLiveRun(ws, 'checkout', 'checkout-r2')).toBe('checkout-r1');
  });
});

describe('specForRun', () => {
  it('reads the spec a run belongs to from its RUN_STARTED, and is null for a run that never started', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    const store = await EventStore.open({ file: eventsFile(ws, 'a-001-z-r1'), runId: 'a-001-z-r1', specHash: 'h' });
    await store.append({ type: 'RUN_STARTED', data: { runId: 'a-001-z-r1', specId: 'a-001-z', projectId: 'shop' } });
    await store.close();
    expect(await specForRun(ws, 'a-001-z-r1')).toBe('a-001-z');
    expect(await specForRun(ws, 'never-r1')).toBeNull();
  });

  it('reads whether the run was the first spec from its RUN_STARTED, null when it did not record it', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    const open = (id: string) => EventStore.open({ file: eventsFile(ws, id), runId: id, specHash: 'h' });
    const first = await open('a-001-x-r1');
    await first.append({ type: 'RUN_STARTED', data: { runId: 'a-001-x-r1', specId: 'a-001-x', projectId: 'shop', firstSpec: true } });
    await first.close();
    const later = await open('a-002-y-r1');
    await later.append({ type: 'RUN_STARTED', data: { runId: 'a-002-y-r1', specId: 'a-002-y', projectId: 'shop', firstSpec: false } });
    await later.close();
    const old = await open('a-003-z-r1');
    await old.append({ type: 'RUN_STARTED', data: { runId: 'a-003-z-r1', specId: 'a-003-z', projectId: 'shop' } });
    await old.close();
    expect(await firstSpecForRun(ws, 'a-001-x-r1')).toBe(true);
    expect(await firstSpecForRun(ws, 'a-002-y-r1')).toBe(false);
    expect(await firstSpecForRun(ws, 'a-003-z-r1')).toBeNull();
    expect(await firstSpecForRun(ws, 'never-r1')).toBeNull();
  });
});

const task = (id: string, description = `do ${id}`): PlanTask => ({ id, title: id, description, owner: 'dev', origin: 'plan', criteriaRefs: ['AC-001'], affectedPaths: [`src/${id}.ts`], dependsOn: [] });
const priorRuns = async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
  const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
  // A run as the orchestrator journals it: its plan, then what it merged, adopted or found on main.
  const run = async (id: string, o: { projectId?: string; specHash?: string; planned: PlanTask[]; merged?: string[]; onMain?: string[]; adopted?: string[]; replanned?: { taskId: string; replacements: { id: string }[] }[]; finished?: boolean }) => {
    const s = await EventStore.open({ file: eventsFile(ws, id), runId: id, specHash: o.specHash ?? 'h' });
    await s.append({ type: 'RUN_STARTED', data: { runId: id, specId: 'a-001', projectId: o.projectId ?? 'shop' } });
    for (const t of o.planned) await s.append({ type: 'TASK_PLANNED', data: { task: t } });
    for (const r of o.replanned ?? []) await s.append({ type: 'TASK_REPLANNED', data: r });
    for (const taskId of o.merged ?? []) await s.append({ type: 'PR_MERGED', data: { taskId, pr: 1 } });
    for (const taskId of o.onMain ?? []) await s.append({ type: 'TASK_ALREADY_ON_MAIN', data: { taskId, paths: [], summary: '' } });
    const merged = [...(o.merged ?? []), ...(o.onMain ?? []), ...(o.adopted ?? [])];
    if (o.finished !== false) await s.append({ type: 'RUN_FINISHED', data: { result: 'verification-failed', reason: 'x', merged, blocked: [], tokens: {} } });
    await s.close();
  };
  return { ws, run };
};

describe('mergedByPriorRuns', () => {
  it('adopts what earlier runs of the same spec in this project delivered, ignoring later and other-project runs', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', { planned: [task('T0-scaffold'), task('T1')], merged: ['T0-scaffold', 'T1'] });
    await run('a-001-r2', { planned: [task('T2')], merged: ['T2'] });
    // A later run (r4) and a run of another project sharing the spec id must not count.
    await run('a-001-r4', { planned: [task('T3')], merged: ['T3'] });
    await run('a-001-r5', { projectId: 'other-shop', planned: [task('T9')], merged: ['T9'] });
    const tasks = [task('T0-scaffold'), task('T1'), task('T2'), task('T3'), task('T9')];
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r3', tasks, 'h')).toEqual(new Set(['T0-scaffold', 'T1', 'T2']));
  });

  // Live finding (loja-eventos/cancelar-pedido run 3, 2026-10-12): the spec's second version re-planned its six
  // tasks with new definitions under the same ids; all six were adopted because run 1 merged those ids, and no code changed.
  it('does not adopt a task whose definition changed since an earlier run delivered it', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', { planned: [task('T1', 'create the route')], merged: ['T1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T1', 'create the route and document its 404')], 'h')).toEqual(new Set());
  });

  // Plan 75 review: a new version may reword a criterion its unchanged task references, so it checks every task again.
  it('does not adopt from an earlier run of another version of the spec, even with the same definition', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', { specHash: 'h-old', planned: [task('T1')], merged: ['T1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T1')], 'h')).toEqual(new Set());
  });

  // Plan 75 review: a run journaled before a schema default existed still matches the same task parsed today.
  it('adopts a task journaled before a field it has today had a default', async () => {
    const { ws, run } = await priorRuns();
    const { origin: _, ...before } = task('T1');
    await run('a-001-r1', { planned: [before as PlanTask], merged: ['T1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T1')], 'h')).toEqual(new Set(['T1']));
  });

  it('does not adopt a task an earlier run only adopted, so a wrong adoption never travels to the next run', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', { planned: [task('T1', 'old')], merged: ['T1'] });
    await run('a-001-r2', { planned: [task('T1', 'new')], adopted: ['T1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r3', [task('T1', 'new')], 'h')).toEqual(new Set());
  });

  it('adopts a task an earlier run found already on main', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', { planned: [task('T1')], onMain: ['T1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T1')], 'h')).toEqual(new Set(['T1']));
  });

  it('adopts what an earlier run merged even when it stopped before finishing', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', { planned: [task('T1'), task('T2')], merged: ['T1'], finished: false });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T1'), task('T2')], 'h')).toEqual(new Set(['T1']));
  });

  it('adopts a replaced task once every task that replaced it merged', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', {
      planned: [task('T0'), task('T1')],
      replanned: [{ taskId: 'T0', replacements: [{ id: 'T0-r1' }] }, { taskId: 'T1', replacements: [{ id: 'T1-r1' }, { id: 'T1-r2' }] }],
      merged: ['T0-r1', 'T1-r1'],
    });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T0'), task('T1')], 'h')).toEqual(new Set(['T0']));
  });

  it('is empty for a spec with no earlier runs', async () => {
    const { ws } = await priorRuns();
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r1', [task('T1')], 'h')).toEqual(new Set());
  });

  // Live finding (R11.3/4 program run, r4-r7, 2026-10-07): T900-fix-1, planned by Phase 4 for a criterion a prior
  // run found uncovered, was inherited as already-merged by every retry. Once the criterion's own wording changed
  // (an owner correction to an unprovable AC), Phase 4 never got a fresh chance to plan a fix for it again: the old
  // fix task stayed adopted as done, silently answering for a criterion it was never re-checked against.
  it('never adopts a T900-fix-* task: a fix task answers one verification attempt, never carried into a retry', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', { planned: [task('T0-scaffold'), task('T900-fix-1')], merged: ['T0-scaffold', 'T900-fix-1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T0-scaffold'), task('T900-fix-1')], 'h')).toEqual(new Set(['T0-scaffold']));
  });
});

describe('deliveredByPriorRuns', () => {
  it('lists the plan tasks earlier runs delivered in any version, never one a run only adopted', async () => {
    const { ws, run } = await priorRuns();
    await run('a-001-r1', { specHash: 'h-old', planned: [task('T0-scaffold'), task('T1')], merged: ['T0-scaffold', 'T1'] });
    await run('a-001-r2', { planned: [task('T2', 'new')], adopted: ['T2'] });
    await run('a-001-r3', { planned: [task('T3')], onMain: ['T3'] });
    expect(await deliveredByPriorRuns(ws, 'a-001', 'a-001-r4')).toEqual(new Set(['T0-scaffold', 'T1', 'T3']));
  });
});

describe('firstSpecForSpec', () => {
  // Live finding (R11.3/4 program run, r4, 2026-10-07): retrying the project's first spec with a fresh run id (no
  // --run, so no resume answer) re-asked isFirstSpec(), which by then saw far more than docs/.github on main (the
  // scaffold this very spec had already merged) and answered false, rejecting its own T0-scaffold task on replan.
  it('is true once any earlier run of this spec in this project recorded firstSpec true, regardless of what main looks like now', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    const open = (id: string) => EventStore.open({ file: eventsFile(ws, id), runId: id, specHash: 'h' });
    const r1 = await open('a-001-r1');
    await r1.append({ type: 'RUN_STARTED', data: { runId: 'a-001-r1', specId: 'a-001', projectId: 'shop', firstSpec: true } });
    await r1.close();
    expect(await firstSpecForSpec(ws, 'a-001', 'a-001-r2')).toBe(true);
  });

  it('is false once an earlier run recorded firstSpec false and none recorded true', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    const open = (id: string) => EventStore.open({ file: eventsFile(ws, id), runId: id, specHash: 'h' });
    const r1 = await open('a-002-r1');
    await r1.append({ type: 'RUN_STARTED', data: { runId: 'a-002-r1', specId: 'a-002', projectId: 'shop', firstSpec: false } });
    await r1.close();
    expect(await firstSpecForSpec(ws, 'a-002', 'a-002-r2')).toBe(false);
  });

  it('is null with no earlier run, or when none of them recorded the field', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    expect(await firstSpecForSpec(ws, 'a-003', 'a-003-r1')).toBeNull();
    const open = (id: string) => EventStore.open({ file: eventsFile(ws, id), runId: id, specHash: 'h' });
    const r1 = await open('a-003-r1');
    await r1.append({ type: 'RUN_STARTED', data: { runId: 'a-003-r1', specId: 'a-003', projectId: 'shop' } });
    await r1.close();
    expect(await firstSpecForSpec(ws, 'a-003', 'a-003-r2')).toBeNull();
  });

  it('ignores a run of the same spec id in another project', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    const open = (id: string) => EventStore.open({ file: eventsFile(ws, id), runId: id, specHash: 'h' });
    const r1 = await open('a-004-r1');
    await r1.append({ type: 'RUN_STARTED', data: { runId: 'a-004-r1', specId: 'a-004', projectId: 'other-shop', firstSpec: true } });
    await r1.close();
    expect(await firstSpecForSpec(ws, 'a-004', 'a-004-r2')).toBeNull();
  });
});
