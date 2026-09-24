import { describe, expect, it } from 'vitest';
import { MergeQueue, type MergeSteps } from '../../server/git/merge-queue.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function steps(over: Partial<MergeSteps> = {}, log: string[] = [], tag = ''): MergeSteps {
  return {
    alreadyMerged: async () => (log.push(`${tag}check`), null),
    rebase: async () => (log.push(`${tag}rebase`), { ok: true, baseSha: 'main1' }),
    gates: async () => (log.push(`${tag}gates`), { ok: true }),
    push: async () => void log.push(`${tag}push`),
    ensurePr: async () => (log.push(`${tag}pr`), { number: 7 }),
    remoteMainSha: async () => (log.push(`${tag}main`), 'main1'),
    merge: async () => (log.push(`${tag}merge`), { merged: true }),
    afterMerge: async () => void log.push(`${tag}after`),
    ...over,
  };
}

describe('MergeQueue', () => {
  it('runs the stages in order and returns the PR number', async () => {
    const log: string[] = [];
    const q = new MergeQueue();
    expect(await q.enqueue('T1', steps({}, log))).toEqual({ ok: true, pr: 7 });
    expect(log).toEqual(['check', 'rebase', 'gates', 'push', 'pr', 'main', 'merge', 'after']);
    expect(q.holder).toBeNull();
  });

  it('short-circuits when the PR was already merged (crash between merge and confirm)', async () => {
    const log: string[] = [];
    const q = new MergeQueue();
    expect(await q.enqueue('T1', steps({ alreadyMerged: async () => 12 }, log))).toEqual({ ok: true, pr: 12, already: true });
    expect(log).toEqual([]);
  });

  it('serializes tasks: the second waits for the first to finish', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new MergeQueue();
    const first = q.enqueue('T1', steps({ gates: async () => (await gate, log.push('a:gates'), { ok: true }) }, log, 'a:'));
    await flush();
    const second = q.enqueue('T2', steps({}, log, 'b:'));
    await flush();
    expect(q.holder).toBe('T1');
    expect(q.waiting).toEqual(['T2']);
    expect(log.some((l) => l.startsWith('b:'))).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(log.indexOf('b:rebase')).toBeGreaterThan(log.indexOf('a:after'));
  });

  it('returns the same promise when a task is enqueued twice', async () => {
    const q = new MergeQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const a = q.enqueue('T1', steps({ gates: async () => (await gate, { ok: true }) }, log));
    const b = q.enqueue('T1', steps({}, log));
    expect(b).toBe(a);
    release();
    await a;
    expect(log.filter((l) => l === 'merge')).toHaveLength(1);
  });

  it('stops at a rebase conflict and reports the files', async () => {
    const log: string[] = [];
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ rebase: async () => ({ ok: false, conflicts: ['src/a.ts'] }) }, log));
    expect(r).toEqual({ ok: false, stage: 'rebase', conflicts: ['src/a.ts'] });
    expect(log).toEqual(['check']);
  });

  it('stops when the gates fail after the rebase', async () => {
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ gates: async () => ({ ok: false, detail: 'unit-test failed' }) }));
    expect(r).toEqual({ ok: false, stage: 'gates', detail: 'unit-test failed' });
  });

  it('refuses to merge when main moved after the rebase, without calling merge', async () => {
    const log: string[] = [];
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ remoteMainSha: async () => 'main2' }, log));
    expect(r).toEqual({ ok: false, stage: 'merge', detail: 'main moved: rebased on main1, remote is main2' });
    expect(log).not.toContain('merge');
  });

  it('reports a refused merge (head moved) without forcing and releases the lock', async () => {
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ merge: async () => ({ merged: false, reason: 'head moved' }) }));
    expect(r).toEqual({ ok: false, stage: 'merge', detail: 'head moved' });
    expect(q.holder).toBeNull();
  });

  it('keeps a merged PR as success when afterMerge fails, carrying a warning', async () => {
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ afterMerge: async () => { throw new Error('graphify failed'); } }));
    expect(r).toEqual({ ok: true, pr: 7, warning: 'afterMerge: graphify failed' });
  });

  it('turns a thrown step into that stage failure and keeps serving the queue', async () => {
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ push: async () => { throw new Error('remote hung up'); } }));
    expect(r).toEqual({ ok: false, stage: 'push', detail: 'remote hung up' });
    expect(await q.enqueue('T2', steps())).toEqual({ ok: true, pr: 7 });
  });
});
