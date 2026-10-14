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

const plain = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const words = (text: string): string[] => [...new Set(plain(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4))];

/**
 * The older messages that share the most words with the question, best first: the chat remembers more than the last few
 * messages without a search step (each tool call re-reads the whole prompt). A message must share at least two words.
 */
export function relatedMessages(history: readonly ChatMessage[], question: string, limit = 3): ChatMessage[] {
  const wanted = words(question);
  return history
    .map((message) => ({ message, hits: words(message.text).filter((w) => wanted.includes(w)).length }))
    .filter((m) => m.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((m) => m.message);
}

/** Puts the guide and its graph in the step's working directory, the only place it can read. */
export async function stageChatFiles(cwd: string, guideDir: string): Promise<void> {
  await fs.mkdir(path.join(cwd, 'guia'), { recursive: true });
  for (const name of (await fs.readdir(guideDir)).filter((n) => n.endsWith('.md'))) await fs.copyFile(path.join(guideDir, name), path.join(cwd, 'guia', name));
  await fs.mkdir(path.join(cwd, 'graphify-out'), { recursive: true });
  // Without the graph the chat still has the files to read and search.
  await fs.copyFile(path.join(guideDir, GUIDE_GRAPH), path.join(cwd, GUIDE_GRAPH)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}
