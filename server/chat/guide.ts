import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from './store.js';

/** Where the committed graph of the guide lives, inside the guide folder; the chat step finds it at the same relative path. */
export const GUIDE_GRAPH = path.join('graphify-out', 'graph.json');
export const GUIDE_HASH = path.join('graphify-out', 'guia.hash');

/** Hash of the guide's Markdown files; the committed graph records it, so a graph older than the guide is caught by a test. */
export async function guideHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort()) hash.update(`${name}\n${await fs.readFile(path.join(dir, name), 'utf8')}\n`);
  return hash.digest('hex');
}

/** The conversation as text the step can search with Grep. */
export function historyMarkdown(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) return '(sem conversas anteriores)\n';
  return messages.map((m) => `## ${m.role === 'user' ? 'Pergunta' : 'Resposta'} (${m.at.slice(0, 10)})\n${m.text}\n`).join('\n');
}

/** Puts the guide, its graph and the conversation in the step's working directory, the only place it can read. */
export async function stageChatFiles(cwd: string, guideDir: string, history: readonly ChatMessage[]): Promise<void> {
  await fs.mkdir(path.join(cwd, 'guia'), { recursive: true });
  for (const name of (await fs.readdir(guideDir)).filter((n) => n.endsWith('.md'))) await fs.copyFile(path.join(guideDir, name), path.join(cwd, 'guia', name));
  await fs.mkdir(path.join(cwd, 'graphify-out'), { recursive: true });
  // Without the graph the chat still has the files to read and search.
  await fs.copyFile(path.join(guideDir, GUIDE_GRAPH), path.join(cwd, GUIDE_GRAPH)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await fs.writeFile(path.join(cwd, 'historico.md'), historyMarkdown(history));
}
