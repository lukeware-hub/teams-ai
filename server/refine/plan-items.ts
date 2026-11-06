// Shared with the web page, so this file imports no Node module.
import { isStarted } from './coverage.js';
import { buildSpecsIndex } from './specs-index.js';
import type { RefineState } from './state.js';

/** The part of the session a preparation reads: the detailed backlog, or the single spec it derived. */
export type PlanSource = Pick<RefineState, 'backlog' | 'derived' | 'featureKey' | 'repositories' | 'architecture'>;

/** One backlog item, or the single spec, which gets one plan. */
export interface PlanItem {
  key: string;
  specId: string;
  title: string;
  /** The repository the spec changes, when its draft has an architecture. */
  repository?: string;
}

/** The plans to write: each backlog item still to start, or the single spec as one item. A spec main already started was planned by its own run. */
export function planItems(draftId: string, source: PlanSource): PlanItem[] {
  const backlog = source.backlog;
  if (backlog?.enabled) return buildSpecsIndex(draftId, backlog).specs.filter((item) => !isStarted(backlog.specs?.[item.key]?.spec?.status));
  return source.derived ? [{ key: source.featureKey ?? draftId, specId: draftId, title: source.derived.spec.objectives[0]! }] : [];
}
