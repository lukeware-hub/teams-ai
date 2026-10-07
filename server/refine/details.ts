import type { BACKLOG_DOCS, BacklogItem } from '../contracts/backlog.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import type { SpecProvenance } from '../contracts/spec.js';
import { sectionText } from './sections.js';

/** The target project's five docs by the names backlog items cite them with. */
export type BacklogDocs = Record<(typeof BACKLOG_DOCS)[number], string>;

/** Bumped when what goes into a hash changes, so every item is re-derived once. */
const HASH_VERSION = 2;

const cited = (item: Pick<BacklogItem, 'sources'>, docs: BacklogDocs) => item.sources.map((s) => ({ doc: s.doc, heading: s.heading, text: sectionText(docs[s.doc], s.heading) }));

/**
 * What a spec is derived from: the item itself and the text of every section it cites. The briefing and project.md
 * enter only through cited sections; hashing them whole would re-derive every spec on almost every accepted patch.
 */
export function specInputHash(item: BacklogItem, docs: BacklogDocs): string {
  return sha256(canonicalJson({ v: HASH_VERSION, key: item.key, title: item.title, scope: item.scope, dependsOn: item.dependsOn, sources: cited(item, docs) }));
}

/** What a pre-plan is derived from: the spec it plans (by hash), stack.md, and whether the item carries the scaffold. */
export function preplanInputHash(item: Pick<BacklogItem, 'key' | 'title' | 'dependsOn'>, specRev: string, stackMd: string, first: boolean): string {
  return sha256(canonicalJson({ v: HASH_VERSION, key: item.key, title: item.title, dependsOn: item.dependsOn, specRev, stack: stackMd, first }));
}

/** Each cited section with the hash of its text, for the spec's provenance; null when the heading is not in the doc. */
export function sourceHashes(item: Pick<BacklogItem, 'sources'>, docs: BacklogDocs): SpecProvenance['sources'] {
  return cited(item, docs).map(({ doc, heading, text }) => ({ doc, heading, hash: text === null ? null : sha256(text) }));
}

/** Items to (re)derive, grouped by epic in rank order, at most `size` per agent call. */
export function batches<T extends { epic: string; rank: number }>(items: readonly T[], size = 3): T[][] {
  const byEpic = new Map<string, T[]>();
  for (const i of [...items].sort((a, b) => a.rank - b.rank)) byEpic.set(i.epic, [...(byEpic.get(i.epic) ?? []), i]);
  const out: T[][] = [];
  for (const group of byEpic.values()) for (let n = 0; n < group.length; n += size) out.push(group.slice(n, n + size));
  return out;
}
