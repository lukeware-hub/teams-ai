import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRepoPath } from '../../server/docs/layout.js';
import { docsStoreDir, snapshotDesign, writeDocsMarker } from '../../server/docs/project-state.js';
import { readProjectDocs } from '../../server/git/main-docs.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A folder that holds the given files and a commit of them, with origin/main pointing at it. */
async function repoWith(files: Record<string, string>, dir?: string): Promise<string> {
  const root = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-store-readers-')));
  if (dir === undefined) dirs.push(root);
  await fs.mkdir(root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'docs', '--allow-empty');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}

/** Commits the files on main of origin from a scratch clone, the way a teammate pushes. */
async function pushToOrigin(origin: string, files: Record<string, string>): Promise<void> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-push-'));
  dirs.push(work);
  execFileSync('git', ['clone', '-q', origin, work]);
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(work, rel)), { recursive: true });
    await fs.writeFile(path.join(work, rel), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'docs');
  git('push', '-q', 'origin', 'HEAD:main');
}

/** A docs-repo project whose documentation store is a clone of a bare origin that holds the given files on main. */
async function docsRepoProject(files: Record<string, string>): Promise<{ root: string; repo: string; origin: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-store-fetch-'));
  dirs.push(base);
  const root = path.join(base, 'ws');
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await pushToOrigin(origin, files);
  await writeDocsMarker({ root }, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'app' }, firstSha: null });
  execFileSync('git', ['clone', '-q', origin, docsStoreDir({ root })]);
  return { root, repo: path.join(base, 'legacy'), origin };
}

describe('parseRepoPath (plan 119, I8 item 6)', () => {
  it('returns the alias of a spec file of either layout', () => {
    expect(parseRepoPath('docs/specify/orders-001/plan.md')).toBe('orders-001');
    expect(parseRepoPath('docs/orders-api/specify/orders-001/task.md')).toBe('orders-001');
  });

  it('returns null for the five documents and for every other path', () => {
    expect(parseRepoPath('docs/project.md')).toBeNull();
    expect(parseRepoPath('docs/specs/orders-001/plan.md')).toBeNull();
    expect(parseRepoPath('docs/specify/orders-001/readme.md')).toBeNull();
    expect(parseRepoPath('docs/specify/CON/spec.md')).toBeNull();
  });
});

describe('snapshotDesign (plan 119, I8 item 6)', () => {
  it('reads the design document of a snapshot, and null when it has none', async () => {
    const root = await repoWith({ 'docs/design.md': '# design\n' });
    expect(await snapshotDesign(root)).toBe('# design\n');
    expect(await snapshotDesign(path.join(root, 'missing'))).toBeNull();
  });
});

describe('readProjectDocs (plan 119, I8 item 6)', () => {
  it('reads the five documents of origin/main for a legacy project', async () => {
    const repo = await repoWith({ 'docs/project.md': 'legacy project\n' });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-ws-'));
    dirs.push(root);
    const docs = await readProjectDocs({ root, repo }, undefined);
    expect(docs.find((doc) => doc.file === 'project.md')!.text).toBe('legacy project\n');
  });

  it('reads the five documents from the documentation store for a docs-repo project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-ws-'));
    dirs.push(root);
    const repo = await repoWith({ 'docs/project.md': 'legacy copy\n' });
    await writeDocsMarker({ root }, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'app' }, firstSha: null });
    await repoWith({ 'docs/project.md': 'store project\n', 'docs/briefing.md': 'store briefing\n' }, docsStoreDir({ root }));
    const docs = await readProjectDocs({ root, repo }, 'orders-001');
    expect(docs.find((doc) => doc.file === 'project.md')!.text).toBe('store project\n');
    expect(docs.find((doc) => doc.file === 'briefing.md')!.text).toBe('store briefing\n');
  });

  it('shows a document pushed to origin after the store was cloned, with no other fetch', async () => {
    const { root, repo, origin } = await docsRepoProject({ 'docs/project.md': 'first\n' });
    await pushToOrigin(origin, { 'docs/project.md': 'second\n' });
    const docs = await readProjectDocs({ root, repo }, undefined);
    expect(docs.find((doc) => doc.file === 'project.md')!.text).toBe('second\n');
  });

  it('keeps the last known documents when the fetch fails', async () => {
    const { root, repo, origin } = await docsRepoProject({ 'docs/project.md': 'first\n' });
    await fs.rm(origin, { recursive: true, force: true });
    const docs = await readProjectDocs({ root, repo }, undefined);
    expect(docs.find((doc) => doc.file === 'project.md')!.text).toBe('first\n');
  });
});
