import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkBrain, linkBrainFile } from '../../server/knowledge/brain-links.js';

const node = (id: string, label: string, source_file: string) => ({ id, label, source_file });
const graph = () => ({
  nodes: [
    node('info::t1', 'T1 — Registrar o nome', 'brain/tasks/spec-a.md'),
    node('api::handler', 'hello/handler.go', 'internal/hello/handler.go'),
    node('api::new', 'NewHandler()', 'internal/hello/handler.go'),
    node('web::handler', 'hello/handler.go', 'internal/hello/handler.go'),
  ],
  links: [{ source: 'api::handler', target: 'api::new', relation: 'contains' }],
});
const want = { noteFile: 'brain/tasks/spec-a.md', heading: 'T1 — Registrar o nome', path: 'internal/hello/handler.go' };

describe('linkBrain', () => {
  it('links a task heading to the file nodes of its paths, not to the symbols inside them', () => {
    const { graph: out, added } = linkBrain(graph(), [want]);
    expect(added).toBe(2);
    expect(out.links.filter((l) => l.relation === 'references').map((l) => `${l.source}>${l.target}`)).toEqual(['info::t1>api::handler', 'info::t1>web::handler']);
  });

  it('keeps the edges the graph had and does not change the graph it was given', () => {
    const before = graph();
    const { graph: out } = linkBrain(before, [want]);
    expect(out.links[0]).toEqual(before.links[0]);
    expect(before.links).toHaveLength(1);
  });

  it('adds an edge once however many times it is asked', () => {
    expect(linkBrain(graph(), [want, want]).added).toBe(2);
    const once = linkBrain(graph(), [want]).graph;
    expect(linkBrain(once, [want]).added).toBe(0);
  });

  it('adds nothing for a heading or a path the graph does not have', () => {
    expect(linkBrain(graph(), [{ ...want, heading: 'T9 — outra' }]).added).toBe(0);
    expect(linkBrain(graph(), [{ ...want, path: 'nao/existe.go' }]).added).toBe(0);
  });

  it('handles a graph with no nodes or links', () => {
    expect(linkBrain({}, [want]).added).toBe(0);
  });

  it('links to at most three file nodes of one path', () => {
    const many = { nodes: [node('h', 'T1 — Registrar o nome', 'brain/tasks/spec-a.md'), ...Array.from({ length: 6 }, (_, i) => node(`f${i}`, 'x/handler.go', 'internal/hello/handler.go'))], links: [] };
    expect(linkBrain(many, [want]).added).toBe(3);
  });
});

describe('linkBrainFile', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('writes the links into the graph file', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-links-'));
    const file = path.join(dir, 'graph.json');
    await fs.writeFile(file, JSON.stringify(graph()));
    expect(await linkBrainFile(file, [want])).toBe(2);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).links).toHaveLength(3);
    await expect(fs.access(`${file}.tmp`)).rejects.toThrow();
  });

  it('leaves a missing or broken file alone', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-links-'));
    expect(await linkBrainFile(path.join(dir, 'none.json'), [want])).toBe(0);
    const broken = path.join(dir, 'broken.json');
    await fs.writeFile(broken, '{not json');
    expect(await linkBrainFile(broken, [want])).toBe(0);
    expect(await fs.readFile(broken, 'utf8')).toBe('{not json');
  });

  it('does nothing without links to make', async () => {
    expect(await linkBrainFile('/does/not/matter.json', [])).toBe(0);
  });
});
