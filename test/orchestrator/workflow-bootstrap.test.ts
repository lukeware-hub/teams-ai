import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Intent } from '../../server/orchestrator/events.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import { renderCi, renderRelease, CI_PATH, RELEASE_PATH } from '../../server/orchestrator/workflows.js';
import { worktreeDir } from '../../server/orchestrator/workspace.js';
import { runStep } from '../../server/runner/step.js';
import { makeFrozenSpec, makePlan, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const project = makeProject({ projectId: 'hello-app' });
const spec = makeFrozenSpec({ specId: 'hello-001' });
const plan = makePlan(spec);
let remote: Remote;
afterEach(() => remote.cleanup());

function deps(exec: FakeExec): RunDeps {
  const root = path.join(remote.root, 'ws').replace(/\\/g, '/');
  return {
    cfg: loadConfig({ paths: { workspaces: root, runs: `${root}/runs`, secrets: '/tmp/none' } }),
    ws: { projectId: 'hello-app', root, repo: remote.repo, worktrees: `${root}/wt`, graph: `${root}/graph`, knowledgeDb: '', secrets: `${root}/secrets`, runs: `${root}/runs` },
    project, spec, firstSpec: true,
    exec: exec.exec, ghExec: exec.exec,
    runStep,
    binary: { bin: process.execPath, prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: undefined as never,
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
    claudeJsonPath: path.join(remote.root, '.claude.json'),
    bootstrap: { docsDir: path.join(remote.root, 'draft'), owner: 'o' },
  };
}

const show = async (rel: string) => `${await git(remote.repo, ['show', `origin/main:${rel}`], execCommand)}
`;

describe('workflow bootstrap (R8.3)', () => {
  it('commits ci.yml and release.yml to main through a docs PR', { timeout: 60_000 }, async () => {
    remote = await makeRemote({ 'README.md': 'seed' });
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const gh = new FakeGh().install(exec);
    const run = await Run.create(deps(exec), 'hello-001-r1');
    expect(await run.executeWorkflows(plan)).toEqual({ ok: true });
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(await show(CI_PATH)).toBe(renderCi(plan));
    expect(await show(RELEASE_PATH)).toBe(renderRelease(plan));
    expect(gh.prs.filter((p) => p.title.includes('GitHub Actions workflows'))).toHaveLength(1);
    await run.close();
  });

  it('never overwrites a workflow the repository already has', { timeout: 60_000 }, async () => {
    remote = await makeRemote({ 'README.md': 'seed', [CI_PATH]: 'name: mine\n' });
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    new FakeGh().install(exec);
    const run = await Run.create(deps(exec), 'hello-001-r1');
    expect(await run.executeWorkflows(plan)).toEqual({ ok: true });
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(await show(CI_PATH)).toBe('name: mine\n');
    expect(await show(RELEASE_PATH)).toBe(renderRelease(plan));
    await run.close();
  });

  it('opens no PR when both files already exist and removes the docs worktree', { timeout: 60_000 }, async () => {
    remote = await makeRemote({ 'README.md': 'seed', [CI_PATH]: 'a: 1\n', [RELEASE_PATH]: 'b: 2\n' });
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const gh = new FakeGh().install(exec);
    const d = deps(exec);
    const run = await Run.create(d, 'hello-001-r1');
    expect(await run.executeWorkflows(plan)).toEqual({ ok: true });
    expect(gh.prs).toHaveLength(0);
    const branch = 'docs/hello-001-workflows';
    await expect(fs.access(worktreeDir(d.ws, branch))).rejects.toThrow();
    expect(run.journal.isConfirmed(Intent.WorktreeRemove, `${branch}@empty`)).toBe(true);
    await run.close();
  });
});
