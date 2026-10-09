import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Intent, OrchEvent } from '../../server/orchestrator/events.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import { worktreeDir } from '../../server/orchestrator/workspace.js';
import { runStep } from '../../server/runner/step.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const project = makeProject({ projectId: 'hello-app' });
const spec = makeFrozenSpec({ specId: 'hello-001' });
let remote: Remote;
let draftDocs: string;

beforeEach(async () => {
  remote = await makeRemote({ 'README.md': 'seed' });
  draftDocs = path.join(remote.root, 'draft', 'docs');
  await fs.mkdir(path.join(draftDocs, 'specs', 'hello-001'), { recursive: true });
  await fs.writeFile(path.join(draftDocs, 'project.md'), '# Hello');
  await fs.writeFile(path.join(draftDocs, 'project.json'), JSON.stringify(project));
  await fs.writeFile(path.join(draftDocs, 'specs', 'hello-001', 'brief.md'), '## Objectives');
  await fs.writeFile(path.join(draftDocs, 'specs', 'hello-001', 'spec.json'), JSON.stringify(spec));
});
afterEach(() => remote.cleanup());

function deps(exec: FakeExec, repo: string, over: Partial<RunDeps> = {}): RunDeps {
  const root = path.join(remote.root, 'ws').replace(/\\/g, '/');
  return {
    cfg: loadConfig({ paths: { workspaces: root, runs: `${root}/runs`, secrets: '/tmp/none' } }),
    ws: { projectId: 'hello-app', root, repo, worktrees: `${root}/wt`, graph: `${root}/graph`, knowledgeDb: '', secrets: `${root}/secrets`, runs: `${root}/runs` },
    project, spec, firstSpec: true,
    exec: exec.exec, ghExec: exec.exec,
    runStep,
    binary: { bin: process.execPath, prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: undefined as never,
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
    claudeJsonPath: path.join(remote.root, '.claude.json'),
    bootstrap: { docsDir: draftDocs, owner: 'o' },
    ...over,
  };
}

describe('phase 0', () => {
  describe('a draft with a base copy', () => {
    const setup = async (main: Record<string, string>, base: Record<string, string>, draft: Record<string, string>) => {
      await remote.cleanup();
      remote = await makeRemote({ 'README.md': 'seed', ...Object.fromEntries(Object.entries(main).map(([k, v]) => [`docs/${k}`, v])) });
      draftDocs = path.join(remote.root, 'draft', 'docs');
      const put = async (dir: string, files: Record<string, string>) => {
        for (const [rel, text] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
          await fs.writeFile(path.join(dir, rel), text);
        }
      };
      await put(path.join(remote.root, 'draft', '.base', 'docs'), base);
      await put(draftDocs, { ...draft, 'specs/hello-001/spec.json': JSON.stringify(spec) });
      const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
      exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
      new FakeGh().install(exec);
      return Run.create(deps(exec, remote.repo), 'hello-001-r1');
    };
    const show = (rel: string) => git(remote.repo, ['show', `origin/main:docs/${rel}`], execCommand);

    it('publishes the changed docs, skips the unchanged ones and still adds what main lacks', { timeout: 60_000 }, async () => {
      const json = JSON.stringify(project);
      const run = await setup(
        { 'project.json': json, 'project.md': '# Main', 'flow.md': '# Flow v1' },
        { 'project.json': json, 'project.md': '# Main', 'flow.md': '# Flow v1', 'stack.md': '# Stack' },
        { 'project.json': json, 'project.md': '# Main', 'flow.md': '# Flow v2', 'stack.md': '# Stack' },
      );
      expect(await run.executePhase0()).toEqual({ ok: true });
      expect(await show('flow.md')).toBe('# Flow v2');
      expect(await show('project.md')).toBe('# Main');
      expect(await show('stack.md')).toBe('# Stack');
      expect(await show('specs/hello-001/spec.json')).toContain('"specHash"');
      await run.close();
    });

    it('keeps what main has for a doc the base never had, such as a sibling spec main delivered meanwhile', { timeout: 60_000 }, async () => {
      const run = await setup(
        { 'project.md': '# P', 'specs/hello-000/spec.json': '{"status":"done"}' },
        { 'project.md': '# P' },
        { 'project.md': '# P', 'specs/hello-000/spec.json': '{"status":"awaiting-validation"}' },
      );
      expect(await run.executePhase0()).toEqual({ ok: true });
      expect(await show('specs/hello-000/spec.json')).toBe('{"status":"done"}');
      await run.close();
    });

    it('publishes a doc only the draft changed when its base copy lost the final newline main has', { timeout: 60_000 }, async () => {
      // Drafts created before the byte-for-byte copy keep a base without the final newline.
      const run = await setup({ 'flow.md': '# Flow v1\n' }, { 'flow.md': '# Flow v1' }, { 'flow.md': '# Flow v2\n' });
      expect(await run.executePhase0()).toEqual({ ok: true });
      expect(await show('flow.md')).toBe('# Flow v2');
      await run.close();
    });

    it('merges a doc that both main and the draft changed instead of stopping, keeping both changes', { timeout: 60_000 }, async () => {
      const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
      const run = await setup(
        { 'flow.md': '# Flow from another spec\n', 'project.json': json({ ...project, constraints: ['from main'] }) },
        { 'flow.md': '# Flow v1\n', 'project.json': json({ ...project, constraints: [] }) },
        { 'flow.md': '# Flow v2\n', 'project.json': json({ ...project, constraints: ['from draft'] }) },
      );
      expect(await run.executePhase0()).toEqual({ ok: true });
      expect(await show('flow.md')).toContain('# Flow from another spec');
      expect(await show('flow.md')).toContain('# Flow v2');
      expect(JSON.parse(await show('project.json')).constraints).toEqual(['from main', 'from draft']);
      await run.close();
    });
  });

  it('creates the repository from the draft when none exists', { timeout: 60_000 }, async () => {
    const origin = path.join(remote.root, 'empty.git');
    await fs.mkdir(origin);
    await git(origin, ['init', '--bare', '-b', 'main'], execCommand);
    const repo = path.join(remote.root, 'fresh-repo').replace(/\\/g, '/');
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    let created = false;
    exec.onArgs('gh', ['repo', 'view'], () => (created ? { stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: 'https://github.example/o/hello-app' }) } : { exitCode: 1, stderr: 'Could not resolve to a Repository' }));
    exec.onArgs('gh', ['repo', 'create'], async () => {
      created = true;
      await git(repo, ['remote', 'add', 'origin', origin], execCommand);
      await git(repo, ['push', '-q', '-u', 'origin', 'main'], execCommand);
      return { stdout: 'https://github.example/o/hello-app\n' };
    });
    new FakeGh().install(exec);
    const run = await Run.create(deps(exec, repo), 'hello-001-r1');
    expect(await run.executePhase0()).toEqual({ ok: true });
    const types = run.journal.events.map((e) => `${e.kind}:${e.type}`);
    expect(types).toContain('intent:DOCS_COMMIT');
    expect(types).toContain('confirm:DOCS_COMMIT');
    expect(run.journal.events.find((e) => e.kind === 'confirm' && e.type === 'DOCS_COMMIT')!.data.files).toContain('docs/specs/hello-001/spec.json');
    expect(types).toContain('confirm:REPO_CREATE');
    expect(types).toContain(`fact:${OrchEvent.RepoBootstrapped}`);
    expect(await git(repo, ['show', 'origin/main:docs/specs/hello-001/spec.json'], execCommand)).toContain('"specHash"');
    await run.close();
  });

  it('merges a docs PR when the repository exists, and resume after a crash does not duplicate the commit', { timeout: 60_000 }, async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
    const gh = new FakeGh().install(exec);
    const d = deps(exec, remote.repo, { crashAfterIntent: (id) => id === `${Intent.DocsCommit}:hello-001-0` });
    const first = await Run.create(d, 'hello-001-r1');
    await expect(first.executePhase0()).rejects.toThrow(/crash injected/);
    await first.close();
    const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, 'hello-001-r1');
    expect(await resumed.executePhase0()).toEqual({ ok: true });
    expect(gh.prs.filter((p) => p.title === 'docs(hello-001): spec v1')).toHaveLength(1);
    const log = await git(remote.repo, ['log', '--oneline', 'origin/main', '--', 'docs/specs/hello-001/spec.json'], execCommand);
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(resumed.journal.events.filter((e) => e.kind === 'confirm' && e.type === Intent.DocsCommit)).toHaveLength(1);
    await resumed.close();
  });

  it('publishes a backlog item: its whole spec directory without brief.md, the docs main lacks, and nothing main already has', { timeout: 60_000 }, async () => {
    // Spec 1 already delivered and published; the draft still holds its stale planned copy and spec 2 planned on main.
    await remote.cleanup();
    remote = await makeRemote({
      'README.md': 'seed',
      'docs/specs/hello-000/spec.json': '{"status":"done"}',
      'docs/specs/hello-001/spec.json': '{"status":"planned"}',
    });
    draftDocs = path.join(remote.root, 'draft', 'docs');
    const write = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(draftDocs, rel)), { recursive: true });
      await fs.writeFile(path.join(draftDocs, rel), text);
    };
    await write('project.md', '# Hello');
    await write('project.json', JSON.stringify(project));
    await write('briefing.md', '# Briefing');
    await write('backlog.md', '# Backlog');
    await write('specs.json', '[]');
    await write('specs/hello-000/spec.json', '{"status":"planned"}');
    await write('specs/hello-001/spec.json', JSON.stringify(spec));
    await write('specs/hello-001/spec.md', '# Spec');
    await write('specs/hello-001/preplan.json', '{"tasks":[]}');
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
    new FakeGh().install(exec);
    const run = await Run.create(deps(exec, remote.repo), 'hello-001-r1');
    expect(await run.executePhase0()).toEqual({ ok: true });
    const show = (rel: string) => git(remote.repo, ['show', `origin/main:docs/${rel}`], execCommand);
    expect(await show('specs/hello-001/spec.json')).toContain('"specHash"');
    expect(await show('specs/hello-001/spec.md')).toBe('# Spec');
    expect(await show('specs/hello-001/preplan.json')).toBe('{"tasks":[]}');
    for (const rel of ['briefing.md', 'backlog.md', 'specs.json']) expect(await show(rel)).toBeTruthy();
    expect(await show('specs/hello-000/spec.json')).toBe('{"status":"done"}');
    await run.close();
  });

  it('resuming after Phase 0 already merged does not open a second, empty docs PR', { timeout: 60_000 }, async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
    const gh = new FakeGh().install(exec);
    const d = deps(exec, remote.repo);
    const first = await Run.create(d, 'hello-001-r1');
    expect(await first.executePhase0()).toEqual({ ok: true });
    await first.close();
    const resumed = await Run.resume(d, 'hello-001-r1');
    expect(await resumed.executePhase0()).toEqual({ ok: true });
    expect(gh.prs.filter((p) => p.title === 'docs(hello-001): spec v1')).toHaveLength(1);
    await resumed.close();
  });

  it('a crash after the docs commit is confirmed but before the push does not lose the commit on resume', { timeout: 60_000 }, async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
    const gh = new FakeGh().install(exec);
    // DOCS_COMMIT is confirmed and the commit exists in the local worktree; the crash lands on the
    // very next intent (PUSH), before the commit ever reaches the remote.
    const d = deps(exec, remote.repo, { crashAfterIntent: (id) => id.startsWith('PUSH:') });
    const first = await Run.create(d, 'hello-001-r1');
    await expect(first.executePhase0()).rejects.toThrow(/crash injected/);
    await first.close();
    const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, 'hello-001-r1');
    expect(await resumed.executePhase0()).toEqual({ ok: true });
    const pr = gh.prs.find((p) => p.title === 'docs(hello-001): spec v1');
    expect(pr).toBeDefined();
    const merged = await git(remote.repo, ['show', `${pr!.headRefOid}:docs/specs/hello-001/spec.json`], execCommand);
    expect(merged).toContain('"specHash"');
    await resumed.close();
  });

  it('if the local worktree is lost after the docs commit is confirmed, resume never silently discards it', { timeout: 60_000 }, async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
    new FakeGh().install(exec);
    const d = deps(exec, remote.repo, { crashAfterIntent: (id) => id.startsWith('PUSH:') });
    const first = await Run.create(d, 'hello-001-r1');
    await expect(first.executePhase0()).rejects.toThrow(/crash injected/);
    await first.close();
    // Simulate the worktree directory being lost between the crash and the resume (ephemeral storage,
    // disk cleanup): the branch still exists in the repo's object database with the unmerged commit.
    const branch = `docs/hello-001-v1`;
    await fs.rm(worktreeDir(d.ws, branch), { recursive: true, force: true });
    const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, 'hello-001-r1');
    // Either it recreates the worktree without losing the commit, or it fails loudly instead of
    // silently recreating an empty branch — never a merged PR whose diff has quietly gone missing.
    const result = await resumed.executePhase0().catch((err: Error) => ({ ok: false as const, reason: err.message }));
    if (result.ok) {
      const head = await git(remote.repo, ['show', `origin/main:docs/specs/hello-001/spec.json`], execCommand).catch(() => null);
      expect(head).toContain('"specHash"');
    }
    await resumed.close();
  });

  it('records PHASE_FAILED instead of throwing when gh repo create fails', { timeout: 60_000 }, async () => {
    const wsRepo = path.join(remote.root, 'fresh-repo-2').replace(/\\/g, '/');
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ exitCode: 1, stderr: 'Could not resolve to a Repository' }));
    exec.onArgs('gh', ['repo', 'create'], () => ({ exitCode: 1, stderr: 'HTTP 422: name already exists on this account' }));
    new FakeGh().install(exec);
    const d = deps(exec, wsRepo);
    const run = await Run.create(d, 'hello-001-r1');
    const result = await run.executePhase0();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/gh repo create failed/);
    expect(run.journal.events.some((e) => e.type === OrchEvent.PhaseFailed && e.data.phase === 0)).toBe(true);
    await run.close();
  });

  it('an unrelated gh repo view failure (auth/network) is a hard error, not silently treated as "no repository"', { timeout: 60_000 }, async () => {
    const wsRepo = path.join(remote.root, 'fresh-repo-3').replace(/\\/g, '/');
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ exitCode: 1, stderr: 'HTTP 401: Bad credentials' }));
    const created = { called: false };
    exec.onArgs('gh', ['repo', 'create'], () => {
      created.called = true;
      return { stdout: 'https://github.example/o/hello-app\n' };
    });
    new FakeGh().install(exec);
    const d = deps(exec, wsRepo);
    const run = await Run.create(d, 'hello-001-r1');
    const result = await run.executePhase0();
    expect(result.ok).toBe(false);
    expect(created.called).toBe(false);
    await run.close();
  });
});
