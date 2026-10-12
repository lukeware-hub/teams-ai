import { describe, expect, it } from 'vitest';
import { autoAnswerFloor, metrics, routingSamples, samplesFromRecords, type EvalSample, type JournaledDecision } from '../../server/decide/evals.js';

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

describe('question routing eval', () => {
  it('labels each routed question with its answer, and leaves out the ones nobody answered yet', () => {
    const events = [
      { type: 'REFINE_EVALUATED', data: { questionRouting: { 'po-c1-0': { route: 'auto', confidence: 0.96 }, 'po-c1-1': { route: 'human', confidence: 0.7 }, 'sm-c1-0': { route: 'auto', confidence: 0.9 } } } },
      { type: 'QUESTION_ANSWERED', data: { questionId: 'po-c1-0', text: 'project.md › Execução', docsAnswered: true } },
      { type: 'QUESTION_ANSWERED', data: { questionId: 'po-c1-1', text: '5 segundos' } },
      // An answer a role gave from the docs carries no human label, so it never becomes a sample.
      { type: 'QUESTION_ANSWERED', data: { questionId: 'sm-c1-0', text: 'stack.md diz Node 22.', by: 'sm' } },
    ];
    expect(routingSamples(events)).toEqual([
      { route: 'auto', confidence: 0.96, docsAnswered: true },
      { route: 'human', confidence: 0.7, docsAnswered: false },
    ]);
  });

  it('finds the lowest confidence at which questions routed auto were answered by the documents often enough', () => {
    const auto = (confidence: number, docsAnswered = true) => ({ route: 'auto', confidence, docsAnswered });
    // 20 right answers from 0.99 down to 0.80, then a wrong one at 0.79 and more right ones below it.
    const right = Array.from({ length: 20 }, (_, i) => auto(0.99 - i * 0.01));
    expect(autoAnswerFloor(right)).toBeCloseTo(0.8);
    expect(autoAnswerFloor([...right, auto(0.79, false), auto(0.78), auto(0.77)], { precision: 0.99 })).toBeCloseTo(0.8);
    // Too few samples, or too many wrong ones: no floor yet.
    expect(autoAnswerFloor(right.slice(0, 19))).toBeNull();
    expect(autoAnswerFloor(right.map((s, i) => ({ ...s, docsAnswered: i % 2 === 0 })))).toBeNull();
    // Other routes and questions without a confidence never count.
    expect(autoAnswerFloor([...right.map((s) => ({ ...s, route: 'po' })), { route: 'auto', confidence: null, docsAnswered: true }])).toBeNull();
  });
});
