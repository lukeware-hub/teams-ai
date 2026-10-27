import { createHash } from 'node:crypto';
import { isIndependentOwnerLabel, wilsonLower } from '../decide/evals.js';
import { clusterInterval, define, type Asked, type JournalEvent, type OwnerAnswer } from './agreement.js';
import { RefineEvent } from './events.js';
import { normalized, RULES, resolveCard, resolveLanding, type Impact, type Resolution, type Site, type Verdict } from './resolver.js';
import { applyRefineEvent, emptyRefineState } from './state.js';

/** One owner answer to a question with a recommended option, paired as the agreement replay pairs it (the parity check reads these). */
export interface OwnerRow {
  questionId: string;
  item: string;
  gapSeconds: number | null;
  agreed: boolean;
}

/** One owner answer to a question the resolver resolved, with what the verdict's own rule says about it. */
export interface Label {
  questionId: string;
  site: Site;
  impact: Impact;
  verdict: Verdict;
  item: string;
  gapSeconds: number | null;
  /** The answer's journal time in milliseconds; NaN when the event had none. */
  at: number;
  independent: boolean;
  /** The question had its answer left out, because an armed floor answered the round. */
  armed: boolean;
  /** Whether the answer is the recommended option; null when the question had none. */
  recommendedAgreed: boolean | null;
  /** The verdict's own outcome: true or false when it labels the answer, null when it cannot. */
  outcome: boolean | null;
  /** The similarity of the nearest twin, for a repeat. */
  similarity?: number;
}

export interface Replay {
  /** Owner answers in journal order, for the answers that had a recommended option. */
  owner: OwnerRow[];
  /** Owner answers to questions the resolver resolved. */
  labels: Label[];
  /** The final resolution of each question. */
  resolutions: Resolution[];
  /** Owner answers in total, with or without a recommended option. */
  answers: number;
}

const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>;

/** The outcome of the verdict's own rule for one owner answer: a repeat is the twin's answer, an assumption the recommended option. */
function outcomeOf(r: Resolution, text: string, recommended: string | undefined, answered: Map<string, { text: string; independent: boolean }>): boolean | null {
  if (r.verdict === 'assume') return recommended === undefined ? null : text === recommended;
  if (r.verdict !== 'repeat' || !r.nearest) return null;
  const twin = answered.get(r.nearest.of);
  if (!twin || !twin.independent) return null;
  if (normalized(twin.text) === normalized(text)) return true;
  const labels = new Set(r.options.map(normalized));
  return labels.has(normalized(twin.text)) && labels.has(normalized(text)) ? false : null;
}

/** Walks the journal once: each question is resolved against the state before the event that lands it, and each owner answer is labelled. */
export function replayResolver(events: readonly JournalEvent[]): Replay {
  const state = emptyRefineState();
  const asked = new Map<string, Asked>();
  const resolutions = new Map<string, Resolution>();
  const armed = new Set<string>();
  const answered = new Map<string, { text: string; independent: boolean }>();
  const owner: OwnerRow[] = [];
  const labels: Label[] = [];
  let answers = 0;
  let previous: number | null = null;
  for (const e of events) {
    const data = e.data;
    // The recommendation of each question as the agreement replay defines it: the newest definition before an answer counts.
    if (e.type === RefineEvent.Evaluated) for (const q of list(data.questions)) define(asked, q, 'round');
    else if (e.type === RefineEvent.StageReviewed) for (const q of list(data.questions)) define(asked, q, `doc:${String(data.file)}`);
    else if (e.type === RefineEvent.SpeckitStepDone) for (const q of list(data.questions)) define(asked, q, String(q.itemKey ?? 'speckit'));
    else if (e.type === RefineEvent.SpeckitTriaged) for (const r of list(data.results)) define(asked, r);
    for (const r of resolveLanding(e, state)) {
      resolutions.set(r.questionId, r);
      if (e.type === RefineEvent.Evaluated && typeof data.autoAnswerFloor === 'number') armed.add(r.questionId);
    }
    for (const r of resolveCard(e, state)) resolutions.set(r.questionId, r);
    if (e.type === RefineEvent.QuestionAnswered && data.by === undefined) {
      answers += 1;
      const at = Date.parse(e.at ?? '');
      const gapSeconds = previous === null || Number.isNaN(at) ? null : (at - previous) / 1000;
      if (!Number.isNaN(at)) previous = at;
      const questionId = String(data.questionId);
      const text = String(data.text ?? '').trim();
      const latest = asked.get(questionId);
      const resolution = resolutions.get(questionId);
      const independent = isIndependentOwnerLabel({ gapSeconds });
      if (latest) owner.push({ questionId, item: latest.item, gapSeconds, agreed: text === latest.recommended });
      if (resolution) {
        labels.push({
          questionId,
          site: resolution.site,
          impact: resolution.impact,
          verdict: resolution.verdict,
          item: latest?.item ?? resolution.item,
          gapSeconds,
          at,
          independent,
          armed: armed.has(questionId),
          recommendedAgreed: latest ? text === latest.recommended : null,
          outcome: outcomeOf(resolution, text, latest?.recommended, answered),
          ...(resolution.nearest ? { similarity: resolution.nearest.score } : {}),
        });
      }
      answered.set(questionId, { text, independent });
    }
    applyRefineEvent(state, { type: e.type, data });
  }
  return { owner, labels, resolutions: [...resolutions.values()], answers };
}

