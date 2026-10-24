import { applyRefineEvent } from '@server/refine/state';
import type { Snapshot, StoredEvent } from '../api.js';

export type LiveSnapshot = Snapshot & { docsDirty?: boolean };

/** The journal carries state, not document text: a patch edit, docs main brought in, an answer the orchestrator wrote or an evaluation ask the page to refetch. */
export function applyBatch(snap: LiveSnapshot, events: StoredEvent[]): LiveSnapshot {
  const state = structuredClone(snap.state);
  let docsDirty = snap.docsDirty === true;
  for (const e of events) {
    applyRefineEvent(state as never, e);
    // An edit the owner made in this page is already on screen; every other edit changed a document the page must read again.
    if (e.type === 'REFINE_EVALUATED' || (e.type === 'DOC_EDITED' && e.data.source !== 'human')) docsDirty = true;
  }
  return { ...snap, state, docsDirty };
}

export function applyToSnapshot(snap: LiveSnapshot, e: StoredEvent): LiveSnapshot {
  return applyBatch(snap, [e]);
}
