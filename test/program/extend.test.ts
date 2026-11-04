import { describe, expect, it } from 'vitest';
import { extendProgram, newProgram, type ProgramEntry } from '../../server/program/controller.js';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const entry = (specId: string, rank: number, over: Partial<ProgramEntry> = {}): ProgramEntry => ({ specId, key: specId, rank, dependsOn: [], ...over });

describe('extendProgram: a follow-on request joins the program that runs', () => {
  it('queues the specs it adds, takes the new order of the pending ones, and keeps what started', () => {
    const base = newProgram('shop-001', [entry('login', 1), entry('cart', 2, { dependsOn: ['login'] })], NOW);
    const running = { ...base, items: base.items.map((i) => (i.specId === 'login' ? { ...i, status: 'running' as const, runId: 'shop-001-login-r1' } : i)) };
    const joined = extendProgram(running, [entry('login', 1), entry('export', 2), entry('cart', 3, { dependsOn: ['login', 'export'] })], 'shop-pedido-1', NOW);
    expect(joined.items.map((i) => [i.specId, i.rank, i.status, i.draftId ?? null])).toEqual([
      ['login', 1, 'running', null],
      ['export', 2, 'pending', 'shop-pedido-1'],
      ['cart', 3, 'pending', 'shop-pedido-1'],
    ]);
    expect(joined.items.find((i) => i.specId === 'login')!.runId).toBe('shop-001-login-r1');
    expect(joined.history).toEqual([{ at: NOW.toISOString(), requestId: 'shop-pedido-1', added: ['export'], reranked: ['cart'] }]);
  });

  it('reopens a finished program when the request adds work to it', () => {
    const finished = { ...newProgram('shop-001', [entry('login', 1)], NOW), status: 'finished' as const };
    expect(extendProgram(finished, [entry('login', 1), entry('export', 2)], 'shop-pedido-1', NOW).status).toBe('running');
  });

  it('keeps a spec the program already delivered as it is, whatever the request says about it', () => {
    const done = newProgram('shop-001', [entry('login', 1, { done: true })], NOW);
    const joined = extendProgram(done, [entry('login', 3)], 'shop-pedido-1', NOW);
    expect(joined.items).toEqual(done.items);
    expect(joined.history?.[0]?.reranked).toEqual([]);
  });
});
