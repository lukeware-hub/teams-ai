import type { Spec, SpecDecision } from '../contracts/spec.js';
import { docSections, normHeading, type DocSection } from './sections.js';
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

/** Character span of the decisions section (`## Decisões` or `## Decisions`, heading included); null when there is none. */
export function decisionsSpan(doc: string): { start: number; end: number } | null {
  const section = docSections(doc).find((s) => s.text.startsWith('## ') && ['decisoes', 'decisions'].includes(normHeading(s.heading)));
  if (!section) return null;
  const lines = doc.split('\n');
  const offset = (line: number) => lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
  return { start: offset(section.line), end: Math.min(offset(section.line + section.text.split('\n').length), doc.length) };
}

/** The spec with each answered question recorded as a decision; a later answer to the same question replaces the earlier one. */
export function withDecisions(spec: Spec, rows: readonly QuestionRow[]): Spec {
  const answered: SpecDecision[] = rows.flatMap((q) => (q.status === 'answered' && q.answer ? [{ question: q.text, answer: q.answer, ...(q.answeredBy ? { by: q.answeredBy } : {}) }] : []));
  if (answered.length === 0) return spec;
  const byQuestion = new Map((spec.decisions ?? []).map((d) => [norm(d.question), d]));
  for (const d of answered) byQuestion.set(norm(d.question), d);
  return { ...spec, decisions: [...byQuestion.values()] };
}

/** `lines` with `count` of them at `at` replaced by `added`, and a blank line before any text that follows or at the end. */
function splice(lines: readonly string[], at: number, count: number, added: readonly string[]): string {
  const rest = lines.slice(at + count);
  const gap = rest.length === 0 || rest[0]!.trim() !== '' ? [''] : [];
  return [...lines.slice(0, at), ...added, ...gap, ...rest].join('\n');
}

/**
 * R11.10 (plan 90): the briefing with the owner's answer as its own `### <question>` heading under its `## Decisões`
 * section (added at the end when missing), every line quoted so none becomes a heading; the same question inside that
 * section gets the new answer. Lines are only inserted or replaced, so no other section's text changes.
 */
export function recordDecision(briefing: string, question: string, answer: string, subject?: string): string {
  const lines = briefing.replace(/\r\n/g, '\n').split('\n');
  const title = (subject ?? question).replace(/\s+/g, ' ').trim();
  const quote = answer.replace(/\r\n/g, '\n').trim().split('\n').map((l) => (l.trim() ? `> ${l}` : '>'));
  const sections = docSections(lines.join('\n'));
  const decisions = sections.find((s) => s.text.startsWith('## ') && normHeading(s.heading) === 'decisoes');
  if (!decisions) return splice(lines, lines.length, 0, ['## Decisões', '', `### ${title}`, '', ...quote]);
  const end = decisions.line + decisions.text.split('\n').length;
  const inside = sections.filter((s) => s.line > decisions.line && s.line < end);
  // A heading holding only answers is replaced in place; prose a person wrote under a heading is kept and the answer goes under a numbered heading.
  let heading = title;
  let same = inside.find((s) => s.text.split('\n', 1)[0] === `### ${heading}`);
  for (let n = 2; same && !quotesOnly(same); n++) {
    heading = `${title} (${n})`;
    same = inside.find((s) => s.text.split('\n', 1)[0] === `### ${heading}`);
  }
  const block = [`### ${heading}`, '', ...quote];
  if (!same) return splice(lines, end, 0, block);
  // Only the answer is replaced: a heading nested under the decision stays with what follows it.
  const nested = docSections(same.text).slice(1)[0];
  const own = same.text.split('\n').slice(0, nested?.line);
  while (own.length > 1 && own.at(-1)!.trim() === '') own.pop();
  return splice(lines, same.line, own.length, block);
}

/** True when a decision's own lines are only its heading, blank lines and quoted answer lines. */
function quotesOnly(section: DocSection): boolean {
  const nested = docSections(section.text).slice(1)[0];
  return section.text.split('\n').slice(1, nested?.line).every((l) => l.trim() === '' || l.trim().startsWith('>'));
}
