import { describe, expect, it } from 'vitest';
import { closingChecks, emptyRefineState, type RefineState } from '../../server/refine/state.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';

/** A repository session where every check passes, except the ones a test breaks. */
function greenState(): RefineState {
  const state = emptyRefineState();
  return {
    ...state,
    repositories: true,
    stages: true,
    doneStages: [...DOC_STAGES],
    graphed: [...DOC_STAGES],
    checklist: [{ id: 'po.objectives-verifiable', passed: true, detail: 'ok' }] as never,
    architecture: {
      docsHash: 'd',
      decision: {
        style: 'microservices',
        rationale: 'Two parts.',
        repositories: [
          { name: 'shop-api', responsibility: 'Sells', evidence: { doc: 'project.md', quote: 'sells' } },
          { name: 'shop-web', responsibility: 'Shows', evidence: { doc: 'design.md', quote: 'shows' } },
        ],
        integrations: [],
      },
    },
    backlog: {
      enabled: true,
      detail: true,
      keyIds: true,
      epics: [{ key: 'core', title: 'Core' }],
      items: [
        { key: 'cart', title: 'Cart', epic: 'core', scope: 's', priority: 'P1', rationale: 'r', dependsOn: [], sources: [], size: 'S', rank: 1, repository: 'shop-api' },
        { key: 'catalog', title: 'Catalog', epic: 'core', scope: 's', priority: 'P1', rationale: 'r', dependsOn: ['cart'], sources: [], size: 'S', rank: 2, repository: 'shop-web' },
      ],
      specs: {
        cart: { spec: { acceptanceCriteria: [] } as never, rev: 'r' } as never,
        catalog: { spec: { acceptanceCriteria: [] } as never, rev: 'r' } as never,
      },
      preplans: {
        cart: { inputHash: 'i', specRev: 'r', preplan: { tasks: [] }, issues: [], cycle: 1 } as never,
        catalog: { inputHash: 'i', specRev: 'r', preplan: { tasks: [] }, issues: [], cycle: 1 } as never,
      },
    } as never,
    speckit: {
      status: 'done',
      steps: [
        { command: 'plan', itemKey: 'cart', basis: 'b' },
        { command: 'plan', itemKey: 'catalog', basis: 'b' },
        { command: 'tasks', itemKey: 'cart', basis: 'b' },
        { command: 'tasks', itemKey: 'catalog', basis: 'b' },
      ],
    } as never,
  } as RefineState;
}

const failing = (state: RefineState, architectureCurrent = true) => closingChecks(state, architectureCurrent).filter((c) => !c.ok).map((c) => c.id);

describe('closing checks of a repository session', () => {
  it('says that an empty backlog has no items, not that the architecture and the specs are in place', () => {
    const state = { ...greenState(), backlog: { enabled: true, detail: true, epics: [], items: [], specs: {}, preplans: {} } } as never;
    const checks = closingChecks(state, true);
    expect(checks.find((c) => c.id === 'architecture')).toMatchObject({ ok: false, detail: 'o backlog ainda não tem itens' });
    expect(checks.find((c) => c.id === 'specs')).toMatchObject({ ok: false, detail: 'o backlog ainda não tem itens' });
  });

  it('says in plain words which item fails and which documents to review for it', () => {
    const divergence = { fact: 'porta', a: { file: 'docs/project.md', heading: null, quote: 'x' }, b: { file: 'stack.md', heading: null, quote: 'y' }, fix: 'z' };
    const state = {
      ...greenState(),
      checklist: [
        { id: 'po.no-contradictions', role: 'po', passed: false, detail: '1 divergência', divergences: [divergence] },
        { id: 'po.scope-explicit', role: 'po', passed: false, detail: 'falta escopo' },
      ],
    } as never;
    expect(closingChecks(state, true).find((c) => c.id === 'questions')?.detail).toBe('revise antes de iniciar, nos arquivos indicados: Documentos sem contradições (project.md, stack.md); Escopo explícito (flow.md, briefing.md)');
  });

  it('passes all seven when the documents, the architecture, the specs, the plans and the tasks are in place', () => {
    const checks = closingChecks(greenState(), true);
    expect(checks.map((c) => c.id)).toEqual(['documents', 'architecture', 'specs', 'plans', 'tasks', 'dependencies', 'questions']);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('names the document still out of the graph', () => {
    const state = { ...greenState(), graphed: DOC_STAGES.filter((f) => f !== 'design.md') };
    expect(closingChecks(state, true).find((c) => c.id === 'documents')).toMatchObject({ ok: false, detail: 'faltam: design.md' });
  });

  it('refuses an architecture decided on documents that have changed since', () => {
    expect(failing(greenState(), false)).toEqual(['architecture']);
  });

  it('refuses an item with no repository of the architecture', () => {
    const state = greenState();
    const items = state.backlog!.items.map((i) => (i.key === 'catalog' ? { ...i, repository: 'shop-cli' } : i));
    expect(closingChecks({ ...state, backlog: { ...state.backlog!, items } } as RefineState, true).find((c) => c.id === 'architecture')).toMatchObject({ ok: false, detail: 'itens sem repositório da arquitetura: catalog' });
  });

  it('refuses a plan or a task list that is missing for an item', () => {
    const state = greenState();
    const speckit = { ...state.speckit!, steps: state.speckit!.steps.filter((s) => !(s.command === 'tasks' && s.itemKey === 'catalog')) };
    expect(failing({ ...state, speckit } as RefineState, true)).toEqual(['tasks']);
  });

  it('refuses a dependency that names no item, and a blocking question still open', () => {
    const state = greenState();
    const items = state.backlog!.items.map((i) => (i.key === 'catalog' ? { ...i, dependsOn: ['payments'] } : i));
    expect(failing({ ...state, backlog: { ...state.backlog!, items } } as RefineState, true)).toEqual(['dependencies']);
    const asked = { ...greenState(), questions: [{ questionId: 'q', role: 'sm', text: 'Quem paga?', blocking: true, relatedAcIds: [], cycle: 1, status: 'pending', answer: null }] } as never;
    expect(failing(asked, true)).toEqual(['questions']);
  });
});

describe('closing checks of a follow-on request', () => {
  it('asks no plan and no task list of a spec main already started', () => {
    const state = greenState();
    const withStarted = {
      ...state,
      backlog: { ...state.backlog!, specs: { ...state.backlog!.specs, cart: { spec: { status: 'running', acceptanceCriteria: [] }, rev: 'r' } } },
      speckit: { ...state.speckit!, steps: (state.speckit?.steps ?? []).filter((step) => step.itemKey !== 'cart') },
    } as never;
    expect(failing(withStarted, true)).toEqual([]);
  });
});

describe('the impact check of a follow-on request', () => {
  it('is asked only of a follow-on request, and passes once the impact is made without a broken rule', () => {
    const state = greenState();
    expect(closingChecks(state, true).some((c) => c.id === 'impact')).toBe(false);
    const request: RefineState = { ...state, extension: { requestId: 'hello-001-pedido-1', title: 'T', text: 'Exportar.', at: 'x' } };
    expect(failing(request, true)).toEqual(['impact']);
    const impact = { requestId: 'pedido-1', summary: 's', affected: [], conflicts: [], duplicates: [], dependencies: [], risks: [] };
    expect(failing({ ...request, impact: { inputHash: 'h', impact, issues: [] } }, true)).toEqual([]);
    expect(failing({ ...request, impact: { inputHash: 'h', impact: null, issues: ['o impacto cita a spec x'] } }, true)).toEqual(['impact']);
  });
});
