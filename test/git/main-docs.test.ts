import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMainDocs } from '../../server/git/main-docs.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A repository whose origin/main holds the given files, the way a clone does. */
async function mainWith(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-main-docs-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'docs');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

describe('readMainDocs', () => {
  it('gives the five documents of origin/main, with null for each one main does not have', async () => {
    const repo = await mainWith({ 'docs/project.md': 'Projeto', 'docs/design.md': 'Design' });
    expect(await readMainDocs(repo, undefined)).toEqual([
      { file: 'project.md', text: 'Projeto' },
      { file: 'briefing.md', text: null },
      { file: 'stack.md', text: null },
      { file: 'flow.md', text: null },
      { file: 'design.md', text: 'Design' },
    ]);
  });

  it('takes the briefing of the newest spec when main has no root briefing', async () => {
    const repo = await mainWith({ 'docs/specs/hello-002/briefing.md': 'Briefing da spec' });
    const briefing = (await readMainDocs(repo, 'hello-002')).find((doc) => doc.file === 'briefing.md');
    expect(briefing).toEqual({ file: 'briefing.md', text: 'Briefing da spec' });
  });

  it('keeps the root briefing when main has both', async () => {
    const repo = await mainWith({ 'docs/briefing.md': 'Briefing da raiz', 'docs/specs/hello-002/briefing.md': 'Briefing da spec' });
    const briefing = (await readMainDocs(repo, 'hello-002')).find((doc) => doc.file === 'briefing.md');
    expect(briefing?.text).toBe('Briefing da raiz');
  });

  it('ignores a spec id that is not a safe folder name', async () => {
    const repo = await mainWith({ 'docs/specs/hello-002/briefing.md': 'Briefing da spec' });
    const briefing = (await readMainDocs(repo, '..')).find((doc) => doc.file === 'briefing.md');
    expect(briefing?.text).toBeNull();
  });

  it('fails when origin/main does not exist, instead of reporting every document as missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-main-docs-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await expect(readMainDocs(dir, undefined)).rejects.toThrow(/origin\/main/);
  });
});
