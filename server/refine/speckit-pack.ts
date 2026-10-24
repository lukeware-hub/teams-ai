import path from 'node:path';
import { QUALITY_RULES } from '../agents/registry.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import type { DocFile } from './draft.js';
import { DOC_FILES } from './suggest.js';

export type SpeckitCommand = 'constitution' | 'specify' | 'plan' | 'tasks';

/** One backlog item, as Spec Kit names its feature folder after the item's spec id. */
export interface SpeckitItem {
  key: string;
  specId: string;
  title: string;
}

export const itemSpecPath = (docsDir: string, specId: string): string => path.posix.join(docsDir, 'specs', specId, 'spec.json');
export const itemPreplanPath = (docsDir: string, specId: string): string => path.posix.join(docsDir, 'specs', specId, 'preplan.json');

/** The user input of one command: the constitution reads the project documents, an item command reads its own files. */
function argumentsOf(command: SpeckitCommand, docsDir: string, item: SpeckitItem | undefined): string {
  const doc = (file: DocFile) => path.posix.join(docsDir, file);
  if (command === 'constitution') {
    return `Write the constitution of this project from the principles in ${doc('project.md')}, the stack in ${doc('stack.md')} and the visual contract in ${doc('design.md')}, plus these rules:\n${QUALITY_RULES}`;
  }
  const feature = `Use SPECIFY_FEATURE_DIRECTORY=specs/${item!.specId} as the feature directory.`;
  if (command === 'specify') {
    return `${feature} Specify the backlog item "${item!.title}" from its spec ${itemSpecPath(docsDir, item!.specId)}: keep its objectives, features, acceptance criteria with their ids and what is out of scope. Read the project documents for context: ${DOC_FILES.map(doc).join(', ')}.`;
  }
  if (command === 'plan') {
    return `${feature} Plan the feature with the stack in ${doc('stack.md')} and the visual contract in ${doc('design.md')}. The item's pre-plan ${itemPreplanPath(docsDir, item!.specId)}, when it exists, lists the modules, tasks and risks the team already agreed.`;
  }
  return `${feature} Break the plan of the feature into tasks, keeping the acceptance criterion ids.`;
}

/** One Spec Kit command run by an agent in the staging folder, where `specify init` put the skills it follows. */
export function speckitPack(input: { command: SpeckitCommand; specHash: string; docsDir: string; item?: SpeckitItem }): ContextPackInput {
  const feedback = [
    `Run the Spec Kit command /speckit-${input.command} in this folder: read .claude/skills/speckit-${input.command}/SKILL.md with the Read tool and follow it, with the text under "### arguments" as the user input.`,
    '- This folder has no git repository and needs none: skip every git step and every hook.',
    '- Run the scripts the skill names from this folder.',
    '- Never stop to ask a question: when the documents leave a point open, take the most reasonable choice and write it down as an assumption.',
    '- Write only under .specify/ and specs/ in this folder; never change .claude/ or the documents you read.',
    '- Write the content in Brazilian Portuguese; keep the template headings, ids, code names and commands as they are.',
    '- Answer status done with the files you wrote in `files` (paths relative to this folder) and a one-sentence `summary`; answer status blocked with `reason` when the command cannot finish.',
    `### arguments\n${argumentsOf(input.command, input.docsDir, input.item)}`,
  ].join('\n\n');
  return { kind: 'speckit', role: 'dev', specHash: input.specHash, principles: [], outputContract: outputContract('speckit'), criteria: [], feedback, budgetTokens: 8_000 };
}
