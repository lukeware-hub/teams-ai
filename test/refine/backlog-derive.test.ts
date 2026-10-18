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
    expect(pack.feedback).toContain('is cited through the sub-sections the item needs, never whole');
    // Plan 88 review: the item able to check a rule of another section cites that section, so its spec carries the rule.
    expect(pack.feedback).toContain('that later item cites the section too');
    expect(pack.feedback).not.toContain('one service per spec');
    expect(pack.outputContract).toContain('"backlog"');
    // The briefing is the target project's docs/briefing.md: the agents cite and read it by that name only.
    expect(pack.feedback).toContain('### briefing.md');
    expect(pack.feedback).not.toContain('brief.md');
  });

  // Plan 87 review: narrowing a started item's citations reads as a change and asks the owner for an adjustment (R11.7.4).
  it('marks the started items, which keep their sources, and lets a new decision reach an item', () => {
    const pack = backlogPack(input({ previous: previous([item('base'), item('casos')]), started: ['casos'] }));
    const shown = JSON.parse(String(pack.feedback).split('### previous backlog (keep the keys)\n\n')[1]!.split('\n\n### ')[0]!) as { items: Array<{ key: string; started?: boolean }> };
    expect(shown.items.map((i) => [i.key, i.started])).toEqual([['base', undefined], ['casos', true]]);
    expect(pack.feedback).toContain('An item marked `started` keeps its sources');
    expect(pack.feedback).toContain('adding only the citation of each new decision that changes what it delivers');
  });

  it('lists the previous keys so they stay stable, and the last rejection when there is one', () => {
    const pack = backlogPack(input({ previous: previous([item('base'), item('casos')]), rejection: ['chave reservada: primary'] }));
    expect(pack.feedback).toContain('"base"');
    expect(pack.feedback).toContain('"casos"');
    expect(pack.feedback).toContain('chave reservada: primary');
  });

  it('states the 40-character limit of keys and dependsOn', () => {
    expect(backlogPack(input()).feedback).toContain('at most 40 characters');
  });

  it('keeps every doc in the pack once fitted, even for a 50 KB flow', () => {
    const built = buildContextPack(fitPackBudget(backlogPack(input({ flowMd: `%% 1. A\n${'x'.repeat(50_000)}` }))));
    expect(built.dropped).toEqual([]);
  });
});

