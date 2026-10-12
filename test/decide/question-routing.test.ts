import { describe, expect, it } from 'vitest';
import { QUESTION_ROUTES, questionRoutingQuestions, questionRoutingState, routeQuestion } from '../../server/decide/decisions/question-routing.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { choiceAnswer } from '../fixtures/fake-backend.js';

const acs = [{ id: 'AC-001', given: 'the service is running', when: 'GET /health is called', then: 'status 200', smoke: true }];
function fakeDecider(outcome: DecisionOutcome) {
  const calls: unknown[][] = [];
  return {
    calls,
    decide: async (...args: unknown[]) => {
      calls.push(args);
      return outcome;
    },
  };
}

describe('question routing (plan 53, R11.5a slice 1)', () => {
  it('has the four routes with distinct descriptions', () => {
    expect(Object.keys(QUESTION_ROUTES).sort()).toEqual(['auto', 'human', 'po', 'sm']);
    expect(new Set(Object.values(QUESTION_ROUTES)).size).toBe(4);
    expect(QUESTION_ROUTES.auto).toContain('one repository per service the docs declare');
    expect(questionRoutingQuestions().route).toMatchObject({ type: 'choice', options: QUESTION_ROUTES });
  });

  it('builds a state with the related acceptance criteria and the question text', () => {
    const s = questionRoutingState(acs, 'Which port does the service listen on?');
    expect(s).toContain('AC-001: Given the service is running, when GET /health is called, then status 200');
    expect(s).toContain('question:\nWhich port does the service listen on?');
  });

  it('builds a state with "(none)" when the question cites no criterion', () => {
    expect(questionRoutingState([], 'x')).toContain('(none)');
  });

  it('uses the decider answer with its confidence and backend', async () => {
    const d = fakeDecider({ answered: true, backend: 'jev', escalated: false, answers: { route: choiceAnswer('auto', { auto: 0.9, human: 0.1 }) } });
    const r = await routeQuestion(acs, 'How does the e2e suite reach the database?', d, { confidential: false });
    expect(r).toMatchObject({ route: 'auto', source: 'jev' });
    expect(r?.confidence).toBeGreaterThan(0);
    expect(d.calls[0]![0]).toBe('question-routing');
  });

  it('gives no hint when the layer is disabled or exhausted', async () => {
    expect(await routeQuestion(acs, 'x', fakeDecider({ answered: false, reason: 'disabled' }), { confidential: false })).toBeNull();
    expect(await routeQuestion(acs, 'x', fakeDecider({ answered: false, reason: 'exhausted' }), { confidential: false })).toBeNull();
  });
});