export type GateState = 'probation' | 'bad' | 'below' | 'clears';

export interface Tally {
  label: string;
  labelled: number;
  agreed: number;
  share: number | null;
  lower: number | null;
  state: GateState;
}

/** A stratum's state under the gate: probation until it has enough labels, then clears, below or bad by its Wilson lower bound. */
function gateOf(labelled: number, lower: number | null): GateState {
  if (labelled < RULES.gate.labels || lower === null) return 'probation';
  if (lower >= RULES.gate.lower) return 'clears';
  return lower < RULES.gate.bad ? 'bad' : 'below';
}

function tally(label: string, outcomes: boolean[]): Tally {
  const labelled = outcomes.length;
  const agreed = outcomes.filter(Boolean).length;
  const lower = labelled === 0 ? null : wilsonLower(agreed, labelled, RULES.gate.z);
  return { label, labelled, agreed, share: labelled === 0 ? null : agreed / labelled, lower, state: gateOf(labelled, lower) };
}

export interface Summary {
  stamp: string;
  resolved: number;
  bySite: Record<Site, number>;
  answers: number;
  withRecommended: number;
  independent: number;
  armed: number;
  unlabelledRepeats: number;
  verdicts: Array<Tally & { site: Site; verdict: Verdict; resolved: number }>;
  impacts: Array<Tally & { impact: Impact }>;
  bins: Tally[];
  clusters: { items: number; largestShare: number | null; interval: [number, number] | null };
}

/** The tables: labels are independent, not armed, and inside the window when one is given. */
export function summarize(replay: Replay, sinceMs?: number): Summary {
  const inWindow = (l: Label) => sinceMs === undefined || l.at >= sinceMs;
  const scored = replay.labels.filter((l) => inWindow(l) && l.independent && !l.armed);
  const bySite: Record<Site, number> = { round: 0, stage: 0, speckit: 0 };
  for (const r of replay.resolutions) bySite[r.site] += 1;
  const pairs = new Map<string, { site: Site; verdict: Verdict }>();
  for (const r of replay.resolutions) pairs.set(`${r.site}/${r.verdict}`, { site: r.site, verdict: r.verdict });
  const verdicts = [...pairs.values()].map(({ site, verdict }) => ({
    site,
    verdict,
    resolved: replay.resolutions.filter((r) => r.site === site && r.verdict === verdict).length,
    ...tally(`${site}/${verdict}`, scored.filter((l) => l.site === site && l.verdict === verdict).flatMap((l) => (l.outcome === null ? [] : [l.outcome]))),
  }));
  const recommended = scored.filter((l) => l.recommendedAgreed !== null);
  const impacts = (['detail', 'unclassified', 'scope'] as const).map((impact) => ({
    impact,
    ...tally(impact, recommended.filter((l) => l.impact === impact).flatMap((l) => (l.recommendedAgreed === null ? [] : [l.recommendedAgreed]))),
  }));
  const repeats = scored.filter((l) => l.verdict === 'repeat' && l.outcome !== null);
  const band = (s: number | undefined) => (s === undefined ? 'no twin' : s >= 0.8 ? '0.8 to 1' : s >= 0.6 ? '0.6 to 0.8' : 'under 0.6');
  const bins = ['under 0.6', '0.6 to 0.8', '0.8 to 1'].map((name) => tally(name, repeats.filter((l) => band(l.similarity) === name).flatMap((l) => (l.outcome === null ? [] : [l.outcome]))));
  const clusterRows: OwnerAnswer[] = recommended.map((l) => ({ questionId: l.questionId, item: l.item, gapSeconds: l.gapSeconds, agreed: l.recommendedAgreed === true }));
  const counts = new Map<string, number>();
  for (const r of clusterRows) counts.set(r.item, (counts.get(r.item) ?? 0) + 1);
  return {
    stamp: RULES.stamp,
    resolved: replay.resolutions.length,
    bySite,
    answers: replay.answers,
    withRecommended: replay.owner.length,
    independent: replay.labels.filter((l) => l.independent).length,
    armed: replay.labels.filter((l) => l.armed).length,
    unlabelledRepeats: replay.labels.filter((l) => l.verdict === 'repeat' && l.outcome === null).length,
    verdicts,
    impacts,
    bins,
    clusters: {
      items: counts.size,
      largestShare: clusterRows.length === 0 ? null : Math.max(...counts.values()) / clusterRows.length,
      interval: clusterInterval(clusterRows),
    },
  };
}

