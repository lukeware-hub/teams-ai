import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api.js';
import { RefinementView } from './Refinement.js';

// These tests are about the backlog screen of a new project, which keeps the review panel.
beforeEach(() => window.history.replaceState(null, '', '/?vista=backlog'));
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

describe('a new project refines in two mandatory stages', () => {
  it('offers one evaluation once the documents are ready, and a start that stays disabled until something is derived', () => {
    const h = renderView(project({}));
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
    expect(screen.getByTestId('evaluate').textContent).toBe('Reavaliar');
    // Nothing changed since the last round, so the button asks first instead of spending a round.
    fireEvent.click(screen.getByTestId('evaluate'));
    expect(screen.getByText('Reavaliar sem mudanças')).toBeTruthy();
    expect(h.onEvaluate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('enable-backlog')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('locks the start together with Reavaliar while the evaluation runs, the backlog included', () => {
    renderView(project({ status: 'evaluating', backlog: backlogOutline as never }));
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('evaluate') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Próximo passo/)).toBeNull();
  });

  it('keeps both buttons while a blocking question is pending: the question comes first, and the start waits for the detailed backlog', () => {
    renderView(project({ status: 'answering', backlog: backlogOutline as never, questions: [question(true) as never] }));
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
    expect((screen.getByTestId('evaluate') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/O backlog depende desta resposta/)).toBeTruthy();
  });

  it('evaluates again once no blocking question is pending', () => {
    renderView(project({ status: 'answering', backlog: backlogOutline as never, questions: [question(false) as never] }));
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
    expect((screen.getByTestId('evaluate') as HTMLButtonElement).disabled).toBe(false);
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

describe('a question offers its choices as buttons', () => {
  const options = [
    { label: 'Citar as subseções', detail: 'O item cita 2.1, 2.2 e 2.3.' },
    { label: 'Citar a seção inteira', detail: 'O item cita 2 por inteiro.', recommended: true },
  ];

  it('fills the answer with the chosen option, and marks the recommended one', () => {
    renderView(project({ status: 'answering', questions: [{ ...question(false), options } as never] }));
    const second = screen.getByRole('radio', { name: /Citar a seção inteira/ });
    fireEvent.click(second);
    expect((screen.getByTestId('answer') as HTMLTextAreaElement).value).toBe('Citar a seção inteira');
    expect(second.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Recomendada')).toBeTruthy();
  });

  it('shows no choices for an open question', () => {
    renderView(project({ status: 'answering', questions: [question(false) as never] }));
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});
