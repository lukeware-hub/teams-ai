import { QUALITY_RULES } from '../agents/registry.js';
import { sha256 } from '../contracts/hash.js';
import { decisionsSpan } from './decisions.js';
import type { SpeckitCommand, SpeckitInput } from './speckit-pack.js';
import type { Step } from './speckit-steps.js';

/** A question as a step's basis reads it: a refinement question, or a Spec Kit one with the item and the command that asked it. */
export interface BasisQuestion {
  questionId: string;
  status: string;
  answer?: string | null;
  answeredBy?: string | null;
  origin?: string;
  itemKey?: string;
  command?: SpeckitCommand;
}

/** The order the commands run in: a question asked by an earlier command changes a step, and so does one asked by the same command, unless the step is a specify. */
const RANK: Record<SpeckitCommand, number> = { constitution: 0, specify: 1, clarify: 2, plan: 3, tasks: 4 };

/** A document with every run of spaces made one, so a blank line alone changes no basis. */
const normalized = (doc: string): string => doc.replace(/\s+/g, ' ').trim();

/** The owner's decisions: the briefing's `## Decisões` section. Every step follows them, so a change to any of them reaches every step. */
const decisionsText = (doc: string): string => {
  const span = decisionsSpan(doc);
  return span ? normalized(doc.slice(span.start, span.end)) : '';
};

/** The section of one backlog item in specs.md, from its heading up to the next level-two heading. */
function sectionOf(specs: string, key: string): string {
  const lines = specs.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${key}: `));
  if (start < 0) return '';
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}

/** Whether a question can change what a step writes: any refinement question, or a Spec Kit one about the step's item (or none) asked earlier. */
function dependsOn(q: BasisQuestion, step: Step): boolean {
  if (q.origin !== 'speckit') return true;
  if (q.itemKey !== undefined && q.itemKey !== step.item?.key) return false;
  const asked = RANK[q.command ?? 'constitution'];
  return asked < RANK[step.command] || (asked === RANK[step.command] && step.command !== 'specify');
}

/** What a Spec Kit step reads, its documents and the answers that can change it, recorded with the step; a new preparation continues from the finished steps without comparing it. */
export function stepBasis(step: Step, texts: Record<SpeckitInput, string>, questions: readonly BasisQuestion[]): string {
  const documents = step.item
    ? [texts['project.md'], texts['flow.md'], normalized(texts['briefing.md']), texts['stack.md'], texts['design.md'], sectionOf(texts['specs.md'], step.item.key)]
    : [texts['project.md'], texts['stack.md'], texts['design.md'], decisionsText(texts['briefing.md']), QUALITY_RULES];
  const answers = questions
    .filter((q) => dependsOn(q, step))
    .sort((a, b) => (a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0))
    .map((q) => [q.questionId, q.status, q.answer ?? '', q.answeredBy ?? ''].join('\n'));
  return sha256([...documents, ...answers].join('\n\u0000\n'));
}
