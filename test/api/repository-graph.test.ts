import { describe, expect, it } from 'vitest';
import { buildGraphView, graphUsage } from '../../server/api/repository-graph.js';
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
