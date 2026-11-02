import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';
import { findCredential } from '../core/redact.js';
import { execCommand, type Exec } from '../exec/command.js';
import { git, headSha, pushMain, withRepoLock } from '../git/git.js';
import type { Workspace } from '../orchestrator/workspace.js';
import { isAllowedPath, type Style } from './layout.js';
import { docsStoreDir } from './project-state.js';

export class DocsStoreError extends Error {}

/** The clone of a project's documentation repository, owned by the store and never by the project's own clone. */
export interface Store {
  dir: string;
  style: Style;
  exec: Exec;
}

/** One commit of the store: the files of a draft, projected onto the allowlist. */
export interface Projection {
  draftId: string;
  stepKey: string;
  scope: string;
  label: string;
  files: Record<string, string>;
  /** The copy each document held when the draft started; a missing key means the document did not exist. */
  bases?: Record<string, string>;
  /** Aliases that have started or been delivered: never written again. */
  frozen?: readonly string[];
  /** Aliases to delete; only the ones this draft owns are removed. */
  retire?: readonly string[];
  /** Known secret values of the platform and the project. */
  known?: readonly string[];
  /** Allows an empty commit at a milestone. */
  milestone?: boolean;
}

export interface ProjectedFile {
  path: string;
  text: string;
}

const NETWORK_MS = 30_000;
const MAX_FILE_BYTES = 1024 * 1024;
const LOCK_STALE_MS = 60_000;
const PUSH_TRIES = 5;

export const storeOf = (ws: Pick<Workspace, 'root'>, style: Style, exec: Exec = execCommand): Store => ({ dir: docsStoreDir(ws), style, exec });

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

/** Finishes a rebase or a merge that a crash left in progress. */
async function abortUnfinished(store: Store): Promise<void> {
  const gitDir = path.join(store.dir, '.git');
  if ((await exists(path.join(gitDir, 'rebase-merge'))) || (await exists(path.join(gitDir, 'rebase-apply')))) {
    await git(store.dir, ['rebase', '--abort'], store.exec);
  }
  if (await exists(path.join(gitDir, 'MERGE_HEAD'))) await git(store.dir, ['merge', '--abort'], store.exec);
}

/** Drops an index lock that outlived a crash; a recent one may belong to a live process. */
async function removeStaleLock(gitDir: string): Promise<void> {
  const lock = path.join(gitDir, 'index.lock');
  const stat = await fs.stat(lock).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { force: true });
}

