import { describe, expect, it } from 'vitest';
import type { DecideContext } from '../../server/decide/decider.js';
import type { DecisionId, DecisionOutcome, DecisionRecord, Questions } from '../../server/decide/types.js';
import { recorded } from '../../server/refine/cycle.js';

const full: DecisionRecord = {
  decisionId: 'question-dedup',
  backend: 'jev',
  model: 'typesafe/jev-1.13',
  escalated: false,
  answers: { same: { type: 'noul', value: 0.9, probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 } },
  attempts: [{ backend: 'jev', outcome: 'answered', confidence: 0.9, model: 'typesafe/jev-1.13', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 }, message: null }],
  usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 },
  stateChars: 42,
  stateTruncated: false,
  durationMs: 7,
  at: '2026-10-27T10:00:00.000Z',
};

/** A journal that keeps what it is given, and a decider that answers with the outcome and, when given, the record. */
function harness(outcome: DecisionOutcome, record?: DecisionRecord) {
  const facts: Array<{ type: string; data: unknown }> = [];
  const journal = { fact: async (type: string, data: unknown) => void facts.push({ type, data }) } as unknown as Parameters<typeof recorded>[1];
  const decider = {
    decide: async (_id: DecisionId, _state: string, _questions: Questions, ctx: DecideContext): Promise<DecisionOutcome> => {
      if (record) ctx.onRecord?.(record);
      return outcome;
    },
  };
  return { facts, journal, decider };
}

describe('recorded decisions', () => {
  it('journals the full record its decider made, attempts and usage included', async () => {
    const { facts, journal, decider } = harness({ answered: true, answers: full.answers!, backend: 'jev', escalated: false }, full);
    await recorded(decider, journal, 3).decide('question-dedup', 'state', {}, { confidential: false });
    expect(facts).toEqual([{ type: 'DECISION_MADE', data: { cycle: 3, record: full } }]);
  });

  it('journals an unanswered call with its reason when the decider made no record', async () => {
    const { facts, journal, decider } = harness({ answered: false, reason: 'exhausted' });
    await recorded(decider, journal, 3).decide('question-dedup', 'state', {}, { confidential: false });
    expect(facts).toEqual([
      { type: 'DECISION_MADE', data: { cycle: 3, record: { decisionId: 'question-dedup', backend: null, escalated: false, answers: null, durationMs: expect.any(Number), unanswered: 'exhausted' } } },
    ]);
  });

  it('journals a decider that threw with its redacted message', async () => {
    const { facts, journal, decider } = harness({ answered: false, reason: 'error', message: 'socket hang up' });
    await recorded(decider, journal, 3).decide('question-dedup', 'state', {}, { confidential: false });
    expect(facts[0]).toEqual({ type: 'DECISION_MADE', data: { cycle: 3, record: expect.objectContaining({ backend: null, error: 'socket hang up', unanswered: 'error' }) } });
  });
});
