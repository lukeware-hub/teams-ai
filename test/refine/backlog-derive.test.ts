import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { buildContextPack } from '../../server/knowledge/context-pack.js';
import { backlogPack, postProcessBacklog, renderBacklogMd } from '../../server/refine/backlog.js';
import { fitPackBudget } from '../../server/refine/fit-pack.js';
import type { BacklogState } from '../../server/refine/state.js';
import { makeProject } from '../fixtures/contracts.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const item = (key: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  key, title: `Item ${key}`, epic: 'core', scope: `Entrega ${key}`, priority: 'P1', rationale: 'valor', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'M', ...over,
});
const raw = (items: BacklogItem[]) => ({ project: makeProject(), backlog: { epics: [{ key: 'core', title: 'Core' }], items } });
const previous = (items: BacklogItem[]): BacklogState => ({ enabled: true, project: makeProject(), epics: [{ key: 'core', title: 'Core' }], items: items.map((i, n) => ({ ...i, rank: n + 1 })), cycle: 1 });

const input = (over: Record<string, unknown> = {}) => ({
  specHash: HASH, principles: ['p'], projectMd: '# Projeto', briefMd: '# Briefing\nQuero OPME como P2.', stackMd: '# Stack', flowMd: '# Fluxo\n%% 7. OPME', designMd: '# Design', previous: null, ...over,
});

describe('backlogPack', () => {
  it('puts the five docs, the binding-decisions rule and the output contract in the pack', () => {
    const pack = backlogPack(input());
    expect(pack).toMatchObject({ kind: 'backlog', role: 'po', specHash: HASH });
    expect(pack.feedback).toContain('Quero OPME como P2.');
    expect(pack.feedback).toContain('%% 7. OPME');
    expect(pack.feedback).toMatch(/binding/);
    expect(pack.feedback).toContain('a spec may change several of them');
    expect(pack.feedback).not.toContain('one service per spec');
    expect(pack.outputContract).toContain('"backlog"');
    // The briefing is the target project's docs/briefing.md: the agents cite and read it by that name only.
    expect(pack.feedback).toContain('### briefing.md');
    expect(pack.feedback).not.toContain('brief.md');
  });

  it('lists the previous keys so they stay stable, and the last rejection when there is one', () => {
    const pack = backlogPack(input({ previous: previous([item('base'), item('casos')]), rejection: ['chave reservada: primary'] }));
    expect(pack.feedback).toContain('"base"');
    expect(pack.feedback).toContain('"casos"');
    expect(pack.feedback).toContain('chave reservada: primary');
  });

  it('keeps every doc in the pack once fitted, even for a 50 KB flow', () => {
    const built = buildContextPack(fitPackBudget(backlogPack(input({ flowMd: `%% 1. A\n${'x'.repeat(50_000)}` }))));
    expect(built.dropped).toEqual([]);
  });
});

describe('postProcessBacklog', () => {
  it('returns the project and the items ranked by priority, dependencies first', () => {
    const out = postProcessBacklog(raw([item('a', { dependsOn: ['b'] }), item('b'), item('c', { priority: 'P0' })]), null, '');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.backlog.items.map((i) => [i.key, i.rank])).toEqual([['c', 1], ['b', 2], ['a', 3]]);
  });

  it('reports schema problems with their path', () => {
    const out = postProcessBacklog({ project: makeProject(), backlog: { epics: [{ key: 'core', title: 'Core' }], items: [{ ...item('a'), priority: 'P9' }] } }, null, '');
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.issues.join('\n')).toMatch(/backlog\.items\.0\.priority/);
  });

  it('reports rule violations, including flow sections no item cites', () => {
    const out = postProcessBacklog(raw([item('a', { dependsOn: ['zzz'] })]), null, '%% 3. Faturamento');
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.issues.join('\n')).toMatch(/zzz[\s\S]*Faturamento/);
  });

  it('keeps the previous key when the agent renames an item that has the same title', () => {
    const prev = previous([item('opme', { title: 'Gestão de OPME' })]);
    const out = postProcessBacklog(raw([item('materiais', { title: 'gestão de opme' }), item('outro', { dependsOn: ['materiais'] })]), prev, '');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.backlog.items.map((i) => i.key)).toContain('opme');
      expect(out.value.backlog.items.find((i) => i.key === 'outro')!.dependsOn).toEqual(['opme']);
    }
  });
});

describe('renderBacklogMd', () => {
  it('lists each epic with its ranked items, dependencies and sources', () => {
    const p = previous([item('base', { priority: 'P0', title: 'Fundação' }), item('casos', { dependsOn: ['base'], title: 'Abertura de casos', sources: [{ doc: 'flow.md', heading: '2. Abertura do caso' }] })]);
    const md = renderBacklogMd(p);
    expect(md).toContain('## Core');
    expect(md).toContain('| 1 | P0 | base | M | - |');
    expect(md).toContain('| 2 | P1 | casos | M | base |');
    expect(md).toContain('### casos: Abertura de casos');
    expect(md).toContain('flow.md › 2. Abertura do caso');
    expect(md).toContain('briefing.md › Objectives');
    expect(md).toMatch(/não edite/);
  });
});