/** Ignores the temporary files of atomic writes, in this clone only. */
async function excludeTmpFiles(gitDir: string): Promise<void> {
  const file = path.join(gitDir, 'info', 'exclude');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (text.split('\n').includes('*.tmp')) return;
  await fs.writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}*.tmp\n`);
}

/** Brings an existing store back to a clean state under its repository lock. */
export async function heal(store: Store): Promise<void> {
  await withRepoLock(store.dir, async () => {
    await abortUnfinished(store);
    await removeStaleLock(path.join(store.dir, '.git'));
    await git(store.dir, ['reset', '-q'], store.exec);
    await excludeTmpFiles(path.join(store.dir, '.git'));
  });
}

/** Opens an existing store after healing it. */
export async function openStore(ws: Pick<Workspace, 'root'>, style: Style, exec: Exec = execCommand): Promise<Store> {
  const store = storeOf(ws, style, exec);
  await heal(store);
  return store;
}

/** The files of a projection; refused whole, before any write, when one is not a document path or is above 1 MiB. */
export function projectFiles(style: Style, files: Record<string, string>): ProjectedFile[] {
  const entries = Object.entries(files).map(([file, text]) => ({ path: file, text }));
  const refused = entries.filter((f) => !isAllowedPath(style, f.path)).map((f) => f.path);
  if (refused.length > 0) throw new DocsStoreError(`not a document path: ${refused.join(', ')}`);
  const large = entries.filter((f) => Buffer.byteLength(f.text) > MAX_FILE_BYTES).map((f) => f.path);
  if (large.length > 0) throw new DocsStoreError(`document above 1 MiB: ${large.join(', ')}`);
  return entries;
}

/** Refuses the whole commit when a file holds a credential; the error names the document, never the value. */
function assertNoSecrets(files: ProjectedFile[], known: readonly string[]): void {
  for (const f of files) {
    const hit = findCredential(f.text, known);
    if (hit) throw new DocsStoreError(`${f.path} holds a credential (${hit.kind}); nothing was committed`);
  }
}

/** Writes the files atomically and stages exactly those paths. */
async function stageFiles(store: Store, files: ProjectedFile[]): Promise<void> {
  for (const f of files) {
    const file = path.join(store.dir, f.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, f.text);
  }
  if (files.length > 0) await git(store.dir, ['add', '-f', '--', ...files.map((f) => f.path)], store.exec);
}

/** Refuses a staged path outside the allowlist or a link, and clears the index so nothing reaches a commit. */
async function verifyStaged(store: Store): Promise<void> {
  const raw = await git(store.dir, ['diff', '--cached', '--raw'], store.exec);
  const staged = raw.split('\n').filter((line) => line !== '').map((line) => {
    const [meta, file] = line.split('\t');
    return { mode: meta!.split(' ')[1], path: file! };
  });
  const bad = staged.filter((e) => !isAllowedPath(store.style, e.path) || e.mode === '120000');
  if (bad.length === 0) return;
  await git(store.dir, ['reset', '-q'], store.exec);
  throw new DocsStoreError(`refused to commit ${bad.map((e) => e.path).join(', ')}: not a document path or a link`);
}

/** Commits what is staged; an empty diff makes no commit unless the caller marks a milestone. */
async function commitStaged(store: Store, p: Projection): Promise<string | null> {
  const staged = await git(store.dir, ['diff', '--cached', '--name-only'], store.exec);
  if (staged === '' && !p.milestone) return null;
  const message = `docs(${p.scope}): ${p.label} [skip ci]\n\nRefine-Draft: ${p.draftId}\nStep: ${p.stepKey}`;
  await git(store.dir, ['commit', '-q', ...(staged === '' ? ['--allow-empty'] : []), '-m', message], store.exec);
  return headSha(store.dir, store.exec);
}

/** Projects the files onto the store and commits them; nothing is written unless every check passes. */
export async function commitProjection(store: Store, p: Projection): Promise<{ sha: string | null }> {
  const files = projectFiles(store.style, p.files);
  assertNoSecrets(files, p.known ?? []);
  return withRepoLock(store.dir, async () => {
    await stageFiles(store, files);
    await verifyStaged(store);
    return { sha: await commitStaged(store, p) };
  });
}

export type PushFailure = 'busy' | 'protected' | 'auth' | 'offline' | 'other';
export type PushOutcome = { ok: true; sha: string } | { ok: false; kind: PushFailure; message: string };

const MESSAGES: Record<PushFailure, string> = {
  busy: 'Another change reached main first. The documents must be published again.',
  protected: 'The main branch refuses direct pushes, so the documents were not published.',
  auth: 'GitHub refused the token, so the documents were not published.',
  offline: 'GitHub could not be reached, so the documents were not published. They stay in the local store.',
  other: 'The documents could not be published.',
};

const failure = (kind: PushFailure): PushOutcome => ({ ok: false, kind, message: MESSAGES[kind] });

/** Network calls get a shorter limit than local git. */
const networkExec = (exec: Exec): Exec => (spec) => exec({ ...spec, timeoutMs: NETWORK_MS });

const pause = (attempt: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.random() * 150 * attempt));

/** Replays the local commits on origin main; a conflict aborts the replay and returns false. */
function replayOnOrigin(store: Store): Promise<boolean> {
  return withRepoLock(store.dir, async () => {
    try {
      await git(store.dir, ['rebase', 'origin/main'], store.exec);
      return true;
    } catch {
      await git(store.dir, ['rebase', '--abort'], store.exec).catch(() => undefined);
      return false;
    }
  });
}

/** Drops the local commits for origin main and reports busy, so the caller projects the drafts again. */
async function resetAndBusy(store: Store): Promise<PushOutcome> {
  await withRepoLock(store.dir, () => git(store.dir, ['reset', '-q', '--hard', 'origin/main'], store.exec));
  return failure('busy');
}

/** Pushes the local main without force; a rejection by origin main fetches, replays and pushes again, at most five times. */
export async function pushWithRecovery(store: Store): Promise<PushOutcome> {
  const net = networkExec(store.exec);
  for (let attempt = 1; attempt <= PUSH_TRIES; attempt++) {
    const sha = await withRepoLock(store.dir, () => headSha(store.dir, store.exec));
    const r = await pushMain(store.dir, sha, net);
    if (r.ok) return { ok: true, sha };
    if (r.kind !== 'non-fast-forward') return failure(r.kind);
    if (!(await git(store.dir, ['fetch', '-q', '--prune', 'origin'], net).then(() => true, () => false))) return failure('other');
    if (!(await replayOnOrigin(store))) return resetAndBusy(store);
    await pause(attempt);
  }
  return resetAndBusy(store);
}
