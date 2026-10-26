import path from 'node:path';
import { QUALITY_RULES } from '../agents/registry.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
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

/** The user input of one command: the constitution reads the project inputs, an item command its section of specs.md. */
function argumentsOf(command: SpeckitCommand, inputDir: string, item: SpeckitItem | undefined): string {
  const input = (file: SpeckitInput) => path.posix.join(inputDir, file);
  if (command === 'constitution') {
    return `Write the constitution of this project from the principles in ${input('project.md')}, the stack in ${input('stack.md')} and the visual contract in ${input('design.md')}, plus these rules:\n${QUALITY_RULES}`;
  }
  const entry = `The backlog item is the section "## ${item!.key}: ${item!.title}" of ${input('specs.md')}`;
  if (command === 'specify') return `${entry}. Specify it from that section, keeping its acceptance criterion ids, with the other five files as context.`;
  if (command === 'clarify') return `${entry}. Clarify the current feature against that section and the other five files, keeping its acceptance criterion ids.`;
  if (command === 'plan') return `${entry}. Plan the current feature with ${input('stack.md')}, ${input('design.md')} and the item's pre-plan in that section, keeping its acceptance criterion ids.`;
  return `${entry}. Break the plan of the current feature into tasks, keeping the acceptance criterion ids.`;
}

/** One Spec Kit command run by an agent in the staging folder, where `specify init` put the skills it follows. */
export function speckitPack(input: { command: SpeckitCommand; specHash: string; inputDir: string; item?: SpeckitItem }): ContextPackInput {
  const feedback = [
    `Run the Spec Kit command /speckit-${input.command} in this folder: read .claude/skills/speckit-${input.command}/SKILL.md with the Read tool and follow it, with the text under "### arguments" as the user input.`,
    `- Your inputs are these six Markdown files, read with the Read tool: ${SPECKIT_INPUTS.map((file) => path.posix.join(input.inputDir, file)).join(', ')}. specs.md lists the backlog items in order, each in its own section with its acceptance criteria and pre-plan. Every spec.md, plan.md and tasks.md you write is derived from these six files only.`,
    '- This folder has no git repository and needs none: skip every git step and every hook.',
    '- Run the scripts the skill names from this folder.',
    '- Never stop to ask a question in the chat. List every open point, each [NEEDS CLARIFICATION] marker and each question the skill would ask, in `questions`: its text in Brazilian Portuguese, `options` when there are clear choices (mark the one you recommend), `blocking` true only when the work cannot be right without the answer, and `itemKey` of the item it is about. Then take the most reasonable choice, flag it as an assumption in the file you write, and continue.',
    `- The owner's decisions are under "## Decisões" in ${path.posix.join(input.inputDir, 'briefing.md')}: they answer earlier questions, so follow them and never ask them again.`,
    '- Write only under .specify/ and specs/ in this folder; never change .claude/ or the inputs.',
    '- Write the content in Brazilian Portuguese; keep the template headings, ids, code names and commands as they are.',
    '- Answer status done with the files you wrote in `files` (paths relative to this folder) and a one-sentence `summary`; answer status blocked with `reason` when the command cannot finish.',
    `### arguments\n${argumentsOf(input.command, input.inputDir, input.item)}`,
  ].join('\n\n');
  return { kind: 'speckit', role: 'dev', specHash: input.specHash, principles: [], outputContract: outputContract('speckit'), criteria: [], feedback, budgetTokens: 8_000 };
}
