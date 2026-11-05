import { describe, expect, it } from 'vitest';
import { Accounting } from '../../server/budget/accounting.js';
import { replayAccounting } from '../../server/orchestrator/accounting-replay.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
let seq = 0;
const ev = (type: string, data: Record<string, unknown>): StoredEvent => ({ seq: ++seq, at: '2026-11-05T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact', data });
const step = (stepId: string, costUsd: number): StoredEvent[] => [
  ev('STEP_STARTED', { stepId, kind: 'dev', role: 'dev', taskId: null, attempt: 1 }),
  ev('STEP_FINISHED', { stepId, kind: 'dev', taskId: null, attempt: 1, usage: tokens, costUsd }),
];
const decision = (attempts: unknown[]): StoredEvent => ev('DECISION_MADE', { record: { attempts } });

const totalOf = (events: StoredEvent[]): number => {
  const accounting = new Accounting();
  replayAccounting(events, accounting);
  return accounting.total().costUsd;
};

describe('replayAccounting', () => {
  it('counts a finished step with its cost', () => {
    expect(totalOf(step('s1', 0.5))).toBeCloseTo(0.5);
  });

  it('counts every billed decision call: the Jev and the Claude escalation, and a local call at no cost', () => {
    const events = [
      ...step('s1', 1),
      decision([
        { backend: 'jev', model: 'jev-model', outcome: 'low-confidence', usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.02 } },
        { backend: 'local', model: 'local', outcome: 'answered', usage: { inputTokens: 5, outputTokens: 2, costUsd: 0 } },
        { backend: 'claude', model: 'claude', outcome: 'answered', usage: { inputTokens: 9, outputTokens: 3, costUsd: 0.3 } },
      ]),
    ];
    expect(totalOf(events)).toBeCloseTo(1.32);
  });

  it('counts a Claude escalation that failed when its cost was recorded', () => {
    const events = [decision([{ backend: 'claude', model: 'claude', outcome: 'unavailable', usage: { inputTokens: 9, outputTokens: 3, costUsd: 0.12 } }])];
    expect(totalOf(events)).toBeCloseTo(0.12);
  });

  it('adds nothing for a failed Claude escalation from an older run, which has no recorded cost', () => {
    expect(totalOf([decision([{ backend: 'claude', model: 'claude', outcome: 'unavailable', usage: null }])])).toBe(0);
  });

  it('adds nothing for an attempt that made no call', () => {
    expect(totalOf([decision([{ backend: 'jev', model: 'm', outcome: 'skipped-confidential', usage: null }])])).toBe(0);
  });
});
