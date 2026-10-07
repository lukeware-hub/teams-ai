import { describe, expect, it } from 'vitest';
import { newProgram, tick, type Program, type ProgramEffects, type RunOutcome } from '../../server/program/controller.js';

const entry = (key: string, rank: number, dependsOn: string[] = []) => ({ specId: `d-${key}`, key, rank, dependsOn: dependsOn.map((k) => `d-${k}`) });
const NOW = new Date('2026-10-07T12:00:00Z');

/** Effects over an in-memory world: runs are created by startRun and answer whatever the test scripted. */
function world(outcomes: Record<string, RunOutcome | RunOutcome[]> = {}) {
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
  };
  return { fx, calls, active };
}
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

  it('finishes when nothing is left to run, with what failed on the ledger', async () => {
    const { fx } = world({ 'd-a-r1': { kind: 'failed', reason: 'boom' } });
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a'])], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(p.status).toBe('finished');
    expect(status(p)).toEqual({ a: 'failed', b: 'blocked' });
  });

  it('resumes an interrupted run a bounded number of times, then fails the item', async () => {
    const { fx, calls } = world({ 'd-a-r1': { kind: 'interrupted' } });
    let p = newProgram('d', [entry('a', 1)], NOW);
    p = await tick(p, fx, save);
    for (let i = 0; i < 5; i++) p = await tick(p, fx, save);
    expect(calls.filter((c) => c.startsWith('resume'))).toHaveLength(3);
    expect(p.items[0]!.status).toBe('failed');
    expect(p.items[0]!.reason).toMatch(/interrupted/);
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

  it('records a start failure on the item and goes on', async () => {
    const { fx } = world();
    fx.startRun = async (specId) => {
      if (specId === 'd-a') throw new Error('docker is not reachable');
      return { runId: `${specId}-r1` };
    };
    let p = newProgram('d', [entry('a', 1), entry('b', 2)], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'failed', b: 'running' });
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
});
