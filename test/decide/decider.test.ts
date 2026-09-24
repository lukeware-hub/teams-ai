import { describe, expect, it } from 'vitest';
import { Decider, MAX_STATE_CHARS, TRUNCATION_MARK, capState, type DeciderDeps } from '../../server/decide/decider.js';
import type { DecisionConfig, DecisionRecord, Questions } from '../../server/decide/types.js';
import { FakeBackend, choiceAnswer, invalid, ok, unavailable } from '../fixtures/fake-backend.js';

const T0 = new Date('2026-09-24T10:00:00.000Z');
const questions: Questions = {
  kind: { type: 'choice', instructions: 'Why did the gate fail?', options: { code: 'a test failed', infra: 'docker broke' } },
};
const cfg = (over: Partial<DecisionConfig> = {}): DecisionConfig => ({
  enabled: true,
  chain: ['jev', 'local', 'claude'],
  thresholds: { jev: 0.8, local: 0.9 },
  escalateTo: 'test',
  ...over,
});

function decider(backends: DeciderDeps['backends'], over: Partial<DecisionConfig> = {}, extra: Partial<DeciderDeps> = {}) {
  const records: DecisionRecord[] = [];
  const d = new Decider({ backends, config: () => cfg(over), onDecision: (r) => records.push(r), clock: () => T0, ...extra });
  return { d, records };
}

