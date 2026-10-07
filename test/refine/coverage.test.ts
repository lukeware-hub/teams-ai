import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { coverageGaps, coverageMatrix, itemCites } from '../../server/refine/coverage.js';
import type { BacklogState } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';

const H = `sha256:${'1'.repeat(64)}`;
const REV = `sha256:${'2'.repeat(64)}`;
const ac = (id: string) => ({ id, given: 'g', when: 'w', then: 't', smoke: false });
const item = (key: string, sources: BacklogItem['sources'], rank: number) => ({ key, title: key, epic: 'core', scope: 's', priority: 'P1' as const, rationale: 'r', dependsOn: [], sources, size: 'M' as const, rank });
const specRow = (key: string, ids: string[], rev = REV) => ({ inputHash: H, specId: `kayron-001-${key}`, rev, spec: { ...makeSpec({ specId: `kayron-001-${key}` }), acceptanceCriteria: ids.map(ac) }, issues: [], cycle: 2 });
const preplanRow = (tasks: Array<[string, string[]]>, specRev = REV) => ({
  inputHash: H, specRev, issues: [], cycle: 2,
  preplan: { specId: 'x', specRev, inputHash: H, modules: [{ name: 'm', purpose: 'p' }], tasks: tasks.map(([id, refs]) => ({ id, title: id, module: 'm', owner: 'dev' as const, criteriaRefs: refs, dependsOn: [] })), risks: [] },
});
const backlog = (over: Partial<BacklogState> = {}): BacklogState => ({
  enabled: true, project: null, epics: [{ key: 'core', title: 'Core' }], cycle: 2, detail: true, flowHeadings: ['1. Caso', '7. OPME'],
  items: [item('opme', [{ doc: 'flow.md', heading: '7. OPME' }], 1), item('caso', [{ doc: 'flow.md', heading: '1. Caso' }], 2)],
  specs: { opme: specRow('opme', ['AC-047']), caso: specRow('caso', ['AC-048']) },
  preplans: { opme: preplanRow([['P1', ['AC-047']]]), caso: preplanRow([['P1', ['AC-048']]]) },
  ...over,
} as BacklogState);

describe('coverageGaps', () => {
  it('finds nothing in a complete tree: every section, spec, criterion and task accounted for', () => {
    expect(coverageGaps(backlog())).toEqual([]);
  });

  it('lists uncited flow sections first, then each item in rank order', () => {
    const b = backlog({
      flowHeadings: ['1. Caso', '7. OPME', '9. Faturamento'],
      specs: { opme: specRow('opme', ['AC-047', 'AC-049']), caso: { ...specRow('caso', ['AC-048']), spec: null, rev: null, issues: ['x'] } },
      preplans: { opme: preplanRow([['P1', ['AC-047', 'AC-099']]]) },
    });
    expect(coverageGaps(b)).toEqual([
      'seção do flow.md sem nenhum item: "9. Faturamento"',
      'item opme: critério AC-049 sem tarefa no pré-plano',
      'item opme: tarefa P1 cita AC-099, que não é desta spec',
      'item caso: sem spec válida',
    ]);
  });

  it('needs a pre-plan made for the current revision of the spec', () => {
    expect(coverageGaps(backlog({ preplans: { opme: preplanRow([['P1', ['AC-047']]]) } }))).toEqual(['item caso: sem pré-plano válido']);
    expect(coverageGaps(backlog({ specs: { opme: specRow('opme', ['AC-047'], `sha256:${'3'.repeat(64)}`), caso: specRow('caso', ['AC-048']) } }))).toEqual(['item opme: pré-plano desatualizado']);
  });
});

describe('coverageGaps with numbered sections', () => {
  it('does not let an item citing "11. Caso clínico" cover "1. Caso"', () => {
    const b = backlog({ flowHeadings: ['1. Caso', '11. Caso clínico'], detail: false, items: [item('clinico', [{ doc: 'flow.md', heading: '11. Caso clínico' }], 1)] });
    expect(coverageGaps(b)).toContain('seção do flow.md sem nenhum item: "1. Caso"');
  });

  it('counts a citation for the one section it names in a markdown flow', () => {
    const b = backlog({
      flowHeadings: ['1. Caso', 'Pagamento do caso', '3. Pagamento'], detail: false,
      items: [item('caso', [{ doc: 'flow.md', heading: '1. Caso' }], 1), item('pagto', [{ doc: 'flow.md', heading: 'Pagamento do caso' }], 2)],
    });
    expect(coverageGaps(b).filter((g) => g.startsWith('seção'))).toEqual(['seção do flow.md sem nenhum item: "3. Pagamento"']);
  });
});

describe('coverageMatrix', () => {
  it('maps each flow section to the items citing it and each criterion to its pre-plan tasks', () => {
    const m = coverageMatrix(backlog({ flowHeadings: ['1. Caso', '7. OPME', '9. Faturamento'] }));
    expect(m.sections).toEqual([{ heading: '1. Caso', items: ['caso'] }, { heading: '7. OPME', items: ['opme'] }, { heading: '9. Faturamento', items: [] }]);
    expect(m.items).toEqual([
      { key: 'opme', specId: 'kayron-001-opme', criteria: [{ id: 'AC-047', tasks: ['P1'] }] },
      { key: 'caso', specId: 'kayron-001-caso', criteria: [{ id: 'AC-048', tasks: ['P1'] }] },
    ]);
  });
});

describe('itemCites', () => {
  it('reads flow.md citations only, leniently', () => {
    expect(itemCites(item('a', [{ doc: 'flow.md', heading: '7 opme' }], 1), '7. OPME', ['7. OPME'])).toBe(true);
    expect(itemCites(item('a', [{ doc: 'briefing.md', heading: '7. OPME' }], 1), '7. OPME', ['7. OPME'])).toBe(false);
  });

  it('loads in the browser: no node: imports and only type imports of the hashing contracts', async () => {
    const src = await fs.readFile('server/refine/coverage.ts', 'utf8');
    expect(src).not.toMatch(/from 'node:/);
    expect(src).not.toMatch(/^import \{[^}]*\} from '\.\.\/contracts\/spec\.js'/m);
  });
});