const pct = (share: number | null): string => (share === null ? '-' : `${(100 * share).toFixed(1)}%`);
const tallyLine = (t: Tally): string => `labels ${String(t.labelled).padStart(4)}  agreed ${String(t.agreed).padStart(4)}  share ${pct(t.share).padStart(6)}  Wilson lower ${t.lower === null ? '-' : t.lower.toFixed(3)}  ${t.state}`;

const hash = (id: string): string => createHash('sha256').update(id).digest('hex');

/** The printed report: the denominators first, then the verdict and impact tables, the clusters, and the optional bins and audit. */
export function renderResolverReport(replay: Replay, options: { since?: number; bins?: boolean; audit?: number } = {}): string[] {
  const s = summarize(replay, options.since);
  const lines = [
    `resolver rules ${s.stamp}: a DEV run, not promotable until a holdout made after the rules are frozen`,
    `questions resolved: ${s.resolved} (round ${s.bySite.round}, stage ${s.bySite.stage}, speckit ${s.bySite.speckit})`,
    `owner answers: ${s.answers}; with a recommended option: ${s.withRecommended}; independent labels: ${s.independent}; left out, armed floor: ${s.armed}; repeats unlabelled: ${s.unlabelledRepeats}`,
    'verdicts (site/verdict, labelled by the verdict\'s own rule):',
    ...s.verdicts.map((v) => `  ${`${v.site}/${v.verdict}`.padEnd(20)} resolved ${String(v.resolved).padStart(4)}  ${tallyLine(v)}`),
    'impact (agreement with the recommended option, independent labels):',
    ...s.impacts.map((i) => `  ${i.impact.padEnd(20)} ${tallyLine(i)}`),
    `clusters: ${s.clusters.items} items, largest share ${pct(s.clusters.largestShare)}, bootstrap 95% interval ${s.clusters.interval === null ? '-' : `${pct(s.clusters.interval[0])} to ${pct(s.clusters.interval[1])}`}`,
  ];
  if (options.bins) lines.push('repeat labels by similarity of the nearest twin:', ...s.bins.map((b) => `  ${b.label.padEnd(20)} ${tallyLine(b)}`));
  if (options.audit !== undefined) {
    lines.push(`audit, ordered by hash of the question id, ${options.audit} per class (read them, mark the scope ones):`);
    for (const impact of ['scope', 'unclassified'] as const) {
      const picked = replay.resolutions.filter((r) => r.impact === impact).sort((a, b) => hash(a.questionId).localeCompare(hash(b.questionId))).slice(0, options.audit);
      lines.push(`  ${impact}:`, ...picked.map((r) => `    ${r.questionId}: ${r.text}`));
    }
  }
  return lines;
}
