import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Item, type Snapshot, type Status } from '../api.js';
import type { StoredEvent } from '../api.js';
import { JevActions, RefinementView } from './Refinement.js';

const green = (ids: string[]) => ids.map((id) => ({ id, role: (id.startsWith('po') ? 'po' : 'sm') as 'po' | 'sm', passed: true, detail: 'ok' }));
const ALL = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];

const base = (over: Partial<Snapshot['state']>): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-001',
  docs: { 'project.md': '# Hello', 'brief.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [{ name: 'DB_URL', present: false, hint: null }],
  tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, steps: 3 },
  state: {
    status: 'answering',
    stale: false,
    cycle: 1,
    derived: { spec: { type: 'feature', acceptanceCriteria: [], externalDependencies: [{ name: 'db', secretNames: ['DB_URL'] }] }, project: {} },
    checklist: green(ALL),
    questions: [
      { questionId: 'po-c1-0', role: 'po', text: 'Port?', blocking: true, relatedAcIds: ['AC-001'], cycle: 1, status: 'pending', answer: null },
      { questionId: 'sm-c1-0', role: 'sm', text: 'DB?', blocking: false, relatedAcIds: [], cycle: 1, status: 'pending', answer: null },
    ],
    patches: [{ patchId: 'sm-c1-0', role: 'sm', file: 'brief.md', find: 'a', replace: 'b', reason: 'clearer', diff: '--- brief.md\n-a\n+b\n', cycle: 1, status: 'pending', decision: null }],
    discarded: [{ cycle: 1, role: 'po', file: 'docs/project.md', reason: 'find not found in project.md' }],
    error: null,
    runId: null,
    ...over,
  },
});
const on = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn() });
const event = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq, at: '', runId: 'hello-app/hello-001', specHash: 'draft', type, kind: 'fact', data });

