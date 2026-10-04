import { describe, expect, it } from 'vitest';
import { contradictedChunks, duplicatePairs, notReadyCriteria } from '../../server/decide/decisions/gate1.js';
import type { DecisionOutcome, NoulAnswer } from '../../server/decide/types.js';

const ac = (id: string, then = 't') => ({ id, given: 'g', when: 'w', then, smoke: false });
const noul = (value: number): NoulAnswer => ({ type: 'noul', value, probabilities: { yes: value, no: 1 - value }, confidence: Math.max(value, 1 - value) });
const answer = (value: number): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers: { q0: noul(value) } });
const none: DecisionOutcome = { answered: false, reason: 'exhausted' };
/** Answers each call by looking at its own state, and records every call. */
function fakeDecider(by: (state: string) => DecisionOutcome) {
  const calls: Array<{ id: string; state: string; questions: Record<string, unknown> }> = [];
  return { calls, decide: async (id: string, state: string, questions: Record<string, unknown>) => { calls.push({ id, state, questions }); return by(state); } };
}
const ctx = { confidential: false };

describe('Gate 1 decisions', () => {
  it('decision 2 asks once per criterion and lists those below 0.8', async () => {
    const d = fakeDecider((s) => answer(s.includes('something reasonable') ? 0.66 : 1));
    expect(await notReadyCriteria([ac('AC-001', 'it returns something reasonable'), ac('AC-002', 'status 200')], d as never, ctx)).toEqual(['AC-001']);
    expect(d.calls.map((c) => c.id)).toEqual(['gate1-readiness', 'gate1-readiness']);
    expect(d.calls[0]!.state).toContain('AC-001');
    expect(d.calls[0]!.state).not.toContain('AC-002'); // one item per call, so one uncertain item cannot sink the rest
    expect(Object.keys(d.calls[0]!.questions)).toEqual(['q0']);
  });

  it('decision 2 flags a vague THEN with no concrete value by rule, without asking the model', async () => {
    const d = fakeDecider(() => answer(1));
    const criteria = [ac('AC-001', 'it answers nicely'), ac('AC-002', 'the service responds properly'), ac('AC-003', 'it is handled correctly'), ac('AC-004', 'status 200 and {"ok":true}'), ac('AC-005', 'it works properly and returns 204')];
    // AC-001..003 are vague words only; AC-004 has concrete values; AC-005 mixes a vague word with a number, so the model decides.
    expect(await notReadyCriteria(criteria, d as never, ctx)).toEqual(['AC-001', 'AC-002', 'AC-003']);
    expect(d.calls).toHaveLength(2); // only AC-004 and AC-005 reached System 1
    expect(d.calls.map((c) => c.state).join()).not.toContain('AC-001');
  });

  it('decision 2 gives no hint when nothing answered, and skips only the unanswered criterion otherwise', async () => {
    expect(await notReadyCriteria([ac('AC-001')], fakeDecider(() => none) as never, ctx)).toBeNull();
    const d = fakeDecider((s) => (s.includes('AC-001') ? none : answer(0.2)));
    expect(await notReadyCriteria([ac('AC-001'), ac('AC-002')], d as never, ctx)).toEqual(['AC-002']);
  });

  it('decision 3 asks once per pair, flags duplicates at 0.5 or more, and keeps an unanswered pair apart', async () => {
    const pairs = [{ a: 'Which port?', b: 'What port does it listen on?' }, { a: 'Which port?', b: 'Which database?' }, { a: 'x', b: 'y' }];
    const d = fakeDecider((s) => (s.includes('What port') ? answer(0.9) : s.includes('database') ? answer(0.1) : none));
    expect(await duplicatePairs(pairs, d as never, ctx)).toEqual([true, false, false]);
    expect(d.calls).toHaveLength(3);
    expect(d.calls[0]!.id).toBe('question-dedup');
    expect(await duplicatePairs(pairs, fakeDecider(() => none) as never, ctx)).toBeNull();
    expect(await duplicatePairs([], fakeDecider(() => none) as never, ctx)).toEqual([]);
  });

  it('decision 4 asks once per chunk and returns the contradicted indexes, none when unanswered', async () => {
    const d = fakeDecider((s) => answer(s.includes('old b') ? 0.8 : 0.1));
    expect(await contradictedChunks([ac('AC-001')], ['todos'], ['old a', 'old b'], d as never, ctx)).toEqual([1]);
    expect(d.calls[0]!.id).toBe('history-contradiction');
    expect(d.calls[1]!.state).toContain('history chunk q1:\nold b');
    expect(d.calls[0]!.state).not.toContain('old b');
    expect(await contradictedChunks([ac('AC-001')], ['todos'], ['old a'], fakeDecider(() => none) as never, ctx)).toEqual([]);
  });
});
