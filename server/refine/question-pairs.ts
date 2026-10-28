import type { QuestionPair } from '../decide/decisions/gate1.js';
import type { Question } from './events.js';
import { normHeading } from './sections.js';

/** Two questions of about ten meaningful words each reach this share with three words in common; below it they almost never ask the same fact. */
const MIN_OVERLAP = 0.15;
/** Three earlier questions per new one leave room for the repeat to rank below two others on the same subject. */
const PER_QUESTION = 3;
/** Ten new questions, more than a round or a plan step usually asks, with their three candidates each. */
export const MAX_DEDUP_PAIRS = 30;

const STOPWORDS = new Set(
  ('que para com uma umas uns por pelo pela pelos pelas como mais mas dos das nos nas num numa nao sim sem sob sobre entre ate apos antes depois ' +
    'quando onde qual quais quem cada todo toda todos todas este esta estes estas esse essa esses essas isso isto neste nesta nesse nessa deste desta ' +
    'desse dessa ele ela eles elas seu sua seus suas ser sao foi tem ter deve devem pode podem fica ficar tambem ainda mesmo mesma muito outro outra ' +
    'voce porque entao qualquer the and for with that this these those from into are was were been has have had does did should would could must ' +
    'can will what which who when where why how not any all each its their there than then also only but our your you they them about after before ' +
    'other some such same').split(' '),
);

type Asked = Pick<Question, 'text' | 'relatedAcIds'>;

/** The meaningful words of a text: three or more letters, without accents, and not a common Portuguese or English word. */
export const words = (text: string): Set<string> => new Set(normHeading(text).split(' ').filter((w) => /^[a-z]{3,}$/.test(w) && !STOPWORDS.has(w)));

/** The share of words two texts have in common (Jaccard). */
export function overlap(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
}

/** The pairs to ask the classifier about: each new question with its most similar earlier ones or ones on a shared criterion, best first. */
export function questionPairs<Q extends Asked>(fresh: readonly Q[], earlierOf: (q: Q, i: number) => readonly Asked[]): Array<QuestionPair & { drop: Q }> {
  return fresh
    .flatMap((q, i) => {
      const own = words(q.text);
      return earlierOf(q, i)
        .map((e) => ({ a: e.text, b: q.text, drop: q, score: overlap(own, words(e.text)), shared: e.relatedAcIds.some((id) => q.relatedAcIds.includes(id)) }))
        .filter((p) => p.shared || p.score >= MIN_OVERLAP)
        .sort((x, y) => y.score - x.score)
        .slice(0, PER_QUESTION);
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, MAX_DEDUP_PAIRS);
}
