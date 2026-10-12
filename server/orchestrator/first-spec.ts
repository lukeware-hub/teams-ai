import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Exec } from '../exec/command.js';
import { fetch as gitFetch, git } from '../git/git.js';

/** What a repository holds before any code task has merged: the docs, the rendered workflows and what GitHub adds to a new one. */
const DOCS_ONLY = /^(docs|\.github|README(\.\w+)?|LICENSE(\.\w+)?|\.gitignore|\.gitattributes)$/;

/**
 * Is this the spec that scaffolds the project? A lone spec directory always is. With several (a draft carries every spec
 * of main, a backlog carries its planned ones) it is the first only while main still holds nothing but docs and
 * workflows: counting directories would forbid the scaffold task on a first run that sits beside other spec directories.
 */
export async function isFirstSpec(opts: { specDirs: readonly string[]; specId: string; repo: string; exec: Exec }): Promise<boolean> {
  return opts.specDirs.length === 1 || holdsOnlyDocs(opts.repo, opts.exec);
}

/** Does origin/main hold nothing but docs and workflows: a project, or a service, before its first code? */
export async function holdsOnlyDocs(repo: string, exec: Exec): Promise<boolean> {
  if (!(await fs.access(path.join(repo, '.git')).then(() => true, () => false))) return true;
  await gitFetch(repo, exec).catch(() => undefined);
  const top = await git(repo, ['ls-tree', '--name-only', 'origin/main'], exec).catch(() => null);
  if (top === null) return true;
  return top.split('\n').filter((f) => f !== '').every((f) => DOCS_ONLY.test(f));
}
