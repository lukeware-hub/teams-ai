import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git, headSha, remoteMainSha } from '../../server/git/git.js';
import { MergeQueue, type MergeSteps } from '../../server/git/merge-queue.js';
import { mainForMerge } from '../../server/orchestrator/merge-steps.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const exec = execCommand;
let remote: Remote;
let other: string;
let base: string;

/** Another clone pushes one commit with the given files to origin/main. */
async function pushToMain(files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(other, rel)), { recursive: true });
    await fs.writeFile(path.join(other, rel), text);
  }
  await git(other, ['add', '-A'], exec);
  await git(other, ['commit', '-q', '-m', 'change on main'], exec);
  await git(other, ['push', '-q', 'origin', 'main'], exec);
}

beforeEach(async () => {
  remote = await makeRemote({ 'README.md': '# app\n', 'src/a.ts': 'export {};\n', 'docs/stack.md': 'old\n' });
  other = path.join(remote.root, 'other');
  await git(remote.root, ['clone', '-q', remote.origin, other], exec);
  base = await headSha(remote.repo, exec);
});
afterEach(async () => {
  await remote.cleanup();
});

describe('mainForMerge: a monolith main that moved only by documents (plan 119, I8 item 4)', () => {
  it('counts as the rebase base when the move touches only allowlisted document paths', async () => {
    await pushToMain({ 'docs/stack.md': 'new\n', 'docs/specify/orders-001/plan.md': '# plan\n', 'docs/project.md': 'p\n' });
    expect(await remoteMainSha(remote.repo, exec)).not.toBe(base);
    expect(await mainForMerge(remote.repo, base, exec)).toBe(base);
  });

  it('keeps the remote main when the move also touches code', async () => {
    await pushToMain({ 'docs/stack.md': 'new\n', 'src/a.ts': 'export const a = 1;\n' });
    const remoteSha = await remoteMainSha(remote.repo, exec);
    expect(await mainForMerge(remote.repo, base, exec)).toBe(remoteSha);
  });

  it('keeps the remote main when the move touches a document the repository does not own', async () => {
    await pushToMain({ 'docs/notes.md': 'loose\n' });
    expect(await mainForMerge(remote.repo, base, exec)).not.toBe(base);
  });

  it('returns the remote main when main did not move', async () => {
    expect(await mainForMerge(remote.repo, base, exec)).toBe(base);
  });

  it('lets the queue merge a main moved only by documents, and refuses one moved by code', async () => {
    const merged = (sha: () => Promise<string>): MergeSteps => ({
      alreadyMerged: async () => null,
      rebase: async () => ({ ok: true, baseSha: base }),
      gates: async () => ({ ok: true }),
      push: async () => {},
      ensurePr: async () => ({ number: 7 }),
      remoteMainSha: sha,
      merge: async () => ({ merged: true }),
    });
    await pushToMain({ 'docs/stack.md': 'new\n' });
    expect(await new MergeQueue().enqueue('T1', merged(() => mainForMerge(remote.repo, base, exec)))).toEqual({ ok: true, pr: 7 });
    await pushToMain({ 'src/b.ts': 'export {};\n' });
    expect(await new MergeQueue().enqueue('T2', merged(() => mainForMerge(remote.repo, base, exec)))).toMatchObject({ ok: false, stage: 'merge' });
  });
});
