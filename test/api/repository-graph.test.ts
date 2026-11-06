import { describe, expect, it } from 'vitest';
import { buildBrainView, buildGraphView, communitiesOf, graphUsage, linkNodes } from '../../server/api/repository-graph.js';
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
    expect(view).toMatchObject({ available: true, nodes: 3, links: 2, communities: 1 });
    expect(view.top[0]).toMatchObject({ id: 'a', edges: 2 });
    expect(view.map?.links).toHaveLength(2);
    expect(view.map?.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(view.map?.truncated).toBe(false);
  });

  it('counts how the agents used the code context, newest first', () => {
    const usage = graphUsage([{ runId: 'r1', events: [used('t1', 'dev', 'graph', 5), used('t1', 'review', 'grep', 0), used('t2', 'dev', 'none', 0)] }]);
    expect(usage).toMatchObject({ graph: 1, grep: 1, none: 1 });
    expect(usage.recent[0]).toMatchObject({ taskId: 't2', source: 'none' });
  });

  it('adds up the graph queries of the finished steps by kind, and skips steps recorded before they were counted', () => {
    const finished = (kind: string, profile?: Record<string, unknown>) =>
      ({ seq: 1, at: '2026-11-06T00:00:00Z', runId: 'r1', specHash: 'h', type: 'STEP_FINISHED', kind: 'fact', data: { kind, ...(profile ? { profile } : {}) } }) as StoredEvent;
    const usage = graphUsage([{ runId: 'r1', events: [finished('dev', { toolCalls: {}, graphQueries: 2 }), finished('dev', { toolCalls: {}, graphQueries: 0 }), finished('review', { toolCalls: {}, graphQueries: 1 }), finished('dev', { toolCalls: {} }), finished('dev')] }]);
    expect(usage.queries).toEqual({ total: 3, steps: 3, byKind: { dev: 2, review: 1 }, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } });
  });

  it('starts with no queries measured', () => {
    expect(graphUsage([]).queries).toEqual({ total: 0, steps: 0, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } });
  });

  it('counts the refinement drafts and the chat answers apart from the delivery runs', () => {
    const finished = (profile?: Record<string, unknown>) =>
      ({ seq: 1, at: '2026-11-06T00:00:00Z', runId: 'd1', specHash: 'h', type: 'STEP_FINISHED', kind: 'fact', data: { kind: 'derive', ...(profile ? { profile } : {}) } }) as StoredEvent;
    const usage = graphUsage([], { refine: [[finished({ toolCalls: {}, graphQueries: 2 }), finished({ toolCalls: {}, graphQueries: 0 }), finished()], [finished({ toolCalls: {}, graphQueries: 1 })]], chat: [1, undefined, 0] });
    expect(usage.queries).toMatchObject({ total: 0, steps: 0, refine: { total: 3, steps: 3 }, chat: { total: 1, steps: 2 } });
    expect(usage.queries.byKind).toEqual({});
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

describe('communities', () => {
  const node = (id: string) => ({ id, label: id.toUpperCase() });
  const link = (source: string, target: string) => ({ source, target });
  const clique = (prefix: string) => {
    const members = [1, 2, 3, 4, 5].map((i) => `${prefix}${i}`);
    return members.flatMap((m, i) => members.slice(i + 1).map((other) => link(m, other)));
  };
  const twoGroups = [...clique('a'), ...clique('b'), link('a5', 'b1')];
  const ids = [1, 2, 3, 4, 5].flatMap((i) => [`a${i}`, `b${i}`]);

  it('splits two tight groups joined by one link', () => {
    const { of, list } = communitiesOf(ids.map(node), twoGroups);
    expect(list).toHaveLength(2);
    expect(of.get('a1')).toBe(of.get('a4'));
    expect(of.get('b2')).toBe(of.get('b4'));
    expect(of.get('a1')).not.toBe(of.get('b2'));
  });

  it('gives the same groups however the nodes and links are ordered', () => {
    const first = communitiesOf(ids.map(node), twoGroups);
    const second = communitiesOf([...ids].reverse().map(node), [...twoGroups].reverse());
    expect([...first.of.entries()].sort()).toEqual([...second.of.entries()].sort());
  });

  it('puts the nodes without links in one group and names each group after its most connected node', () => {
    const { of, list } = communitiesOf(['x', 'y', 'hub', 'leaf'].map(node), [link('hub', 'leaf')]);
    expect(of.get('x')).toBe(of.get('y'));
    expect(list.map((c) => c.name).sort()).toEqual(['HUB', 'Sem ligações']);
    expect(list.find((c) => c.name === 'Sem ligações')?.size).toBe(2);
  });

  it('does not let a hub pull every node into one group', () => {
    const many = Array.from({ length: 60 }, (_, i) => `n${String(i).padStart(2, '0')}`);
    const spokes = many.map((id) => link('hub', id));
    const pairs = Array.from({ length: 30 }, (_, i) => link(many[i * 2]!, many[i * 2 + 1]!));
    const { list } = communitiesOf(['hub', ...many].map(node), [...spokes, ...pairs]);
    expect(list.length).toBeGreaterThan(5);
  });

  it('draws at most the most connected nodes and says when it cut the rest', () => {
    const nodes = Array.from({ length: 3005 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    const links = nodes.slice(1).map((n) => ({ source: 'n0', target: n.id }));
    const view = buildGraphView(JSON.stringify({ nodes, links }), []);
    expect(view.map?.nodes).toHaveLength(3000);
    expect(view.map?.truncated).toBe(true);
    expect(view.map?.nodes[0]?.id).toBe('n0');
  });
});
