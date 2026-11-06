import { describe, expect, it } from 'vitest';
import type { PlanTask } from '../../server/contracts/plan.js';
import { buildContextPack, SECTION_ORDER, type ContextPackInput } from '../../server/knowledge/context-pack.js';

const base: ContextPackInput = {
  kind: 'dev',
  role: 'dev',
  specHash: 'sha256:abc',
  principles: ['p'],
  outputContract: 'Return JSON.',
  criteria: [],
  budgetTokens: 12_000,
};

const task = (over: Partial<PlanTask> = {}): PlanTask => ({ id: 'T1', title: 'Register the name', description: 'd', owner: 'dev', dependsOn: [], criteriaRefs: [], affectedPaths: ['internal/hello/handler.go', 'README.md', 'docs/extra.md'], ...over }) as PlanTask;

const all = { projectGraph: '/ws/shop/graph/project/graphify-out/graph.json', repoGraph: '/ws/shop/graph/main/graphify-out/graph.json', brainGraph: '/ws/_brain/graphify-out/graph.json' };

describe('graph access in the pack', () => {
  it('names every graph the agent may query, in the one place after the code context', () => {
    const pack = buildContextPack({ ...base, graphAccess: all });
    expect(pack.sections).toContain('graph-access');
    expect(SECTION_ORDER.indexOf('graph-access')).toBe(SECTION_ORDER.indexOf('code') + 1);
    expect(pack.text).toContain('## Graph access (the brain)');
    expect(pack.text).toContain(`project graph (code, documents, specs, tasks, run history and failures, costs, chat): ${all.projectGraph}`);
    expect(pack.text).toContain(`repository graph (the code of this repository): ${all.repoGraph}`);
    expect(pack.text).toContain(`global brain (every project of this machine that is not confidential): ${all.brainGraph}`);
  });

  it('leaves the global brain out when the project may not have it, and the whole section when no graph exists', () => {
    const open = buildContextPack({ ...base, graphAccess: { projectGraph: all.projectGraph } });
    expect(open.text).toContain('project graph');
    expect(open.text).not.toContain('global brain');
    expect(buildContextPack({ ...base, graphAccess: {} }).sections).not.toContain('graph-access');
    expect(buildContextPack(base).sections).not.toContain('graph-access');
  });

  it('gives ready queries for a task: its title and the files it names', () => {
    const text = buildContextPack({ ...base, task: task(), graphAccess: all }).text;
    expect(text).toContain(`graphify query "Register the name" --graph ${all.projectGraph}`);
    expect(text).toContain(`graphify explain "handler.go" --graph ${all.projectGraph}`);
    expect(text).toContain(`graphify explain "README.md" --graph ${all.projectGraph}`);
    expect(text.split('\n').filter((l) => l.startsWith('- graphify explain'))).toHaveLength(2);
  });

  it('gives no ready query for a step with no task', () => {
    expect(buildContextPack({ ...base, graphAccess: all }).text).not.toContain('Ready queries');
  });

  it('keeps a task title from reaching a shell: quotes, substitutions and separators are dropped', () => {
    const text = buildContextPack({ ...base, task: task({ title: 'x"; rm -rf / `id` $(whoami) | cat' }), graphAccess: all }).text;
    const query = text.split('\n').find((l) => l.startsWith('- graphify query'))!;
    expect(query).not.toMatch(/[`$|;]/);
    expect(query.match(/"/g)).toHaveLength(2);
  });

  it('uses the repository graph for the ready queries when there is no project graph', () => {
    const text = buildContextPack({ ...base, task: task(), graphAccess: { repoGraph: all.repoGraph } }).text;
    expect(text).toContain(`graphify query "Register the name" --graph ${all.repoGraph}`);
  });

  it('is never dropped for budget, even when the code and the retrieval are', () => {
    const pack = buildContextPack({
      ...base,
      budgetTokens: 10,
      graphAccess: all,
      code: { source: 'graph', nodes: [{ label: 'x', file: 'a.go', line: 1 }], graphFile: all.repoGraph },
      retrieval: [{ chunkId: 'c', docId: 'd', kind: 'spec', title: 't', heading: null, snippet: 's', text: 'long '.repeat(100), score: 1 }],
    });
    expect(pack.dropped).toEqual(expect.arrayContaining(['retrieval', 'code']));
    expect(pack.sections).toContain('graph-access');
    expect(pack.text).toContain(all.projectGraph);
  });
});
