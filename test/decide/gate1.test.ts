import { describe, expect, it } from 'vitest';
import { contradictedChunks, duplicatePairs, notReadyCriteria } from '../../server/decide/decisions/gate1.js';
import type { DecisionOutcome, NoulAnswer } from '../../server/decide/types.js';

const ac = (id: string) => ({ id, given: 'g', when: 'w', then: 't', smoke: false });
const noul = (value: number): NoulAnswer => ({ type: 'noul', value, probabilities: { yes: value, no: 1 - value }, confidence: Math.max(value, 1 - value) });
const answered = (values: number[]): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers: Object.fromEntries(values.map((v, i) => [`q${i}`, noul(v)])) });
function fakeDecider(outcome: DecisionOutcome) {
  const calls: unknown[][] = [];
  return { calls, decide: async (...args: unknown[]) => { calls.push(args); return outcome; } };
}
const ctx = { confidential: false };

describe('Gate 1 decisions', () => {
  it('decision 2 lists the criteria below 0.5 and gives no hint when unanswered', async () => {
    const d = fakeDecider(answered([0.9, 0.2]));
    expect(await notReadyCriteria([ac('AC-001'), ac('AC-002')], d, ctx)).toEqual(['AC-002']);
    expect(d.calls[0]![0]).toBe('gate1-readiness');
    expect(Object.keys(d.calls[0]![2] as object)).toEqual(['q0', 'q1']);
    expect(await notReadyCriteria([ac('AC-001')], fakeDecider({ answered: false, reason: 'disabled' }), ctx)).toBeNull();
  });

  it('decision 3 flags duplicates at 0.5 or more and keeps everything when unanswered or partial', async () => {
    const pairs = [{ a: 'Which port?', b: 'What port does it listen on?' }, { a: 'Which port?', b: 'Which database?' }];
    const d = fakeDecider(answered([0.7, 0.1]));
    expect(await duplicatePairs(pairs, d, ctx)).toEqual([true, false]);
    expect(d.calls[0]![0]).toBe('question-dedup');
    expect(await duplicatePairs(pairs, fakeDecider(answered([0.7])), ctx)).toBeNull();
    expect(await duplicatePairs([], fakeDecider({ answered: false, reason: 'disabled' }), ctx)).toEqual([]);
  });

  it('decision 4 returns the contradicted chunk indexes and none when unanswered', async () => {
    const d = fakeDecider(answered([0.1, 0.8]));
    expect(await contradictedChunks([ac('AC-001')], ['todos'], ['old a', 'old b'], d, ctx)).toEqual([1]);
    expect(d.calls[0]![0]).toBe('history-contradiction');
    expect(String(d.calls[0]![1])).toContain('history chunk q1:\nold b');
    expect(await contradictedChunks([ac('AC-001')], ['todos'], ['old a'], fakeDecider({ answered: false, reason: 'exhausted' }), ctx)).toEqual([]);
  });
});
