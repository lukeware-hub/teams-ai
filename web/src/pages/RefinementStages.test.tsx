import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api.js';
import { RefinementView } from './Refinement.js';

const green = (ids: string[]) => ids.map((id) => ({ id, role: (id.startsWith('po') ? 'po' : 'sm') as 'po' | 'sm', passed: true, detail: 'ok' }));
const ALL = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];

/** A project in its refinement, with the documents ready unless the state says otherwise. */
const project = (over: Partial<Snapshot['state']>): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-app-001',
  docs: { 'project.md': '# Hello', 'brief.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
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
const backlogDetailed = { enabled: true, detail: true, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
const question = (blocking: boolean, status = 'pending') => ({ questionId: 'outline-c2-0', role: 'po', text: 'O backlog ainda não fecha: x. Como deve ser tratado?', blocking, relatedAcIds: [], cycle: 2, status, answer: null });

const handlers = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onPlanBacklog: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn() });
const renderView = (snap: Snapshot, h = handlers()) => {
  render(<MemoryRouter><RefinementView snap={snap} busy={false} events={[]} {...h} /></MemoryRouter>);
  return h;
};

describe('a new project refines in two mandatory stages', () => {
  it('asks for the backlog once the documents are ready, and shows no start until it exists', () => {
    const h = renderView(project({}));
    expect(screen.getByTestId('plan-backlog').textContent).toBe('Quebrar o backlog (etapa 2)');
    expect(screen.getByTestId('evaluate').textContent).toBe('Reavaliar');
    fireEvent.click(screen.getByTestId('plan-backlog'));
    expect(h.onPlanBacklog).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('enable-backlog')).toBeNull();
    expect(screen.queryByTestId('start')).toBeNull();
  });

  it('shows one locked stage button while stage 2 runs, with no tip and no second action', () => {
    renderView(project({ status: 'evaluating', backlog: backlogOutline as never }));
    const button = screen.getByTestId('plan-backlog') as HTMLButtonElement;
    expect(button.textContent).toBe('Etapa 2 em andamento');
    expect(button.disabled).toBe(true);
    expect(screen.queryByTestId('evaluate')).toBeNull();
    expect(screen.queryByText(/Próximo passo/)).toBeNull();
  });

  it('offers no stage button while a blocking question is pending: the question comes first', () => {
    renderView(project({ status: 'answering', backlog: backlogOutline as never, questions: [question(true) as never] }));
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
    expect(screen.queryByTestId('evaluate')).toBeNull();
    expect(screen.getByText(/O backlog depende desta resposta/)).toBeTruthy();
  });

  it('continues the stopped stage 2 once no blocking question is pending', () => {
    renderView(project({ status: 'answering', backlog: backlogOutline as never, questions: [question(false) as never] }));
    const button = screen.getByTestId('plan-backlog') as HTMLButtonElement;
    expect(button.textContent).toBe('Continuar etapa 2');
    expect(button.disabled).toBe(false);
    expect(screen.getByTestId('evaluate').textContent).toBe('Reavaliar');
  });

  it('opens the start only once the backlog is detailed and covered, as the primary action', () => {
    renderView(project({ backlog: backlogDetailed as never }));
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('evaluate').textContent).toBe('Reavaliar');
  });

  it('shows only the locked start once the program has started', () => {
    renderView(project({ status: 'started', backlog: backlogDetailed as never }));
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
    expect(screen.queryByTestId('evaluate')).toBeNull();
  });

  it('shows the history open, with the number of entries it holds', () => {
    renderView(project({ questions: [{ ...question(false, 'answered'), answer: '8080' } as never] }));
    const history = screen.getByText('Histórico · 1').closest('details') as HTMLDetailsElement;
    expect(history.open).toBe(true);
  });

  it('keeps a new spec on the single-stage screen: no stage bar and no stage 2 button', () => {
    renderView(project({ mode: 'new-spec' }));
    expect(screen.queryByLabelText('Etapas do refinamento')).toBeNull();
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
  });
});
