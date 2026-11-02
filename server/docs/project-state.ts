import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { updateFileAtomic, writeFileAtomic } from '../core/atomic-write.js';
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

/** The detached copy of the documents a draft closed with, which the agents read. */
export const docsSnapshotDir = (ws: Pick<Workspace, 'root'>, draftId: string): string => path.posix.join(ws.root, 'docs-at', draftId);

/** The record of a draft's closing commit and the tags still to create. */
export const docsClosingPath = (ws: Pick<Workspace, 'root'>, draftId: string): string => path.posix.join(ws.root, 'state', 'closing', `${draftId}.json`);

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

/** Whether the project is bound to a documentation repository, so its machine files live in the mirror. */
export const isDocsRepo = async (ws: Pick<Workspace, 'root'>): Promise<boolean> => (await readDocsMarker(ws)) !== null;

/** The design document of a documentation snapshot, or null when the snapshot has none. */
export const snapshotDesign = (root: string): Promise<string | null> => fs.readFile(path.join(root, 'docs', 'design.md'), 'utf8').catch(() => null);

export async function writeDocsMarker(ws: Pick<Workspace, 'root'>, marker: DocsMarker): Promise<void> {
  const file = docsMarkerPath(ws);
  await fs.mkdir(path.posix.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(DocsMarker.parse(marker), null, 2)}\n`);
}

const statePath = (ws: Pick<Workspace, 'root'>, rel: string): string => path.posix.join(docsMirrorDir(ws), rel);

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** The parsed content, or undefined when the text is missing or is not JSON. */
function parseState(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A machine file of the mirror, parsed; undefined when it is missing or not JSON. */
export async function readState(ws: Pick<Workspace, 'root'>, rel: string): Promise<unknown> {
  return parseState(await readText(statePath(ws, rel)));
}

/** The names of the entries of a folder of the mirror; none when the folder is missing. */
export const listState = (ws: Pick<Workspace, 'root'>, rel: string): Promise<string[]> => fs.readdir(statePath(ws, rel)).catch(() => []);

export async function writeState(ws: Pick<Workspace, 'root'>, rel: string, text: string): Promise<void> {
  const file = statePath(ws, rel);
  await fs.mkdir(path.posix.dirname(file), { recursive: true });
  await writeFileAtomic(file, text);
}

/** Rewrites a machine file of the mirror from its parsed content; returning undefined leaves it alone. A missing or unparsable file is an error. */
export async function updateState(ws: Pick<Workspace, 'root'>, rel: string, update: (current: unknown) => string | undefined): Promise<void> {
  const file = statePath(ws, rel);
  await fs.mkdir(path.posix.dirname(file), { recursive: true });
  await updateFileAtomic(file, (text) => {
    if (text === undefined) throw new Error(`the mirror has no ${rel}`);
    return update(JSON.parse(text));
  });
}
