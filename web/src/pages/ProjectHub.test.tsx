import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ProjectHubView } from './ProjectHub.js';

const project = {
  projectId: 'hello-app',
  dir: '/p/hello',
  name: 'Hello app',
  description: 'A tiny HTTP service that greets by name.',
  specs: [
    { specId: 'hello-001', status: 'running', activeRunId: null },
    { specId: 'hello-002', status: 'running', activeRunId: 'hello-002-r1' },
    { specId: 'hello-000', status: 'done', activeRunId: null },
  ],
};
const runs = [
  { runId: 'hello-002-r1', specId: 'hello-002', projectId: 'hello-app', status: 'running', at: '2026-09-24T10:00:00.000Z', tokens: 1500, cost: 0.25, stoppable: true },
  { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'paused:auth', at: '2026-09-24T09:00:00.000Z', tokens: 100, cost: 0.01, stoppable: false },
  { runId: 'hello-000-r1', specId: 'hello-000', projectId: 'hello-app', status: 'complete', at: '2026-09-23T09:00:00.000Z', tokens: 9000, cost: 3.33, stoppable: false },
];
const on = () => ({ start: vi.fn(), resume: vi.fn(), stop: vi.fn(), newSpec: vi.fn(), cont: vi.fn(), deleteDraft: vi.fn() });

describe('ProjectHubView', () => {
  it('shows the project header, one action per spec status and per run status', () => {
    const o = on();
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Hello app' })).toBeTruthy();
    expect(screen.getByText('A tiny HTTP service that greets by name.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('start-hello-001'));
    expect(o.start).toHaveBeenCalledWith('hello-001');
    expect(screen.getByTestId('open-hello-002').getAttribute('href')).toBe('/runs/hello-002-r1');
    expect(screen.queryByTestId('start-hello-000')).toBeNull();
    fireEvent.click(screen.getByTestId('resume-hello-001-r1'));
    expect(o.resume).toHaveBeenCalledWith('hello-001-r1');
    fireEvent.click(screen.getByTestId('stop-hello-002-r1'));
    expect(o.stop).toHaveBeenCalledWith('hello-002-r1');
    expect(screen.queryByTestId('stop-hello-001-r1')).toBeNull();
    expect(screen.getByText('US$ 3.33')).toBeTruthy();
  });
  it('creates a new spec, continues one and opens its refinements, with delete', () => {
    const o = on();
    const drafts = [
      { projectId: 'hello-app', specId: 'hello-003', state: 'answering' as const, registered: true },
    ];
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={drafts} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('new-spec-id'), { target: { value: 'hello-005' } });
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'Greet in Portuguese' } });
    fireEvent.click(screen.getByTestId('new-spec'));
    expect(o.newSpec).toHaveBeenCalledWith('hello-005', 'Greet in Portuguese');
    fireEvent.click(screen.getByTestId('continue-hello-000'));
    expect(o.cont).toHaveBeenCalledWith('hello-000');
    expect(screen.queryByTestId('continue-hello-001')).toBeNull();
    expect(screen.getByTestId('refine-hello-003').getAttribute('href')).toBe('/refine/hello-app/hello-003');
    fireEvent.click(screen.getByTestId('delete-hello-003'));
    expect(screen.getByRole('alertdialog').textContent).toContain('hello-app / hello-003');
    fireEvent.click(screen.getByTestId('delete-confirm'));
    expect(o.deleteDraft).toHaveBeenCalledWith('hello-003');
  });
  it('an awaiting-validation spec links to the validation page of its last run', () => {
    const o = on();
    const awaiting = { ...project, specs: [{ specId: 'hello-009', status: 'awaiting-validation', activeRunId: null }] };
    const awaitingRuns = [{ runId: 'hello-009-r1', specId: 'hello-009', projectId: 'hello-app', status: 'awaiting-validation', at: '2026-09-24T11:00:00.000Z', tokens: 1, cost: 0, stoppable: false }];
    render(
      <MemoryRouter>
        <ProjectHubView project={awaiting} notFound={false} runs={awaitingRuns} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('validate-hello-009').getAttribute('href')).toBe('/runs/hello-009-r1/validation');
  });
  it('lists the five latest runs and expands to all of them', () => {
    const o = on();
    const seven = Array.from({ length: 7 }, (_, i) => ({ runId: `hello-001-r${7 - i}`, specId: 'hello-001', projectId: 'hello-app', status: 'complete', at: null, tokens: 10, cost: 0.1, stoppable: false }));
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={seven} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    const runLinks = () => screen.queryAllByRole('link').filter((a) => /^\/runs\/hello-001-r\d+$/.test(a.getAttribute('href') ?? '')).map((a) => a.textContent);
    expect(runLinks()).toEqual(['hello-001-r7', 'hello-001-r6', 'hello-001-r5', 'hello-001-r4', 'hello-001-r3']);
    const more = screen.getByRole('button', { name: 'Mostrar todas (7)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(runLinks()).toHaveLength(7);
    expect(more.textContent).toBe('Mostrar menos');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(more);
    expect(runLinks()).toHaveLength(5);
  });
  it('shows a not-found state with a link back to Projetos', () => {
    render(
      <MemoryRouter>
        <ProjectHubView project={null} notFound runs={[]} drafts={[]} error={null} deleteError={null} onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onNewSpec={vi.fn()} onContinue={vi.fn()} onDeleteDraft={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Esse projeto não foi encontrado.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para Projetos' }).getAttribute('href')).toBe('/projects');
  });
});
