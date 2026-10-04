import { describe, expect, it } from 'vitest';
import { REPORT_ROUTES, reportRoutingQuestions, reportRoutingState, routeReport } from '../../server/decide/decisions/report-routing.js';
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

describe('report routing', () => {
  it('has the four routes from spec 10A.5 row 7 with distinct descriptions', () => {
    expect(Object.keys(REPORT_ROUTES).sort()).toEqual(['bug-existing-ac', 'environment', 'new-requirement', 'unclear']);
    expect(new Set(Object.values(REPORT_ROUTES)).size).toBe(4);
    expect(reportRoutingQuestions().route).toMatchObject({ type: 'choice', options: REPORT_ROUTES });
  });

  it('builds a state with the acceptance criteria and the report', () => {
    const s = reportRoutingState(acs, '/health answers 500');
    expect(s).toContain('AC-001: Given the service is running, when GET /health is called, then status 200');
    expect(s).toContain('report:\n/health answers 500');
  });

  it('uses the decider answer with its confidence and backend', async () => {
    const d = fakeDecider({ answered: true, backend: 'jev', escalated: false, answers: { route: choiceAnswer('bug-existing-ac', { 'bug-existing-ac': 0.9, unclear: 0.1 }) } });
    const r = await routeReport(acs, '/health answers 500', d, { confidential: false });
    expect(r).toMatchObject({ route: 'bug-existing-ac', source: 'jev' });
    expect(r?.confidence).toBeGreaterThan(0);
    expect(d.calls[0]![0]).toBe('report-routing');
  });

  it('gives no hint when the layer is disabled or exhausted', async () => {
    expect(await routeReport(acs, 'x', fakeDecider({ answered: false, reason: 'disabled' }), { confidential: false })).toBeNull();
    expect(await routeReport(acs, 'x', fakeDecider({ answered: false, reason: 'exhausted' }), { confidential: false })).toBeNull();
  });
});
