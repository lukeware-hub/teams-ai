import type { StoredEvent } from '../store/event-store.js';
import { RefineEvent } from './events.js';
import type { BacklogState } from './state.js';

type Fact = Pick<StoredEvent, 'type' | 'data'>;

/** The commit label of a plan or task step that validated, or null when it did not finish an item's file. */
function stepLabel(data: Record<string, unknown>, backlog: BacklogState | null): string | null {
  const command = data.command;
  if (data.blocked === true || (command !== 'plan' && command !== 'tasks')) return null;
  const alias = backlog?.specs?.[String(data.itemKey)]?.specId;
  return alias ? `${command} ${alias}` : null;
}

/** The commit label of a fact that ends a unit of the documents, or null when it ends none. */
export function boundaryLabel(fact: Fact, backlog: BacklogState | null): string | null {
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
    // A document change is committed at the next tick, not held for a later boundary: the store follows the draft at once.
    case RefineEvent.DocEdited:
    case RefineEvent.PatchAccepted:
      return typeof fact.data.file === 'string' ? `document ${fact.data.file}` : 'documents edited';
    case RefineEvent.DocMoved:
    case RefineEvent.DocMoveUndone:
    case RefineEvent.DocReshaped:
    case RefineEvent.DocReshapeUndone:
      return 'documents edited';
    default:
      return null;
  }
}
