import type { Question } from './events.js';
import { overlap, words } from './question-pairs.js';
import type { QuestionRow } from './state.js';

/** plan questions: two questions at least this similar ask about the same fact (Jaccard over their meaningful words). */
export const REPEAT_OVERLAP = 0.3;
/** Stage review questions, against any document: the live journal's repeats start at this similarity. */
export const STAGE_REPEAT_OVERLAP = 0.25;
/** Full-round questions, against any document. */
export const ROUND_REPEAT_OVERLAP = 0.3;
/** A difference is a sentence of at least this many words, so one bare word never passes as one. */
const MIN_DIFFERENCE_WORDS = 8;

/** A question the owner decided: answered by the owner, or skipped by the owner. */
const decided = (q: QuestionRow): boolean => q.status === 'skipped' || (q.status === 'answered' && !q.answeredBy);

/** The decided earlier questions of the same kind and item that a new question repeats, the most similar first. */
export function repeatsOf(question: Pick<Question, 'text' | 'itemKey' | 'origin'>, earlier: readonly QuestionRow[], floor = REPEAT_OVERLAP): QuestionRow[] {
  const own = words(question.text);
  return earlier
    .filter((e) => e.origin === question.origin && e.itemKey === question.itemKey && decided(e))
    .map((e) => ({ e, score: overlap(own, words(e.text)) }))
    .filter((x) => x.score >= floor)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);
}

/** A difference holds when it is a sentence with a word that the decided question and its answer do not have. */
export function differenceHolds(difference: string, decidedQuestion: QuestionRow): boolean {
  const known = words(`${decidedQuestion.text} ${decidedQuestion.answer ?? ''}`);
  return difference.trim().split(/\s+/).length >= MIN_DIFFERENCE_WORDS && [...words(difference)].some((w) => !known.has(w));
}

export interface RepeatCheck {
  /** The new questions the owner sees: none repeats a decided one, or each repeat names a real difference. */
  kept: Question[];
  /** The repeats no difference justifies, each with the decided questions it repeats, the most similar first. */
  unresolved: Array<{ question: Question; matches: QuestionRow[] }>;
}

/** Splits the new questions of a step between those the owner sees and the repeats of a decided question no difference justifies. */
export function checkRepeats(fresh: readonly Question[], earlier: readonly QuestionRow[], floor = REPEAT_OVERLAP): RepeatCheck {
  const kept: Question[] = [];
  const unresolved: RepeatCheck['unresolved'] = [];
  for (const question of fresh) {
    const matches = repeatsOf(question, earlier, floor);
    if (matches.length === 0) kept.push(question);
    else if (matches.every((m) => question.distinctFrom?.some((d) => d.questionId === m.questionId && differenceHolds(d.difference, m)))) kept.push(question);
    else unresolved.push({ question, matches });
  }
  return { kept, unresolved };
}

/** The journal payload of a dropped question: the question as it was asked, and the decided one it repeats. */
export function droppedOf(question: Question, decidedQuestion: QuestionRow, file?: Question['file']): Record<string, unknown> {
  return { ...question, ...(file === undefined ? {} : { file }), matchedQuestionId: decidedQuestion.questionId, matchedText: decidedQuestion.text, matchedAnswer: decidedQuestion.answer };
}

/** The note a step runs again with: each decided question a new one repeats, and the one way to keep the new question. */
export function repeatNote(unresolved: RepeatCheck['unresolved']): string {
  const lines = unresolved.flatMap(({ question, matches }) => [
    `- "${question.text}" repeats:`,
    ...matches.map((m) => `  - id ${m.questionId}: "${m.text}", decided as "${m.answer ?? 'skipped by the owner'}"`),
  ]);
  return [
    'Some questions you listed repeat a question the owner already decided. Do not list them again.',
    'A question that is still needed names, in `distinctFrom`, each decided question it repeats: its id and one sentence, of at least eight words, with a fact the decided question did not have.',
    ...lines,
  ].join('\n');
}
