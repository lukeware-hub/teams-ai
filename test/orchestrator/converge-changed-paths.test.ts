import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { changedPaths, discardEdits } from '../../server/orchestrator/phases/converge.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A repository whose .gitignore hides *.log and node_modules, the way a project repo does. */
async function worktree(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-converge-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(dir, '.gitignore'), '*.log\nnode_modules/\n');
  await fs.writeFile(path.join(dir, 'app.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'base');
  return dir;
}

async function write(dir: string, rel: string, text = 'x\n'): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
}

describe('changedPaths', () => {
  it('reports nothing when the review only wrote the npm cache logs, ignored output and a sandbox placeholder', async () => {
    const dir = await worktree();
    await write(dir, '.tools/npm-cache/_logs/2026-11-01T23_59_02_600Z-debug-0.log');
    await write(dir, 'node_modules/left-pad/index.js');
    await write(dir, '.bashrc');
    expect(await changedPaths(dir, execCommand)).toEqual([]);
  });

  it('reports the code files the review changed', async () => {
    const dir = await worktree();
    await write(dir, 'app.ts', 'export const a = 2;\n');
    await write(dir, 'src/new.ts');
    expect((await changedPaths(dir, execCommand)).sort()).toEqual(['app.ts', 'src/new.ts']);
  });

  it('drops the review edits, keeps the tool cache and leaves the worktree clean', async () => {
    const dir = await worktree();
    await write(dir, 'app.ts', 'export const a = 2;\n');
    await write(dir, 'src/new.ts');
    await write(dir, '.tools/npm-cache/cache.json');
    await discardEdits(dir, await changedPaths(dir, execCommand), execCommand);
    expect(await fs.readFile(path.join(dir, 'app.ts'), 'utf8')).toBe('export const a = 1;\n');
    await expect(fs.access(path.join(dir, 'src/new.ts'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, '.tools/npm-cache/cache.json'), 'utf8')).toBe('x\n');
    expect(await changedPaths(dir, execCommand)).toEqual([]);
  });

  it('does nothing when the review changed no file, so an empty list never cleans the worktree', async () => {
    const dir = await worktree();
    await write(dir, '.tools/npm-cache/cache.json');
    await discardEdits(dir, [], execCommand);
    expect(await fs.readFile(path.join(dir, '.tools/npm-cache/cache.json'), 'utf8')).toBe('x\n');
  });
});
