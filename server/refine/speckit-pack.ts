import path from 'node:path';
import { QUALITY_RULES } from '../agents/registry.js';
import type { SpecDecision } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import type { QuestionRow } from './state.js';
import { outputContract } from '../orchestrator/steps.js';

export type SpeckitCommand = 'constitution' | 'specify' | 'clarify' | 'plan' | 'tasks';

/** One backlog item; Spec Kit numbers and names its feature folder itself. */
export interface SpeckitItem {
  key: string;
  specId: string;
  title: string;
}

/** The six Markdown files every spec.md, plan.md and tasks.md comes from: the five documents and the specs index. */
export const SPECKIT_INPUTS = ['project.md', 'flow.md', 'briefing.md', 'stack.md', 'design.md', 'specs.md'] as const;
export type SpeckitInput = (typeof SPECKIT_INPUTS)[number];

/** The feature folder of one backlog item, named after its key, so every run and every parallel step finds the same one. */
export const speckitFeatureDir = (key: string): string => path.posix.join('specs', key);

/** The user input of one command: the constitution reads the project inputs, an item command its section of specs.md. */
function argumentsOf(command: SpeckitCommand, inputDir: string, item: SpeckitItem | undefined): string {
  const input = (file: SpeckitInput) => path.posix.join(inputDir, file);
  if (command === 'constitution') {
    return `Write the constitution of this project from the principles in ${input('project.md')}, the stack in ${input('stack.md')} and the visual contract in ${input('design.md')}, plus these rules:\n${QUALITY_RULES}`;
  }
  const entry = `The backlog item is the section "## ${item!.key}: ${item!.title}" of ${input('specs.md')}`;
  const folder = speckitFeatureDir(item!.key);
  if (command === 'specify') return `${entry}. Specify it from that section, keeping its acceptance criterion ids, with the other five files as context. Its feature folder is ${folder}: write it there and nowhere else, never picking a number.`;
  if (command === 'clarify') return `${entry}. Clarify the feature in ${folder} against that section and the other five files, keeping its acceptance criterion ids.`;
  if (command === 'plan') return `${entry}. Plan the feature in ${folder} with ${input('stack.md')}, ${input('design.md')} and the item's pre-plan in that section, keeping its acceptance criterion ids.`;
  return `${entry}. Break the plan in ${folder} into tasks, keeping the acceptance criterion ids.`;
}

/** The note of a step that runs again on the files of its earlier run, which are already in the staging folder. */
const ADJUST_NOTE = `- Its files from an earlier run are already in this folder: read them first, keep what is still right, and change only what the owner's decisions and the changed documents require. Never copy the template over them, and never rewrite the constitution or a spec from scratch.`;

/** The most earlier questions a pack lists. */
const LEDGER_LIMIT = 40;

/** What the journal says about one earlier question: its answer, who gave it and when. */
const ledgerState = (q: QuestionRow): string => {
  if (q.status === 'pending') return 'open, waiting for the owner';
  if (q.status === 'skipped') return 'skipped by the owner';
  const by = q.answeredBy ? `the ${q.answeredBy.toUpperCase()}` : 'the owner';
  return `answered by ${by}${q.answeredAt ? ` on ${q.answeredAt}` : ''}: ${q.answer}`;
};

/** The earlier questions of an item, the latest answer first, one per line with its state. */
export function questionLedger(rows: readonly QuestionRow[]): string {
  const latest = [...rows].sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? ''));
  return latest.slice(0, LEDGER_LIMIT).map((q) => `- [${q.role}] ${q.text}\n  id ${q.questionId}: ${ledgerState(q)}`).join('\n') || '(none)';
}

/** One Spec Kit command run by an agent in the staging folder, where `specify init` put the skills it follows. */
export function speckitPack(input: { command: SpeckitCommand; specHash: string; inputDir: string; item?: SpeckitItem; decisions?: readonly SpecDecision[]; history?: readonly QuestionRow[]; adjust?: boolean }): ContextPackInput {
  const feedback = [
    `Run the Spec Kit command /speckit-${input.command} in this folder: read .claude/skills/speckit-${input.command}/SKILL.md with the Read tool and follow it, with the text under "### arguments" as the user input.`,
    `- Your inputs are these six Markdown files, read with the Read tool: ${SPECKIT_INPUTS.map((file) => path.posix.join(input.inputDir, file)).join(', ')}. specs.md lists the backlog items in order, each in its own section with its acceptance criteria and pre-plan. Every spec.md, plan.md and tasks.md you write is derived from these six files only.`,
    '- This folder has no git repository and needs none: skip every git step and every hook.',
    '- Run the scripts the skill names from this folder.',
    '- Never stop to ask a question in the chat. List every open point, each [NEEDS CLARIFICATION] marker and each question the skill would ask, in `questions`: its text in Brazilian Portuguese, `options` with two or three choices, one marked recommended, whenever the question is a yes-or-no question or names alternatives, such as two places or two values; leave it empty only when the answer is free text, such as a name, a number or a date, `blocking` true only when the work cannot be right without the answer, and `itemKey` of the item it is about. Then take the most reasonable choice, flag it as an assumption in the file you write, and continue.',
    `- The owner's decisions are under "## Decisões" in ${path.posix.join(input.inputDir, 'briefing.md')}: they answer earlier questions, so follow them and never ask them again.`,
    '- A question that repeats one listed under "Earlier questions" is dropped, unless `distinctFrom` names, for each such question, its id and one sentence of at least eight words with a fact the earlier question did not have.',
    '- The decisions marked "(PO, from the docs)" or "(SM, from the docs)" are provisional: the six documents and the owner\'s own decisions win over them, and a decision replaces any assumption you took, correcting every file you wrote that holds one.',
    '- Write only under .specify/ and specs/ in this folder; never change .claude/ or the inputs.',
    '- Write the content in Brazilian Portuguese; keep the template headings, ids, code names and commands as they are.',
    '- Answer status done with the files you wrote in `files` (paths relative to this folder) and a one-sentence `summary`; answer status blocked with `reason` when the command cannot finish.',
    `### Earlier questions of this item (the latest owner answer wins; never ask one of them again, even reworded)\n${questionLedger(input.history ?? [])}`,
    ...(input.adjust ? [ADJUST_NOTE] : []),
    `### arguments\n${argumentsOf(input.command, input.inputDir, input.item)}`,
  ].join('\n\n');
  return { kind: 'speckit', role: 'dev', specHash: input.specHash, principles: [], outputContract: outputContract('speckit'), criteria: [], feedback, budgetTokens: 8_000, decisions: input.decisions };
}
