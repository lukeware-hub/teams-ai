import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
type Row = Parameters<typeof ProjectHubView>[0]['runs'][number];
const row = (r: Omit<Row, 'kind' | 'n' | 'locked'> & Partial<Row>): Row => ({ kind: 'run', n: 1, locked: false, ...r });
const runs = [
  { runId: 'hello-002-r1', specId: 'hello-002', projectId: 'hello-app', status: 'running', at: '2026-09-24T10:00:00.000Z', tokens: 1500, cost: 0.25, stoppable: true },
  { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'paused:auth', at: '2026-09-24T09:00:00.000Z', tokens: 100, cost: 0.01, stoppable: false },
  { runId: 'hello-000-r1', specId: 'hello-000', projectId: 'hello-app', status: 'complete', at: '2026-09-23T09:00:00.000Z', tokens: 9000, cost: 3.33, stoppable: false },
].map(row);
const on = () => ({ start: vi.fn(), resume: vi.fn(), stop: vi.fn(), newSpec: vi.fn(), cont: vi.fn(), restart: vi.fn(), deleteDraft: vi.fn() });

describe('ProjectHubView', () => {
  it('links to the GitHub repository only when the project has one', () => {
    const o = on();
    const hub = (repoUrl: string | null) => (
      <MemoryRouter>
        <ProjectHubView project={{ ...project, repoUrl }} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>
    );
    const { rerender } = render(hub('https://github.com/acme/hello-app'));
    expect(screen.getByTestId('github-link').getAttribute('href')).toBe('https://github.com/acme/hello-app');
    rerender(hub(null));
    expect(screen.queryByTestId('github-link')).toBeNull();
  });
  it('shows the project header, one action per spec status and per run status', () => {
    const o = on();
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
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
  it('creates a spec from a description: Continuar suggests the id, which stays editable', async () => {
    const o = on();
    const suggest = vi.fn(async () => ({ id: 'user-login' }));
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} onSuggestName={suggest} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('new-spec-description')).toBeNull();
    fireEvent.click(screen.getByTestId('open-new-spec'));
    expect((screen.getByTestId('continue-new-spec') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'Entrar com e-mail e senha' } });
    fireEvent.click(screen.getByTestId('continue-new-spec'));
    await waitFor(() => expect((screen.getByTestId('new-spec-id') as HTMLInputElement).value).toBe('user-login'));
    expect(suggest).toHaveBeenCalledWith({ kind: 'spec', projectId: 'hello-app', name: '', description: 'Entrar com e-mail e senha' });
    fireEvent.change(screen.getByTestId('new-spec-id'), { target: { value: 'user-sign-in' } });
    fireEvent.click(screen.getByTestId('new-spec'));
    expect(o.newSpec).toHaveBeenCalledWith('user-sign-in', 'Entrar com e-mail e senha');
  });
  it('a failed suggestion leaves the id field to fill by hand, and Cancelar closes the panel', async () => {
    const o = on();
    const suggest = vi.fn(async () => {
      throw new Error('IA indisponível');
    });
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} onSuggestName={suggest} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('open-new-spec'));
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'Listar usuários' } });
    fireEvent.click(screen.getByTestId('continue-new-spec'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('IA indisponível'));
    expect((screen.getByTestId('new-spec') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('new-spec-id'), { target: { value: 'list-users' } });
    fireEvent.click(screen.getByTestId('new-spec'));
    expect(o.newSpec).toHaveBeenCalledWith('list-users', 'Listar usuários');
    fireEvent.click(screen.getByTestId('cancel-new-spec'));
    expect(screen.queryByTestId('new-spec-description')).toBeNull();
  });
  it('shows the same breadcrumb as the run page: Projetos › project id', () => {
    const o = on();
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Navegação' });
    expect(nav.querySelector('a')?.getAttribute('href')).toBe('/projects');
    expect(nav.querySelector('strong')?.textContent).toBe('hello-app');
  });
  it('creates a new spec, continues one and opens its refinements, with delete', () => {
    const o = on();
    const drafts = [
      { projectId: 'hello-app', specId: 'hello-003', state: 'answering' as const, registered: true },
    ];
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={drafts} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('open-new-spec'));
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'Greet in Portuguese' } });
    fireEvent.click(screen.getByTestId('continue-new-spec'));
    fireEvent.change(screen.getByTestId('new-spec-id'), { target: { value: 'hello-005' } });
    fireEvent.click(screen.getByTestId('new-spec'));
    expect(o.newSpec).toHaveBeenCalledWith('hello-005', 'Greet in Portuguese');
    expect(screen.queryByTestId('continue-hello-000')).toBeNull(); // a concluded spec is read-only
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
    const awaitingRuns = [row({ runId: 'hello-009-r1', specId: 'hello-009', projectId: 'hello-app', status: 'awaiting-validation', at: '2026-09-24T11:00:00.000Z', tokens: 1, cost: 0, stoppable: false })];
    render(
      <MemoryRouter>
        <ProjectHubView project={awaiting} notFound={false} runs={awaitingRuns} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('validate-hello-009').getAttribute('href')).toBe('/runs/hello-009-r1/validation');
    fireEvent.click(screen.getByTestId('continue-hello-009'));
    expect(o.cont).toHaveBeenCalledWith('hello-009');
  });
  it('restarting an awaiting-validation spec asks first, then calls onRestart', () => {
    const o = on();
    const awaiting = { ...project, specs: [{ specId: 'hello-009', status: 'awaiting-validation', activeRunId: null }, { specId: 'hello-010', status: 'done', activeRunId: null }] };
    render(
      <MemoryRouter>
        <ProjectHubView project={awaiting} notFound={false} runs={[]} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('restart-hello-010')).toBeNull();
    fireEvent.click(screen.getByTestId('restart-hello-009'));
    expect(o.restart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('delete-cancel'));
    expect(o.restart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('restart-hello-009'));
    fireEvent.click(screen.getByTestId('delete-confirm'));
    expect(o.restart).toHaveBeenCalledWith('hello-009');
  });
  it('lists the five latest runs and expands to all of them', () => {
    const o = on();
    const seven = Array.from({ length: 7 }, (_, i) => row({ runId: `hello-001-r${7 - i}`, n: 7 - i, specId: 'hello-001', projectId: 'hello-app', status: 'complete', at: null, tokens: 10, cost: 0.1, stoppable: false }));
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={seven} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    const runLinks = () => screen.queryAllByRole('link').filter((a) => /^\/runs\/hello-001-r\d+$/.test(a.getAttribute('href') ?? '')).map((a) => a.textContent);
    expect(runLinks()).toEqual(['Execução #7', 'Execução #6', 'Execução #5', 'Execução #4', 'Execução #3']);
    const more = screen.getByRole('button', { name: 'Mostrar todas (7)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(runLinks()).toHaveLength(7);
    expect(more.textContent).toBe('Mostrar menos');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(more);
    expect(runLinks()).toHaveLength(5);
  });
  it('a concluded project: counts only agent runs, names each run, locks the old ones and points at a new spec', () => {
    const o = on();
    const concluded = { ...project, specs: [{ specId: 'hello-001', status: 'done', activeRunId: null }] };
    const history = [
      row({ runId: 'hello-app--hello-001--complete-run-1', kind: 'complete', n: 1, locked: true, specId: 'hello-001', projectId: 'hello-app', status: 'done', at: '2026-09-24T12:00:00.000Z', tokens: 0, cost: 0, stoppable: false }),
      row({ runId: 'hello-app--hello-001--run-2', n: 2, locked: true, specId: 'hello-001', projectId: 'hello-app', status: 'interrupted', at: '2026-09-24T11:00:00.000Z', tokens: 10, cost: 0.5, stoppable: false }),
      row({ runId: 'hello-app--hello-001--deploy-run-3', kind: 'deploy', n: 3, specId: 'hello-001', projectId: 'hello-app', status: 'done', at: null, tokens: 0, cost: 0, stoppable: false }),
    ];
    render(
      <MemoryRouter>
        <ProjectHubView project={concluded} notFound={false} runs={history} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    expect(screen.getByText('1 execução')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Conclusão #1' }).getAttribute('title')).toBe('hello-app--hello-001--complete-run-1');
    expect(screen.getByRole('link', { name: 'Deploy #3' })).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy(); // a run with no date yet
    expect(screen.getByTestId('locked-hello-app--hello-001--run-2').textContent).toContain('Somente leitura');
    expect(screen.queryByTestId('resume-hello-app--hello-001--run-2')).toBeNull();
    expect(screen.queryByTestId('locked-hello-app--hello-001--deploy-run-3')).toBeNull();
    expect(screen.queryByTestId('continue-hello-001')).toBeNull();
    expect(screen.queryByTestId('start-hello-001')).toBeNull();
    expect(screen.getByTestId('validation-hello-001').getAttribute('href')).toBe('/runs/hello-app--hello-001--run-2/validation');
    expect(screen.getByTestId('all-concluded').textContent).toContain('nova spec');
    expect(screen.getByTestId('open-new-spec').className).toContain('primary');
  });
  it('shows a not-found state with a link back to Projetos', () => {
    render(
      <MemoryRouter>
        <ProjectHubView project={null} notFound runs={[]} drafts={[]} error={null} deleteError={null} onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onNewSpec={vi.fn()} onContinue={vi.fn()} onRestart={vi.fn()} onDeleteDraft={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Esse projeto não foi encontrado.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para Projetos' }).getAttribute('href')).toBe('/projects');
  });
});
