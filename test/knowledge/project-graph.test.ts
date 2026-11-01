import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../server/config/config.js';
import type { Project } from '../../server/contracts/project.js';
import { buildProjectGraph, mergeProjectGraph } from '../../server/knowledge/project-graph.js';
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

