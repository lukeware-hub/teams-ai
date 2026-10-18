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

const handlers = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onPlanBacklog: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn() });
const renderView = (snap: Snapshot, h = handlers()) => {
  render(<MemoryRouter><RefinementView snap={snap} busy={false} events={[]} {...h} /></MemoryRouter>);
  return h;
};

describe('a new project refines in two mandatory stages', () => {
  it('asks for the backlog once the documents are ready, and keeps the start closed until it exists', () => {
    const h = renderView(project({}));
    expect(screen.getByTestId('plan-backlog').textContent).toBe('Quebrar o backlog (etapa 2)');
    fireEvent.click(screen.getByTestId('plan-backlog'));
    expect(h.onPlanBacklog).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('enable-backlog')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('continues the stopped stage 2, and waits while a blocking question is pending', () => {
    const blocking = { questionId: 'outline-c2-0', role: 'po', text: 'O backlog ainda não fecha: x. Como deve ser tratado?', blocking: true, relatedAcIds: [], cycle: 2, status: 'pending', answer: null };
    const backlog = { enabled: true, detail: false, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
    renderView(project({ status: 'answering', backlog: backlog as never, questions: [blocking as never] }));
    const button = screen.getByTestId('plan-backlog') as HTMLButtonElement;
    expect(button.textContent).toBe('Continuar etapa 2');
    expect(button.disabled).toBe(true);
  });

  it('opens the start only once the backlog is detailed and covered', () => {
    const backlog = { enabled: true, detail: true, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
    renderView(project({ backlog: backlog as never }));
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps a new spec on the single-stage screen: no stage bar and no stage 2 button', () => {
    renderView(project({ mode: 'new-spec' }));
    expect(screen.queryByLabelText('Etapas do refinamento')).toBeNull();
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
  });
});
