import type { BacklogState } from './state.js';

/** The spec a backlog item becomes: named after the draft and the item's stable key. */
export const specIdOf = (draftId: string, key: string): string => `${draftId}-${key}`;

export interface SpecsIndexEntry {
  specId: string;
  key: string;
  title: string;
  epic: string;
  priority: BacklogState['items'][number]['priority'];
  rank: number;
  size: BacklogState['items'][number]['size'];
  scope: string;
  rationale: string;
  dependsOn: string[];
  sources: BacklogState['items'][number]['sources'];
}

/** The ordered list of specs the agents will work through: structure only, no status, hash, run or PR. */
export interface SpecsIndex {
  version: 1;
  draftId: string;
  epics: BacklogState['epics'];
  specs: SpecsIndexEntry[];
}

/** Generated from the derived backlog (browser-safe: the page builds the same file it offers for download). */
export function buildSpecsIndex(draftId: string, backlog: Pick<BacklogState, 'epics' | 'items'>): SpecsIndex {
  const specs = [...backlog.items]
    .sort((a, b) => a.rank - b.rank)
    .map((i) => ({
      specId: specIdOf(draftId, i.key),
      key: i.key,
      title: i.title,
      epic: i.epic,
      priority: i.priority,
      rank: i.rank,
      size: i.size,
      scope: i.scope,
      rationale: i.rationale,
      dependsOn: i.dependsOn.map((d) => specIdOf(draftId, d)),
      sources: i.sources,
    }));
  return { version: 1, draftId, epics: backlog.epics, specs };
}
