import type { AcceptanceCriterion } from '../../contracts/spec.js';
import type { DecideContext, Decider } from '../decider.js';
import type { DecisionId, Questions } from '../types.js';

/** Spec 10A.5 decisions 2–4: filters for Gate 1. They route and drop; PO/SM still write every question. */

const acLine = (c: AcceptanceCriterion) => `${c.id}: Given ${c.given}, when ${c.when}, then ${c.then}`;
const key = (i: number) => `q${i}`;

/** One decide call with one Noul per item; null when the layer is off or did not answer every item. */
async function nouls(decider: Pick<Decider, 'decide'>, id: DecisionId, state: string, items: readonly string[], criteria: { true: string; false: string }, ctx: DecideContext): Promise<number[] | null> {
  if (items.length === 0) return [];
  const questions: Questions = Object.fromEntries(items.map((instructions, i) => [key(i), { type: 'noul' as const, instructions, criteria }]));
  const outcome = await decider.decide(id, state, questions, ctx);
  if (!outcome.answered) return null;
  const values: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = outcome.answers[key(i)];
    if (!a || a.type !== 'noul') return null;
    values.push(a.value);
  }
  return values;
}

/** Decision 2: acceptance criteria System 1 does not consider ready; null means no hint. */
export async function notReadyCriteria(criteria: readonly AcceptanceCriterion[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<string[] | null> {
  const state = ['acceptance criteria:', ...criteria.map((c) => `- ${acLine(c)}`)].join('\n');
  const p = await nouls(
    decider,
    'gate1-readiness',
    state,
    criteria.map((c) => `Is acceptance criterion ${c.id} ready for delivery: one observable behavior, a concrete trigger and an outcome a test can check?`),
    { true: 'Ready: unambiguous and testable as written.', false: 'Not ready: vague, compound, missing a concrete value, or not testable.' },
    ctx,
  );
  return p === null ? null : criteria.filter((_, i) => p[i]! < 0.5).map((c) => c.id);
}

export interface QuestionPair {
  a: string;
  b: string;
}

/** Decision 3: for each pair, whether `b` asks the same thing as `a`; null means keep every question. */
export async function duplicatePairs(pairs: readonly QuestionPair[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<boolean[] | null> {
  const state = pairs.map((p, i) => `pair ${key(i)}:\n  A: ${p.a}\n  B: ${p.b}`).join('\n');
  const p = await nouls(
    decider,
    'question-dedup',
    state,
    pairs.map((_, i) => `In pair ${key(i)}, would one answer from the human settle both question A and question B?`),
    { true: 'Duplicate: same information asked in other words.', false: 'Different: each needs its own answer.' },
    ctx,
  );
  return p === null ? null : p.map((v) => v >= 0.5);
}

/** Decision 4: indexes of history chunks the new spec contradicts. */
export async function contradictedChunks(criteria: readonly AcceptanceCriterion[], objectives: readonly string[], chunks: readonly string[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<number[]> {
  const state = [
    'new spec objectives:', ...objectives.map((o) => `- ${o}`),
    'new spec acceptance criteria:', ...criteria.map((c) => `- ${acLine(c)}`),
    '', ...chunks.map((c, i) => `history chunk ${key(i)}:\n${c}`),
  ].join('\n');
  const p = await nouls(
    decider,
    'history-contradiction',
    state,
    chunks.map((_, i) => `Does the new spec contradict history chunk ${key(i)} (both cannot hold at once)?`),
    { true: 'Contradiction: the new spec requires something the chunk rules out, or the reverse.', false: 'Compatible, unrelated, or a deliberate extension.' },
    ctx,
  );
  return p === null ? [] : p.flatMap((v, i) => (v >= 0.5 ? [i] : []));
}
