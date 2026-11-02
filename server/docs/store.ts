import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';
import { findCredential } from '../core/redact.js';
import { execCommand, type Exec } from '../exec/command.js';
import { createAnnotatedTag, git, headSha, isAncestor, pushMain, pushTags, remoteTagTarget, showFile, withRepoLock } from '../git/git.js';
import { createPrivateRepo, repoInfo, type RepoInfo } from '../git/github.js';
import type { Workspace } from '../orchestrator/workspace.js';
import { FIVE_DOC_PATHS, isAliasFolder, isAllowedPath, parseRepoPath, startTagOf, type RepoTarget, type Style } from './layout.js';
import {
  docsClosingRoot,
  docsMarkerPath,
  docsMirrorDir,
  docsSnapshotDir,
  docsSnapshotRoot,
  docsStoreDir,
  draftFolderName,
  readDocsMarker,
  removeDocsMarker,
  writeClosingRecord,
  writeDocsMarker,
  type DocsMarker,
} from './project-state.js';

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
  /** Alias folders of specs to delete, by their repository path; only the ones this draft owns are removed. */
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

/** What a projection did: the commit (null for an empty diff) and what the store refused to take. */
export interface FlushResult {
  sha: string | null;
  diverged: string[];
  aliasTaken: string[];
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
  await writeFileAtomic(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}*.tmp\n`);
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

/** The facts one projection reads from the store: its HEAD, read once, and the draft it works for. */
interface Ctx {
  store: Store;
  draftId: string;
  born: boolean;
}

async function hasHead(store: Store): Promise<boolean> {
  return git(store.dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], store.exec).then(() => true, () => false);
}

/** The text a file holds at HEAD, or null when HEAD does not have it. */
async function textAtHead(store: Store, rel: string): Promise<string | null> {
  const listed = await git(store.dir, ['ls-tree', 'HEAD', '--', rel], store.exec);
  return listed === '' ? null : showFile(store.dir, 'HEAD', rel, store.exec);
}

async function headText(c: Ctx, rel: string): Promise<string | null> {
  return c.born ? textAtHead(c.store, rel) : null;
}

/** The spec files at the store's HEAD, by repository path. */
async function specFilesAtHead(store: Store): Promise<string[]> {
  if (!(await hasHead(store))) return [];
  const paths = (await git(store.dir, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs'], store.exec)).split('\n');
  return paths.filter((p) => parseRepoPath(p) !== null);
}

/** The aliases that have a spec file at the store's HEAD: every spec folder the documentation repository holds. */
export async function aliasesOnStore(store: Store): Promise<string[]> {
  return [...new Set((await specFilesAtHead(store)).map((p) => parseRepoPath(p)!))];
}

/** The alias folders whose last commit this draft made, except the aliases in `keep`: the only folders it may remove. */
async function ownedAliasFolders(store: Store, draftId: string, keep: readonly string[]): Promise<string[]> {
  const c: Ctx = { store, draftId, born: true };
  const folders = [...new Set((await specFilesAtHead(store)).map((p) => path.posix.dirname(p)))];
  const owned: string[] = [];
  for (const folder of folders) if (!keep.includes(path.posix.basename(folder)) && (await aliasWritable(c, folder))) owned.push(folder);
  return owned;
}

/** Removes the alias folders a discarded draft committed; the five documents, other drafts' folders and the `keep` aliases stay. */
export async function retireAliases(store: Store, draftId: string, keep: readonly string[] = []): Promise<FlushResult> {
  const retire = await ownedAliasFolders(store, draftId, keep);
  return commitProjection(store, { draftId, stepKey: 'discard', scope: 'refine', label: 'draft discarded', files: {}, retire });
}

/** The text a file holds at the store's HEAD, or null when the store has no commit or the file. */
export async function readStoreText(store: Store, rel: string): Promise<string | null> {
  return (await hasHead(store)) ? textAtHead(store, rel) : null;
}

/** Whether a folder has any file at HEAD. */
async function folderAtHead(c: Ctx, folder: string): Promise<boolean> {
  if (!c.born) return false;
  return (await git(c.store.dir, ['ls-tree', '-r', '--name-only', 'HEAD', '--', folder], c.store.exec)) !== '';
}

interface Touch {
  sha: string;
  body: string;
}

/** The commits that touched a path, newest first, with their messages. */
async function commitsTouching(c: Ctx, rel: string): Promise<Touch[]> {
  if (!c.born) return [];
  const out = await git(c.store.dir, ['log', '--format=%H%x1f%B%x1e', '--', rel], c.store.exec);
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [sha, body = ''] = record.split('\x1f');
      return { sha: sha!, body };
    });
}

const trailerOf = (body: string, key: string): string | null => body.match(new RegExp(`^${key}: (\\S+)$`, 'm'))?.[1] ?? null;

/** A document may be written when the store still holds the copy the draft started from, or the copy this draft last committed. */
async function documentWritable(c: Ctx, rel: string, base: string | null): Promise<boolean> {
  const head = await headText(c, rel);
  if (head === base) return true;
  if (head === null) return false;
  const last = (await commitsTouching(c, rel)).find((t) => trailerOf(t.body, 'Refine-Draft') === c.draftId);
  return last !== undefined && head === (await showFile(c.store.dir, last.sha, rel, c.store.exec));
}

/** An alias folder may be written when it is absent, or its last commit belongs to this draft. */
async function aliasWritable(c: Ctx, folder: string): Promise<boolean> {
  if (!(await folderAtHead(c, folder))) return true;
  const last = (await commitsTouching(c, folder))[0];
  return last !== undefined && trailerOf(last.body, 'Refine-Draft') === c.draftId;
}

interface Decision {
  accepted: ProjectedFile[];
  retire: string[];
  diverged: string[];
  aliasTaken: string[];
}

/** Which files may be written and which folders may be retired, by the ownership rules. */
async function decide(c: Ctx, p: Projection, files: ProjectedFile[]): Promise<Decision> {
  const frozen = p.frozen ?? [];
  const decision: Decision = { accepted: [], retire: [], diverged: [], aliasTaken: [] };
  const folderOk = new Map<string, boolean>();
  const canWrite = async (folder: string): Promise<boolean> => {
    if (!folderOk.has(folder)) folderOk.set(folder, !frozen.includes(path.posix.basename(folder)) && (await aliasWritable(c, folder)));
    return folderOk.get(folder)!;
  };
  for (const f of files) {
    if (FIVE_DOC_PATHS.includes(f.path)) {
      if (await documentWritable(c, f.path, p.bases?.[f.path] ?? null)) decision.accepted.push(f);
      else decision.diverged.push(f.path);
    } else if (await canWrite(path.posix.dirname(f.path))) {
      decision.accepted.push(f);
    } else {
      decision.aliasTaken.push(path.posix.basename(path.posix.dirname(f.path)));
    }
  }
  for (const folder of p.retire ?? []) {
    if (!(await folderAtHead(c, folder))) continue;
    if (await canWrite(folder)) decision.retire.push(folder);
    else decision.aliasTaken.push(path.posix.basename(folder));
  }
  decision.aliasTaken = [...new Set(decision.aliasTaken)];
  return decision;
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

/** Deletes the folders this draft owns from the index and the working tree. */
async function removeFolders(store: Store, folders: readonly string[]): Promise<void> {
  if (folders.length > 0) await git(store.dir, ['rm', '-r', '-q', '--', ...folders], store.exec);
}

/** Refuses the whole flush when a folder to retire is not an alias folder, before anything is written. */
function assertAliasFolders(style: Style, folders: readonly string[]): void {
  const refused = folders.filter((folder) => !isAliasFolder(style, folder));
  if (refused.length > 0) throw new DocsStoreError(`not an alias folder, so nothing is removed: ${refused.join(', ')}`);
}

/** Puts the index and the working tree back to HEAD, or empties them when the store has no commit yet. */
async function restoreHead(store: Store): Promise<void> {
  if (await hasHead(store)) await git(store.dir, ['reset', '-q', '--hard', 'HEAD'], store.exec);
  else await git(store.dir, ['rm', '-r', '-q', '-f', '--ignore-unmatch', '--', '.'], store.exec);
}

/** Refuses a staged path outside the allowlist or a link, and restores HEAD so nothing reaches a commit; returns the count staged. */
async function verifyStaged(store: Store): Promise<number> {
  const raw = await git(store.dir, ['diff', '--cached', '--raw'], store.exec);
  const staged = raw.split('\n').filter((line) => line !== '').map((line) => {
    const [meta, file] = line.split('\t');
    return { mode: meta!.split(' ')[1], path: file! };
  });
  const bad = staged.filter((e) => !isAllowedPath(store.style, e.path) || e.mode === '120000');
  if (bad.length > 0) {
    await restoreHead(store);
    throw new DocsStoreError(`refused to commit ${bad.map((e) => e.path).join(', ')}: not a document path or a link`);
  }
  return staged.length;
}

/** Commits what is staged; an empty diff makes no commit unless the caller marks a milestone. */
async function commitStaged(store: Store, p: Projection, stagedCount: number): Promise<string | null> {
  if (stagedCount === 0 && !p.milestone) return null;
  const message = `docs(${p.scope}): ${p.label} [skip ci]\n\nRefine-Draft: ${p.draftId}\nStep: ${p.stepKey}`;
  await git(store.dir, ['commit', '-q', ...(stagedCount === 0 ? ['--allow-empty'] : []), '-m', message], store.exec);
  return headSha(store.dir, store.exec);
}

/** Projects the files onto the store and commits them; nothing is written unless every check passes. */
export async function commitProjection(store: Store, p: Projection): Promise<FlushResult> {
  // The draft id reaches a commit trailer and a folder name, so it is checked first.
  draftFolderName(p.draftId);
  const files = projectFiles(store.style, p.files);
  assertNoSecrets(files, p.known ?? []);
  assertAliasFolders(store.style, p.retire ?? []);
  return withRepoLock(store.dir, async () => {
    const c: Ctx = { store, draftId: p.draftId, born: await hasHead(store) };
    const d = await decide(c, p, files);
    await stageFiles(store, d.accepted);
    await removeFolders(store, d.retire);
    const stagedCount = await verifyStaged(store);
    return { sha: await commitStaged(store, p, stagedCount), diverged: d.diverged, aliasTaken: d.aliasTaken };
  });
}

export type PushFailure = 'busy' | 'protected' | 'auth' | 'offline' | 'other';
export interface Refusal {
  ok: false;
  kind: PushFailure;
  message: string;
}
export type PushOutcome = { ok: true; sha: string } | Refusal;

const MESSAGES: Record<PushFailure, string> = {
  busy: 'Another change reached main first. The documents must be published again.',
  protected: 'The main branch refuses direct pushes, so the documents were not published.',
  auth: 'GitHub refused the token, so the documents were not published.',
  offline: 'GitHub could not be reached, so the documents were not published. They stay in the local store.',
  other: 'The documents could not be published.',
};

const failure = (kind: PushFailure): Refusal => ({ ok: false, kind, message: MESSAGES[kind] });

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

export interface BindInput {
  style: Style;
  target: RepoTarget;
  draftId: string;
  documents: Record<string, string>;
}

export const WRITE_PERMISSIONS = ['ADMIN', 'MAINTAIN', 'WRITE'];

/** A repository that already exists must be private, not archived, and writable by the token's user. */
/** Why the repository cannot hold the documents, in plain words, or null when it can. */
export function adoptionProblem(info: RepoInfo): string | null {
  if (!info.isPrivate) return `O repositório ${info.nameWithOwner} é público; o repositório de documentos precisa ser privado.`;
  if (info.isArchived) return `O repositório ${info.nameWithOwner} está arquivado.`;
  if (!WRITE_PERMISSIONS.includes(info.viewerPermission)) return `Sua conta não tem permissão de escrita em ${info.nameWithOwner}.`;
  return null;
}

function assertAdoptable(info: RepoInfo): void {
  const problem = adoptionProblem(info);
  if (problem !== null) throw new DocsStoreError(problem);
}

/** Creates the local clone on its main branch, unless it exists already. */
async function initStore(store: Store): Promise<void> {
  await fs.mkdir(store.dir, { recursive: true });
  if (await exists(path.join(store.dir, '.git'))) return;
  await withRepoLock(store.dir, () => git(store.dir, ['init', '-q', '-b', 'main'], store.exec));
}

async function setOrigin(store: Store, url: string): Promise<void> {
  await withRepoLock(store.dir, async () => {
    const remotes = await git(store.dir, ['remote'], store.exec);
    const verb = remotes.split('\n').includes('origin') ? ['set-url', 'origin'] : ['add', 'origin'];
    await git(store.dir, ['remote', ...verb, url], store.exec);
  });
}

/** A remote main that the local history does not contain is other history, and is never adopted. */
async function assertNoOtherHistory(store: Store): Promise<void> {
  const remoteMain = await withRepoLock(store.dir, () =>
    git(store.dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], store.exec).catch(() => null),
  );
  if (remoteMain === null) return;
  const contained = await withRepoLock(store.dir, () => isAncestor(store.dir, remoteMain, 'HEAD', store.exec));
  if (!contained) throw new DocsStoreError('the repository already has other history, so it is not adopted');
}

/** Connects the store to its repository, creating it when missing and adopting it when empty or ours; returns whether it was created. */
async function attach(store: Store, target: RepoTarget, exec: Exec): Promise<boolean> {
  const fullName = `${target.owner}/${target.name}`;
  const info = await repoInfo(store.dir, fullName, exec);
  if (info) assertAdoptable(info);
  const url = info ? info.url : await createPrivateRepo(target, exec);
  await setOrigin(store, `${url}.git`);
  await git(store.dir, ['fetch', '-q', 'origin'], networkExec(exec));
  await assertNoOtherHistory(store);
  return info === null;
}

/** Attaches the store, and removes the marker when a refusal comes before any remote effect, so another target can be bound. */
async function attachOrUnbind(ws: Pick<Workspace, 'root'>, store: Store, target: RepoTarget, exec: Exec): Promise<boolean> {
  try {
    return await attach(store, target, exec);
  } catch (err) {
    if (err instanceof DocsStoreError) await removeDocsMarker(ws);
    throw err;
  }
}

const sameBinding = (a: DocsMarker, b: DocsMarker): boolean => a.style === b.style && a.target.owner === b.target.owner && a.target.name === b.target.name;

/** Binds a project to its documentation repository in order: marker, local history, remote; the push never forces. */
export async function bind(ws: Pick<Workspace, 'root'>, input: BindInput, exec: Exec = execCommand): Promise<{ sha: string; created: boolean }> {
  const marker: DocsMarker = { layout: 'docs-repo', style: input.style, target: input.target, firstSha: null };
  const earlier = await readDocsMarker(ws);
  if (earlier) {
    if (!sameBinding(earlier, marker)) throw new DocsStoreError('the project is already bound to another repository or style, and both are fixed');
    if (earlier.firstSha) return { sha: earlier.firstSha, created: false };
  }
  await writeDocsMarker(ws, marker);
  const store = storeOf(ws, input.style, exec);
  await initStore(store);
  if (!(await withRepoLock(store.dir, () => hasHead(store)))) {
    await commitProjection(store, { draftId: input.draftId, stepKey: 'bind', scope: 'refine', label: 'initial documents', files: input.documents });
  }
  const created = await attachOrUnbind(ws, store, input.target, exec);
  const sha = await withRepoLock(store.dir, () => headSha(store.dir, exec));
  const pushed = await pushMain(store.dir, sha, networkExec(exec));
  if (!pushed.ok) throw new DocsStoreError((pushed.kind === 'non-fast-forward' ? failure('busy') : failure(pushed.kind)).message);
  await writeDocsMarker(ws, { ...marker, firstSha: sha });
  return { sha, created };
}

export interface Closing {
  summary: string;
  aliases: readonly string[];
}

const CLOSE_TRIES = 3;

/** The empty closing commit that marks where development starts. */
function commitClosing(store: Store, draftId: string, summary: string): Promise<void> {
  const oneLine = summary.replace(/\s+/g, ' ').trim();
  const message = `docs: refinement closed, development starts [skip ci]\n\nClosing-Draft: ${draftId}\nSummary: ${oneLine}`;
  return withRepoLock(store.dir, async () => {
    await git(store.dir, ['commit', '-q', '--allow-empty', '-m', message], store.exec);
  });
}

/** Detaches a snapshot of the documents at the closing commit, and writes the record that starts development. */
async function finishClosing(ws: Pick<Workspace, 'root'>, store: Store, draftId: string, commit: string, aliases: readonly string[]): Promise<{ commit: string; snapshot: string }> {
  const snapshot = docsSnapshotDir(ws, draftId);
  await withRepoLock(store.dir, async () => {
    await fs.mkdir(docsSnapshotRoot(ws), { recursive: true });
    await git(store.dir, ['worktree', 'remove', '--force', snapshot], store.exec).catch(() => undefined);
    await fs.rm(snapshot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await git(store.dir, ['worktree', 'prune'], store.exec);
    await git(store.dir, ['worktree', 'add', '--detach', snapshot, commit], store.exec);
  });
  await writeClosingRecord(ws, draftId, { commit, aliases: [...aliases], pendingTags: aliases.map(startTagOf) });
  return { commit, snapshot };
}

/** Flushes the draft, adds and publishes the closing commit; a changed store or a push that never lands refuses the close. */
export async function closeRefinement(ws: Pick<Workspace, 'root'>, store: Store, p: Projection, closing: Closing): Promise<{ commit: string; snapshot: string }> {
  for (let attempt = 1; attempt <= CLOSE_TRIES; attempt++) {
    const flushed = await commitProjection(store, p);
    const refused = [...flushed.diverged, ...flushed.aliasTaken];
    if (refused.length > 0) throw new DocsStoreError(`the store changed under this draft (${refused.join(', ')}); nothing launches`);
    await commitClosing(store, p.draftId, closing.summary);
    const pushed = await pushWithRecovery(store);
    if (pushed.ok) return finishClosing(ws, store, p.draftId, pushed.sha, closing.aliases);
    if (pushed.kind !== 'busy') throw new DocsStoreError(pushed.message);
  }
  throw new DocsStoreError('the closing commit could not be published after 3 tries; nothing launches');
}

const MAX_TAG_SUFFIX = 20;

/** The commit a local tag names, read under the repository lock; null when there is no such tag. */
const localTagAt = (store: Store, name: string): Promise<string | null> =>
  withRepoLock(store.dir, () => git(store.dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`], store.exec).catch(() => null));