describe('postProcessBacklog', () => {
  // R11.10 (plan 87): the outline cites the narrowest sections, except a started item, whose sources stay as they were.
  it('sends back a citation of a section made only of sub-sections, unless the item started', () => {
    const docs = { 'briefing.md': '# Briefing\n\n## Decisões\n\n### Prazo\n\n15 dias.\n' };
    const broad = item('fat', { sources: [{ doc: 'briefing.md', heading: 'Decisões' }] });
    expect(postProcessBacklog(raw([item('opme'), broad]), null, docs)).toEqual({ ok: false, issues: ['item fat cita briefing.md › "Decisões", uma seção feita só de subseções; cite as de que o item precisa: "Prazo"'] });
    expect(postProcessBacklog(raw([item('opme'), broad]), null, docs, [], [broad]).ok).toBe(true);
  });

  it('returns the project and the items ranked by priority, dependencies first', () => {
    const out = postProcessBacklog(raw([item('a', { dependsOn: ['b'] }), item('b'), item('c', { priority: 'P0' })]), null, {});
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.backlog.items.map((i) => [i.key, i.rank])).toEqual([['c', 1], ['b', 2], ['a', 3]]);
  });

  it('reports schema problems with their path', () => {
    const out = postProcessBacklog({ project: makeProject(), backlog: { epics: [{ key: 'core', title: 'Core' }], items: [{ ...item('a'), priority: 'P9' }] } }, null, {});
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.issues.join('\n')).toMatch(/backlog\.items\.0\.priority/);
  });

  it('reports a too long dependsOn entry with its value, so the retry can fix it', () => {
    const long = 'a'.repeat(41);
    const out = postProcessBacklog(raw([item('a', { dependsOn: [long] })]), null, {});
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.issues).toEqual([`backlog.items.0.dependsOn.0: Too big: expected string to have <=40 characters (got "${long}")`]);
  });

  it('reports rule violations, including flow sections no item cites', () => {
    const out = postProcessBacklog(raw([item('a', { dependsOn: ['zzz'] })]), null, { 'flow.md': '%% 3. Faturamento' });
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.issues.join('\n')).toMatch(/zzz[\s\S]*Faturamento/);
  });

  it('keeps the previous key when the agent renames an item that has the same title', () => {
    const prev = previous([item('opme', { title: 'Gestão de OPME' })]);
    const out = postProcessBacklog(raw([item('materiais', { title: 'gestão de opme' }), item('outro', { dependsOn: ['materiais'] })]), prev, {});
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.backlog.items.map((i) => i.key)).toContain('opme');
      expect(out.value.backlog.items.find((i) => i.key === 'outro')!.dependsOn).toEqual(['opme']);
    }
  });

  it('keeps a key renamed out of a shared docs branch, even when its title stays', () => {
    const renamed = (prev: BacklogState, items: BacklogItem[]) => {
      const out = postProcessBacklog(raw(items), prev, {});
      return out.ok ? out.value.backlog.items.map((i) => i.key).sort() : out.issues;
    };
    // Both keys came from an earlier cycle, so restoring either previous key shares docs/pricing-plan again.
    const both = previous([item('pricing', { title: 'Preços' }), item('pricing-plan', { title: 'Plano de preços' })]);
    expect(renamed(both, [item('pricing', { title: 'Preços' }), item('pricing-planning', { title: 'Plano de preços' })])).toEqual(['pricing', 'pricing-planning']);
    expect(renamed(both, [item('pricing-core', { title: 'Preços' }), item('pricing-plan', { title: 'Plano de preços' })])).toEqual(['pricing-core', 'pricing-plan']);
    // A new key next to an earlier one: the earlier key the validator blames stays renamed too.
    const one = previous([item('pricing-plan', { title: 'Plano de preços' })]);
    expect(renamed(one, [item('pricing', { title: 'Preços' }), item('pricing-planning', { title: 'Plano de preços' })])).toEqual(['pricing', 'pricing-planning']);
  });

  it('drops any adjustment the agent writes and adds each approved one after its original (R11.7.4)', () => {
    const items = [item('opme'), item('opme-ajuste-1', { title: 'inventado' }), item('caso', { priority: 'P0' })];
    const keys = (approved: string[]) => {
      const out = postProcessBacklog(raw(items), null, {}, approved);
      return out.ok ? out.value.backlog.items.map((i) => [i.key, i.rank, i.title]) : out.issues;
    };
    expect(keys([])).toEqual([['caso', 1, 'Item caso'], ['opme', 2, 'Item opme']]);
    expect(keys(['opme-ajuste-1'])).toEqual([['caso', 1, 'Item caso'], ['opme', 2, 'Item opme'], ['opme-ajuste-1', 3, 'Ajuste 1: Item opme']]);
  });

  // R11.7.5: a started item never leaves on its own; the owner decides through an adjustment whether it goes.
  it('keeps a started item the agent dropped, with only the dependencies still in the outline', () => {
    const out = postProcessBacklog(raw([item('opme'), item('caso', { title: 'reescrito' })]), null, {}, [], [item('fat', { dependsOn: ['opme', 'antigo'] }), item('caso')]);
    expect(out.ok && out.value.backlog.items.map((i) => [i.key, i.title, i.dependsOn])).toEqual([['opme', 'Item opme', []], ['caso', 'reescrito', []], ['fat', 'Item fat', ['opme']]]);
  });

  // Plan 80 review: the backlog views group by epic, so a kept item without its epic would vanish from them.
  it('keeps the epic of a started item whose epic the agent dropped', () => {
    const prev = { ...previous([item('opme')]), epics: [{ key: 'core', title: 'Core' }, { key: 'fin', title: 'Financeiro' }] };
    const out = postProcessBacklog(raw([item('opme')]), prev, {}, [], [item('fat', { epic: 'fin' })]);
    expect(out.ok && out.value.backlog.epics.map((e) => e.key)).toEqual(['core', 'fin']);
  });

  it('keeps a started adjustment whose approval is gone, and puts a later approved one after it', () => {
    const out = postProcessBacklog(raw([item('opme')]), null, {}, ['opme-ajuste-2'], [item('opme-ajuste-1', { title: 'Ajuste 1: Item opme', dependsOn: ['opme'] })]);
    expect(out.ok && out.value.backlog.items.map((i) => [i.key, i.dependsOn])).toEqual([['opme', []], ['opme-ajuste-1', ['opme']], ['opme-ajuste-2', ['opme-ajuste-1']]]);
  });

  // Review of plan 79: run by rank, a dependent of the original must not be built on its old behavior first.
  it('ranks an adjustment right after its original, ahead of the items of its priority that wait on that original', () => {
    const out = postProcessBacklog(raw([item('caso', { priority: 'P0' }), item('opme'), item('fat', { dependsOn: ['opme'] }), item('relatorio')]), null, {}, ['opme-ajuste-1']);
    expect(out.ok && out.value.backlog.items.map((i) => i.key)).toEqual(['caso', 'opme', 'opme-ajuste-1', 'fat', 'relatorio']);
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
