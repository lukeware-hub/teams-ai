import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api.js';
import { RefinementView } from './Refinement.js';

// These tests are about stage 7 of a new project, the screen that prepares the development.
beforeEach(() => window.history.replaceState(null, '', '/?etapa=backlog'));
afterEach(() => window.history.replaceState(null, '', '/'));

const green = (ids: string[]) => ids.map((id) => ({ id, role: (id.startsWith('po') ? 'po' : 'sm') as 'po' | 'sm', passed: true, detail: 'ok' }));
const ALL = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];

/** A project in its refinement, with the documents ready unless the state says otherwise. */
const project = (over: Partial<Snapshot['state']>): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-app-001',
  docs: { 'project.md': '# Hello', 'briefing.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, steps: 3 },
  state: {
    status: 'ready',
    stale: false,
    cycle: 1,
    mode: 'new-project',
    derived: null,
    checklist: green(ALL),
    questions: [],
    patches: [],
    discarded: [],
    error: null,
    runId: null,
    backlog: null,
    ...over,
  } as never,
});

const backlogOutline = { enabled: true, detail: false, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
const backlogItem = { key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 };
const backlogDetailed = { enabled: true, detail: true, epics: [], items: [backlogItem], specs: {}, preplans: {}, flowHeadings: [] };
const question = (blocking: boolean, status = 'pending') => ({ questionId: 'outline-c2-0', role: 'po', text: 'O backlog ainda não fecha: x. Como deve ser tratado?', blocking, relatedAcIds: [], cycle: 2, status, answer: null });

const handlers = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn() });
const renderView = (snap: Snapshot, h = handlers()) => {
  render(<MemoryRouter><RefinementView snap={snap} busy={false} events={[]} {...h} /></MemoryRouter>);
  return h;
};

