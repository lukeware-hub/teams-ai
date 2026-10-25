import type { SpeckitCommand, SpeckitItem } from './speckit-pack.js';

export type Step = { command: SpeckitCommand; item?: SpeckitItem };

/** Spec Kit's own flow: the constitution once, then specify, clarify, plan and tasks for each item in rank order (1 + 4N steps). */
export function speckitSteps(items: readonly SpeckitItem[]): Step[] {
  return [{ command: 'constitution' }, ...items.flatMap((item) => (['specify', 'clarify', 'plan', 'tasks'] as const).map((command) => ({ command, item })))];
}
