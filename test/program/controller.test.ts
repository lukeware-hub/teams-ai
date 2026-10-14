import { describe, expect, it } from 'vitest';
import { MAX_REPAIRS, newProgram, prioritizeItem, retryItem, tick, type Program, type ProgramEffects, type RunOutcome } from '../../server/program/controller.js';

const entry = (key: string, rank: number, dependsOn: string[] = []) => ({ specId: `d-${key}`, key, rank, dependsOn: dependsOn.map((k) => `d-${k}`) });
const NOW = new Date('2026-10-07T12:00:00Z');

/** Effects over an in-memory world: runs are created by startRun and answer whatever the test scripted. */
function world(outcomes: Record<string, RunOutcome | RunOutcome[]> = {}, repair?: ProgramEffects['repair']) {
  const calls: string[] = [];
  let n = 0;
  const active = new Map<string, string>();
  const fx: ProgramEffects = {
    now: () => NOW,
    findActiveRun: async (specId) => active.get(specId) ?? null,
    startRun: async (specId) => {
      calls.push(`start ${specId}`);
      const runId = `${specId}-r${++n}`;
      active.set(specId, runId);
      return { runId };
    },
    resumeRun: async (runId) => void calls.push(`resume ${runId}`),
    completeSpec: async (specId) => {
      calls.push(`complete ${specId}`);
      return { runId: `${specId}-complete-r1` };
    },
    outcome: async (runId) => {
      const o = outcomes[runId] ?? { kind: 'running' };
      return Array.isArray(o) ? (o.length > 1 ? o.shift()! : o[0]!) : o;
    },
    repair,
  };
  return { fx, calls, active };
}
/** An entry with the SM's conflict map: the keys it must never run together with. */
const mapped = (key: string, rank: number, dependsOn: string[] = [], conflicts: string[] = []) => ({ ...entry(key, rank, dependsOn), conflictsWith: conflicts.map((k) => `d-${k}`) });
const saved: Program[] = [];
const save = async (p: Program) => void saved.push(structuredClone(p));
const status = (p: Program) => Object.fromEntries(p.items.map((i) => [i.key, i.status]));

