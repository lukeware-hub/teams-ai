import type { Spec } from '../contracts/spec.js';
import type { SpeckitCommand, SpeckitItem } from './speckit-pack.js';
import { buildSpecsIndex } from './specs-index.js';
import type { BacklogState } from './state.js';

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

/** The part of a session its Spec Kit items come from: the backlog in backlog mode, else the single spec it derived. */
export interface ItemSource {
  backlog?: Pick<BacklogState, 'enabled' | 'epics' | 'items' | 'keyIds'> | null;
  derived?: { spec: Pick<Spec, 'objectives'> } | null;
  featureKey?: string;
}

/**
 * The items a preparation covers, in rank order: every backlog item, or the single spec as one item titled by its first
 * objective. That item is named by the backlog key its spec came from, so a continued spec keeps its feature folder, or else by its id.
 */
export function speckitItems(draftId: string, s: ItemSource): SpeckitItem[] {
  if (s.backlog?.enabled) return buildSpecsIndex(draftId, s.backlog).specs;
  return s.derived ? [{ key: s.featureKey ?? draftId, specId: draftId, title: s.derived.spec.objectives[0]! }] : [];
}
