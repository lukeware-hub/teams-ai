import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { KnowledgeIndex, type DocKind } from './retrieval.js';

/** Opens the project's knowledge index and fills it with the Markdown documents under its docs folder. */
export async function openProjectKnowledge(file: string | ':memory:', repoDir: string): Promise<KnowledgeIndex> {
  const index = KnowledgeIndex.open(file);
  const onDisk = new Set<string>();
  for (const abs of await markdownFiles(path.join(repoDir, 'docs'))) {
    const id = path.relative(repoDir, abs).split(path.sep).join('/');
    onDisk.add(id);
    index.index({ id, kind: kindOf(id), title: path.basename(abs, '.md'), text: await fs.readFile(abs, 'utf8'), specId: specIdOf(id) });
  }
  for (const id of index.documentIds()) if (id.startsWith('docs/') && !onDisk.has(id)) index.removeDocument(id);
  return index;
}

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? markdownFiles(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : [])));
  return nested.flat();
}

const kindOf = (id: string): DocKind => (id.includes('/specs/') ? 'spec' : id.includes('/adr/') ? 'adr' : 'other');

const specIdOf = (id: string): string | undefined => /^docs\/specs\/([^/]+)\//.exec(id)?.[1];
