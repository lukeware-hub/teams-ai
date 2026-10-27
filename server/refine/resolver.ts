import { RefineEvent, type QuestionChoice } from './events.js';
import { overlap, words } from './question-pairs.js';
import type { RefineState } from './state.js';

/** The resolver's rules for one replay: a change is a new stamp, and promotion needs a holdout made after it (plan 101). */
export const RULES = {
  stamp: 'r2',
  /** A repeat: the same context, and a word overlap of at least `overlap` between questions of at least `words` content words. */
  repeat: { overlap: 0.8, words: 4 },
  /** The gate a stratum clears before it acts: labels, the one-sided Wilson z, the lower bound to clear, and the bound below which it is bad. */
  gate: { labels: 40, z: 1.645, lower: 0.8, bad: 0.6 },
} as const;

export type Impact = 'scope' | 'detail' | 'unclassified';
export type Site = 'round' | 'stage' | 'speckit';
export type Verdict = 'escalate' | 'repeat' | 'evidence' | 'assume' | 'ask';

/** The part of a question the resolver reads; a journal question and a state row both fit. */
export interface Subject {
  questionId: string;
  text: string;
  subject?: string;
  rule?: string;
  options?: readonly QuestionChoice[];
  relatedAcIds?: readonly string[];
  itemKey?: string;
  file?: string;
}

/** The closest question of the ledger in the same context: its score, and whether its digits match. */
export interface Twin {
  of: string;
  score: number;
  sameDigits: boolean;
}

/** What the resolver decided for one question, with the facts behind the decision. */
export interface Resolution {
  questionId: string;
  text: string;
  site: Site;
  /** The cluster the owner's labels fall in, named as the agreement replay names them. */
  item: string;
  impact: Impact;
  rules: string[];
  verdict: Verdict;
  /** The label of the first option marked recommended, as the agreement replay reads it. */
  recommended?: string;
  options: string[];
  nearest?: Twin;
  evidence: boolean;
}

/** A journal event as the resolver reads it. */
export interface EventLike {
  type: string;
  data: Record<string, unknown>;
}

const plainText = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The text with its punctuation and spacing reduced, so two answers compare as the owner typed them. */
export const normalized = (text: string): string => plainText(text).replace(/[^a-z0-9]+/g, ' ').trim();

const digitsOf = (text: string): string => (plainText(text).match(/\d+/g) ?? []).sort().join(' ');

/** Words that put a question in scope: adding, cutting, priority, order, phase, release, or what enters this delivery. */
const SCOPE_CUE = /\b(inclu(?:ir|i|em|sao|ido|ida|idos|idas)|include\w*|adicion\w*|adicionar|acrescent\w*|remov\w*|retir\w*|cort\w*|exclu(?:ir|i|ido|ida|idos|idas)|descart\w*|divid\w*|mescl\w*|unir|unific\w*|prior\w*|escopo|mvp|fases?|release\w*|entregas?|entr(?:a|am|ar)|adi(?:ar|ado|ada|ados|adas|amento)|adiad\w*|split\w*|merge\w*|add\w*|drop\w*|cut\w*|scope|defer\w*|phase\w*|later|milestone\w*|futur\w*)\b/g;
/** An ask: a question word. */
const DETAIL_ASK = /\b(qual|quais|quanto|quanta|quantos|quantas|how many|how much|how long|what is|what are)\b/;
/** The kind of value an ask names: a value, a limit, a name, a format or a message text. */
const DETAIL_NOUN = /\b(valor\w*|limite\w*|prazo\w*|tamanho\w*|formato\w*|nome\w*|mensagem\w*|texto\w*|rotulo\w*|cor|cores|frequencia\w*|intervalo\w*|tempo\w*|numero\w*|quantidade\w*|tentativa\w*|idioma\w*|padrao\w*|value\w*|limit\w*|name\w*|format\w*|message\w*|text\w*|label\w*|size\w*|length\w*|timeout\w*|deadline\w*)\b/;
/** The questions the replay builds itself: a rule check, a gap, an outline or a stuck check. */
const SYSTEM_ID = /^(gap-|outline-|stuck-)/;

/** The impact of a question, failing closed: a scope cue anywhere wins, and detail needs a positive ask for a value. */
export function impactOf(question: Subject): { impact: Impact; rules: string[] } {
  if (question.rule !== undefined || SYSTEM_ID.test(question.questionId)) return { impact: 'scope', rules: ['system'] };
  const stem = plainText(`${question.subject ?? ''} ${question.text}`);
  const everything = plainText([stem, ...(question.options ?? []).map((o) => `${o.label} ${o.detail ?? ''}`)].join(' '));
  const cues = everything.match(SCOPE_CUE) ?? [];
  if (cues.length > 0) return { impact: 'scope', rules: [...new Set(cues)].map((cue) => `cue:${cue}`) };
  if (DETAIL_ASK.test(stem) && DETAIL_NOUN.test(stem)) return { impact: 'detail', rules: ['ask', 'noun'] };
  return { impact: 'unclassified', rules: [] };
}