/** The first name of a start tag that is free, as the base or with .2, .3 ...; null when origin already has it at this commit. */
async function freeTagName(store: Store, base: string, sha: string): Promise<string | null> {
  for (let n = 1; n <= MAX_TAG_SUFFIX; n++) {
    const name = n === 1 ? base : `${base}.${n}`;
    const remote = await remoteTagTarget(store.dir, name, networkExec(store.exec));
    if (remote === sha) return null;
    const local = await localTagAt(store, name);
    if (remote === null && (local === null || local === sha)) return name;
  }
  throw new DocsStoreError(`no free tag name for ${base}`);
}

/** Creates the start tags at the closing commit and publishes them in one atomic push, never moving a tag. */
export async function createStartTags(store: Store, aliases: readonly string[], closingSha: string): Promise<{ tags: string[]; pushed: boolean }> {
  const tags: string[] = [];
  for (const alias of aliases) {
    const name = await freeTagName(store, startTagOf(alias), closingSha);
    if (name !== null) tags.push(name);
  }
  if (tags.length === 0) return { tags, pushed: true };
  await withRepoLock(store.dir, async () => {
    for (const name of tags) {
      const local = await git(store.dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`], store.exec).catch(() => null);
      if (local === null) await createAnnotatedTag(store.dir, name, closingSha, `development starts (${name})`, store.exec);
    }
  });
  const pushed = await pushTags(store.dir, tags, networkExec(store.exec));
  return { tags, pushed: pushed.ok };
}

/** Removes everything the documents left on disk for a project, and refuses nothing so a broken store can be deleted. */
export async function releaseDocs(ws: Pick<Workspace, 'root'>): Promise<void> {
  const targets = [docsStoreDir(ws), docsSnapshotRoot(ws), docsMirrorDir(ws), docsMarkerPath(ws), docsClosingRoot(ws)];
  for (const target of targets) await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
