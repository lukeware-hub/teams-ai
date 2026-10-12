import type { Spec, SpecDecision } from '../contracts/spec.js';
import type { QuestionRow } from './state.js';

/** Question text compared without case and extra spaces, so the same question asked twice counts once. */
export const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

const ANSWER = /^Answer(?: \((PO|SM), from the docs\))?: ?(.*)$/;
/** Continuation lines are indented under their item, so a heading or blank line inside an answer stays in it. */
const indent = (t: string) => t.replace(/\n/g, '\n  ');

/** One decision as a list item, its answer on an `Answer:` line; every continuation line stays indented inside it. */
export const renderDecision = (d: SpecDecision): string => `- ${indent(d.question)}\n  Answer${d.by ? ` (${d.by.toUpperCase()}, from the docs)` : ''}: ${indent(d.answer)}`;

/** The brief's `## Decisions` section: one item per decision, so the owner can edit it. */
export function renderDecisions(decisions: readonly SpecDecision[]): string[] {
  return ['## Decisions', '', ...decisions.map(renderDecision), ''];
}

/** The decisions in the brief's `## Decisions` section as the owner left them; undefined when it holds none. */
export function parseDecisions(md: string): SpecDecision[] | undefined {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^## Decisions\s*$/.test(l));
  if (start < 0) return undefined;
  const items: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    if (line.startsWith('- ')) items.push([line.slice(2)]);
    else items.at(-1)?.push(line.startsWith('  ') ? line.slice(2) : line);
  }
  const decisions = items.flatMap((item): SpecDecision[] => {
    const i = item.findIndex((l) => ANSWER.test(l));
    const m = i > 0 ? ANSWER.exec(item[i]!) : null;
    if (!m) return [];
    const question = item.slice(0, i).join('\n').trim();
    const answer = [m[2]!, ...item.slice(i + 1)].join('\n').trim();
    return question && answer ? [{ question, answer, ...(m[1] ? { by: m[1].toLowerCase() as 'po' | 'sm' } : {}) }] : [];
  });
  return decisions.length > 0 ? decisions : undefined;
}

/** The spec with each answered question recorded as a decision; a later answer to the same question replaces the earlier one. */
export function withDecisions(spec: Spec, rows: readonly QuestionRow[]): Spec {
  const answered: SpecDecision[] = rows.flatMap((q) => (q.status === 'answered' && q.answer ? [{ question: q.text, answer: q.answer, ...(q.answeredBy ? { by: q.answeredBy } : {}) }] : []));
  if (answered.length === 0) return spec;
  const byQuestion = new Map((spec.decisions ?? []).map((d) => [norm(d.question), d]));
  for (const d of answered) byQuestion.set(norm(d.question), d);
  return { ...spec, decisions: [...byQuestion.values()] };
}
