import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult, Exec } from '../../server/exec/command.js';
import { isFirstSpec } from '../../server/orchestrator/first-spec.js';

let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

const result = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, signal: null, stdout, stderr: exitCode === 0 ? '' : 'fatal', timedOut: false, durationMs: 1, truncated: false });

/** A repo whose origin/main lists `topLevel`; `null` means origin/main does not exist. */
const fakeExec = (topLevel: string[] | null): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = [];
  const exec: Exec = async (spec) => {
    const args = [...spec.args].filter((a) => a !== '-c' && !a.includes('='));
    calls.push(args);
    if (args.includes('ls-tree')) return topLevel === null ? result('', 128) : result(topLevel.join('\n'));
    return result('');
  };
  return { exec, calls };
};

const repoWithGit = async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-first-'));
  await fs.mkdir(path.join(dir, '.git'));
  return dir;
};

describe('isFirstSpec', () => {
  it('is true for the only spec directory, without touching git', async () => {
    const { exec, calls } = fakeExec(['docs', 'src']);
    expect(await isFirstSpec({ specDirs: ['a-001'], specId: 'a-001', repo: '/nowhere', exec })).toBe(true);
    expect(calls).toEqual([]);
  });

  it('is true when the project has no clone yet', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-first-'));
    const { exec } = fakeExec(['docs', 'src']);
    expect(await isFirstSpec({ specDirs: ['a-001', 'a-001-b'], specId: 'a-001', repo: dir, exec })).toBe(true);
  });

  it('is true with several spec directories while main holds only docs and workflows (no scaffold merged yet)', async () => {
    const repo = await repoWithGit();
    const { exec } = fakeExec(['.github', 'docs']);
    expect(await isFirstSpec({ specDirs: ['a-001', 'a-001-b'], specId: 'a-001-b', repo, exec })).toBe(true);
  });

  it('is false with several spec directories once main carries code', async () => {
    const repo = await repoWithGit();
    const { exec } = fakeExec(['.github', 'docs', 'package.json', 'src']);
    expect(await isFirstSpec({ specDirs: ['a-001', 'a-001-b'], specId: 'a-001-b', repo, exec })).toBe(false);
  });

  it('is true when origin/main does not exist yet', async () => {
    const repo = await repoWithGit();
    const { exec } = fakeExec(null);
    expect(await isFirstSpec({ specDirs: ['a-001', 'a-001-b'], specId: 'a-001', repo, exec })).toBe(true);
  });
});
