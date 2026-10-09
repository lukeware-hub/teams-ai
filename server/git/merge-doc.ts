import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execCommand, type Exec } from '../exec/command.js';
import { GitError } from './git.js';

/**
 * Three-way merge of one doc that both main and a draft changed since the draft's base copy. It never stops:
 * text merges as git does and keeps both sides of an edit to the same lines; JSON merges field by field.
 */
export async function mergeDoc(rel: string, base: string, main: string, draft: string, exec: Exec = execCommand): Promise<string> {
  if (rel.endsWith('.json')) {
    const parsed = [base, main, draft].map(parseJson);
    if (parsed.every((v) => v !== undefined)) return `${JSON.stringify(mergeJson(parsed[0], parsed[1], parsed[2]), null, 2)}\n`;
  }
  return mergeText(base, main, draft, exec);
}

/** Trailing whitespace is not a change: older base copies lost the final newline main keeps. */
export const sameDoc = (a: string | null, b: string | null): boolean => a?.trimEnd() === b?.trimEnd();

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Each side keeps its own changes, lists are joined, and the draft wins a value both sides changed. */
function mergeJson(base: unknown, main: unknown, draft: unknown): unknown {
  if (isDeepStrictEqual(draft, base)) return main;
  if (isDeepStrictEqual(main, base) || isDeepStrictEqual(main, draft)) return draft;
  if (Array.isArray(main) && Array.isArray(draft)) return [...main, ...draft.filter((x) => !main.some((m) => isDeepStrictEqual(m, x)))];
  if (isObject(main) && isObject(draft)) {
    const from = isObject(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(main), ...Object.keys(draft)])) {
      const value = mergeJson(from[key], main[key], draft[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  return draft;
}

/** `git merge-file --union`: overlapping edits keep both sides instead of conflict markers. */
async function mergeText(base: string, main: string, draft: string, exec: Exec): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-merge-'));
  try {
    const [b, m, d] = ['base', 'main', 'draft'].map((n) => path.join(dir, n));
    await Promise.all([fs.writeFile(b!, base), fs.writeFile(m!, main), fs.writeFile(d!, draft)]);
    const r = await exec({ bin: 'git', args: ['merge-file', '-p', '--union', m!, b!, d!], cwd: dir, timeoutMs: 30_000 });
    if (r.exitCode !== 0) throw new GitError(`git merge-file failed (${r.exitCode}): ${r.stderr.trim()}`);
    return r.stdout;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
