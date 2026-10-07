import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import type { Spec } from '../../server/contracts/spec.js';
import { backlogPack } from '../../server/refine/backlog.js';
import { preplanPack, specPack } from '../../server/refine/detail-packs.js';
import type { BacklogDocs } from '../../server/refine/details.js';
import type { BacklogState } from '../../server/refine/state.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { NUMBERED_MERMAID_FLOW } from '../fixtures/numbered-mermaid-flow.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const item = (key: string, rank: number, over: Partial<BacklogItem> = {}) => ({
  key, title: `Item ${key}`, epic: 'core', scope: `Entrega ${key}`, priority: 'P1' as const, rationale: 'valor', dependsOn: [], sources: [{ doc: 'flow.md' as const, heading: '7. OPME' }], size: 'M' as const, rank, ...over,
});
const docs: BacklogDocs = { 'project.md': '# Clínica\n\n## Personas\n\n- Médico auditor', 'briefing.md': '# Briefing\n\n## Prioridades\n\n- OPME é P2', 'stack.md': '# Stack\n\n- Node 22\n- Postgres 16', 'flow.md': NUMBERED_MERMAID_FLOW, 'design.md': '# Design' };
const ac = (id: string, then: string) => ({ id, given: 'g', when: 'w', then, smoke: false });
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('specPack', () => {
  it('carries the project, each cited section once and nothing uncited, for the PO', () => {
    const opme = item('opme', 2, { dependsOn: ['caso'] });
    const consumo = item('consumo', 3, { sources: [{ doc: 'flow.md', heading: '7. OPME' }, { doc: 'briefing.md', heading: 'Prioridades' }] });
    const caso = item('caso', 1, { sources: [{ doc: 'flow.md', heading: '1. Caso' }] });
    const pack = specPack({ specHash: HASH, principles: ['p'], docs, batch: [opme, consumo], all: [caso, opme, consumo], previous: {}, rejection: {} });
    expect(pack).toMatchObject({ kind: 'spec', role: 'po', specHash: HASH });
    expect(pack.outputContract).toContain('"acceptanceCriteria"');
    expect(pack.feedback).toContain('Médico auditor');
    expect(count(pack.feedback!, '### flow.md › 7. OPME')).toBe(1);
    expect(pack.feedback).toContain('O0[Pedido de OPME] --> O1[Cotação]');
    expect(pack.feedback).toContain('### briefing.md › Prioridades');
    expect(pack.feedback).not.toContain('C0[Abrir caso]');
    expect(pack.feedback).toContain('Entrega caso');
    expect(pack.feedback).toMatch(/do not read files/);
  });

  it('carries the previous criteria with their ids and the last rejection of the item', () => {
    const previous = { ...makeSpec({ specId: 'k-001-opme' }), acceptanceCriteria: [ac('AC-047', 'pedido registrado')] } as Spec;
    const pack = specPack({ specHash: HASH, principles: [], docs, batch: [item('opme', 1)], all: [item('opme', 1)], previous: { opme: previous }, rejection: { opme: ['spec opme.bug: bug details are required for bug specs'] } });
    expect(pack.feedback).toContain('AC-047');
    expect(pack.feedback).toContain('pedido registrado');
    expect(pack.feedback).toContain('bug details are required');
  });

  it('asks for criteria that hold on one shared deploy: relative times and only the data the test creates', () => {
    // Live check: criteria with fixed calendar dates or an empty database failed review cycle after cycle.
    const pack = specPack({ specHash: HASH, principles: [], docs, batch: [item('opme', 1)], all: [item('opme', 1)], previous: {}, rejection: {} });
    expect(pack.feedback).toMatch(/never a fixed calendar date/);
    expect(pack.feedback).toMatch(/never assume an empty database/);
  });
});

describe('preplanPack', () => {
  it('carries stack.md, each spec with its criterion ids, the scaffold carrier, the previous pre-plan and the rejection', () => {
    const spec = { ...makeSpec({ specId: 'k-001-opme' }), acceptanceCriteria: [ac('AC-047', 'pedido registrado'), { ...ac('AC-048', 'saúde ok'), smoke: true }] } as Spec;
    const previous = { specId: 'k-001-opme', specRev: HASH, inputHash: HASH, modules: [{ name: 'opme', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Cadastro antigo', module: 'opme', owner: 'dev' as const, criteriaRefs: ['AC-047'], dependsOn: [] }], risks: [] };
    const pack = preplanPack({ specHash: HASH, principles: [], projectMd: docs['project.md'], stackMd: docs['stack.md'], batch: [{ item: item('opme', 1), spec, first: true, previous, rejection: ['critério AC-048 sem nenhuma tarefa'] }, { item: item('consumo', 2), spec: { ...spec, specId: 'k-001-consumo' }, first: false, previous: null, rejection: [] }] });
    expect(pack).toMatchObject({ kind: 'preplan', role: 'sm', specHash: HASH });
    expect(pack.outputContract).toContain('"criteriaRefs"');
    expect(pack.feedback).toContain('Postgres 16');
    expect(pack.feedback).toContain('AC-048');
    expect(count(pack.feedback!, 'FIRST')).toBeGreaterThanOrEqual(1);
    expect(pack.feedback).toMatch(/opme[^\n]*FIRST/);
    expect(pack.feedback).not.toMatch(/consumo[^\n]*FIRST/);
    expect(pack.feedback).toContain('Cadastro antigo');
    expect(pack.feedback).toContain('critério AC-048 sem nenhuma tarefa');
    expect(pack.feedback).toMatch(/do not read files/);
  });

  it('carries project.md, so the pre-plans follow its technical decisions', () => {
    // A pre-plan without project.md compared dates with the database clock against a "clock port" decided there.
    const projectMd = '# Agenda\n\n## Decisões técnicas\n\n- O serviço lê o horário atual por uma porta de relógio.';
    const pack = preplanPack({ specHash: HASH, principles: [], projectMd, stackMd: docs['stack.md'], batch: [{ item: item('opme', 1), spec: makeSpec({ specId: 'k-001-opme' }), first: true, previous: null, rejection: [] }] });
    expect(pack.feedback).toContain('porta de relógio');
    expect(pack.feedback).toMatch(/technical decisions in project\.md/);
  });
});

describe('backlogPack previous backlog', () => {
  it('carries each item scope and sources, and asks to keep them verbatim when the sources did not change', () => {
    const previous: BacklogState = { enabled: true, project: makeProject(), epics: [{ key: 'core', title: 'Core' }], items: [item('opme', 1, { scope: 'Pedido, cotação e consumo de OPME' })], cycle: 1 };
    const pack = backlogPack({ specHash: HASH, principles: [], projectMd: '# P', briefMd: '# B', previous });
    expect(pack.feedback).toContain('Pedido, cotação e consumo de OPME');
    expect(pack.feedback).toContain('"heading": "7. OPME"');
    expect(pack.feedback).toMatch(/verbatim/);
  });
});
