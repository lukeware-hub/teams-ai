import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../server/config/config.js';
import { eventsFile, expandHome, firstSpecForRun, graphDir, nextRunId, olderLiveRun, specForRun, stepDir, workspacePaths, worktreeDir } from '../../server/orchestrator/workspace.js';
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

  it('numbers runs per spec from the existing run directories', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    expect(await nextRunId(ws, 'checkout')).toBe('checkout-r1'); // creates the directory
    await fs.mkdir(path.join(dir, 'checkout-r2'));
    await fs.mkdir(path.join(dir, 'other-r9'));
    expect(await nextRunId(ws, 'checkout')).toBe('checkout-r3');
  });

  it('hands concurrent callers distinct run ids and creates each run directory', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => nextRunId(ws, 'checkout')));
    expect([...ids].sort()).toEqual(['checkout-r1', 'checkout-r2', 'checkout-r3', 'checkout-r4', 'checkout-r5']);
    expect((await fs.readdir(dir)).sort()).toEqual([...ids].sort());
  });

  it('creates the runs directory when it does not exist yet', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    expect(await nextRunId({ runs: path.join(dir, 'nested', 'runs') }, 'checkout')).toBe('checkout-r1');
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
