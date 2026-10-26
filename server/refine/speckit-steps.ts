import type { SpeckitCommand, SpeckitItem } from './speckit-pack.js';

export type Step = { command: SpeckitCommand; item?: SpeckitItem };

/** A step's name in the journal and in the state: its command and its backlog item. */
export const stepKey = (command: string, itemKey?: string): string => `${command}|${itemKey ?? ''}`;

const ITEM_COMMANDS = ['specify', 'clarify', 'plan', 'tasks'] as const;

/** The four commands of one backlog item, in order. */
export const itemSteps = (item: SpeckitItem): Step[] => ITEM_COMMANDS.map((command) => ({ command, item }));

/** Spec Kit's own flow: the constitution once, then the four commands of each item in rank order (1 + 4N steps). */
export function speckitSteps(items: readonly SpeckitItem[]): Step[] {
  return [{ command: 'constitution' }, ...items.flatMap(itemSteps)];
}
