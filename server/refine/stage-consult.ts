import { access } from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeIndex, type Hit } from '../knowledge/retrieval.js';
import type { DocFile } from './draft.js';

/** The excerpts one review of a part reads from the other documents. */
export const CONSULT_HITS = 8;
/** The graph notes one document adds to a review of a part, in estimated tokens. */
export const CONSULT_GRAPH_TOKENS = 1_500;
/** The longest excerpt shown; a longer one is cut and marked. */
const EXCERPT_CHARS = 2_000;

/** The Graphify notes of one graph folder for a question, as the packs read them. */
export type GraphNotes = (outDir: string, question: string, budgetTokens: number) => Promise<string>;

/** The graph folder of one document of the draft: the one its own extraction wrote. */
export const fileGraphDir = (root: string, doc: DocFile): string => path.posix.join(root, 'doc-graph', 'files', doc);

/** Graph notes only from a document whose graph was built: a document never graphed costs no call. */
export function builtGraphNotes(graph: GraphNotes): GraphNotes {
  return async (outDir, question, budgetTokens) => {
    const built = await access(path.posix.join(outDir, 'graphify-out', 'graph.json')).then(() => true, () => false);
    return built ? graph(outDir, question, budgetTokens) : '';
  };
}

/** The words of a part that recur most in it, as one question for the search and for the graph. */
export function questionOf(text: string, count = 30): string {
  const counts = new Map<string, number>();
  for (const word of text.toLocaleLowerCase().match(/\p{L}{4,}/gu) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, count).map(([word]) => word).join(' ');
}

const excerpt = (text: string): string => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()} […]` : text);

function formatConsult(hits: readonly Hit[], notes: ReadonlyArray<{ doc: DocFile; text: string }>): string {
  if (hits.length === 0 && notes.length === 0) return 'Nothing in these documents matches this part.';
  return [
    ...(hits.length > 0 ? ['#### Excerpts that match this part (by relevance)', ...hits.map((h) => `##### ${h.docId} › ${h.heading ?? 'start of the document'}\n${excerpt(h.text)}`)] : []),
    ...(notes.length > 0 ? ['#### Graph notes of these documents (Graphify)', ...notes.map((n) => `##### ${n.doc}\n${n.text}`)] : []),
  ].join('\n\n');
}

/** What one review of a part reads from the other documents: the excerpts that match the part, and each document's graph notes. */
export async function consultDocs(input: { docs: Record<DocFile, string>; consulted: readonly DocFile[]; part: string; graphDirOf: (doc: DocFile) => string; graphNotes?: GraphNotes }): Promise<string> {
  if (input.consulted.length === 0) return '';
  const question = questionOf(input.part);
  const index = KnowledgeIndex.open(':memory:');
  try {
    for (const doc of input.consulted) index.index({ id: doc, kind: 'other', title: doc, text: input.docs[doc] });
    const hits = index.search(question, { k: CONSULT_HITS });
    const graph = input.graphNotes;
    const notes = graph
      ? await Promise.all(input.consulted.map(async (doc) => ({ doc, text: await graph(input.graphDirOf(doc), question, CONSULT_GRAPH_TOKENS) })))
      : [];
    return formatConsult(hits, notes.filter((n) => n.text !== ''));
  } finally {
    index.close();
  }
}
