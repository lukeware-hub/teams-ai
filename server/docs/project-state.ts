import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../core/atomic-write.js';
import type { Workspace } from '../orchestrator/workspace.js';

/** The environment switch of the documentation repository layout: on only when it is set to 1. */
export const DOCS_REPO_LAYOUT_ENV = 'TEAMS_AI_DOCS_REPO_LAYOUT';

export const docsRepoLayoutEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[DOCS_REPO_LAYOUT_ENV] === '1';

/** The clone of the documentation repository, kept apart from the project's own clone. */
export const docsStoreDir = (ws: Pick<Workspace, 'root'>): string => path.posix.join(ws.root, 'docs-store');

/** The machine files of a docs-repo project, under their legacy relative paths. */
export const docsMirrorDir = (ws: Pick<Workspace, 'root'>): string => path.posix.join(ws.root, 'state', 'docs');

/** The record that binds a project to its documentation repository. */
export const docsMarkerPath = (ws: Pick<Workspace, 'root'>): string => path.posix.join(ws.root, 'state', 'docs-store.json');

/** The folder that holds every draft's detached copy of the documents. */
export const docsSnapshotRoot = (ws: Pick<Workspace, 'root'>): string => path.posix.join(ws.root, 'docs-at');

/** The detached copy of the documents a draft closed with, which the agents read. */
export const docsSnapshotDir = (ws: Pick<Workspace, 'root'>, draftId: string): string => path.posix.join(docsSnapshotRoot(ws), draftId);

/** The folder that holds every draft's closing record. */
export const docsClosingRoot = (ws: Pick<Workspace, 'root'>): string => path.posix.join(ws.root, 'state', 'closing');

/** The record of a draft's closing commit and the tags still to create. */
export const docsClosingPath = (ws: Pick<Workspace, 'root'>, draftId: string): string => path.posix.join(docsClosingRoot(ws), `${draftId}.json`);

export const DocsMarker = z.object({
  layout: z.literal('docs-repo'),
  style: z.enum(['monolith', 'microservices']),
  target: z.object({ owner: z.string().min(1), name: z.string().min(1) }),
  firstSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
});
export type DocsMarker = z.infer<typeof DocsMarker>;

/** The marker of a bound project, or null when the project has none. A marker that cannot be read is an error. */
export async function readDocsMarker(ws: Pick<Workspace, 'root'>): Promise<DocsMarker | null> {
  let text: string;
  try {
    text = await fs.readFile(docsMarkerPath(ws), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return DocsMarker.parse(JSON.parse(text));
}

export async function writeDocsMarker(ws: Pick<Workspace, 'root'>, marker: DocsMarker): Promise<void> {
  const file = docsMarkerPath(ws);
  await fs.mkdir(path.posix.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(DocsMarker.parse(marker), null, 2)}\n`);
}
