import { applyRefineEvent } from '@server/refine/state';
import type { Snapshot, StoredEvent } from '../api.js';

export type LiveSnapshot = Snapshot & { docsDirty?: boolean };

/** The journal carries state, not document text: a patch edit, docs main brought in, an answer the orchestrator wrote or an evaluation ask the page to refetch. */
export function applyToSnapshot(snap: LiveSnapshot, e: StoredEvent): LiveSnapshot {
  const state = structuredClone(snap.state);
  applyRefineEvent(state as never, e);
  const dirty = snap.docsDirty === true || (e.type === 'DOC_EDITED' && (e.data.source === 'patch' || e.data.source === 'main' || e.data.source === 'decision')) || e.type === 'REFINE_EVALUATED';
  return { ...snap, state, docsDirty: dirty };
}
