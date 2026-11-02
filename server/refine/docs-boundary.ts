import type { StoredEvent } from '../store/event-store.js';
import { RefineEvent } from './events.js';
import type { BacklogState } from './state.js';

/** The facts that change a document and wait for the next boundary to reach the store. */
const EDITS: ReadonlySet<string> = new Set([
  RefineEvent.DocEdited,
  RefineEvent.PatchAccepted,
  RefineEvent.DocMoved,
  RefineEvent.DocMoveUndone,
  RefineEvent.DocReshaped,
  RefineEvent.DocReshapeUndone,
]);

export const isDocumentEdit = (type: string): boolean => EDITS.has(type);

type Fact = Pick<StoredEvent, 'type' | 'data'>;

/** The commit label of a plan or task step that validated, or null when it did not finish an item's file. */
function stepLabel(data: Record<string, unknown>, backlog: BacklogState | undefined): string | null {
  const command = data.command;
  if (data.blocked === true || (command !== 'plan' && command !== 'tasks')) return null;
  const alias = backlog?.specs?.[String(data.itemKey)]?.specId;
  return alias ? `${command} ${alias}` : null;
}

/** The commit label of a fact that ends a unit of the documents, or null when it ends none. */
export function boundaryLabel(fact: Fact, backlog: BacklogState | undefined): string | null {
  switch (fact.type) {
    case RefineEvent.BacklogEnabled:
      return 'backlog enabled';
    case RefineEvent.BacklogDerived:
      return 'backlog derived';
    case RefineEvent.SpecDerived:
      return `spec ${String(fact.data.specId)}`;
    case RefineEvent.SpeckitStepDone:
      return stepLabel(fact.data, backlog);
    case RefineEvent.PlansPrepared:
      return 'plans prepared';
    default:
      return null;
  }
}
