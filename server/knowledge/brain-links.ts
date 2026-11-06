import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrainLink } from './brain-notes.js';

interface RawNode {
  id: string;
  label?: string;
  source_file?: string;
}

interface RawLink {
  source: string;
  target: string;
  relation?: string;
}

interface RawGraph {
  nodes?: RawNode[];
  links?: RawLink[];
}

/** The most file nodes one named path may link to; the same path in several repositories is rare, and a long list is a guess. */
const MAX_FILE_MATCHES = 3;

/**
 * Adds a `references` edge from each task heading of the notes to the file nodes of the paths the task names. graphify links a note to
 * code only when both are extracted together, which the notes are not (the code graphs already exist), so the links are made here.
 * A file node is the one whose source file is the path and whose label ends with the file name; a path with no node adds nothing.
 */
export function linkBrain<G extends RawGraph>(graph: G, wanted: readonly BrainLink[]): { graph: G; added: number } {
  const nodes = graph.nodes ?? [];
  const links = [...(graph.links ?? [])];
  const seen = new Set(links.map((l) => `${l.source}|${l.target}|${l.relation ?? ''}`));
  const byFile = new Map<string, RawNode[]>();
  for (const n of nodes) if (n.source_file) byFile.set(n.source_file, [...(byFile.get(n.source_file) ?? []), n]);
  let added = 0;
  for (const want of wanted) {
    const heading = (byFile.get(want.noteFile) ?? []).find((n) => n.label === want.heading);
    if (!heading) continue;
    const name = path.posix.basename(want.path);
    const files = (byFile.get(want.path) ?? []).filter((n) => (n.label ?? '').endsWith(name)).slice(0, MAX_FILE_MATCHES);
    for (const file of files) {
      const key = `${heading.id}|${file.id}|references`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: heading.id, target: file.id, relation: 'references', confidence: 'INFERRED', weight: 1, source_file: want.noteFile, _origin: 'brain' } as RawLink);
      added += 1;
    }
  }
  return { graph: { ...graph, links }, added };
}

/** Adds the links to the graph file in place; a file that cannot be read or parsed is left as it is. */
export async function linkBrainFile(graphFile: string, wanted: readonly BrainLink[]): Promise<number> {
  if (wanted.length === 0) return 0;
  let graph: RawGraph;
  try {
    graph = JSON.parse(await fs.readFile(graphFile, 'utf8')) as RawGraph;
  } catch {
    return 0;
  }
  const { graph: linked, added } = linkBrain(graph, wanted);
  if (added === 0) return 0;
  const tmp = `${graphFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(linked));
  await fs.rename(tmp, graphFile);
  return added;
}
