import { SAFE_ID } from '../api/run-index.js';
import { BACKLOG_DOCS } from '../contracts/backlog.js';
import { execCommand } from '../exec/command.js';
import { docsStoreDir, isDocsRepo } from '../docs/project-state.js';
import type { Workspace } from '../orchestrator/workspace.js';
import { fetch as gitFetch, git as runGit, showFile } from './git.js';

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

/** The project's five documents: from the documentation store when the project is docs-repo, else from origin/main of its repository. */
export async function readProjectDocs(ws: Pick<Workspace, 'root' | 'repo'>, newestSpec: string | undefined): Promise<MainDoc[]> {
  if (!(await isDocsRepo(ws))) return readMainDocs(ws.repo, newestSpec);
  const store = docsStoreDir(ws);
  // A failed fetch keeps the last copy of main, so the documents still show.
  await gitFetch(store, execCommand, { timeoutMs: 30_000 }).catch(() => undefined);
  return readMainDocs(store, undefined);
}

/** The spec, plan and task files of every spec: docs/specs/<alias>/ in the legacy layout, docs/**\/specify/<alias>/ in a documentation repository. */
const SPEC_FILE = /^docs\/(?:.+\/)?(?:specs|specify)\/[^/]+\/(?:spec|plan|implementation-plan|task)\.md$/;

/** At most this many spec files go into the graph, so a project with dozens of specs keeps a build that finishes. */
const MAX_SPEC_FILES = 300;

/** The specs, plans and tasks of the project as origin/main has them, for the graph a new request is consulted against; none when main has none or cannot be read. */
export async function readSpecFiles(ws: Pick<Workspace, 'root' | 'repo'>): Promise<MainDoc[]> {
  const dir = (await isDocsRepo(ws)) ? docsStoreDir(ws) : ws.repo;
  const listed = await runGit(dir, ['ls-tree', '-r', '--name-only', 'origin/main', 'docs']).catch(() => '');
  const paths = listed.split('\n').filter((p) => SPEC_FILE.test(p)).slice(0, MAX_SPEC_FILES);
  return Promise.all(paths.map(async (file) => ({ file, text: await showFile(dir, 'origin/main', file).catch(() => null) })));
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
