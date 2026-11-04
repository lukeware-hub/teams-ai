import { describe, expect, it } from 'vitest';
import { buildGraphView, graphUsage, linkNodes } from '../../server/api/repository-graph.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const used = (taskId: string, step: string, source: string, nodes: number): StoredEvent =>
  ({ seq: 1, at: '2026-11-04T00:00:00Z', runId: 'r1', specHash: 'h', type: 'CODE_CONTEXT_USED', kind: 'fact', data: { taskId, step, source, nodes } }) as StoredEvent;

const graph = JSON.stringify({
  nodes: [
    { id: 'a', label: 'A', source_file: 'a.ts', community_name: 'core' },
    { id: 'b', label: 'B', source_file: 'b.ts', community_name: 'core' },
    { id: 'c', label: 'C', source_file: 'c.ts', community_name: 'ui' },
  ],
  links: [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
  ],
});

describe('graph view', () => {
  it('says the graph is not available when the file is missing or broken', () => {
    expect(buildGraphView(null, []).available).toBe(false);
    expect(buildGraphView('{not json', []).available).toBe(false);
  });

  it('counts the graph and ranks the most connected node first', () => {
    const view = buildGraphView(graph, []);
    expect(view).toMatchObject({ available: true, nodes: 3, links: 2, communities: 2 });
    expect(view.top[0]).toMatchObject({ id: 'a', edges: 2 });
    expect(view.topLinks).toHaveLength(2);
  });

  it('counts how the agents used the code context, newest first', () => {
    const usage = graphUsage([{ runId: 'r1', events: [used('t1', 'dev', 'graph', 5), used('t1', 'review', 'grep', 0), used('t2', 'dev', 'none', 0)] }]);
    expect(usage).toMatchObject({ graph: 1, grep: 1, none: 1 });
    expect(usage.recent[0]).toMatchObject({ taskId: 't2', source: 'none' });
  });

  it('keeps the usage even when the graph is not available', () => {
    const view = buildGraphView(null, [{ runId: 'r1', events: [used('t1', 'dev', 'grep', 0)] }]);
    expect(view.usage.grep).toBe(1);
  });
});

describe('graph view nodes', () => {
  const raw = JSON.stringify({
    nodes: [
      { id: 'a', label: 'A', repo: 'shop', source_file: 'docs/a.md', source_location: 'L12', community_name: 'core' },
      { id: 'b', label: 'B', repo: 'shop', source_file: 'docs/b.md', source_location: 'x', community_name: 'core' },
      { id: 'i', label: 'A', repo: 'project-info', source_file: 'a.md', source_location: 'L1', community_name: 'core' },
    ],
    links: [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'i' },
    ],
  });

  it('leaves out the project description nodes, and the links that touch them', () => {
    const view = buildGraphView(raw, []);
    expect(view.nodes).toBe(2);
    expect(view.links).toBe(1);
    expect(view.top.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('carries the repository tag and the line of each node, and no link yet', () => {
    const [a, b] = ['a', 'b'].map((id) => buildGraphView(raw, []).top.find((n) => n.id === id)!);
    expect(a).toMatchObject({ repo: 'shop', file: 'docs/a.md', line: 12, url: null });
    expect(b!.line).toBeNull();
  });

  it('fills in each link from the resolver, and a node whose lookup fails keeps none', async () => {
    const view = await linkNodes(buildGraphView(raw, []), async (n) => {
      if (n.id === 'b') throw new Error('git down');
      return `https://github.com/acme/shop/blob/c/${n.file}`;
    });
    expect(view.top.find((n) => n.id === 'a')!.url).toBe('https://github.com/acme/shop/blob/c/docs/a.md');
    expect(view.top.find((n) => n.id === 'b')!.url).toBeNull();
  });
});
