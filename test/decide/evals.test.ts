import { describe, expect, it } from 'vitest';
import { metrics, samplesFromRecords, type EvalSample, type JournaledDecision } from '../../server/decide/evals.js';

const sample = (over: Partial<EvalSample>): EvalSample => ({ decisionId: 'gate-triage', question: 'kind', probabilities: { code: 0.8, infra: 0.2 }, predicted: 'code', label: 'code', escalated: false, durationMs: 100, ...over });

describe('decision evals', () => {
  it('computes accuracy, multiclass Brier, ECE, escalation rate and latency percentiles', () => {
    const m = metrics([
      sample({}),
      sample({ probabilities: { code: 0.6, infra: 0.4 }, predicted: 'code', label: 'infra', escalated: true, durationMs: 300 }),
    ]);
    expect(m.count).toBe(2);
    expect(m.accuracy).toBe(0.5);
    // (0.2² + 0.2²) and (0.6² + 0.6²), averaged
    expect(m.brier).toBeCloseTo((0.08 + 0.72) / 2, 10);
    // bins: 0.8 (correct) and 0.6 (wrong), one sample each → (|1-0.8| + |0-0.6|) / 2
    expect(m.ece).toBeCloseTo((0.2 + 0.6) / 2, 10);
    expect(m.escalationRate).toBe(0.5);
    expect(m.latencyP50).toBe(100);
    expect(m.latencyP95).toBe(300);
  });

  it('returns zeros for no samples', () => {
    expect(metrics([])).toEqual({ count: 0, accuracy: 0, brier: 0, ece: 0, escalationRate: 0, latencyP50: 0, latencyP95: 0 });
  });

  it('joins journaled decisions with labels by run, event seq and question', () => {
    const records: JournaledDecision[] = [
      { runId: 'r1', seq: 7, record: { decisionId: 'gate-triage', escalated: false, durationMs: 50, answers: { kind: { type: 'choice', value: 'infra', probabilities: { code: 0.3, infra: 0.7 }, confidence: 0.7 } } } },
      { runId: 'r1', seq: 9, record: { decisionId: 'pr-risk', escalated: false, durationMs: 60, answers: null } },
    ];
    const s = samplesFromRecords(records, [{ runId: 'r1', seq: 7, question: 'kind', label: 'code' }, { runId: 'r1', seq: 9, question: 'risk', label: 'low' }]);
    expect(s).toEqual([{ decisionId: 'gate-triage', question: 'kind', probabilities: { code: 0.3, infra: 0.7 }, predicted: 'infra', label: 'code', escalated: false, durationMs: 50 }]);
  });
});