describe('program controller', () => {
  it('starts the first item by rank, one at a time, and no other while it runs', async () => {
    const { fx, calls } = world();
    let p = newProgram('d', [entry('b', 2, ['a']), entry('a', 1), entry('c', 3)], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(calls).toEqual(['start d-a']);
    expect(status(p)).toEqual({ a: 'running', b: 'pending', c: 'pending' });
    expect(p.items.find((i) => i.key === 'a')!.runId).toBe('d-a-r1');
  });

  // R11.7.2: an item delivered before this program starts done, so its dependents run and it never runs again.
  it('starts an item delivered before the program as done and runs its dependents', async () => {
    const { fx, calls } = world();
    let p = newProgram('d', [{ ...entry('a', 1), done: true }, entry('b', 2, ['a'])], NOW);
    expect(status(p)).toEqual({ a: 'done', b: 'pending' });
    expect('done' in p.items[0]!).toBe(false);
    // Plan 77 review: no reason on it, since a start that launches nothing reports the first item's reason as the cause.
    expect(p.items[0]!.reason).toBeNull();
    p = await tick(p, fx, save);
    expect(calls).toEqual(['start d-b']);
  });

  it('completes a delivered item, then starts the next only after it is done', async () => {
    const { fx, calls } = world({ 'd-a-r1': { kind: 'delivered' }, 'd-a-complete-r1': { kind: 'done' } });
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a'])], NOW);
    p = await tick(p, fx, save); // start a
    p = await tick(p, fx, save); // delivered: complete it
    expect(status(p)).toEqual({ a: 'completing', b: 'pending' });
    p = await tick(p, fx, save); // completion done
    expect(status(p).a).toBe('done');
    p = await tick(p, fx, save); // b starts
    expect(calls).toEqual(['start d-a', 'complete d-a', 'start d-b']);
    expect(p.items[1]!.status).toBe('running');
  });

  it('sums the delivering run\'s and the completion run\'s cost onto the item (R11.6)', async () => {
    const { fx } = world({ 'd-a-r1': { kind: 'delivered', costUsd: 1.5 }, 'd-a-complete-r1': { kind: 'done', costUsd: 0.25 } });
    let p = newProgram('d', [entry('a', 1)], NOW);
    p = await tick(p, fx, save); // start a
    expect(p.items[0]!.costUsd).toBeNull();
    p = await tick(p, fx, save); // delivered: adds 1.5, starts completion
    expect(p.items[0]!.costUsd).toBe(1.5);
    p = await tick(p, fx, save); // completion done: adds 0.25
    expect(p.items[0]!.costUsd).toBe(1.75);
  });

  it('records cost on a failed outcome too, so partial spend is not lost', async () => {
    const { fx } = world({ 'd-a-r1': { kind: 'failed', reason: 'boom', costUsd: 3 } });
    let p = newProgram('d', [entry('a', 1)], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(p.items[0]!.status).toBe('failed');
    expect(p.items[0]!.costUsd).toBe(3);
  });

  it('isolates a failed item, blocks only its dependents and goes on with the others', async () => {
    const { fx, calls } = world({ 'd-a-r1': { kind: 'failed', reason: 'verification-failed: AC-003' } });
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a']), entry('c', 3), entry('d', 4, ['b'])], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'failed', b: 'blocked', c: 'running', d: 'blocked' });
    expect(p.items[0]!.reason).toBe('verification-failed: AC-003');
    expect(p.items[1]!.reason).toMatch(/depends on a/);
    expect(calls).toEqual(['start d-a', 'start d-c']);
  });

  it('blocks an item whose dependency names no item of the program, so a wrong id shows instead of stalling', async () => {
    const { fx, calls } = world();
    // A program saved before dependencies used the items' real ids names d-shop-a, which no item is.
    let p = newProgram('d', [entry('a', 1), { specId: 'd-b', key: 'b', rank: 2, dependsOn: ['d-shop-a'] }], NOW);
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'running', b: 'blocked' });
    expect(p.items[1]!.reason).toBe('depends on d-shop-a, which names no item of this program');
    expect(calls).toEqual(['start d-a']);
  });

  it('finishes when nothing is left to run, with what failed on the ledger', async () => {
    const { fx } = world({ 'd-a-r1': { kind: 'failed', reason: 'boom' } });
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a'])], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(p.status).toBe('finished');
    expect(status(p)).toEqual({ a: 'failed', b: 'blocked' });
  });

  it('resumes an interrupted run a bounded number of times, then the item waits to start again', async () => {
    const { fx, calls } = world({ 'd-a-r1': { kind: 'interrupted' } });
    let p = newProgram('d', [entry('a', 1)], NOW);
    p = await tick(p, fx, save);
    for (let i = 0; i < 5; i++) p = await tick(p, fx, save);
    expect(calls.filter((c) => c.startsWith('resume'))).toHaveLength(3);
    expect(p.items[0]!.status).toBe('waiting');
    expect(p.items[0]!.reason).toMatch(/interrupted/);
  });

  it('marks the run stopped when it gives up resuming it, so the supervisor does not resume it either', async () => {
    const { fx, calls } = world({ 'd-a-r1': { kind: 'interrupted' } });
    fx.stopRun = async (runId) => void calls.push(`stop ${runId}`);
    let p = newProgram('d', [entry('a', 1)], NOW);
    for (let i = 0; i < 6; i++) p = await tick(p, fx, save);
    expect(p.items[0]!.status).toBe('waiting');
    expect(calls.filter((c) => c.startsWith('stop'))).toEqual(['stop d-a-r1']);
  });

  it('persists the spent resume before it launches it, so a crash in between never gives a free one', async () => {
    saved.length = 0;
    const { fx } = world({ 'd-a-r1': { kind: 'interrupted' } });
    let seen: number | undefined;
    fx.resumeRun = async () => void (seen = saved.at(-1)!.items[0]!.resumes);
    let p = newProgram('d', [entry('a', 1)], NOW);
    p = await tick(p, fx, save);
    await tick(p, fx, save);
    expect(seen).toBe(1);
  });

  it('leaves a run the user stopped alone: no resume, no repair, the item waits; a stopped run that finished fails without repair', async () => {
    let repairs = 0;
    const { fx, calls } = world({ 'd-x-r1': { kind: 'stopped' }, 'd-b-r2': { kind: 'stopped', finished: true, costUsd: 1 } }, async () => (repairs++, 'retry-now'));
    let p = newProgram('d', [{ ...entry('a', 1), done: true }, mapped('x', 2), mapped('b', 3)], NOW);
    for (let i = 0; i < 3; i++) p = await tick(p, fx, save);
    expect(calls.filter((c) => !c.startsWith('start'))).toEqual([]);
    expect(repairs).toBe(0);
    expect(status(p)).toEqual({ a: 'done', x: 'running', b: 'failed' });
    expect(p.items[2]).toMatchObject({ reason: 'stopped by the user', costUsd: 1 });
  });

  it('resumes a run a server restart interrupted without spending one of its bounded resumes', async () => {
    const { fx, calls } = world({ 'd-a-r1': { kind: 'interrupted', restart: true } });
    let p = newProgram('d', [entry('a', 1)], NOW);
    p = await tick(p, fx, save);
    for (let i = 0; i < 5; i++) p = await tick(p, fx, save);
    expect(calls.filter((c) => c.startsWith('resume'))).toHaveLength(5);
    expect(p.items[0]).toMatchObject({ status: 'running', resumes: 0 });
  });

  it('adopts a run that was launched before a crash instead of starting a second one', async () => {
    const { fx, calls, active } = world();
    active.set('d-a', 'd-a-r7');
    const p = newProgram('d', [entry('a', 1)], NOW);
    p.items[0]!.status = 'running'; // the crash left the item marked running with no run id recorded
    const next = await tick(p, fx, save);
    expect(next.items[0]!.runId).toBe('d-a-r7');
    expect(calls).toEqual([]);
  });

  it('puts an item whose start failed to wait and goes on', async () => {
    const { fx } = world();
    fx.startRun = async (specId) => {
      if (specId === 'd-a') throw new Error('docker is not reachable');
      return { runId: `${specId}-r1` };
    };
    let p = newProgram('d', [entry('a', 1), entry('b', 2)], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'waiting', b: 'running' });
    expect(p.items[0]!.reason).toMatch(/docker is not reachable/);
  });

  it('persists before it launches, so a crash between the two never loses the claim', async () => {
    saved.length = 0;
    const { fx } = world();
    const order: string[] = [];
    const base = fx.startRun;
    fx.startRun = async (id) => {
      order.push(`launch saw ${saved.length} saves, last ${saved.at(-1)!.items[0]!.status}`);
      return base(id);
    };
    await tick(newProgram('d', [entry('a', 1)], NOW), fx, save);
    expect(order[0]).toBe('launch saw 1 saves, last running');
  });

  it('runs two independent items at once after the first spec is done', async () => {
    const { fx, calls } = world();
    let p = newProgram('d', [{ ...mapped('a', 1), done: true }, mapped('b', 2, ['a']), mapped('c', 3, ['a']), mapped('d', 4, ['a'])], NOW);
    p = await tick(p, fx, save);
    expect(calls).toEqual(['start d-b', 'start d-c']);
    expect(status(p)).toEqual({ a: 'done', b: 'running', c: 'running', d: 'pending' });
  });

  it('never runs together two items the conflict map pairs, from either side', async () => {
    const { fx, calls } = world();
    let p = newProgram('d', [{ ...mapped('a', 1), done: true }, mapped('b', 2, [], ['c']), mapped('c', 3), mapped('d', 4)], NOW);
    p = await tick(p, fx, save);
    expect(calls).toEqual(['start d-b', 'start d-d']);
  });

  it('runs one item at a time when there is no conflict map', async () => {
    const { fx, calls } = world();
    let p = newProgram('d', [{ ...entry('a', 1), done: true }, entry('b', 2), entry('c', 3)], NOW);
    p = await tick(p, fx, save);
    expect(calls).toEqual(['start d-b']);
  });

  it('runs the first spec alone, since it lays the foundation of the project', async () => {
    const { fx, calls } = world();
    let p = newProgram('d', [mapped('a', 1), mapped('b', 2), mapped('c', 3)], NOW);
    p = await tick(p, fx, save);
    expect(calls).toEqual(['start d-a']);
  });

  it('starts a prioritized item ahead of the queue, still never beside an item it conflicts with', async () => {
    const { fx, calls } = world();
    let p = newProgram('d', [{ ...mapped('a', 1), done: true }, mapped('b', 2), mapped('c', 3), mapped('d', 4)], NOW);
    p = prioritizeItem(p, 'd-d', NOW);
    p = await tick(p, fx, save);
    expect(calls).toEqual(['start d-d', 'start d-b']);
    const { fx: fx2, calls: calls2 } = world();
    let q = newProgram('d', [{ ...mapped('a', 1), done: true }, mapped('b', 2, [], ['d']), mapped('d', 3)], NOW);
    q = await tick(q, fx2, save); // b runs; d conflicts with it and waits
    q = prioritizeItem(q, 'd-d', NOW);
    expect(q.items.find((i) => i.key === 'd')!.priority).toBe(true);
    q = await tick(q, fx2, save);
    expect(calls2).toEqual(['start d-b']);
  });

  it('refuses to prioritize an item that is done, running or unknown', () => {
    const p = newProgram('d', [{ ...entry('a', 1), done: true }, entry('b', 2)], NOW);
    expect(() => prioritizeItem(p, 'd-a', NOW)).toThrow(/d-a is done/);
    expect(() => prioritizeItem(p, 'd-zzz', NOW)).toThrow(/unknown/);
  });

  it('runs a failed item again ahead of the queue, and says why a blocked one cannot run', () => {
    let p = newProgram('d', [{ ...entry('a', 1), done: true }, entry('b', 2), entry('c', 3, ['b'])], NOW);
    p.items[1] = { ...p.items[1]!, status: 'failed', reason: 'verification-failed', runId: 'd-b-r1' };
    p.items[2] = { ...p.items[2]!, status: 'blocked', reason: 'depends on b, which failed' };
    expect(() => prioritizeItem(p, 'd-c', NOW)).toThrow('item d-c is blocked: depends on b, which failed');
    p = prioritizeItem(p, 'd-b', NOW);
    expect(p.items[1]).toMatchObject({ status: 'pending', priority: true, runId: null, reason: null });
    expect(p.items[2]!.status).toBe('pending');
    expect(p.status).toBe('running');
  });

  // R11.14: a failed delivering run is repaired a bounded number of times before the owner is asked.
  it('runs a failed item again with its failures, keeps its dependents waiting and its cost, and fails it after the bound', async () => {
    const seen: string[][] = [];
    const { fx, calls } = world(
      {
        'd-a-r1': { kind: 'failed', reason: 'one', costUsd: 1 },
        'd-a-r2': { kind: 'failed', reason: 'two', costUsd: 2 },
        'd-a-r3': { kind: 'failed', reason: 'three', costUsd: 3 },
      },
      async (_specId, failures) => (seen.push([...failures]), 'retry-now'),
    );
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a'])], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'running', b: 'pending' });
    expect(p.items[0]).toMatchObject({ runId: 'd-a-r2', repairs: 1, failures: ['one'], costUsd: 1 });
    p = await tick(p, fx, save);
    expect(p.items[0]).toMatchObject({ runId: 'd-a-r3', repairs: 2, failures: ['one', 'two'], costUsd: 3 });
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'failed', b: 'blocked' });
    expect(p.items[0]!.reason).toBe(`three; ${MAX_REPAIRS} reparo(s) automático(s) não resolveram`);
    expect(p.items[0]!.costUsd).toBe(6);
    // The last failure is classified too: an environment failure waits even after the repairs ran out.
    expect(seen).toEqual([['one'], ['one', 'two'], ['one', 'two', 'three']]);
    expect(calls).toEqual(['start d-a', 'start d-a', 'start d-a']);
  });

  it('stops at the second identical failure instead of spending the remaining repairs on it', async () => {
    const { fx, calls } = world({ 'd-a-r1': { kind: 'failed', reason: 'e2e needs PLATFORM_ADMIN_TOKEN', costUsd: 1 }, 'd-a-r2': { kind: 'failed', reason: 'e2e needs PLATFORM_ADMIN_TOKEN', costUsd: 2 } }, async () => 'retry-now');
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a'])], NOW);
    for (let i = 0; i < 4; i++) p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'failed', b: 'blocked' });
    expect(p.items[0]!.reason).toContain('the same failure came back after a repair');
    expect(calls).toEqual(['start d-a', 'start d-a']);
  });

  it('fails at once when the repair says no, and never repairs without the effect', async () => {
    const refused = world({ 'd-a-r1': { kind: 'failed', reason: 'criteria contradict' } }, async () => 'give-up');
    let p = await tick(newProgram('d', [entry('a', 1)], NOW), refused.fx, save);
    p = await tick(p, refused.fx, save);
    expect(p.items[0]).toMatchObject({ status: 'failed', reason: 'criteria contradict' });
    expect(p.items[0]!.repairs).toBeUndefined();
    const plain = world({ 'd-a-r1': { kind: 'failed', reason: 'x' } });
    let q = await tick(newProgram('d', [entry('a', 1)], NOW), plain.fx, save);
    q = await tick(q, plain.fx, save);
    expect(q.items[0]!.status).toBe('failed');
  });

  it('does not repair a failed completion, and a classification that throws counts as unclassified, so the item waits', async () => {
    const { fx } = world({ 'd-a-r1': { kind: 'delivered' }, 'd-a-complete-r1': { kind: 'failed', reason: 'merge' } }, async () => 'retry-now');
    let p = await tick(newProgram('d', [entry('a', 1)], NOW), fx, save);
    for (let i = 0; i < 3; i++) p = await tick(p, fx, save);
    expect(p.items[0]).toMatchObject({ status: 'failed', reason: 'completion failed: merge' });
    const broken = world({ 'd-a-r1': { kind: 'failed', reason: 'x' } }, async () => { throw new Error('down'); });
    let q = await tick(newProgram('d', [entry('a', 1)], NOW), broken.fx, save);
    q = await tick(q, broken.fx, save);
    expect(q.items[0]).toMatchObject({ status: 'waiting', reason: 'x', waits: 1 });
  });

  // 24/7: an environment failure, or one nobody classified, never ends the item; it waits longer each time, up to an hour.
  it('puts an environment failure to wait with a growing backoff, never spends a repair on it and never fails it', async () => {
    const failed = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`d-a-r${n + 1}`, { kind: 'failed', reason: 'docker daemon down', costUsd: 1 } as RunOutcome]));
    const { fx, calls } = world(failed, async () => 'wait');
    let clock = NOW.getTime();
    fx.now = () => new Date(clock);
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a'])], NOW);
    p = await tick(p, fx, save); // start a
    p = await tick(p, fx, save); // r1 fails: waits 1 minute
    expect(status(p)).toEqual({ a: 'waiting', b: 'pending' });
    expect(p.status).toBe('running');
    expect(p.items[0]).toMatchObject({ reason: 'docker daemon down', waits: 1, retryAt: new Date(clock + 60_000).toISOString(), costUsd: 1 });
    expect(p.items[0]!.repairs).toBeUndefined();
    p = await tick(p, fx, save); // not yet time
    expect(calls).toEqual(['start d-a']);
    for (let n = 2; n <= 6; n++) {
      clock = Date.parse(p.items[0]!.retryAt!);
      p = await tick(p, fx, save); // time has come: back to pending and started again
      expect(p.items[0]).toMatchObject({ status: 'running', runId: `d-a-r${n}` });
      expect(p.items[0]!.retryAt).toBeUndefined();
      p = await tick(p, fx, save); // fails again, the same way
      expect(p.items[0]).toMatchObject({ status: 'waiting', waits: n, retryAt: new Date(clock + 60_000 * 2 ** (n - 1)).toISOString() });
    }
    expect(calls).toHaveLength(6);
    p.items[0]!.waits = 10;
    clock = Date.parse(p.items[0]!.retryAt!);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(p.items[0]).toMatchObject({ status: 'waiting', waits: 11, retryAt: new Date(clock + 3_600_000).toISOString() });
    expect(status(p).b).toBe('pending');
  });

  it('holds no slot while waiting, yet keeps the program live and its dependents pending', async () => {
    const { fx, calls } = world({ 'd-x-r1': { kind: 'failed', reason: 'network down' } }, async () => 'wait');
    let p = newProgram('d', [{ ...mapped('a', 1), done: true }, mapped('x', 2), mapped('b', 3), mapped('c', 4), mapped('y', 5, ['x'])], NOW);
    p = await tick(p, fx, save); // x and b start
    p = await tick(p, fx, save); // x waits; its slot goes to c
    expect(status(p)).toEqual({ a: 'done', x: 'waiting', b: 'running', c: 'running', y: 'pending' });
    expect(calls).toEqual(['start d-x', 'start d-b', 'start d-c']);
    const alone = world({ 'd-a-r1': { kind: 'failed', reason: 'network down' } }, async () => 'wait');
    let q = await tick(newProgram('d', [entry('a', 1)], NOW), alone.fx, save);
    q = await tick(q, alone.fx, save);
    expect(q).toMatchObject({ status: 'running', items: [{ status: 'waiting' }] });
  });

  it('waits when a run cannot be adopted nor started, or cannot be resumed, and stops the run it gave up on', async () => {
    const { fx, calls } = world({ 'd-a-r1': { kind: 'interrupted' } });
    fx.stopRun = async (runId) => void calls.push(`stop ${runId}`);
    fx.startRun = async () => { throw new Error('spawn EAGAIN'); };
    const adopt = newProgram('d', [entry('a', 1)], NOW);
    adopt.items[0]!.status = 'running';
    expect((await tick(adopt, fx, save)).items[0]).toMatchObject({ status: 'waiting', reason: 'spawn EAGAIN', waits: 1 });
    fx.resumeRun = async () => { throw new Error('journal never appeared'); };
    const p = newProgram('d', [entry('a', 1)], NOW);
    Object.assign(p.items[0]!, { status: 'running', runId: 'd-a-r1' });
    expect((await tick(p, fx, save)).items[0]).toMatchObject({ status: 'waiting', reason: 'resume failed: journal never appeared' });
    expect(calls).toEqual(['stop d-a-r1']);
  });

  it('runs a waiting item now when it is prioritized', () => {
    const p = newProgram('d', [entry('a', 1)], NOW);
    Object.assign(p.items[0]!, { status: 'waiting', reason: 'network down', runId: 'd-a-r1', retryAt: '2026-10-07T13:00:00.000Z', waits: 3 });
    const next = prioritizeItem(p, 'd-a', NOW);
    expect(next.items[0]).toMatchObject({ status: 'pending', priority: true, runId: null, reason: null, waits: 3 });
    expect(next.items[0]!.retryAt).toBeUndefined();
  });

  it('retryItem clears a failed item back to pending and un-blocks its dependents, so the next tick gives it another try', () => {
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a']), entry('c', 3)], NOW);
    p.items[0] = { ...p.items[0]!, status: 'failed', reason: 'verification-failed: AC-003', runId: 'd-a-r1', finishedAt: NOW.toISOString(), repairs: 2, failures: ['a', 'b'] };
    p.items[1] = { ...p.items[1]!, status: 'blocked', reason: 'depends on a, which failed', finishedAt: NOW.toISOString() };
    p.items[2] = { ...p.items[2]!, status: 'done' };
    p.status = 'finished';
    const retried = retryItem(p, 'd-a', new Date('2026-10-07T15:00:00Z'));
    expect(retried.items[0]).toMatchObject({ status: 'pending', reason: null, runId: null, finishedAt: null });
    expect(retried.items[0]).toMatchObject({ repairs: 0, failures: [] });
    expect(retried.items[1]).toMatchObject({ status: 'pending', reason: null });
    expect(retried.items[2].status).toBe('done'); // a finished item never resets just because something else retries
    expect(retried.status).toBe('running');
  });

  it('refuses to retry an item that is not failed', () => {
    const p = newProgram('d', [entry('a', 1)], NOW);
    expect(() => retryItem(p, 'd-a', NOW)).toThrow(/not failed/);
  });

  it('refuses to retry an unknown spec id', () => {
    const p = newProgram('d', [entry('a', 1)], NOW);
    p.items[0]!.status = 'failed';
    expect(() => retryItem(p, 'd-zzz', NOW)).toThrow(/unknown/);
  });
});
