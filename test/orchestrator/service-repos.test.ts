import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { ensureServiceRepos } from '../../server/orchestrator/phases/bootstrap.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { serviceWorkspace, type Workspace } from '../../server/orchestrator/workspace.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
let projectRemote: Remote;
let ordersRemote: Remote;
let journal: Journal;
let ws: Workspace;

beforeEach(async () => {
  projectRemote = await makeRemote({ 'docs/README.md': '# docs\n' });
  ordersRemote = await makeRemote({ 'README.md': '# orders\n' });
  const root = path.join(projectRemote.root, 'ws');
  ws = { projectId: 'shop', root, repo: projectRemote.repo, worktrees: path.join(root, 'wt'), graph: path.join(root, 'graph'), knowledgeDb: '', secrets: path.join(root, 'secrets'), runs: path.join(projectRemote.root, 'runs') };
  journal = await Journal.open({ file: path.join(projectRemote.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
});
afterEach(async () => {
  await journal.close();
  await projectRemote.cleanup();
  await ordersRemote.cleanup();
});

/** GitHub already has shop-orders; shop-inventory exists only once `gh repo create` made it from a bare origin. */
function github(): { exec: FakeExec; created: string[] } {
  const created: string[] = [];
  const inventoryOrigin = path.join(projectRemote.root, 'inventory.git');
  const exec = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .onArgs('gh', ['repo', 'view'], (s) => {
      if (s.args[2] === 'o/shop-orders') return { stdout: JSON.stringify({ nameWithOwner: 'o/shop-orders', url: ordersRemote.origin }) };
      if (s.args[2] === 'o/shop-inventory' && created.length > 0) return { stdout: JSON.stringify({ nameWithOwner: 'o/shop-inventory', url: inventoryOrigin }) };
      return { exitCode: 1, stderr: 'Could not resolve to a Repository' };
    })
    .onArgs('gh', ['repo', 'create'], async (s) => {
      created.push(s.args[2]!);
      await fs.mkdir(inventoryOrigin, { recursive: true });
      await git(inventoryOrigin, ['init', '-q', '--bare', '-b', 'main'], execCommand);
      await git(s.cwd!, ['remote', 'add', 'origin', inventoryOrigin], execCommand);
      await git(s.cwd!, ['push', '-q', '-u', 'origin', 'main'], execCommand);
      return { stdout: 'https://github.example/o/shop-inventory\n' };
    });
  return { exec, created };
}

const deps = (exec: FakeExec, services?: string[]) => ({ journal, ws, spec, project: makeProject({ projectId: 'shop', services }), exec: exec.exec, ghExec: exec.exec }) as unknown as PhaseDeps & { ghExec: FakeExec['exec'] };

describe('ensureServiceRepos', () => {
  it('clones a service repository GitHub already has and creates a missing one from an empty first commit', async () => {
    const { exec, created } = github();
    expect(await ensureServiceRepos(deps(exec, ['orders', 'inventory']), 'o')).toEqual({ ok: true });
    expect(await git(serviceWorkspace(ws, 'orders').repo, ['ls-tree', '--name-only', 'origin/main'])).toBe('README.md');
    expect(created).toEqual(['o/shop-inventory']);
    expect(await git(serviceWorkspace(ws, 'inventory').repo, ['log', '--format=%s', 'origin/main'])).toBe('chore: create shop-inventory');
    expect(journal.events.find((e) => e.type === OrchEvent.RepoBootstrapped)!.data).toMatchObject({ service: 'inventory', created: true });
  });

  it('only fetches the clones on a second run', async () => {
    const { exec, created } = github();
    await ensureServiceRepos(deps(exec, ['orders', 'inventory']), 'o');
    const calls = exec.lines('gh').length;
    expect(await ensureServiceRepos(deps(exec, ['orders', 'inventory']), 'o')).toEqual({ ok: true });
    expect(exec.lines('gh')).toHaveLength(calls);
    expect(created).toEqual(['o/shop-inventory']);
  });

  it('touches nothing for a project without services', async () => {
    const { exec } = github();
    expect(await ensureServiceRepos(deps(exec), 'o')).toEqual({ ok: true });
    expect(exec.calls).toEqual([]);
  });
});
