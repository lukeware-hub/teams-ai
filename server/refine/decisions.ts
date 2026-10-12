import type { Spec, SpecDecision } from '../contracts/spec.js';
import type { QuestionRow } from './state.js';

/** Question text compared without case and extra spaces, so the same question asked twice counts once. */
export const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** The spec with each answered question recorded as a decision; a later answer to the same question replaces the earlier one. */
export function withDecisions(spec: Spec, rows: readonly QuestionRow[]): Spec {
  const answered: SpecDecision[] = rows.flatMap((q) => (q.status === 'answered' && q.answer ? [{ question: q.text, answer: q.answer, ...(q.answeredBy ? { by: q.answeredBy } : {}) }] : []));
  if (answered.length === 0) return spec;
  const byQuestion = new Map((spec.decisions ?? []).map((d) => [norm(d.question), d]));
  for (const d of answered) byQuestion.set(norm(d.question), d);
  return { ...spec, decisions: [...byQuestion.values()] };
}
