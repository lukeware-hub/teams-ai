import { describe, expect, it } from 'vitest';
import { Accounting, type UsageRecord } from '../../server/budget/accounting.js';

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  role: 'dev',
  phase: 'tasks',
  taskId: 'T1-create',
  attempt: 1,
  stepKind: 'dev',
  provider: 'claude',
  model: 'opus',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 50 },
  costUsd: 0.01,
  durationMs: 1000,
  numTurns: 2,
  at: '2026-09-24T10:00:00.000Z',
  ...over,
});

describe('Accounting', () => {
  it('sums usage, cost and steps', () => {
    const acc = new Accounting();
    acc.record(rec({}));
    acc.record(rec({ attempt: 2, costUsd: 0.02 }));
    expect(acc.total()).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 100, costUsd: 0.03, steps: 2 });
  });

  it('filters by role, phase, task and provider', () => {
    const acc = new Accounting();
    acc.record(rec({}));
    acc.record(rec({ role: 'test', stepKind: 'review', provider: 'openrouter', costUsd: null }));
    expect(acc.total({ role: 'test' }).steps).toBe(1);
    expect(acc.total({ provider: 'openrouter' }).costUsd).toBe(0);
    expect(acc.total({ taskId: 'T9-none' }).steps).toBe(0);
  });

  it('counts every token class in tokensOf', () => {
    expect(new Accounting().tokensOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(10);
  });

  it('exposes an immutable copy of the records', () => {
    const acc = new Accounting();
    acc.record(rec({}));
    const list = acc.records();
    expect(list).toHaveLength(1);
    expect(() => (list as UsageRecord[]).push(rec({}))).toThrow();
  });
});
