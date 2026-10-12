import { describe, expect, it } from 'vitest';
import { NEVER_DROP, SECTION_ORDER, buildContextPack, estimateTokens, type ContextPackInput, type HandoffSummary } from '../../server/knowledge/context-pack.js';
import { makeFrozenSpec, makePlanTask } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const base: ContextPackInput = {
  kind: 'dev',
  role: 'dev',
  specHash: spec.specHash!,
  principles: ['Every acceptance test name carries its [AC-xxx] tag', 'Never modify frozen files'],
  outputContract: 'Return a JSON object matching the dev output schema.',
  task: makePlanTask({ id: 'T1-create', title: 'Create todo endpoint', criteriaRefs: ['AC-001'], dependsOn: ['T0-scaffold'], affectedPaths: ['src/todos/create/**'] }),
  criteria: [spec.acceptanceCriteria[0]!],
  budgetTokens: 4000,
};

describe('estimateTokens', () => {
  it('rounds up chars/4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('buildContextPack', () => {
  it('renders sections in the fixed order with the stable prefix first and is deterministic', () => {
    const a = buildContextPack(base);
    const b = buildContextPack(base);
    expect(a.text).toBe(b.text);
    expect(a.sections).toEqual(['principles', 'contract', 'task', 'criteria']);
    expect(a.text.indexOf('## Principles')).toBeLessThan(a.text.indexOf('## Output contract'));
    expect(a.text).toContain(`specHash: ${spec.specHash}`);
    expect(a.text).toContain('T1-create');
    expect(a.text).toContain('AC-001');
    expect(a.text).toContain('Given no todos exist');
    expect(a.dropped).toEqual([]);
    expect(a.tokens).toBe(estimateTokens(a.text));
  });

  it('includes optional sections when given, in order', () => {
    const pack = buildContextPack({
      ...base,
      objectives: ['Users can manage todo items'],
      techSpecExcerpt: 'POST /todos creates an item.',
      adrs: [{ id: 'ADR-001', title: 'Stack', text: 'Node 22 + Fastify' }],
      assumptions: ['T1: titles are trimmed (SM, 2026-09-24)'],
      handoffs: [{ taskId: 'T0-scaffold', title: 'Scaffold', summary: 'Project skeleton with Fastify server', changedFiles: ['package.json', 'src/index.ts'], mergedAt: '2026-09-24T10:00:00Z' }],
      code: { source: 'graph', nodes: [{ label: 'createTodo()', file: 'src/todos/create.ts', line: 10 }], affected: [{ label: 'router.ts', relation: 'imports', file: 'src/router.ts', line: 3 }], truncated: false },
      retrieval: [{ chunkId: 'spec-001#2', docId: 'spec-001', kind: 'spec', title: 'Spec 1', heading: 'Decisions', snippet: 'max [discount] 5', text: 'The maximum discount is 5 percent.', score: 1 }],
      currentDocs: 'Current docs/README.md:\n# Todo',
      feedback: 'Gate unit-test failed: [AC-001] returns 500',
      changeSet: 'Changed files:\nsrc/todos/create.ts',
    });
    expect(pack.sections).toEqual([...SECTION_ORDER]);
    expect(pack.text.indexOf('## Current docs on main')).toBeGreaterThan(pack.text.indexOf('## Retrieved context'));
    expect(pack.text.indexOf('## Feedback')).toBeGreaterThan(pack.text.indexOf('## Current docs on main'));
    expect(pack.text).toContain('src/todos/create.ts:10');
    expect(pack.text).toContain('router.ts [imports]');
    expect(pack.text).toContain('Spec 1 › Decisions');
    expect(pack.text.indexOf('## Feedback')).toBeGreaterThan(pack.text.indexOf('## Retrieved context'));
    expect(pack.text.indexOf('## Change set under review')).toBeGreaterThan(pack.text.indexOf('## Feedback'));
  });

  it("names a task's service in its section, and nothing for a task of the project repository", () => {
    expect(buildContextPack({ ...base, task: { ...base.task!, service: 'orders' } }).text).toContain('- service: orders');
    expect(buildContextPack(base).text).not.toContain('- service:');
  });

  it('drops the lowest-priority sections whole when over budget and reports them', () => {
    const big = 'x'.repeat(4000);
    const pack = buildContextPack({
      ...base,
      budgetTokens: 1200,
      techSpecExcerpt: big,
      adrs: [{ id: 'ADR-001', title: 'Stack', text: big }],
      retrieval: [{ chunkId: 'c', docId: 'd', kind: 'spec', title: 't', heading: null, snippet: 's', text: big, score: 1 }],
      feedback: 'keep me',
    });
    expect(pack.tokens).toBeLessThanOrEqual(1200);
    expect(pack.dropped).toEqual(['retrieval', 'adrs', 'tech-spec']);
    expect(pack.sections).toEqual(['principles', 'contract', 'task', 'criteria', 'feedback']);
    expect(pack.text).toContain('Dropped for budget: retrieval, adrs, tech-spec');
  });

  it('never drops principles, contract, task or criteria and flags an impossible budget', () => {
    const pack = buildContextPack({ ...base, budgetTokens: 10 });
    expect(pack.sections).toEqual([...NEVER_DROP]);
    expect(pack.dropped).toContain('!over-budget');
    expect(pack.tokens).toBeGreaterThan(10);
  });

  it('keeps the change set whole and outside the budget: only the context around it is trimmed', () => {
    const big = 'x'.repeat(4000);
    const around: ContextPackInput = {
      ...base,
      budgetTokens: 1200,
      techSpecExcerpt: big,
      adrs: [{ id: 'ADR-001', title: 'Stack', text: big }],
      retrieval: [{ chunkId: 'c', docId: 'd', kind: 'spec', title: 't', heading: null, snippet: 's', text: big, score: 1 }],
      feedback: 'keep me',
    };
    // 144k chars, thirty times the budget, with a truncation notice at its end: both must survive.
    const changeSet = `Diff against origin/main:\n${'+ one more line\n'.repeat(9000)}[diff truncated: first 144000 of 200000 characters shown.]`;
    const pack = buildContextPack({ ...around, changeSet });
    expect(pack.text).toContain(changeSet);
    expect(pack.sections).toEqual(['principles', 'contract', 'task', 'criteria', 'feedback', 'change-set']);
    // The change set neither pushes other sections out nor trips the over-budget flag.
    expect(pack.dropped).toEqual(buildContextPack(around).dropped);
    expect(pack.dropped).toEqual(['retrieval', 'adrs', 'tech-spec']);
    expect(pack.tokens).toBe(estimateTokens(pack.text));
    expect(pack.tokens - estimateTokens(changeSet)).toBeLessThanOrEqual(1200);
  });

  it('never drops the change set, not even when the budget is impossible for the rest', () => {
    const pack = buildContextPack({ ...base, budgetTokens: 10, changeSet: 'Diff against origin/main:\n+ x' });
    expect(pack.sections).toEqual([...NEVER_DROP, 'change-set']);
    expect(pack.text).toContain('Diff against origin/main:\n+ x');
    expect(pack.dropped).toEqual(['!over-budget']);
  });

  it('caps handoffs to the newest six and cuts long summaries', () => {
    const handoffs: HandoffSummary[] = Array.from({ length: 10 }, (_, i) => ({
      taskId: `T${i}-x`,
      title: `Task ${i}`,
      summary: `summary ${i} `.repeat(100),
      changedFiles: [`src/${i}.ts`],
      mergedAt: `2026-09-2${i % 10}T0${i}:00:00Z`,
    }));
    const pack = buildContextPack({ ...base, handoffs });
    const start = pack.text.indexOf('## Handoffs');
    const rel = pack.text.slice(start + 3).search(/\n## (?!#)/);
    const section = pack.text.slice(start, rel === -1 ? pack.text.length : start + 3 + rel);
    const ids = [...section.matchAll(/### (T\d+-x)/g)].map((m) => m[1]);
    expect(ids).toHaveLength(6);
    expect(ids[0]).toBe('T9-x');
    expect(section.length).toBeLessThan(6 * 520);
  });

  it('renders the grep fallback and says why the graph was not used', () => {
    const pack = buildContextPack({ ...base, code: { source: 'grep', grep: [{ file: 'src/a.ts', line: 12, text: 'const discount = 5;' }] } });
    expect(pack.text).toContain('code graph unavailable or too thin');
    expect(pack.text).toContain('src/a.ts:12: const discount = 5;');
  });
});
