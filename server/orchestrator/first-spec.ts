import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Exec } from '../exec/command.js';
import { fetch as gitFetch, git } from '../git/git.js';

/** What a project holds before any code task has merged: the docs and the rendered workflows. */
const DOCS_ONLY = new Set(['docs', '.github']);

/**
 * Is this the spec that scaffolds the project? A lone spec directory always is. With several (a draft carries every spec
 * of main, a backlog carries its planned ones) it is the first only while main still holds nothing but docs and
 * workflows: counting directories would forbid the scaffold task on a first run that sits beside other spec directories.
 */
export async function isFirstSpec(opts: { specDirs: readonly string[]; specId: string; repo: string; exec: Exec }): Promise<boolean> {
  if (opts.specDirs.length === 1) return true;
  if (!(await fs.access(path.join(opts.repo, '.git')).then(() => true, () => false))) return true;
  await gitFetch(opts.repo, opts.exec).catch(() => undefined);
  const top = await git(opts.repo, ['ls-tree', '--name-only', 'origin/main'], opts.exec).catch(() => null);
  if (top === null) return true;
  return top.split('\n').filter((f) => f !== '').every((f) => DOCS_ONLY.has(f));
}
