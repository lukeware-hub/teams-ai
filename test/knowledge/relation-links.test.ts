import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeState } from '../../server/docs/project-state.js';
import { linkRelations, linkRelationsFile, readRelationSpecs, type RelationSpec } from '../../server/knowledge/relation-links.js';

const page = (id: string, file: string) => ({ id, label: file.split('/').slice(-2).join('/'), source_file: file, node_kind: 'page' });
const graph = () => ({
  nodes: [
    page('a-spec', 'docs/billing-api/specify/a/spec.md'),
    page('a-plan', 'docs/billing-api/specify/a/plan.md'),
    page('a-task', 'docs/billing-api/specify/a/task.md'),
    page('b-spec', 'docs/case-api/specify/b/spec.md'),
    { id: 'svc', label: 'billing-api', source_file: 'projeto.md', node_kind: 'heading' },
    { id: 'stack-h', label: 'Modelo de autoridade', source_file: 'stack.md', node_kind: 'heading' },
    { id: 'code', label: 'main.go', source_file: 'cmd/audit/main.go', node_kind: 'file' },
  ],
  links: [] as Array<{ source: string; target: string; relation?: string }>,
});
const spec = (over: Partial<RelationSpec> = {}): RelationSpec => ({ specId: 'a', repository: 'billing-api', dependsOn: ['b'], sources: [{ doc: 'stack.md', heading: 'Modelo de autoridade' }], paths: ['cmd/audit/main.go'], ...over });
const edges = (g: ReturnType<typeof graph>) => g.links.map((l) => `${l.source}>${l.target}:${l.relation}`).sort();

describe('linkRelations', () => {
  it('states the dependency, the plan, the task list, the service, the source heading and the touched file of a spec', () => {
    const { graph: linked, added } = linkRelations(graph(), [spec()]);
    expect(added).toBe(6);
    expect(edges(linked)).toEqual([
      'a-plan>code:touches',
      'a-spec>a-plan:has_plan',
      'a-spec>a-task:has_tasks',
      'a-spec>b-spec:depends_on',
      'a-spec>stack-h:derived_from',
      'a-spec>svc:belongs_to',
    ]);
    expect(linked.links[0]).toMatchObject({ confidence: 'EXTRACTED', _origin: 'relations' });
  });

  it('adds nothing for an end the graph does not hold, and nothing twice', () => {
    expect(linkRelations(graph(), [spec({ specId: 'ghost' })]).added).toBe(0);
    const once = linkRelations(graph(), [spec()]).graph;
    expect(linkRelations(once, [spec()]).added).toBe(0);
  });

  it('matches a document heading under its plain or its docs/ path', () => {
    const g = graph();
    g.nodes.push({ id: 'proj-h', label: 'Visão', source_file: 'docs/project.md', node_kind: 'heading' });
    const { graph: linked } = linkRelations(g, [spec({ dependsOn: [], repository: undefined, paths: [], sources: [{ doc: 'project.md', heading: 'Visão' }] })]);
    expect(edges(linked)).toContain('a-spec>proj-h:derived_from');
  });
});

describe('linkRelationsFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relations-'));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('rewrites the graph file with the edges, and leaves a broken or missing file as it is', async () => {
    const file = path.join(dir, 'graph.json');
    await fs.writeFile(file, JSON.stringify(graph()));
    expect(await linkRelationsFile(file, [spec()])).toBe(6);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).links).toHaveLength(6);
    await fs.writeFile(file, '{broken');
    expect(await linkRelationsFile(file, [spec()])).toBe(0);
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
    expect(await linkRelationsFile(path.join(dir, 'none.json'), [spec()])).toBe(0);
  });
});

describe('readRelationSpecs', () => {
  let ws: { root: string };
  beforeEach(async () => {
    ws = { root: await fs.mkdtemp(path.join(os.tmpdir(), 'relations-state-')) };
  });
  afterEach(() => fs.rm(ws.root, { recursive: true, force: true }));

  it('reads the backlog and the files each plan changes, turning a dependency key into the id of its spec', async () => {
    await writeState(ws, 'specs.json', JSON.stringify({ specs: [
      { specId: 'a-001', key: 'a', repository: 'billing-api', dependsOn: ['b'], sources: [{ doc: 'stack.md', heading: 'H' }] },
      { specId: 'b-001', key: 'b', dependsOn: [], sources: [] },
    ] }));
    await writeState(ws, 'specs/a-001/plan.json', JSON.stringify({ tasks: [{ affectedPaths: ['x.go', 'y.go'] }, { affectedPaths: ['x.go'] }] }));
    expect(await readRelationSpecs(ws)).toEqual([
      { specId: 'a-001', repository: 'billing-api', dependsOn: ['b-001'], sources: [{ doc: 'stack.md', heading: 'H' }], paths: ['x.go', 'y.go'] },
      { specId: 'b-001', dependsOn: [], sources: [], paths: [] },
    ]);
  });

  it('gives no spec for a project with no saved state', async () => {
    expect(await readRelationSpecs(ws)).toEqual([]);
  });
});
