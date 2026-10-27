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

/** One routed blocking refinement question, labelled by its owner's answer (R11.5.7). */
export interface RoutingSample {
  route: string;
  confidence: number | null;
  /** The owner marked that the documents already answered it; an answer without the mark counts as the human being needed. */
  docsAnswered: boolean;
}

type JournalEvent = { type: string; at?: string; data: Record<string, unknown> };

/** An owner answer comes at least this many seconds after the owner's previous one; a faster one may be a bulk click or a script. */
export const MIN_READ_SECONDS = 3;

/** An owner's own judgement, usable as a label: no role wrote it and it came after time to read. A null gap means no earlier answer. */
export function isIndependentOwnerLabel(answer: { by?: unknown; gapSeconds: number | null }): boolean {
  return answer.by === undefined && answer.gapSeconds !== null && answer.gapSeconds >= MIN_READ_SECONDS;
}

/** Joins every route of a refinement journal with the owner's answer to its question; only an independent owner answer labels it. */
export function routingSamples(events: readonly JournalEvent[]): RoutingSample[] {
  const labels = new Map<string, { docsAnswered: boolean; independent: boolean }>();
  let previous: number | null = null;
  for (const e of events) {
    if (e.type !== 'QUESTION_ANSWERED' || e.data.by !== undefined) continue;
    const at = Date.parse(e.at ?? '');
    const gapSeconds = previous === null || Number.isNaN(at) ? null : (at - previous) / 1000;
    if (!Number.isNaN(at)) previous = at;
    labels.set(String(e.data.questionId), { docsAnswered: e.data.docsAnswered === true, independent: isIndependentOwnerLabel({ gapSeconds }) });
  }
  return events
    .filter((e) => e.type === 'REFINE_EVALUATED')
    .flatMap((e) => Object.entries((e.data.questionRouting ?? {}) as Record<string, { route: string; confidence: number | null; source?: string }>))
    // Only Jev's routes are measured: the floor is a floor on Jev's confidence.
    .filter(([id, r]) => labels.get(id)?.independent === true && r.source === 'jev')
    .map(([id, r]) => ({ route: r.route, confidence: r.confidence, docsAnswered: labels.get(id)!.docsAnswered }));
}

/** The one-sided 95% Wilson lower bound of a precision of `right` out of `n`: what the labels prove, not what they happen to show. */
export function wilsonLower(right: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = right / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/**
 * The lowest confidence floor whose questions routed `auto` at or above it the documents answered at least `min` of the time,
 * proven by the Wilson bound over at least `minSamples` of them; null until the labels prove one. A lucky top does not pass,
 * since the bound needs about 25 right answers in a row before it reaches 0.9.
 */
export function measuredFloor(samples: readonly RoutingSample[], opts: { min?: number; minSamples?: number } = {}): number | null {
  const { min = 0.9, minSamples = 20 } = opts;
  const auto = samples.filter((s) => s.route === 'auto' && s.confidence !== null).sort((a, b) => b.confidence! - a.confidence!);
  let floor: number | null = null;
  let right = 0;
  auto.forEach((s, i) => {
    if (s.docsAnswered) right++;
    // A floor sits at the end of a run of equal confidences, so every question at that confidence is counted.
    if (i + 1 >= minSamples && auto[i + 1]?.confidence !== s.confidence && wilsonLower(right, i + 1) >= min) floor = s.confidence;
  });
  return floor;
}

/** The share of the `n` least confident questions routed `auto` at or above the floor that the documents answered: the band the overall precision can hide. */
export function precisionNearFloor(samples: readonly RoutingSample[], floor: number, n = 10): number | null {
  const near = samples.filter((s) => s.route === 'auto' && s.confidence !== null && s.confidence >= floor).sort((a, b) => a.confidence! - b.confidence!).slice(0, n);
  return near.length === 0 ? null : near.filter((s) => s.docsAnswered).length / near.length;
}