describe('RefinementView re-evaluation', () => {
  const evaluated = event(3, 'REFINE_EVALUATED', { cycle: 1, checklist: [] });

  it('asks before re-evaluating when nothing changed since the last evaluation, and runs it once confirmed', () => {
    const h = on();
    render(<MemoryRouter><RefinementView snap={base({ cycle: 1, status: 'ready', stale: false })} busy={false} events={[evaluated]} {...h} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('evaluate'));
    expect(h.onEvaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reavaliar mesmo assim' }));
    expect(h.onEvaluate).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates at once when a document changed after the last evaluation', () => {
    const h = on();
    const edited = event(4, 'DOC_EDITED', { file: 'brief.md' });
    render(<MemoryRouter><RefinementView snap={base({ cycle: 1, status: 'ready', stale: false })} busy={false} events={[evaluated, edited]} {...h} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('evaluate'));
    expect(h.onEvaluate).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates at once after a detailing was requested, because that request is new work', () => {
    const h = on();
    const detailRequested = event(4, 'BACKLOG_DETAIL_ENABLED', {});
    render(<MemoryRouter><RefinementView snap={base({ cycle: 1, status: 'ready', stale: false })} busy={false} events={[evaluated, detailRequested]} {...h} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('evaluate'));
    expect(h.onEvaluate).toHaveBeenCalledTimes(1);
  });
});

describe('RefinementView divergences', () => {
  const divergence = {
    fact: 'porta da API',
    a: { file: 'brief.md', heading: 'Porta', quote: 'A API responde na porta 8080' },
    b: { file: 'flow.md', heading: '1. Entrada', quote: 'chama a API pela porta 18080' },
    fix: 'Alinhe a porta nos dois documentos.',
  };
  const red = (over: object) => green(ALL).map((c) => (c.id === 'po.no-contradictions' ? { ...c, passed: false, detail: '1 divergência comprovada.', ...over } : c));

  it('shows each verified divergence under a red item, with both places, the quotes and the fix', () => {
    render(<MemoryRouter><RefinementView snap={base({ checklist: red({ divergences: [divergence] }) })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText('porta da API')).toBeTruthy();
    expect(screen.getByText('Onde: briefing.md › Porta — “A API responde na porta 8080” × flow.md › 1. Entrada — “chama a API pela porta 18080”')).toBeTruthy();
    expect(screen.getByText('Como corrigir: Alinhe a porta nos dois documentos.')).toBeTruthy();
  });

  it('gives a plain instruction when the fix is empty, and names the file alone when a side has no heading', () => {
    const bare = { ...divergence, fix: '', a: { ...divergence.a, heading: null } };
    render(<MemoryRouter><RefinementView snap={base({ checklist: red({ divergences: [bare] }) })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/^Onde: briefing\.md — “A API responde na porta 8080”/)).toBeTruthy();
    expect(screen.getByText('Como corrigir: corrija o trecho divergente nos documentos e reavalie.')).toBeTruthy();
  });

  it('shows nothing extra for an item without divergences', () => {
    render(<MemoryRouter><RefinementView snap={base({ checklist: red({}) })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.queryByText(/^Onde:/)).toBeNull();
  });
});

describe('RefinementView secrets', () => {
  it('keeps the browser from filling a saved password into a secret field', () => {
    render(<MemoryRouter><RefinementView snap={base({ status: 'answering' })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByTestId('secret-DB_URL').getAttribute('autocomplete')).toBe('new-password');
  });

  it('saves a secret while an evaluation runs', () => {
    const h = on();
    render(<MemoryRouter><RefinementView snap={base({ status: 'evaluating' })} busy {...h} /></MemoryRouter>);
    fireEvent.change(screen.getByTestId('secret-DB_URL'), { target: { value: 'x' } });
    expect((screen.getByTestId('save-secret-DB_URL') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('save-secret-DB_URL'));
    expect(h.onSecret).toHaveBeenCalledWith('DB_URL', 'x');
  });

  it('saves a secret once the run has started', () => {
    const h = on();
    render(<MemoryRouter><RefinementView snap={base({ status: 'started' })} busy={false} {...h} /></MemoryRouter>);
    fireEvent.change(screen.getByTestId('secret-DB_URL'), { target: { value: 'x' } });
    expect((screen.getByTestId('save-secret-DB_URL') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('save-secret-DB_URL'));
    expect(h.onSecret).toHaveBeenCalledWith('DB_URL', 'x');
  });
});

describe('RefinementView backlog mode', () => {
  const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], cycle: 1, items: [{ key: 'base', title: 'Fundação', epic: 'core', scope: 'Esqueleto', priority: 'P0' as const, rationale: 'tudo depende', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' as const, rank: 1 }] };
  const ready = { status: 'ready' as const, questions: [], patches: [], discarded: [], derived: null };

  // Plan 89 review: once ready a suggestion is optional, the detailing step shows after Detalhar specs, and an approval stands apart.
  const suggestion = { patchId: 'po-c1-0', role: 'po' as const, file: 'brief.md' as const, find: 'a', replace: 'b', reason: 'mais claro', diff: '--- briefing.md\n-a\n+b\n', cycle: 1, status: 'pending' as const, decision: null };
  it('calls a suggestion optional once the outline is ready, and shows the detailing step after Detalhar specs', () => {
    const { rerender } = render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog, patches: [suggestion] })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/As sugestões abaixo são opcionais/)).toBeTruthy();
    expect(screen.queryByText(/aceite ou rejeite cada uma/)).toBeNull();
    rerender(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'drafting', backlog: { ...backlog, detail: true }, patches: [suggestion] })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/Detalhamento pedido/)).toBeTruthy();
    expect(screen.queryByText(/aceite ou rejeite cada uma/)).toBeNull();
  });

  // Plan 90 review: the program waits for pending suggestions, so the screen never promises an auto-start that cannot come.
  it('says a detailed backlog with a pending suggestion starts with Iniciar or once the suggestions are decided', () => {
    const detailed = { ...backlog, detail: true };
    const { rerender } = render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog: detailed, patches: [suggestion] })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/só começa sozinho sem sugestões pendentes/)).toBeTruthy();
    expect(screen.queryByText(/começa sozinho em instantes/)).toBeNull();
    expect(screen.queryByText(/As sugestões abaixo são opcionais/)).toBeNull();
    // Plan 90 review: an evaluation in progress says nothing about the suggestions, and an open question keeps the note.
    rerender(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'evaluating', backlog: detailed, patches: [suggestion] })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.queryByText(/As sugestões abaixo são opcionais/)).toBeNull();
    const open = { questionId: 'po-c1-1', role: 'po' as const, text: 'Cor?', blocking: false, relatedAcIds: [], cycle: 1, status: 'pending' as const, answer: null };
    rerender(<MemoryRouter><RefinementView snap={base({ ...ready, backlog: detailed, questions: [open], patches: [suggestion] })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/As sugestões abaixo são opcionais/)).toBeTruthy();
    // A green list waiting for its detailing calls the suggestions optional too, and the history names an approval as one.
    const approval = { ...suggestion, patchId: 'po-c2-0', find: '', replace: '## Ajuste aprovado: base-ajuste-1\n\nok\n', cycle: 2, status: 'accepted' as const };
    rerender(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'drafting', backlog: detailed, patches: [suggestion, approval] })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/As sugestões abaixo são opcionais/)).toBeTruthy();
    expect(screen.getByText(/Aprovação de ajuste .* → aceita/)).toBeTruthy();
  });

  it('asks the owner to decide an adjustment approval apart from the optional suggestions', () => {
    const approval = { ...suggestion, patchId: 'po-c2-0', find: '', replace: '## Ajuste aprovado: base-ajuste-1\n\nA spec base foi entregue antes da mudança.\n', cycle: 2 };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'answering', backlog, patches: [approval, suggestion] })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/Aprove ou rejeite o ajuste proposto abaixo; as outras sugestões são opcionais\./)).toBeTruthy();
    expect(screen.getByText('Aprovação de ajuste')).toBeTruthy();
    expect(screen.getByText(/Sugestão para/)).toBeTruthy();
  });

  it('offers to break the docs into a backlog, and asks the page to enable it', () => {
    const h = { ...on(), onEnableBacklog: vi.fn() };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog: null })} busy={false} {...h} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('enable-backlog'));
    expect(h.onEnableBacklog).toHaveBeenCalledOnce();
  });

  it('offers specs.json instead of spec.json and tasks, and project.json from the backlog run', () => {
    const withProject = { ...backlog, project: { projectId: 'hello-app' } };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog: withProject })} busy={false} {...on()} /></MemoryRouter>);
    const specs = screen.getByTestId('download-specs-json') as HTMLAnchorElement;
    expect(decodeURIComponent(specs.href)).toContain('"specId": "hello-001-base"');
    expect(screen.queryByTestId('download-spec-json')).toBeNull();
    expect(screen.queryByText(/Nenhuma tarefa gerada/)).toBeNull();
    expect(screen.getByTestId('download-project-json')).toBeTruthy();
  });

  it('offers the base docs as JSON, briefing.json from briefing.md', () => {
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog })} busy={false} {...on()} /></MemoryRouter>);
    for (const name of ['flow-json', 'briefing-json', 'stack-json', 'design-json']) expect(screen.getByTestId(`download-${name}`)).toBeTruthy();
    expect(decodeURIComponent((screen.getByTestId('download-briefing-json') as HTMLAnchorElement).href)).toContain('"doc": "briefing.md"');
  });

  it('shows the backlog and keeps Start disabled even when the session is ready', () => {
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByTestId('item-base')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/backlog está pronto para revisão/i)).toBeTruthy();
    expect(screen.queryByTestId('enable-backlog')).toBeNull();
  });

  it('asks the page to detail a ready outline, and describes the briefing as the project briefing', () => {
    const h = { ...on(), onEnableDetail: vi.fn() };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog })} busy={false} {...h} /></MemoryRouter>);
    expect(screen.getByText(/clique em Detalhar specs/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('detail-specs'));
    expect(h.onEnableDetail).toHaveBeenCalledOnce();
    expect(screen.getByTestId('doc-impact').textContent).toMatch(/Briefing do projeto/);
  });

  it('in detail mode draws the coverage tree, finds question criteria in the item specs, and keeps Start disabled', () => {
    const REV = `sha256:${'2'.repeat(64)}`;
    const spec = { specId: 'hello-001-base', type: 'feature', objectives: ['o'], features: [], acceptanceCriteria: [{ id: 'AC-007', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] };
    const preplan = { specId: 'hello-001-base', specRev: REV, inputHash: 'h', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-007'], dependsOn: [] }], risks: [] };
    const detailed = { ...backlog, detail: true, flowHeadings: [], specs: { base: { inputHash: 'h', specId: 'hello-001-base', rev: REV, spec, issues: [], cycle: 2 } }, preplans: { base: { inputHash: 'h', specRev: REV, preplan, issues: [], cycle: 2 } } };
    const question = { questionId: 'po-c2-0', role: 'po' as const, text: 'Qual porta?', blocking: true, relatedAcIds: ['AC-007'], cycle: 2, status: 'pending' as const, answer: null };
    const { container } = render(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'answering', questions: [question], backlog: detailed as never })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByTestId('spec-tree')).toBeTruthy();
    const criteria = container.querySelector('.question-criteria') as HTMLElement;
    expect(criteria.querySelector('[aria-label^="AC-007: dado o serviço no ar, quando GET /health, então 200"]')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Start for a detailed, ready backlog and asks the page to start the program', () => {
    const REV = `sha256:${'2'.repeat(64)}`;
    const spec = { specId: 'hello-001-base', type: 'feature', objectives: ['o'], features: [], acceptanceCriteria: [{ id: 'AC-007', given: 'g', when: 'w', then: 't', smoke: true }], outOfScope: [], externalDependencies: [] };
    const preplan = { specId: 'hello-001-base', specRev: REV, inputHash: 'h', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-007'], dependsOn: [] }], risks: [] };
    const detailed = { ...backlog, detail: true, flowHeadings: [], specs: { base: { inputHash: 'h', specId: 'hello-001-base', rev: REV, spec, issues: [], cycle: 2 } }, preplans: { base: { inputHash: 'h', specRev: REV, preplan, issues: [], cycle: 2 } } };
    const h = on();
    render(<MemoryRouter><RefinementView snap={base({ ...ready, backlog: detailed as never })} busy={false} {...h} /></MemoryRouter>);
    const start = screen.getByTestId('start') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(h.onStart).toHaveBeenCalledOnce();
    expect(screen.getByText(/o programa começa sozinho em instantes/)).toBeTruthy();
  });

  it('keeps asking for a new evaluation while a requested detail has no specs yet', () => {
    render(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'drafting', backlog: { ...backlog, detail: true } as never })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/Detalhamento pedido: clique em Reavaliar/)).toBeTruthy();
  });

  it('says why a ready backlog did not start by itself in this cycle', () => {
    const detailed = { ...backlog, detail: true, flowHeadings: [], specs: {}, preplans: {} };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, cycle: 2, autoStartFailure: { cycle: 2, reason: 'docker is not reachable' }, backlog: detailed as never })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/O programa não começou sozinho: docker is not reachable/)).toBeTruthy();
  });

  it('a started backlog says the agents are executing it', () => {
    const detailed = { ...backlog, detail: true, flowHeadings: [], specs: {}, preplans: {} };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'started', runId: 'hello-001-base-r1', backlog: detailed as never })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/executando o backlog, até duas specs ao mesmo tempo/)).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('in backlog mode reads criteria from the item specs even with an old single-spec derivation, and says what detailing needs next', () => {
    const REV = `sha256:${'2'.repeat(64)}`;
    const spec = { specId: 'hello-001-base', type: 'feature', objectives: ['o'], features: [], acceptanceCriteria: [{ id: 'AC-007', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] };
    const detailed = { ...backlog, detail: true, flowHeadings: [], specs: { base: { inputHash: 'h', specId: 'hello-001-base', rev: REV, spec, issues: [], cycle: 2 } }, preplans: {} };
    const question = { questionId: 'po-c2-0', role: 'po' as const, text: 'Qual porta?', blocking: false, relatedAcIds: ['AC-007'], cycle: 2, status: 'pending' as const, answer: null };
    const oldSingleSpec = { spec: { type: 'feature' as const, acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: false }], externalDependencies: [] }, project: {} };
    const { container } = render(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'answering', questions: [question], derived: oldSingleSpec, backlog: detailed as never })} busy={false} {...on()} /></MemoryRouter>);
    expect((container.querySelector('.question-criteria') as HTMLElement).querySelector('[aria-label^="AC-007: dado o serviço no ar"]')).toBeTruthy();
    expect(screen.getByLabelText('briefing.md editor')).toBeTruthy();
  });

  it('in detail mode with coverage gaps tells the human to reevaluate and read the gaps', () => {
    const detailed = { ...backlog, detail: true, flowHeadings: [], specs: {}, preplans: {} };
    render(<MemoryRouter><RefinementView snap={base({ ...ready, status: 'drafting', backlog: detailed as never })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/clique em Reavaliar para gerar a spec e o pré-plano de cada item/)).toBeTruthy();
  });

  it('tells which agent details the specs and which pre-plans them', () => {
    const stage = (kind: string, role: string) => {
      const { unmount } = render(
        <MemoryRouter>
          <RefinementView snap={base({ status: 'evaluating', questions: [], patches: [], backlog: { ...backlog, detail: true } as never })} busy events={[event(1, 'REFINE_CYCLE_STARTED', { cycle: 1 }), event(2, 'REFINE_DOCS_VALIDATED', { cycle: 1, available: true }), event(3, 'STEP_STARTED', { stepId: 's1', kind, role, attempt: 1 })]} {...on()} />
        </MemoryRouter>,
      );
      const text = document.body.textContent ?? '';
      unmount();
      return text;
    };
    expect(stage('spec', 'po')).toMatch(/PO está detalhando a spec de cada item do backlog/);
    expect(stage('preplan', 'sm')).toMatch(/SM está fazendo o pré-plano de cada spec/);
    expect(stage('backlog', 'po')).toMatch(/PO está quebrando os documentos em backlog/);
    expect(stage('answer', 'po')).toMatch(/PO e SM estão respondendo, a partir dos documentos/);
  });
});