/** The questions the owner already answered, which a new question may repeat: an agent answer is not one of them. */
export const ownerLedger = (state: RefineState): Subject[] => state.questions.filter((q) => q.status === 'answered' && Boolean(q.answer) && !q.answeredBy);

/** Two questions share a context when they are about the same item, the same stage file, or a criterion. */
const sameContext = (a: Subject, b: Subject): boolean =>
  (a.itemKey !== undefined && a.itemKey === b.itemKey) || (a.file !== undefined && a.file === b.file) || (a.relatedAcIds ?? []).some((id) => (b.relatedAcIds ?? []).includes(id));

/** The closest question of the ledger in the same context, with the similarity of the two texts. */
export function nearestTwin(question: Subject, ledger: readonly Subject[]): Twin | undefined {
  const digits = digitsOf(question.text);
  const own = words(question.text);
  let best: Twin | undefined;
  for (const row of ledger) {
    if (row.questionId === question.questionId || !sameContext(question, row)) continue;
    const score = normalized(row.text) === normalized(question.text)
      ? 1
      : own.size >= RULES.repeat.words && words(row.text).size >= RULES.repeat.words ? overlap(own, words(row.text)) : 0;
    if (best === undefined || score > best.score) best = { of: row.questionId, score, sameDigits: digitsOf(row.text) === digits };
  }
  return best;
}

/** A repeat: the nearest twin is close enough and names the same numbers. */
export const isRepeat = (twin: Twin | undefined): boolean => twin !== undefined && twin.sameDigits && twin.score >= RULES.repeat.overlap;

const itemOf = (site: Site, question: Subject): string => (site === 'speckit' ? (question.itemKey ?? 'speckit') : site === 'stage' ? `doc:${question.file ?? ''}` : 'round');

/** The verdict of one question, in the fixed order: scope escalates, then a repeat, then evidence, then an assumption, else the owner is asked. */
export function resolveQuestion(question: Subject, site: Site, ledger: readonly Subject[], evidence = false): Resolution {
  const { impact, rules } = impactOf(question);
  const options = question.options ?? [];
  const marked = options.find((o) => o.recommended === true);
  const nearest = nearestTwin(question, ledger);
  const assumable = impact === 'detail' && options.filter((o) => o.recommended === true).length === 1;
  const verdict: Verdict = impact === 'scope' ? 'escalate' : isRepeat(nearest) ? 'repeat' : evidence ? 'evidence' : assumable ? 'assume' : 'ask';
  return {
    questionId: question.questionId,
    text: question.text,
    site,
    item: itemOf(site, question),
    impact,
    rules,
    verdict,
    ...(marked ? { recommended: marked.label } : {}),
    options: options.map((o) => o.label),
    ...(nearest ? { nearest } : {}),
    evidence,
  };
}

const SITE_OF: Record<string, Site> = {
  [RefineEvent.Evaluated]: 'round',
  [RefineEvent.StageReviewed]: 'stage',
  [RefineEvent.SpeckitStepDone]: 'speckit',
};

/** The questions an event lands, resolved against the state before it; a question already on record is not landed again. */
export function resolveLanding(event: EventLike, state: RefineState): Resolution[] {
  const site = SITE_OF[event.type];
  if (!site) return [];
  const ledger = ownerLedger(state);
  const fresh = new Map<string, Subject>();
  for (const raw of (event.data.questions ?? []) as Subject[]) {
    if (fresh.has(raw.questionId) || state.questions.some((q) => q.questionId === raw.questionId)) continue;
    fresh.set(raw.questionId, site === 'stage' ? { ...raw, file: String(event.data.file) } : raw);
  }
  return [...fresh.values()].map((q) => resolveQuestion(q, site, ledger));
}

/** The triage card of each pending Spec Kit question re-decides its impact, recommendation and evidence. */
export function resolveCard(event: EventLike, state: RefineState): Resolution[] {
  if (event.type !== RefineEvent.SpeckitTriaged) return [];
  const ledger = ownerLedger(state);
  const out: Resolution[] = [];
  for (const r of (event.data.results ?? []) as Array<{ questionId: string; text?: string; subject?: string; options?: QuestionChoice[]; answer?: unknown }>) {
    const row = state.questions.find((q) => q.questionId === r.questionId);
    if (!row || row.status !== 'pending') continue;
    const card: Subject = { ...row, text: r.text ?? row.text, subject: r.subject ?? row.subject, options: r.options ?? row.options };
    out.push(resolveQuestion(card, 'speckit', ledger, r.answer !== undefined && r.answer !== null));
  }
  return out;
}
