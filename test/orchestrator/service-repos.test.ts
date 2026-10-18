import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Intent, Journal, OrchEvent } from '../../server/orchestrator/events.js';
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

/** GitHub already has orders-api; inventory-api exists only once `gh repo create` made it from a bare origin. */
function github(): { exec: FakeExec; created: string[] } {
  const created: string[] = [];
  const inventoryOrigin = path.join(projectRemote.root, 'inventory.git');
  const exec = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .onArgs('gh', ['repo', 'view'], (s) => {
      if (s.args[2] === 'o/orders-api') return { stdout: JSON.stringify({ nameWithOwner: 'o/orders-api', url: ordersRemote.origin }) };
      if (s.args[2] === 'o/inventory-api' && created.length > 0) return { stdout: JSON.stringify({ nameWithOwner: 'o/inventory-api', url: inventoryOrigin }) };
      return { exitCode: 1, stderr: 'Could not resolve to a Repository' };
    })
    .onArgs('gh', ['repo', 'create'], async (s) => {
      created.push(s.args[2]!);
      await fs.mkdir(inventoryOrigin, { recursive: true });
      await git(inventoryOrigin, ['init', '-q', '--bare', '-b', 'main'], execCommand);
      await git(s.cwd!, ['remote', 'add', 'origin', inventoryOrigin], execCommand);
      await git(s.cwd!, ['push', '-q', '-u', 'origin', 'main'], execCommand);
      return { stdout: 'https://github.example/o/inventory-api\n' };
    });
  return { exec, created };
}

const deps = (exec: FakeExec, services?: string[]) => ({ journal, ws, spec, project: makeProject({ projectId: 'shop', services }), exec: exec.exec, ghExec: exec.exec }) as unknown as PhaseDeps & { ghExec: FakeExec['exec'] };

describe('ensureServiceRepos', () => {
  it('clones a service repository GitHub already has and creates a missing one from an empty first commit', async () => {
    const { exec, created } = github();
    expect(await ensureServiceRepos(deps(exec, ['orders-api', 'inventory-api']), 'o')).toEqual({ ok: true });
    expect(await git(serviceWorkspace(ws, 'orders-api').repo, ['ls-tree', '--name-only', 'origin/main'])).toBe('README.md');
    expect(created).toEqual(['o/inventory-api']);
    expect(await git(serviceWorkspace(ws, 'inventory-api').repo, ['log', '--format=%s', 'origin/main'])).toBe('chore: create inventory-api');
    expect(journal.events.find((e) => e.type === OrchEvent.RepoBootstrapped)!.data).toMatchObject({ service: 'inventory-api', created: true });
  });

  it('only fetches the clones on a second run', async () => {
    const { exec, created } = github();
    await ensureServiceRepos(deps(exec, ['orders-api', 'inventory-api']), 'o');
    const calls = exec.lines('gh').length;
    expect(await ensureServiceRepos(deps(exec, ['orders-api', 'inventory-api']), 'o')).toEqual({ ok: true });
    expect(exec.lines('gh')).toHaveLength(calls);
    expect(created).toEqual(['o/inventory-api']);
  });

  /** A repository GitHub has with no commit yet, as a bare origin; `gh repo view` finds it and answers its URL without `.git`, as GitHub does. */
  async function emptyOnGithub(name: string): Promise<{ exec: FakeExec; origin: string }> {
    const origin = path.join(projectRemote.root, `${name}.git`);
    await fs.mkdir(origin);
    await git(origin, ['init', '-q', '--bare', '-b', 'main'], execCommand);
    const url = path.join(projectRemote.root, name);
    await fs.symlink(origin, url);
    const exec = new FakeExec()
      .on((s) => s.bin === 'git', (s) => execCommand(s))
      .onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: `o/${name}`, url }) }));
    return { exec, origin };
  }

  /** A local repository with its first commit, as a creation left it, and that creation confirmed in the journal. */
  async function createdLocally(service: string, origin?: string): Promise<string> {
    const { repo } = serviceWorkspace(ws, service);
    await fs.mkdir(path.dirname(repo), { recursive: true });
    await git(path.dirname(repo), ['init', '-q', '-b', 'main', path.basename(repo)]);
    await git(repo, ['commit', '-q', '--allow-empty', '-m', `chore: create ${service}`]);
    if (origin) await git(repo, ['remote', 'add', 'origin', origin]);
    await journal.intent(Intent.RepoCreate, service, { owner: 'o', name: service });
    await journal.confirm(Intent.RepoCreate, service, {});
    return repo;
  }

  it('gives a repository GitHub has without any commit its first commit on main', async () => {
    const { exec } = await emptyOnGithub('orders-api');
    expect(await ensureServiceRepos(deps(exec, ['orders-api']), 'o')).toEqual({ ok: true });
    expect(await git(serviceWorkspace(ws, 'orders-api').repo, ['log', '--format=%s', 'origin/main'])).toBe('chore: create orders-api');
  });

  it('pushes main when a creation stopped after origin was added', async () => {
    const { exec, origin } = await emptyOnGithub('inventory-api');
    const repo = await createdLocally('inventory-api', origin);
    expect(await ensureServiceRepos(deps(exec, ['inventory-api']), 'o')).toEqual({ ok: true });
    expect(await git(repo, ['log', '--format=%s', 'origin/main'])).toBe('chore: create inventory-api');
  });

  it('adds origin and pushes main when a creation stopped before origin was added', async () => {
    const { exec } = await emptyOnGithub('inventory-api');
    const repo = await createdLocally('inventory-api');
    expect(await ensureServiceRepos(deps(exec, ['inventory-api']), 'o')).toEqual({ ok: true });
    expect(await git(repo, ['log', '--format=%s', 'origin/main'])).toBe('chore: create inventory-api');
  });

  it('says gh is not logged in instead of failing on its empty answer', async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s)).onArgs('gh', ['api', 'user'], () => ({ exitCode: 1, stderr: 'not logged into any GitHub hosts' }));
    expect(await ensureServiceRepos(deps(exec, ['orders-api']), undefined)).toEqual({ ok: false, reason: 'service orders-api: gh api user failed: not logged into any GitHub hosts' });
  });

  it('refuses a repository that holds another teams-ai project, as project orders-api would for service orders-api of shop', async () => {
    const other = await makeRemote({ 'docs/project.json': '{"projectId":"orders-api"}' });
    try {
      const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s)).onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/orders-api', url: other.origin }) }));
      expect(await ensureServiceRepos(deps(exec, ['orders-api']), 'o')).toEqual({ ok: false, reason: 'service orders-api: repository orders-api holds another teams-ai project (docs/project.json on its main); rename the service or the project' });
    } finally {
      await other.cleanup();
    }
  });

  it('touches nothing for a project without services', async () => {
    const { exec } = github();
    expect(await ensureServiceRepos(deps(exec), 'o')).toEqual({ ok: true });
    expect(exec.calls).toEqual([]);
  });
});
