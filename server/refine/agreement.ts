import { isIndependentOwnerLabel, MIN_READ_SECONDS, wilsonLower } from '../decide/evals.js';

/** The replay gates, fixed before any journal is read: a different number is a plan decision, not a tuned one. */
export const REPLAY = { longPauseSeconds: 30, z: 1.645, bootstrapRuns: 2000, seed: 20261027 } as const;

/** One owner answer to a question that had a recommended option. */
export interface OwnerAnswer {
  questionId: string;
  /** What the question is about: a Spec Kit item key, `doc:<file>` for a stage review, or `round` for a full round. */
  item: string;
  /** Seconds since the owner's previous answer; null for the first answer of a journal. */
  gapSeconds: number | null;
  agreed: boolean;
}

/** The part of a journal event this analysis reads. */
export interface JournalEvent {
  type: string;
  at?: string;
  data: Record<string, unknown>;
}

interface Asked {
  item: string;
  recommended: string;
}

/** The questions as the owner last saw them: a triage can re-decide the recommendation, so the newest definition before an answer counts. */
function define(asked: Map<string, Asked>, question: Record<string, unknown>, item?: string): void {
  const questionId = String(question.questionId);
  const options = (question.options ?? []) as Array<{ label?: unknown; recommended?: unknown }>;
  const recommended = options.find((option) => option.recommended === true);
  if (recommended) asked.set(questionId, { item: item ?? asked.get(questionId)?.item ?? 'speckit', recommended: String(recommended.label) });
  else asked.delete(questionId);
}

const questionsOf = (e: JournalEvent): Array<Record<string, unknown>> => (e.data.questions ?? []) as Array<Record<string, unknown>>;

/** The owner's answers in journal order, each with its gap to the owner's previous answer; a question without a recommended option is no sample. */
export function ownerAnswers(events: readonly JournalEvent[]): OwnerAnswer[] {
  const asked = new Map<string, Asked>();
  const answers: OwnerAnswer[] = [];
  let previous: number | null = null;
  for (const e of events) {
    if (e.type === 'SPECKIT_STEP_DONE') for (const q of questionsOf(e)) define(asked, q, String(q.itemKey ?? 'speckit'));
    else if (e.type === 'SPECKIT_TRIAGED') for (const q of (e.data.results ?? []) as Array<Record<string, unknown>>) define(asked, q);
    else if (e.type === 'REFINE_STAGE_REVIEWED') for (const q of questionsOf(e)) define(asked, q, `doc:${String(e.data.file)}`);
    else if (e.type === 'REFINE_EVALUATED') for (const q of questionsOf(e)) define(asked, q, 'round');
    else if (e.type === 'QUESTION_ANSWERED' && e.data.by === undefined) {
      const at = Date.parse(e.at ?? '');
      const gapSeconds = previous === null || Number.isNaN(at) ? null : (at - previous) / 1000;
      if (!Number.isNaN(at)) previous = at;
      const questionId = String(e.data.questionId);
      const question = asked.get(questionId);
      if (question) answers.push({ questionId, item: question.item, gapSeconds, agreed: String(e.data.text ?? '').trim() === question.recommended });
    }
  }
  return answers;
}

export interface Band {
  label: string;
  n: number;
  agreed: number;
  share: number | null;
  /** The one-sided Wilson lower bound of the share at `REPLAY.z`. */
  lower: number | null;
}

function band(label: string, answers: readonly OwnerAnswer[]): Band {
  const n = answers.length;
  const agreed = answers.filter((a) => a.agreed).length;
  return { label, n, agreed, share: n === 0 ? null : agreed / n, lower: n === 0 ? null : wilsonLower(agreed, n, REPLAY.z) };
}

/** Agreement by how long the owner took to answer, and the labels the gates use. */
export function bands(answers: readonly OwnerAnswer[]): Band[] {
  const within = (from: number, to: number) => answers.filter((a) => a.gapSeconds !== null && a.gapSeconds >= from && a.gapSeconds < to);
  const long = REPLAY.longPauseSeconds;
  return [
    band('all answers', answers),
    band(`under ${MIN_READ_SECONDS} s`, within(0, MIN_READ_SECONDS)),
    band(`${MIN_READ_SECONDS} to ${long} s`, within(MIN_READ_SECONDS, long)),
    band(`${long} s and more`, within(long, Infinity)),
    band(`labels (${MIN_READ_SECONDS} s and more)`, answers.filter((a) => isIndependentOwnerLabel({ gapSeconds: a.gapSeconds }))),
  ];
}

/** A seeded generator in [0, 1): the same seed gives the same resamples on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 95% percentile interval of the labels' agreement, resampling whole items with replacement: answers of one item stick together. */
export function clusterInterval(answers: readonly OwnerAnswer[]): [number, number] | null {
  const byItem = new Map<string, { n: number; agreed: number }>();
  for (const a of answers.filter((x) => isIndependentOwnerLabel({ gapSeconds: x.gapSeconds }))) {
    const cluster = byItem.get(a.item) ?? { n: 0, agreed: 0 };
    cluster.n++;
    if (a.agreed) cluster.agreed++;
    byItem.set(a.item, cluster);
  }
  const clusters = [...byItem.values()];
  if (clusters.length === 0) return null;
  const random = mulberry32(REPLAY.seed);
  const shares: number[] = [];
  for (let run = 0; run < REPLAY.bootstrapRuns; run++) {
    let n = 0;
    let agreed = 0;
    for (let k = 0; k < clusters.length; k++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      n += cluster.n;
      agreed += cluster.agreed;
    }
    shares.push(agreed / n);
  }
  shares.sort((x, y) => x - y);
  return [shares[Math.floor(0.025 * shares.length)]!, shares[Math.min(shares.length - 1, Math.ceil(0.975 * shares.length) - 1)]!];
}

export interface ItemShare {
  item: string;
  share: number;
}

/** The label agreement with each item left out, lowest and highest: how far a single item moves the number. */
export function leaveOneItemOut(answers: readonly OwnerAnswer[]): { lowest: ItemShare; highest: ItemShare } | null {
  const labels = answers.filter((a) => isIndependentOwnerLabel({ gapSeconds: a.gapSeconds }));
  const items = [...new Set(labels.map((a) => a.item))];
  if (items.length < 2) return null;
  const shares = items.map((item) => {
    const rest = labels.filter((a) => a.item !== item);
    return { item, share: rest.filter((a) => a.agreed).length / rest.length };
  });
  shares.sort((x, y) => x.share - y.share);
  return { lowest: shares[0]!, highest: shares[shares.length - 1]! };
}
