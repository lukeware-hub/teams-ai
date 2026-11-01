import { SAFE_ID } from '../api/run-index.js';
import { BACKLOG_DOCS } from '../contracts/backlog.js';
import { git as runGit, showFile } from './git.js';

/** One project document as origin/main has it; `text` is null when main does not have it. */
export interface MainDoc {
  file: string;
  text: string | null;
}

/** The paths among `paths` that origin/main has; a git failure is raised, never read as a missing file. */
async function mainPaths(repo: string, paths: string[]): Promise<Set<string>> {
  const listed = await runGit(repo, ['ls-tree', '--name-only', 'origin/main', ...paths]);
  return new Set(listed.split('\n').filter(Boolean));
}

/** Where a project document sits on main: the briefing at the root, else the newest spec's when only that one exists. */
function docPath(file: string, present: ReadonlySet<string>, specBriefing: string | null): string {
  if (file !== 'briefing.md' || present.has('docs/briefing.md') || specBriefing === null || !present.has(specBriefing)) return `docs/${file}`;
  return specBriefing;
}

/** The five project documents as origin/main has them. `newestSpec` supplies the briefing when main has no root briefing. */
export async function readMainDocs(repo: string, newestSpec: string | undefined): Promise<MainDoc[]> {
  const specBriefing = newestSpec !== undefined && SAFE_ID.test(newestSpec) ? `docs/specs/${newestSpec}/briefing.md` : null;
  const present = await mainPaths(repo, [...BACKLOG_DOCS.map((file) => `docs/${file}`), ...(specBriefing ? [specBriefing] : [])]);
  return Promise.all(BACKLOG_DOCS.map(async (file) => {
    const at = docPath(file, present, specBriefing);
    return { file, text: present.has(at) ? await showFile(repo, 'origin/main', at) : null };
  }));
}
