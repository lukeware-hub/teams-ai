import { describe, expect, it } from 'vitest';
import { buildBrainView, buildGraphView } from '../../server/api/repository-graph.js';

describe('buildBrainView', () => {
  const raw = JSON.stringify({
    nodes: [
      { id: 'shop::api::a', label: 'A', repo: 'api', source_file: 'src/a.go', source_location: 'L3' },
      { id: 'shop::api::b', label: 'B', repo: 'api', source_file: 'src/b.go' },
      { id: 'blog::web::c', label: 'C', repo: 'web', source_file: 'src/c.ts' },
      { id: 'blog::project-info::d', label: 'D', repo: 'project-info', source_file: 'projeto.md' },
    ],
    links: [
      { source: 'shop::api::a', target: 'shop::api::b' },
      { source: 'shop::api::a', target: 'blog::web::c' },
    ],
  });

  it('is not available for a missing or broken graph, or one with no node', () => {
    expect(buildBrainView(null).available).toBe(false);
    expect(buildBrainView('{no').available).toBe(false);
    expect(buildBrainView('{}').available).toBe(false);
  });

  it('makes each project one group, biggest first, and colours the nodes by it', () => {
    const view = buildBrainView(raw);
    expect(view).toMatchObject({ available: true, nodes: 3, links: 2, communities: 2 });
    expect(view.map!.communities).toEqual([{ id: 'shop', name: 'shop', size: 2 }, { id: 'blog', name: 'blog', size: 1 }]);
    expect(view.map!.nodes.find((n) => n.id === 'blog::web::c')).toMatchObject({ community: 'blog', file: 'src/c.ts', line: null });
    expect(view.map!.nodes.find((n) => n.id === 'shop::api::a')).toMatchObject({ community: 'shop', line: 3, edges: 2 });
  });

  it('leaves out the description nodes of the projects', () => {
    expect(buildBrainView(raw).map!.nodes.map((n) => n.id)).not.toContain('blog::project-info::d');
  });

  it('keeps no usage, since the brain is read from no run', () => {
    expect(buildBrainView(raw).usage).toMatchObject({ graph: 0, grep: 0, none: 0 });
  });

  it('draws at most the most connected nodes and says so', () => {
    const nodes = Array.from({ length: 3005 }, (_, i) => ({ id: `p${i % 2}::r::n${i}`, label: `N${i}` }));
    const links = nodes.slice(1).map((n) => ({ source: nodes[0]!.id, target: n.id }));
    const view = buildBrainView(JSON.stringify({ nodes, links }));
    expect(view.map!.nodes).toHaveLength(3000);
    expect(view.map!.truncated).toBe(true);
  });
});

describe('the composition of a project brain', () => {
  it('counts the code, the documents and each kind of note', () => {
    const node = (id: string, file: string, type: string) => ({ id, label: id, source_file: file, file_type: type });
    const raw = JSON.stringify({
      nodes: [
        node('a', 'src/a.go', 'code'),
        node('b', 'src/b.go', 'code'),
        node('c', 'docs/API.md', 'document'),
        node('d', 'brain/tasks/spec-a.md', 'document'),
        node('e', 'brain/tasks/spec-a.md', 'document'),
        node('f', 'brain/runs/spec-a.md', 'document'),
        node('g', 'brain/chat.md', 'document'),
        node('h', 'brain/costs.md', 'document'),
      ],
      links: [],
    });
    expect(buildGraphView(raw, []).composition).toEqual({ code: 2, documents: 1, tasks: 2, runs: 1, chat: 1, costs: 1 });
  });
});
