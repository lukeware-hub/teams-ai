import type { AcceptanceCriterion } from '../../contracts/spec.js';
import type { DecideContext, Decider } from '../decider.js';
import type { DecisionId } from '../types.js';

/**
 * Spec 10A.5 decisions 2–4: filters for Gate 1. They route and drop; PO/SM still write every question.
 *
 * One decide call per item, each with its own state: a call's confidence is the lowest of its questions, so
 * batching items made one uncertain item discard the answers of all (live e2e, 2026-10-04: three duplicate pairs in
 * one call came back at 0.60 and the backend's 0.9 threshold left the whole decision unanswered).
 */

const acLine = (c: AcceptanceCriterion) => `${c.id}: Given ${c.given}, when ${c.when}, then ${c.then}`;

/** Readiness below this is "not ready". Provisional: the local 7B scored a vague criterion 0.66 and a precise one 1.00. */
export const READY_MIN = 0.8;
export const DUPLICATE_MIN = 0.5;
export const CONTRADICTION_MIN = 0.5;

/** P(yes) of one noul question about one item; null when the layer is off or gave no answer. */
async function noul(decider: Pick<Decider, 'decide'>, id: DecisionId, state: string, instructions: string, criteria: { true: string; false: string }, ctx: DecideContext): Promise<number | null> {
  const outcome = await decider.decide(id, state, { q0: { type: 'noul', instructions, criteria } }, ctx);
  if (!outcome.answered) return null;
  const a = outcome.answers.q0;
  return a && a.type === 'noul' ? a.value : null;
}

/**
 * Spec 10A.0 "rules first": a THEN that uses only a vague word (nicely, properly, correctly...) and names no concrete
 * value (digit, quote, brace or bracket) is not ready, whatever a model says. The local 7B scored "responds properly"
 * as exact in the live check, so this does not rely on it.
 */
const VAGUE_WORD = /\b(nicely|nice|properly|correctly|appropriately|friendly|fast|quickly|well|good|as expected|handled)\b/i;
const CONCRETE_VALUE = /[\d"'{}[\]]/;
export const vagueByRule = (c: AcceptanceCriterion): boolean => VAGUE_WORD.test(c.then) && !CONCRETE_VALUE.test(c.then);

/** Decision 2: criteria not ready by rule or by System 1; null means System 1 gave no answer and no rule fired (no hint). */
export async function notReadyCriteria(criteria: readonly AcceptanceCriterion[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<string[] | null> {
  const byRule = new Set(criteria.filter(vagueByRule).map((c) => c.id));
  const asked = criteria.filter((c) => !byRule.has(c.id));
  const p = await Promise.all(
    asked.map((c) =>
      noul(
        decider,
        'gate1-readiness',
        `acceptance criterion:
${acLine(c)}`,
        'Does the THEN part name an exact, checkable value such as a status code, a literal body or a number? Words like nicely, fast, correctly, properly or friendly are NOT exact.',
        { true: 'Yes: the outcome names an exact value a test can compare.', false: 'No: the outcome is described only in vague words.' },
        ctx,
      ),
    ),
  );
  if (byRule.size === 0 && p.every((v) => v === null)) return null;
  const byModel = asked.filter((_, i) => p[i] !== null && p[i]! < READY_MIN).map((c) => c.id);
  const flagged = new Set([...byRule, ...byModel]);
  return criteria.filter((c) => flagged.has(c.id)).map((c) => c.id);
}

export interface QuestionPair {
  a: string;
  b: string;
}

/** Decision 3: for each pair, whether `b` repeats `a`; a pair without an answer is kept apart. Null means no answer at all. */
export async function duplicatePairs(pairs: readonly QuestionPair[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<boolean[] | null> {
  if (pairs.length === 0) return [];
  const p = await Promise.all(
    pairs.map((q) =>
      noul(
        decider,
        'question-dedup',
        `Question A: ${q.a}\nQuestion B: ${q.b}`,
        'Do question A and question B ask about the same fact, so that answering one makes the other unnecessary?',
        { true: 'Yes, they ask about the same fact.', false: 'No, they ask about different facts.' },
        ctx,
      ),
    ),
  );
  if (p.every((v) => v === null)) return null;
  return p.map((v) => v !== null && v >= DUPLICATE_MIN);
}

export interface DocPatchLike {
  find: string;
  replace: string;
}

export interface PatchPair {
  a: DocPatchLike;
  b: DocPatchLike;
}

/**
 * R11.5a item 2: PO and SM proposing the same edit in different words. R11.10 already drops a byte-identical
 * later patch on the same file; this catches a paraphrase of it (same resulting meaning, different wording) that
 * byte comparison cannot see. Only called for a later patch that already failed the byte-identical check.
 */
export async function duplicatePatches(pairs: readonly PatchPair[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<boolean[] | null> {
  if (pairs.length === 0) return [];
  const p = await Promise.all(
    pairs.map((q) =>
      noul(
        decider,
        'patch-dedup',
        `Edit A:\nfind: ${q.a.find}\nreplace: ${q.a.replace}\n\nEdit B:\nfind: ${q.b.find}\nreplace: ${q.b.replace}`,
        'Does edit B make the same change in substance as edit A (same resulting document content and meaning), even if the wording of the find/replace text differs?',
        { true: 'Yes, the two edits produce the same resulting content.', false: 'No, the edits differ in what they actually change.' },
        ctx,
      ),
    ),
  );
  if (p.every((v) => v === null)) return null;
  return p.map((v) => v !== null && v >= DUPLICATE_MIN);
}

/** Decision 4: indexes of history chunks the new spec contradicts. */
export async function contradictedChunks(criteria: readonly AcceptanceCriterion[], objectives: readonly string[], chunks: readonly string[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<number[]> {
  const spec = ['new spec objectives:', ...objectives.map((o) => `- ${o}`), 'new spec acceptance criteria:', ...criteria.map((c) => `- ${acLine(c)}`)].join('\n');
  const p = await Promise.all(
    chunks.map((chunk, i) =>
      noul(
        decider,
        'history-contradiction',
        `${spec}\n\nhistory chunk q${i}:\n${chunk}`,
        'Does the new spec contradict this history chunk (both cannot hold at once)?',
        { true: 'Contradiction: the new spec requires something the chunk rules out, or the reverse.', false: 'Compatible, unrelated, or a deliberate extension.' },
        ctx,
      ),
    ),
  );
  return p.flatMap((v, i) => (v !== null && v >= CONTRADICTION_MIN ? [i] : []));
}