describe('stage 7 of a new project prepares the development', () => {
  const speckit = (over: Record<string, unknown> = {}) => ({ status: 'done', steps: [], stale: false, ...over });
  const wizard = (over: Partial<Snapshot['state']>) => project({ stages: true, backlog: backlogDetailed as never, ...over });
  const handlersWithSpeckit = () => ({ ...handlers(), onEnableBacklog: vi.fn(), onPrepareSpeckit: vi.fn() });

  it('offers to break the backlog until it exists, with no start', () => {
    const h = renderView(project({ stages: true }), handlersWithSpeckit());
    expect(screen.getByTestId('backlog-stage')).toBeTruthy();
    fireEvent.click(screen.getByTestId('enable-backlog'));
    expect((h as ReturnType<typeof handlersWithSpeckit>).onEnableBacklog).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('start')).toBeNull();
    expect(screen.queryByTestId('evaluate')).toBeNull();
  });

  it('keeps the Spec Kit preparation off until the backlog is detailed', () => {
    renderView(project({ stages: true, backlog: backlogOutline as never }), handlersWithSpeckit());
    expect((screen.getByTestId('speckit-prepare') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for the preparation first, and keeps the start locked until it is done', () => {
    const h = handlersWithSpeckit();
    renderView(wizard({}), h);
    expect(screen.getByTestId('speckit-idle')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('speckit-prepare'));
    expect(h.onPrepareSpeckit).toHaveBeenCalledTimes(1);
  });

  it('shows the progress while the Spec Kit prepares', () => {
    renderView(wizard({ speckit: speckit({ status: 'running', total: 4, steps: [{ command: 'constitution' }, { command: 'specify', itemKey: 'base' }] }) as never }), handlersWithSpeckit());
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    expect(screen.getByTestId('speckit-running').textContent).toContain('Etapa 3 de 4');
    expect((screen.getByTestId('speckit-prepare') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists every step in order: the finished ones with their time, the running one, and the ones to come', () => {
    const finished = { command: 'constitution', startedAt: '2026-10-25T10:00:00Z', endedAt: '2026-10-25T10:01:05Z' };
    renderView(wizard({ speckit: speckit({ status: 'running', startedAt: new Date().toISOString(), total: 5, steps: [finished], current: { command: 'specify', itemKey: 'base' } }) as never }), handlersWithSpeckit());
    expect(screen.getByTestId('speckit-running').textContent).toContain('Etapa 2 de 5: Spec de Base');
    expect(screen.getByTestId('evaluation-timer')).toBeTruthy();
    const rows = [...screen.getByTestId('speckit-steps').querySelectorAll('li')];
    expect(rows.map((row) => row.dataset.state)).toEqual(['done', 'running', 'pending', 'pending', 'pending']);
    expect(rows[0]!.textContent).toContain('1 min 5 s');
    expect(rows[2]!.textContent).toContain('Esclarecimento de Base');
  });

  it('says why a failed preparation stopped, and lets the owner try again', () => {
    renderView(wizard({ speckit: speckit({ status: 'failed', error: 'O Spec Kit não está instalado neste ambiente.' }) as never }), handlersWithSpeckit());
    expect(screen.getByRole('alert').textContent).toContain('não está instalado');
    expect((screen.getByTestId('speckit-prepare') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns that a preparation is out of date and keeps the start locked', () => {
    renderView(wizard({ speckit: speckit({ stale: true }) as never }), handlersWithSpeckit());
    expect(screen.getByTestId('speckit-stale')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens "Iniciar desenvolvimento" once the preparation is done and current', () => {
    const h = handlersWithSpeckit();
    renderView(wizard({ speckit: speckit() as never }), h);
    expect(screen.getByTestId('speckit-done')).toBeTruthy();
    const start = screen.getByTestId('start') as HTMLButtonElement;
    expect(start.textContent).toContain('Iniciar desenvolvimento');
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(h.onStart).toHaveBeenCalledTimes(1);
  });

  it('shows the questions the Spec Kit asked, for the owner to answer, and keeps the start locked while one blocks', () => {
    const asked = { ...question(true), questionId: 'speckit-abc', origin: 'speckit', itemKey: 'base', text: 'Qual banco de dados?' };
    renderView(wizard({ status: 'answering', speckit: speckit() as never, questions: [asked as never] }), handlersWithSpeckit());
    expect(screen.getByText('Qual banco de dados?')).toBeTruthy();
    expect(screen.getByTestId('answer')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a Spec Kit question shows its item and its context, and drops the document checkbox', () => {
    const asked = { ...question(true), questionId: 'speckit-abc', origin: 'speckit', itemKey: 'base', context: 'Sem prazo, o link fica aberto.', text: 'Por quanto tempo vale o link?' };
    renderView(wizard({ speckit: speckit() as never, questions: [asked as never] }), handlersWithSpeckit());
    expect(screen.getByText('Sobre o item Base')).toBeTruthy();
    expect(screen.getByText('Sem prazo, o link fica aberto.')).toBeTruthy();
    expect(screen.getByText('Bloqueia o início do desenvolvimento até você responder.')).toBeTruthy();
    expect(screen.queryByTestId('docs-answered')).toBeNull();
  });

  it('lists the questions the PO and the SM answered from the documents, closed, with the quote of their document', () => {
    const answered = { ...question(true, 'answered'), questionId: 'speckit-xyz', origin: 'speckit', itemKey: 'base', text: 'Qual o prazo?', answer: '90 dias', answeredBy: 'sm', evidence: [{ file: 'briefing.md', heading: 'Regras', quote: 'O link vale por 90 dias.' }] };
    renderView(wizard({ speckit: speckit() as never, questions: [answered as never] }), handlersWithSpeckit());
    const list = screen.getByTestId('agent-answers') as HTMLDetailsElement;
    expect(list.open).toBe(false);
    expect(list.textContent).toContain('Respondidas pelo PO e pelo SM (1)');
    expect(list.textContent).toContain('briefing.md › Regras');
    expect(list.textContent).toContain('O link vale por 90 dias.');
  });

  it('Iniciar is primary only once the preparation is ready, and says what it waits for', () => {
    renderView(wizard({ speckit: undefined as never }), handlersWithSpeckit());
    expect((screen.getByTestId('start') as HTMLButtonElement).className).not.toContain('primary');
    expect(screen.getByTestId('start-reason').textContent).toContain('Prepare o Spec Kit antes de iniciar.');
  });

  it('the steps of a running preparation sit behind a closed list, and a finished step says Feito', () => {
    renderView(wizard({ speckit: speckit({ status: 'running', total: 3, steps: [{ command: 'constitution' }], current: { command: 'specify', itemKey: 'base' } }) as never }), handlersWithSpeckit());
    expect((screen.getByTestId('speckit-log') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('speckit-steps').textContent).toContain('Feito');
    expect(screen.getByTestId('start-reason').textContent).toContain('em andamento');
  });

  it('says the start waits for a blocking Spec Kit question, even when the preparation is done', () => {
    const asked = { ...question(true), questionId: 'speckit-xyz', origin: 'speckit', text: 'Qual banco de dados?' };
    renderView(wizard({ speckit: speckit() as never, questions: [asked as never] }), handlersWithSpeckit());
    expect(screen.getByTestId('speckit-waiting')).toBeTruthy();
    expect(screen.queryByTestId('speckit-done')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the Spec Kit question while the preparation runs, since the server refuses the answer then', () => {
    const asked = { ...question(false), questionId: 'speckit-xyz', origin: 'speckit', text: 'Qual banco de dados?' };
    renderView(wizard({ speckit: speckit({ status: 'running', steps: [], total: 3 }) as never, questions: [asked as never] }), handlersWithSpeckit());
    expect(screen.queryByText('Qual banco de dados?')).toBeNull();
  });

  it('shows only the locked start once the program has started', () => {
    renderView(wizard({ status: 'started', speckit: speckit() as never }), handlersWithSpeckit());
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps a new spec on the single-stage screen: no stage bar and no stage 2 button', () => {
    renderView(project({ mode: 'new-spec' }));
    expect(screen.queryByLabelText('Etapas do refinamento')).toBeNull();
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
  });
});

describe('a question offers its choices as buttons', () => {
  const options = [
    { label: 'Citar as subseções', detail: 'O item cita 2.1, 2.2 e 2.3.' },
    { label: 'Citar a seção inteira', detail: 'O item cita 2 por inteiro.', recommended: true },
  ];

  it('fills the answer with the chosen option, and marks the recommended one', () => {
    renderView(project({ mode: 'new-spec', status: 'answering', questions: [{ ...question(false), options } as never] }));
    const second = screen.getByRole('radio', { name: /Citar a seção inteira/ });
    fireEvent.click(second);
    expect((screen.getByTestId('answer') as HTMLTextAreaElement).value).toBe('Citar a seção inteira');
    expect(second.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Recomendada')).toBeTruthy();
  });

  it('shows no choices for an open question', () => {
    renderView(project({ mode: 'new-spec', status: 'answering', questions: [question(false) as never] }));
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});
