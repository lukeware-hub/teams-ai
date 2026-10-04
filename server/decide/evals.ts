import type { Answers, DecisionRecord } from './types.js';

/** Spec 10A.6: one labeled answer of one decision question. */
export interface EvalSample {
  decisionId: string;
  question: string;
  probabilities: Record<string, number>;
  predicted: string;
  label: string;
  escalated: boolean;
  durationMs: number;
}

export interface EvalMetrics {
  count: number;
  accuracy: number;
  /** Multiclass Brier: mean over samples of Σ_k (p_k − y_k)². */
  brier: number;
  /** Expected calibration error over equal-width confidence bins. */
  ece: number;
  escalationRate: number;
  latencyP50: number;
  latencyP95: number;
}

/** A DECISION_MADE event as read from a run journal; `seq` is the event's sequence number. */
export interface JournaledDecision {
  runId: string;
  seq: number;
  record: Pick<DecisionRecord, 'decisionId' | 'escalated' | 'durationMs'> & { answers: Answers | null };
}

export interface Label {
  runId: string;
  seq: number;
  question: string;
  label: string;
}

const argmax = (p: Record<string, number>): string => Object.entries(p).reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];

/** Unanswered decisions and unlabeled questions are skipped: only a backend's answer can be scored. */
export function samplesFromRecords(records: readonly JournaledDecision[], labels: readonly Label[]): EvalSample[] {
  const byKey = new Map(labels.map((l) => [`${l.runId}#${l.seq}#${l.question}`, l.label]));
  const out: EvalSample[] = [];
  for (const { runId, seq, record } of records) {
    for (const [question, answer] of Object.entries(record.answers ?? {})) {
      const label = byKey.get(`${runId}#${seq}#${question}`);
      if (label === undefined || Object.keys(answer.probabilities).length === 0) continue;
      const probabilities = { ...answer.probabilities };
      out.push({ decisionId: record.decisionId, question, probabilities, predicted: argmax(probabilities), label, escalated: record.escalated, durationMs: record.durationMs });
    }
  }
  return out;
}

function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

export function metrics(samples: readonly EvalSample[], bins = 10): EvalMetrics {
  const n = samples.length;
  if (n === 0) return { count: 0, accuracy: 0, brier: 0, ece: 0, escalationRate: 0, latencyP50: 0, latencyP95: 0 };
  let correct = 0;
  let brier = 0;
  const binSums = Array.from({ length: bins }, () => ({ count: 0, confidence: 0, correct: 0 }));
  for (const s of samples) {
    const hit = s.predicted === s.label;
    if (hit) correct++;
    const classes = new Set([...Object.keys(s.probabilities), s.label]);
    for (const k of classes) brier += ((s.probabilities[k] ?? 0) - (k === s.label ? 1 : 0)) ** 2;
    const confidence = s.probabilities[s.predicted] ?? 0;
    const bin = binSums[Math.min(bins - 1, Math.floor(confidence * bins))]!;
    bin.count++;
    bin.confidence += confidence;
    bin.correct += hit ? 1 : 0;
  }
  const ece = binSums.reduce((acc, b) => (b.count === 0 ? acc : acc + (b.count / n) * Math.abs(b.correct / b.count - b.confidence / b.count)), 0);
  const latency = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  return {
    count: n,
    accuracy: correct / n,
    brier: brier / n,
    ece,
    escalationRate: samples.filter((s) => s.escalated).length / n,
    latencyP50: percentile(latency, 0.5),
    latencyP95: percentile(latency, 0.95),
  };
}