describe('Decider', () => {
  it('answers from jev when every answer meets the jev threshold', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('infra', { infra: 0.85, code: 0.15 }) }, 'typesafe/jev-1.13')]);
    const { d, records } = decider({ jev });
    const out = await d.decide('gate-triage', 'docker: Cannot connect', questions, { confidential: false });
    expect(out).toEqual({ answered: true, backend: 'jev', escalated: false, answers: { kind: choiceAnswer('infra', { infra: 0.85, code: 0.15 }) } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      decisionId: 'gate-triage',
      backend: 'jev',
      model: 'typesafe/jev-1.13',
      escalated: false,
      attempts: [{ backend: 'jev', outcome: 'answered', confidence: 0.85, model: 'typesafe/jev-1.13', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.00001 }, message: null }],
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.00001 },
      stateTruncated: false,
      at: T0.toISOString(),
    });
    expect(jev.calls[0]).toMatchObject({ escalateTo: 'test', state: 'docker: Cannot connect' });
  });

  it('accepts a confidence exactly at the threshold', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('code', { code: 0.8, infra: 0.2 }) })]);
    const { d } = decider({ jev });
    const out = await d.decide('gate-triage', 's', questions, { confidential: false });
    expect(out.answered).toBe(true);
  });

  it('escalates to claude on low confidence and marks the answer escalated', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('code', { code: 0.55, infra: 0.45 }) })]);
    const local = new FakeBackend('local', [unavailable()]);
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('infra', { infra: 1 }, null) }, 'opus')]);
    const { d, records } = decider({ jev, local, claude });
    const out = await d.decide('gate-triage', 's', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'claude', escalated: true });
    expect(records[0]!.attempts).toEqual([
      { backend: 'jev', outcome: 'low-confidence', confidence: 0.55, model: 'fake', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.00001 }, message: null },
      { backend: 'local', outcome: 'unavailable', confidence: null, model: null, usage: null, message: 'down' },
      { backend: 'claude', outcome: 'answered', confidence: null, model: 'opus', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.00001 }, message: null },
    ]);
    // Both calls that returned cost tokens; the low-confidence one is not free.
    expect(records[0]!.usage).toEqual({ inputTokens: 200, outputTokens: 20, costUsd: 0.00002 });
  });

  it('falls through jev → local → claude when the earlier backends are unavailable or invalid', async () => {
    const jev = new FakeBackend('jev', [invalid('probabilities do not sum to 1')]);
    const local = new FakeBackend('local', [unavailable('stub')]);
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('code', { code: 1 }, null) })]);
    const { d, records } = decider({ jev, local, claude });
    const out = await d.decide('gate-triage', 's', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'claude' });
    expect(records[0]!.attempts.map((a) => a.outcome)).toEqual(['invalid', 'unavailable', 'answered']);
  });

  it('skips jev for a confidential project without calling it', async () => {
    const jev = new FakeBackend('jev', []);
    const local = new FakeBackend('local', [unavailable()]);
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('code', { code: 1 }, null) })]);
    const { d, records } = decider({ jev, local, claude });
    await d.decide('gate-triage', 's', questions, { confidential: true });
    expect(jev.calls).toHaveLength(0);
    expect(records[0]!.attempts[0]).toEqual({ backend: 'jev', outcome: 'skipped-confidential', confidence: null, model: null, usage: null, message: null });
  });

  it('reports exhausted when no backend answers, and disabled when the decision is off', async () => {
    const jev = new FakeBackend('jev', [unavailable()]);
    const claude = new FakeBackend('claude', [unavailable('step failed')]);
    const { d, records } = decider({ jev, claude });
    expect(await d.decide('gate-triage', 's', questions, { confidential: false })).toEqual({ answered: false, reason: 'exhausted' });
    expect(records[0]!.attempts.map((a) => a.outcome)).toEqual(['unavailable', 'missing-backend', 'unavailable']);

    const off = decider({ jev }, { enabled: false });
    expect(await off.d.decide('gate-triage', 's', questions, { confidential: false })).toEqual({ answered: false, reason: 'disabled' });
    expect(off.records[0]).toMatchObject({ backend: null, answers: null, attempts: [] });
    expect(jev.calls).toHaveLength(1);
  });

  it('treats a throwing backend as unavailable and keeps walking the chain', async () => {
    const jev = {
      name: 'jev' as const,
      evaluate: async () => {
        throw new Error('socket hang up');
      },
    };
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('code', { code: 1 }, null) })]);
    const { d, records } = decider({ jev, claude }, { chain: ['jev', 'claude'] });
    expect(await d.decide('gate-triage', 's', questions, { confidential: false })).toMatchObject({ answered: true, backend: 'claude' });
    expect(records[0]!.attempts[0]).toMatchObject({ outcome: 'unavailable', message: 'socket hang up' });
  });

  it('keeps the failure reason of each attempt, redacted, so an invalid Jev answer can be diagnosed', async () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const jev = new FakeBackend('jev', [invalid(`kind: choice "${secret}" is not an option`)]);
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('code', { code: 1 }, null) })]);
    const { d, records } = decider({ jev, claude }, { chain: ['jev', 'claude'] }, { knownSecrets: () => [secret] });
    await d.decide('gate-triage', 's', questions, { confidential: false });
    expect(records[0]!.attempts[0]).toMatchObject({ backend: 'jev', outcome: 'invalid', message: 'kind: choice "[REDACTED]" is not an option' });
  });

  it('truncates an oversized state and marks it', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('code', { code: 1 }) })]);
    const { d, records } = decider({ jev });
    const big = 'x'.repeat(MAX_STATE_CHARS + 5000);
    await d.decide('gate-triage', big, questions, { confidential: false });
    const sent = jev.calls[0]!.state;
    expect(sent.length).toBe(MAX_STATE_CHARS + TRUNCATION_MARK.length);
    expect(sent.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(records[0]).toMatchObject({ stateTruncated: true, stateChars: MAX_STATE_CHARS + 5000 });
    expect(capState('short')).toEqual({ state: 'short', truncated: false });
  });

  it('redacts known secret values from the state before calling a backend', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('code', { code: 1 }) })]);
    const { d } = decider({ jev }, {}, { knownSecrets: () => ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'] });
    await d.decide('gate-triage', 'fatal: token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rejected', questions, { confidential: false });
    expect(jev.calls[0]!.state).toBe('fatal: token [REDACTED] rejected');
  });
});
