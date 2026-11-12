import { promises as fs } from 'node:fs';

/**
 * Rewrites a graph file in place with the graph `edit` returns, and returns how many edges it added. A file that cannot be read or
 * parsed, or an edit that adds none, leaves the file as it is.
 */
export async function editGraphFile<G extends { nodes?: unknown[]; links?: unknown[] }>(file: string, edit: (graph: G) => { graph: G; added: number }): Promise<number> {
  let graph: G;
  try {
    graph = JSON.parse(await fs.readFile(file, 'utf8')) as G;
  } catch {
    return 0;
  }
  const { graph: edited, added } = edit(graph);
  if (added === 0) return 0;
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(edited));
  await fs.rename(tmp, file);
  return added;
}
