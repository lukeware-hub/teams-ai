import path from 'node:path';
import { QUALITY_RULES } from '../agents/registry.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';

export type SpeckitCommand = 'constitution' | 'specify' | 'plan' | 'tasks';

/** One backlog item, as Spec Kit names its feature folder after the item's spec id. */
export interface SpeckitItem {
  key: string;
  specId: string;
  title: string;
}

/** The six JSON files the preparation reads: the specs index and the five documents as JSON. */
export const SPECKIT_INPUTS = ['specs.json', 'project.json', 'flow.json', 'briefing.json', 'stack.json', 'design.json'] as const;
export type SpeckitInput = (typeof SPECKIT_INPUTS)[number];

/** The user input of one command: the constitution reads the project inputs, an item command its entry in specs.json. */
function argumentsOf(command: SpeckitCommand, inputDir: string, item: SpeckitItem | undefined): string {
  const input = (file: SpeckitInput) => path.posix.join(inputDir, file);
  if (command === 'constitution') {
    return `Write the constitution of this project from the principles in ${input('project.json')}, the stack in ${input('stack.json')} and the visual contract in ${input('design.json')}, plus these rules:\n${QUALITY_RULES}`;
  }
  const entry = `Use SPECIFY_FEATURE_DIRECTORY=specs/${item!.specId} as the feature directory. The item is the entry with key "${item!.key}" in ${input('specs.json')}`;
  if (command === 'specify') return `${entry}: specify "${item!.title}" from its scope and its spec, keeping its objectives, features, acceptance criteria with their ids and what is out of scope.`;
  if (command === 'plan') return `${entry}: plan the feature with the stack in ${input('stack.json')}, the visual contract in ${input('design.json')} and the item's preplan, which lists the modules, tasks and risks the team already agreed.`;
  return `${entry}: break the plan of the feature into tasks, keeping the acceptance criterion ids.`;
}

/** One Spec Kit command run by an agent in the staging folder, where `specify init` put the skills it follows. */
export function speckitPack(input: { command: SpeckitCommand; specHash: string; inputDir: string; item?: SpeckitItem }): ContextPackInput {
  const feedback = [
    `Run the Spec Kit command /speckit-${input.command} in this folder: read .claude/skills/speckit-${input.command}/SKILL.md with the Read tool and follow it, with the text under "### arguments" as the user input.`,
    `- Your inputs are these JSON files, read with the Read tool: ${SPECKIT_INPUTS.map((file) => path.posix.join(input.inputDir, file)).join(', ')}. specs.json lists the backlog items in order, each with its spec and preplan; each other file is one project document split into its sections.`,
    '- This folder has no git repository and needs none: skip every git step and every hook.',
    '- Run the scripts the skill names from this folder.',
    '- Never stop to ask a question: when the inputs leave a point open, take the most reasonable choice and write it down as an assumption.',
    '- Write only under .specify/ and specs/ in this folder; never change .claude/ or the inputs.',
    '- Write the content in Brazilian Portuguese; keep the template headings, ids, code names and commands as they are.',
    '- Answer status done with the files you wrote in `files` (paths relative to this folder) and a one-sentence `summary`; answer status blocked with `reason` when the command cannot finish.',
    `### arguments\n${argumentsOf(input.command, input.inputDir, input.item)}`,
  ].join('\n\n');
  return { kind: 'speckit', role: 'dev', specHash: input.specHash, principles: [], outputContract: outputContract('speckit'), criteria: [], feedback, budgetTokens: 8_000 };
}
