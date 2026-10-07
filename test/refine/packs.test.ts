import { describe, expect, it } from 'vitest';
import { flowTemplate, stackTemplate } from '../../server/refine/draft.js';
import { fitPackBudget, PACK_TOKEN_CAP } from '../../server/refine/fit-pack.js';
import { refinePack } from '../../server/refine/packs.js';
import type { BacklogState } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';

const base = {
  specHash: 'sha256:' + 'a'.repeat(64),
  principles: [],
  specId: 'spec-1',
  projectMd: '# p',
  briefMd: '# b',
  derived: { project: {}, spec: { acceptanceCriteria: [], objectives: [] } },
  retrieval: [],
  history: [],
  rejected: [],
} as unknown as Parameters<typeof refinePack>[0];

describe('refinePack', () => {
  it('tells the front agent to review only and answer with the JSON object', () => {
    const { feedback } = refinePack({ ...base, role: 'front' });
    expect(feedback).toContain('This is a review, not an implementation task');
    expect(feedback).toContain('do not edit or create files');
  });

  it('asks the SM to fill a blank stack.md and flow.md instead of questioning the human, and keeps the PO out of it', () => {
    const blank = { ...base, stackMd: stackTemplate(), flowMd: flowTemplate() };
    const sm = refinePack({ ...blank, role: 'sm' }).feedback;
    expect(sm).toContain('only the blank template');
    expect(sm).toContain('docs/stack.md');
    expect(sm).toContain('docs/flow.md');
    expect(sm).toContain('Do NOT ask the human');
    const po = refinePack({ ...blank, role: 'po' }).feedback;
    expect(po).toContain('the SM fills them');
    expect(po).not.toContain('Do NOT ask the human');
    // once the files hold real content there is nothing to fill
    expect(refinePack({ ...base, role: 'sm', stackMd: '# Stack\n\n- Node 22\n', flowMd: '# Fluxo\n' }).feedback).not.toContain('only the blank template');
  });

  it('does not add the review-only rule for po', () => {
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('not an implementation task');
  });

  it('reviews the derived backlog instead of a spec in backlog mode, and keeps criteria empty', () => {
    const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'x' }], size: 'S', rank: 1 }], cycle: 1 };
    const pack = refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog, projectBriefing: true, rejected: [{ file: 'brief.md', find: 'old', decision: 'no' }] } as never);
    expect(pack.feedback).toContain('### docs/briefing.md');
    expect(pack.feedback).toContain('Patch files: docs/project.md, docs/briefing.md.');
    expect(pack.feedback).toContain('- docs/briefing.md: "old" → rejected: no');
    expect(pack.feedback).not.toContain('brief.md');
    expect(pack.feedback).toContain('### derived backlog');
    expect(pack.feedback).toContain('"key": "base"');
    expect(pack.feedback).not.toContain('### derived spec.json');
    expect(pack.feedback).toContain('Backlog mode');
    expect(pack.criteria).toEqual([]);
    expect(pack.objectives).toEqual(['Núcleo']);
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('Backlog mode');
  });
});

describe('refinePack in detail mode', () => {
  const H = `sha256:${'1'.repeat(64)}`;
  const REV = `sha256:${'2'.repeat(64)}`;
  const ac = (n: number) => ({ id: `AC-${String(n).padStart(3, '0')}`, given: 'um pedido de OPME aberto pelo médico auditor', when: 'a cotação chega', then: 'o pedido segue para aprovação '.repeat(4), smoke: n % 6 === 1 });
  const detailed = (count: number, changedCycle: number): BacklogState => {
    const items = Array.from({ length: count }, (_, n) => ({ key: `item-${n}`, title: `Item ${n}`, epic: 'core', scope: 'escopo do item '.repeat(8), priority: 'P1' as const, rationale: 'r', dependsOn: [], sources: [{ doc: 'flow.md' as const, heading: `${n}. Seção` }], size: 'M' as const, rank: n + 1 }));
    const criteria = (n: number) => Array.from({ length: 6 }, (_, a) => ac(n * 6 + a + 1));
    return {
      enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items, cycle: 1, detail: true, flowHeadings: [],
      specs: Object.fromEntries(items.map((i, n) => [i.key, { inputHash: H, specId: `k-${i.key}`, rev: REV, spec: { ...makeSpec({ specId: `k-${i.key}` }), acceptanceCriteria: criteria(n) }, issues: [], cycle: n < 3 ? changedCycle : 2 }])),
      preplans: Object.fromEntries(items.map((i, n) => [i.key, { inputHash: H, specRev: REV, issues: [], cycle: 2, preplan: { specId: `k-${i.key}`, specRev: REV, inputHash: H, modules: [{ name: 'opme', purpose: 'p' }], tasks: criteria(n).map((c, t) => ({ id: `P${t + 1}`, title: `Tarefa ${t + 1} do item ${n}`, module: 'opme', owner: 'dev' as const, criteriaRefs: [c.id], dependsOn: [] })), risks: [] } }])),
    } as BacklogState;
  };

  it('reviews a digest of every item and full JSON only for what changed this cycle, within the cap for 60 items and 45k tokens of docs', () => {
    const big = 'x'.repeat(36_000);
    const pack = fitPackBudget(refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog: detailed(60, 5), projectBriefing: true, cycle: 5, projectMd: big, briefMd: big, stackMd: big, flowMd: big, designMd: big } as never));
    expect(pack.budgetTokens).toBeLessThanOrEqual(PACK_TOKEN_CAP);
    expect(pack.feedback).not.toContain('the docs broken into prioritized specs');
    expect(pack.feedback).toContain('[60] P1 item-59: Item 59');
    expect(pack.feedback).toContain('P6 [AC-360] Tarefa 6 do item 59 · opme');
    expect(pack.feedback).toContain('"specId": "k-item-0"');
    expect(pack.feedback).not.toContain('"specId": "k-item-10"');
    expect(pack.feedback).toMatch(/specs change only through the docs/i);
  });

  it('lists the coverage gaps for the agents to resolve', () => {
    const b = detailed(2, 2);
    const pack = refinePack({ ...base, role: 'sm', derived: { project: {}, spec: null }, backlog: { ...b, preplans: { 'item-0': b.preplans!['item-0']! } }, projectBriefing: true, cycle: 3 } as never);
    expect(pack.feedback).toContain('### Coverage gaps');
    expect(pack.feedback).toContain('item item-1: sem pré-plano válido');
  });
});

describe('refinePack digest provenance', () => {
  it('marks a cited section the docs no longer have', () => {
    const H = `sha256:${'1'.repeat(64)}`;
    const item = { key: 'fat', title: 'Faturamento', epic: 'core', scope: 's', priority: 'P2', rationale: 'r', dependsOn: [], sources: [{ doc: 'flow.md', heading: '9. Faturamento' }], size: 'M', rank: 1 };
    const spec = { ...makeSpec({ specId: 'k-fat' }), derivedFrom: { backlogKey: 'fat', inputHash: H, docsHash: H, sources: [{ doc: 'flow.md', heading: '9. Faturamento', hash: null }] } };
    const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [item], cycle: 1, detail: true, flowHeadings: [], specs: { fat: { inputHash: H, specId: 'k-fat', rev: H, spec, issues: [], cycle: 2 } }, preplans: {} };
    const pack = refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog, projectBriefing: true, cycle: 3 } as never);
    expect(pack.feedback).toContain('seção não encontrada: flow.md › 9. Faturamento');
  });
});
