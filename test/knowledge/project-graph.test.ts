import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../server/config/config.js';
import type { Project } from '../../server/contracts/project.js';
import { readProject } from '../../server/api/run-index.js';
import { buildProjectGraph, locateProject, mergeProjectGraph, projectMainDocs, rebuildProjectGraph, type LocatedProject } from '../../server/knowledge/project-graph.js';
import { Graphify } from '../../server/knowledge/graphify.js';
import { workspacePaths } from '../../server/orchestrator/workspace.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const project = {
  projectId: 'kayron-hub',
  name: 'Kayron Hub',
  vision: 'Plataforma de governança.',
  personas: [{ name: 'Médico', description: 'Revisa a solicitação.' }],
  constraints: [],
  principles: [],
  deploy: { target: 'docker-local' },
  github: {},
  confidential: false,
  services: ['audit-service'],
} as Project;

let root: string | undefined;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('buildProjectGraph', () => {
  it('writes the project description and merges it with the graphs of the repositories', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-graph-'));
    const ws = workspacePaths({ paths: { workspaces: root, runs: path.join(root, 'runs') } } as unknown as Config, 'kayron-hub');
    const fake = new FakeExec();
    const graphify = new Graphify({ exec: fake.exec, readFile: async (p) => (p.endsWith('graph.json') ? '{}' : null) });

    await buildProjectGraph(graphify, ws, project, ['audit-service']);

    const info = await fs.readFile(path.join(ws.graph, 'project-info', 'projeto.md'), 'utf8');
    expect(info).toContain('### audit-service');
    const merge = fake.lines('graphify').find((line) => line.startsWith('merge-graphs'));
    expect(merge).toBeDefined();
    // Each graph goes in under the name of its repository, so the merged nodes say which service they belong to.
    expect(merge).toContain('inputs/kayron-hub/graphify-out/graph.json');
    expect(merge).toContain('inputs/audit-service/graphify-out/graph.json');
    expect(merge).toContain('inputs/project-info/graphify-out/graph.json');
    expect(merge).toContain('project/graphify-out/graph.json');
  });

  it('mergeProjectGraph merges the graphs that exist without rebuilding the repositories', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-graph-'));
    const ws = workspacePaths({ paths: { workspaces: root, runs: path.join(root, 'runs') } } as unknown as Config, 'kayron-hub');
    const fake = new FakeExec();
    const graphify = new Graphify({ exec: fake.exec, readFile: async (p) => (p.endsWith('graph.json') ? '{}' : null) });

    await mergeProjectGraph(graphify, ws, project, ['audit-service']);

    const lines = fake.lines('graphify');
    // Only the project description is scanned; each repository keeps the graph it already has.
    expect(lines.filter((line) => line.startsWith('update'))).toHaveLength(1);
    expect(lines.find((line) => line.startsWith('merge-graphs'))).toContain('audit-service');
  });

  it('scans the five main documents with the project description, and drops a document that main no longer has', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-graph-'));
    const ws = workspacePaths({ paths: { workspaces: root, runs: path.join(root, 'runs') } } as unknown as Config, 'kayron-hub');
    const fake = new FakeExec();
    const graphify = new Graphify({ exec: fake.exec, readFile: async (p) => (p.endsWith('graph.json') ? '{}' : null) });
    await fs.mkdir(path.join(ws.graph, 'project-info'), { recursive: true });
    await fs.writeFile(path.join(ws.graph, 'project-info', 'flow.md'), 'fluxo removido do main');

    await mergeProjectGraph(graphify, ws, project, [], [
      { file: 'design.md', text: 'Tokens de cor' },
      { file: 'stack.md', text: null },
    ]);

    const info = path.join(ws.graph, 'project-info');
    expect(await fs.readFile(path.join(info, 'design.md'), 'utf8')).toBe('Tokens de cor');
    expect(await fs.readFile(path.join(info, 'projeto.md'), 'utf8')).toContain('Kayron Hub');
    await expect(fs.access(path.join(info, 'stack.md'))).rejects.toThrow();
    await expect(fs.access(path.join(info, 'flow.md'))).rejects.toThrow();
  });
});

const HELLO = path.resolve('test/fixtures/hello-app');

/** A workspace whose repository has origin/main with the given files, the way a clone does. */
async function workspaceWithMain(files: Record<string, string>): Promise<{ ws: ReturnType<typeof workspacePaths>; root: string }> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-graph-'));
  const ws = workspacePaths({ paths: { workspaces: root, runs: path.join(root, 'runs') } } as unknown as Config, 'kayron-hub');
  await fs.mkdir(ws.repo, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(ws.repo, rel)), { recursive: true });
    await fs.writeFile(path.join(ws.repo, rel), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ws.repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'docs');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { ws, root };
}

describe('locateProject', () => {
  it('finds the configured project with its workspace and its newest spec', async () => {
    const cfg = loadConfig({ paths: { workspaces: os.tmpdir(), runs: path.join(os.tmpdir(), 'runs') }, projects: [{ dir: HELLO }] });
    const located = await locateProject(cfg, 'hello-app');
    const read = await readProject(HELLO);
    expect(located?.project.projectId).toBe('hello-app');
    expect(located?.ws.repo).toBe(workspacePaths(cfg, 'hello-app').repo);
    expect(located?.newestSpec).toBe(read.specs.at(-1)?.specId);
  });

  it('gives null for a project that no configured folder has', async () => {
    const cfg = loadConfig({ paths: { workspaces: os.tmpdir(), runs: path.join(os.tmpdir(), 'runs') }, projects: [{ dir: HELLO }] });
    expect(await locateProject(cfg, 'nao-existe')).toBeNull();
  });
});

describe('projectMainDocs', () => {
  it('has no documents for a project that is not located', async () => {
    expect(await projectMainDocs(null)).toEqual([]);
  });

  it('reads the documents of origin/main for a located project', async () => {
    const { ws } = await workspaceWithMain({ 'docs/design.md': 'Tokens de cor' });
    const docs = await projectMainDocs({ ws, project: project as Project, newestSpec: undefined });
    expect(docs.find((doc) => doc.file === 'design.md')?.text).toBe('Tokens de cor');
  });

  it('has no documents when the repository is not there, instead of failing the chat', async () => {
    const located: LocatedProject = { ws: workspacePaths({ paths: { workspaces: os.tmpdir(), runs: path.join(os.tmpdir(), 'runs') } } as unknown as Config, 'nao-clonado'), project: project as Project, newestSpec: undefined };
    expect(await projectMainDocs(located)).toEqual([]);
  });
});

describe('rebuildProjectGraph', () => {
  it('fails for a project that is not located', async () => {
    const graphify = new Graphify({ exec: new FakeExec().exec, readFile: async () => null });
    await expect(rebuildProjectGraph(graphify, null)).rejects.toThrow('project not found');
  });

  it('merges the graph with the documents of main as they are now', async () => {
    const { ws } = await workspaceWithMain({ 'docs/stack.md': 'Node e React' });
    const fake = new FakeExec();
    const graphify = new Graphify({ exec: fake.exec, readFile: async (p) => (p.endsWith('graph.json') ? '{}' : null) });
    await rebuildProjectGraph(graphify, { ws, project: project as Project, newestSpec: undefined });
    expect(await fs.readFile(path.join(ws.graph, 'project-info', 'stack.md'), 'utf8')).toBe('Node e React');
    expect(fake.lines('graphify').some((line) => line.startsWith('merge-graphs'))).toBe(true);
  });
});