describe('RefinementView', () => {
  it('shows the blocking question first without a skip button, patches with accept/reject, and disables Start while answering', () => {
    const h = on();
    render(
      <MemoryRouter>
        <RefinementView snap={base({})} busy={false} {...h} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Port?')).toBeTruthy();
    expect(screen.queryByTestId('skip-po-c1-0')).toBeNull();
    fireEvent.change(screen.getByTestId('answer'), { target: { value: '8080' } });
    fireEvent.click(screen.getByTestId('answer-po-c1-0'));
    expect(h.onAnswer).toHaveBeenCalledWith('po-c1-0', '8080', false);
    fireEvent.click(screen.getByTestId('accept-sm-c1-0'));
    expect(h.onAccept).toHaveBeenCalledWith('sm-c1-0');
    expect(screen.getByText(/find not found in project.md/)).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Reavaliar')).toBeTruthy();
  });

  it('lets the owner mark that the documents already answered a question', () => {
    const h = on();
    render(
      <MemoryRouter>
        <RefinementView snap={base({})} busy={false} {...h} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('answer'), { target: { value: 'Está em project.md › Execução: 8080' } });
    fireEvent.click(screen.getByTestId('docs-answered'));
    fireEvent.click(screen.getByTestId('answer-po-c1-0'));
    expect(h.onAnswer).toHaveBeenCalledWith('po-c1-0', 'Está em project.md › Execução: 8080', true);
    expect((screen.getByTestId('docs-answered') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText(/medem quando o Jev pode responder sozinho/)).toBeTruthy();
    // The tip sits beside the mark: a button inside a label is invalid, since a button is itself labelable.
    expect(screen.getByLabelText(/medem quando o Jev pode responder sozinho/).closest('label')).toBeNull();
  });

  it('clears the answer and the mark when the question on screen changes, so neither reaches the wrong question', () => {
    const h = on();
    const view = (questions: Snapshot['state']['questions']) => (
      <MemoryRouter>
        <RefinementView snap={base({ questions })} busy={false} {...h} />
      </MemoryRouter>
    );
    const port = { questionId: 'po-c1-0', role: 'po' as const, text: 'Port?', blocking: true, relatedAcIds: [], cycle: 1, status: 'pending' as const, answer: null };
    const name = { ...port, questionId: 'po-c1-1', text: 'Name?' };
    const { rerender } = render(view([port, name]));
    fireEvent.change(screen.getByTestId('answer'), { target: { value: 'texto para Port?' } });
    fireEvent.click(screen.getByTestId('docs-answered'));
    rerender(view([{ ...port, status: 'answered', answer: '8080', answeredBy: 'po' }, name]));
    expect(screen.getByText('Name?')).toBeTruthy();
    expect((screen.getByTestId('answer') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByTestId('docs-answered') as HTMLInputElement).checked).toBe(false);
  });

  it('shows an answer a role gave from the docs as its assumption', () => {
    const h = on();
    render(
      <MemoryRouter>
        <RefinementView snap={base({ questions: [{ questionId: 'po-c1-0', role: 'po', text: 'Port?', blocking: true, relatedAcIds: [], cycle: 1, status: 'answered', answer: '8080', answeredBy: 'po' }] })} busy={false} {...h} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/suposição do PO, tirada dos documentos/)).toBeTruthy();
  });

  // R11.10 (plan 89): once ready, a pending patch is an optional suggestion: Start stays enabled and nobody is told to decide each one.
  it('keeps Start enabled with a pending suggestion once ready, and calls the suggestions optional', () => {
    const snap = base({ status: 'ready', questions: [] });
    render(
      <MemoryRouter>
        <RefinementView snap={{ ...snap, secrets: [{ name: 'DB_URL', present: true, hint: null }] }} busy={false} {...on()} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/aceite ou rejeite cada uma/)).toBeNull();
    expect(screen.getByText(/As sugestões abaixo são opcionais; aceitar uma pede nova avaliação\./)).toBeTruthy();
  });

  it('saves a doc on blur, enables Start only when ready and not stale, and shows secrets rows', () => {
    const h = on();
    const { rerender } = render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'ready', questions: [], patches: [] })} busy={false} {...h} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('doc-brief.md'), { target: { value: '## Objectives\n- ship' } });
    fireEvent.blur(screen.getByTestId('doc-brief.md'));
    expect(h.onSaveDoc).toHaveBeenCalledWith('brief.md', '## Objectives\n- ship');
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId('secret-DB_URL'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('save-secret-DB_URL'));
    expect(h.onSecret).toHaveBeenCalledWith('DB_URL', 'x');
    rerender(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'ready', stale: true, questions: [], patches: [] })} busy={false} {...h} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('stale')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('locks the editor and the evaluate button while evaluating and leaves cycle errors to the page alert', () => {
    render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'evaluating', questions: [], patches: [] })} busy={true} {...on()} />
      </MemoryRouter>,
    );
    expect((screen.getByTestId('doc-brief.md') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByTestId('evaluate') as HTMLButtonElement).disabled).toBe(true);
    render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'error', error: 'derive: spec.objectives: too small', questions: [], patches: [] })} busy={false} {...on()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/spec.objectives: too small/)).toBeNull();
  });

  it('shows no question and no patch decision while an evaluation runs: the server refuses them, and they show up once it ends', () => {
    const { rerender } = render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'evaluating' })} busy={true} {...on()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('answer')).toBeNull();
    expect(screen.queryByTestId('accept-sm-c1-0')).toBeNull();
    expect(screen.queryByTestId('reject-sm-c1-0')).toBeNull();
    expect(screen.getByText(/aparecem aqui quando a avaliação terminar/)).toBeTruthy();
    rerender(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'answering' })} busy={false} {...on()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('answer')).toBeTruthy();
    expect((screen.getByTestId('accept-sm-c1-0') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('reject-sm-c1-0') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/aparecem aqui quando a avaliação terminar/)).toBeNull();
  });

  it('explains that Jev is required in refinement and keeps re-evaluation available', () => {
    render(
      <MemoryRouter>
        <RefinementView snap={base({ status: 'error', error: 'Jev bloqueou a derivação: flow_covers_scope', questions: [], patches: [] })} busy={false} {...on()} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/O Jev é obrigatório no refinamento/)).toBeTruthy();
    expect((screen.getByTestId('evaluate') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the active Claude step from the refinement journal', () => {
    render(
      <MemoryRouter>
        <RefinementView
          snap={base({ status: 'evaluating', questions: [], patches: [] })}
          busy={true}
          events={[
            event(1, 'REFINE_CYCLE_STARTED', { cycle: 1 }),
            event(2, 'REFINE_DOCS_VALIDATED', { cycle: 1, available: true }),
            event(3, 'STEP_STARTED', { stepId: 'step-1', kind: 'derive', role: 'po', attempt: 1 }),
          ]}
          {...on()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/derivando project\.json e spec\.json/)).toBeTruthy();
  });

  it('turns the evaluation card red when Jev is unavailable', () => {
    render(
      <MemoryRouter>
        <RefinementView
          snap={base({ status: 'evaluating', questions: [], patches: [] })}
          busy={true}
          events={[event(1, 'REFINE_DOCS_VALIDATED', { cycle: 1, available: false })]}
          {...on()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status').className).toContain('bg-bad-soft');
  });

  it('shows the demand type, bug details, and downloadable derived JSON', () => {
    render(
      <MemoryRouter>
        <RefinementView
          snap={base({
            status: 'ready',
            questions: [],
            patches: [],
            derived: {
              project: {},
              spec: {
                type: 'bug',
                bug: { actual: '500', expected: '200', reproduction: 'GET /todos' },
                acceptanceCriteria: [],
                externalDependencies: [],
              },
            },
          })}
          busy={false}
          {...on()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('doc-impact').textContent).toContain('spec.json');
    expect(screen.getByTestId('spec-type').textContent).toContain('Bug');
    expect(screen.getByTestId('bug-details').textContent).toContain('GET /todos');
    expect(screen.getByTestId('download-spec-json').getAttribute('download')).toBe('spec.json');
    expect(screen.getByTestId('download-project-json').getAttribute('download')).toBe('project.json');
  });
});

describe('JevActions', () => {
  const status = (openrouterKey: Item) => ({ items: { openrouterKey }, allOk: false }) as unknown as Status;

  it('links to the OpenRouter onboarding step and reports a failed connection check', async () => {
    vi.spyOn(api, 'status').mockResolvedValue(status({ ok: false, detail: 'OPENROUTER_API_KEY not set' }));
    render(<MemoryRouter><JevActions /></MemoryRouter>);
    expect(screen.getByText('Informar nova chave').getAttribute('href')).toBe('/onboarding?item=openrouter');
    fireEvent.click(screen.getByTestId('jev-validate'));
    expect((await screen.findByTestId('jev-validate-result')).textContent).toContain('Falha na conexão: OPENROUTER_API_KEY not set');
  });

  it('confirms a working connection', async () => {
    vi.spyOn(api, 'status').mockResolvedValue(status({ ok: true, detail: 'ok' }));
    render(<MemoryRouter><JevActions /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('jev-validate'));
    expect((await screen.findByTestId('jev-validate-result')).textContent).toContain('Conexão com o OpenRouter funcionando');
  });
});

describe('RefinementView: a new spec in an existing project', () => {
  it('shows the spec apart from the project context, which changes only with approval', () => {
    const { unmount } = render(<MemoryRouter><RefinementView snap={base({ mode: 'new-spec' })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByTestId('docs-group-spec').textContent).toContain('Spec');
    expect(screen.getByTestId('docs-group-project').textContent).toContain('Contexto do projeto');
    expect(screen.getByTestId('docs-group-project').textContent).toContain('muda só com sua aprovação');
    expect(screen.getByTestId('doc-brief.md')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /\.md$/ }).map((b) => b.textContent)).toEqual(['briefing.md', 'flow.md', 'project.md', 'stack.md', 'design.md']);
    unmount();
    render(<MemoryRouter><RefinementView snap={base({ mode: 'new-project' })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.queryByTestId('docs-group-project')).toBeNull();
    expect(screen.getAllByRole('button', { name: /\.md$/ }).map((b) => b.textContent)).toEqual(['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md']);
  });
});

describe('RefinementView: Anexar imagem', () => {
  it('only on design.md; fills the editor with the adjusted text without saving', async () => {
    const h = { ...on(), onDesignFromImages: vi.fn().mockResolvedValue('# Design ajustado') };
    render(<MemoryRouter><RefinementView snap={base({ mode: 'new-project' })} busy={false} {...h} /></MemoryRouter>);
    expect(screen.queryByTestId('attach-images')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'design.md' }));
    fireEvent.change(screen.getByTestId('attach-images'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await screen.findByDisplayValue('# Design ajustado');
    expect(h.onDesignFromImages).toHaveBeenCalledWith([{ data: 'eA==' }]);
    expect(h.onSaveDoc).not.toHaveBeenCalled();
  });
});

describe('RefinementView: Sugerir', () => {
  it('fills the editor with the suggestion from flow.md without saving, and has no button on flow.md', async () => {
    const h = { ...on(), onSuggestDoc: vi.fn().mockResolvedValue('# Stack sugerida') };
    render(<MemoryRouter><RefinementView snap={base({ mode: 'new-project' })} busy={false} {...h} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'stack.md' }));
    fireEvent.click(screen.getByTestId('suggest'));
    expect(h.onSuggestDoc).toHaveBeenCalledWith('stack.md');
    await screen.findByDisplayValue('# Stack sugerida');
    expect(h.onSaveDoc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'flow.md' }));
    expect(screen.queryByTestId('suggest')).toBeNull();
  });

  it('keeps unsaved text when a reload changes only other documents, and takes the server text when that file changed', () => {
    const snap = base({ mode: 'new-project' });
    const view = (s: Snapshot) => <MemoryRouter><RefinementView snap={s} busy={false} {...on()} /></MemoryRouter>;
    const { rerender } = render(view(snap));
    fireEvent.click(screen.getByRole('button', { name: 'stack.md' }));
    fireEvent.change(screen.getByTestId('doc-stack.md'), { target: { value: '# Stack local' } });
    rerender(view({ ...snap, docs: { ...snap.docs, 'design.md': '# Design aceito' } }));
    expect((screen.getByTestId('doc-stack.md') as HTMLTextAreaElement).value).toBe('# Stack local');
    rerender(view({ ...snap, docs: { ...snap.docs, 'design.md': '# Design aceito', 'stack.md': '# Stack do servidor' } }));
    expect((screen.getByTestId('doc-stack.md') as HTMLTextAreaElement).value).toBe('# Stack do servidor');
  });
});
