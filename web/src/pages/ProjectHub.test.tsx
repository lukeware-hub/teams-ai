import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { refineApi, runApi, type ProgramView, type ProjectDoc } from '../api.js';
import { appLinks, ProjectHub, ProjectHubView } from './ProjectHub.js';

const project = {
  projectId: 'hello-app',
  dir: '/p/hello',
  name: 'Hello app',
  description: 'A tiny HTTP service that greets by name.',
  specs: [
    { specId: 'hello-001', status: 'running', activeRunId: null },
    { specId: 'hello-002', status: 'running', activeRunId: 'hello-002-r1' },
    { specId: 'hello-000', status: 'done', activeRunId: null },
    { specId: 'hello-003', status: 'planned', activeRunId: null },
  ],
};
type Row = Parameters<typeof ProjectHubView>[0]['runs'][number];
const row = (r: Omit<Row, 'kind' | 'n' | 'locked'> & Partial<Row>): Row => ({ kind: 'run', n: 1, locked: false, ...r });
const runs = [
  { runId: 'hello-002-r1', specId: 'hello-002', projectId: 'hello-app', status: 'running', at: '2026-09-24T10:00:00.000Z', tokens: 1500, cost: 0.25, stoppable: true },
  { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'paused:auth', at: '2026-09-24T09:00:00.000Z', tokens: 100, cost: 0.01, stoppable: false },
  { runId: 'hello-000-r1', specId: 'hello-000', projectId: 'hello-app', status: 'complete', at: '2026-09-23T09:00:00.000Z', tokens: 9000, cost: 3.33, stoppable: false },
].map(row);
const on = () => ({ start: vi.fn(), resume: vi.fn(), stop: vi.fn(), newSpec: vi.fn(), cont: vi.fn(), restart: vi.fn(), validate: vi.fn(), deleteDraft: vi.fn() });

describe('ProjectHub documents', () => {
  const docsOf = (name: string): ProjectDoc[] => [{ file: 'project.md', text: `# ${name}` }];
  const hrefOf = (name: string) => `data:text/markdown;charset=utf-8,${encodeURIComponent(`# ${name}`)}`;
  /** The page at /projects/a, with a button that moves the same mounted page to /projects/b. */
  function Go() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate('/projects/b')}>Ir para b</button>;
  }
  const renderHub = () => render(
    <MemoryRouter initialEntries={['/projects/a']}>
      <Go />
      <Routes><Route path="/projects/:projectId" element={<ProjectHub />} /></Routes>
    </MemoryRouter>,
  );
  const mockPage = (docs: (id: string) => Promise<{ docs: ProjectDoc[] }>) => {
    vi.spyOn(runApi, 'projects').mockResolvedValue([{ ...project, projectId: 'a' }, { ...project, projectId: 'b' }]);
    vi.spyOn(runApi, 'runs').mockResolvedValue([]);
    vi.spyOn(refineApi, 'list').mockResolvedValue([]);
    vi.spyOn(runApi, 'docs').mockImplementation(docs);
  };

  it('keeps the documents of the project on screen when an answer for the project opened before arrives last', async () => {
    const answer: Record<string, (docs: ProjectDoc[]) => void> = {};
    mockPage((id) => new Promise((resolve) => { answer[id] = (docs) => resolve({ docs }); }));
    renderHub();
    await waitFor(() => expect(answer.a).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Ir para b' }));
    await waitFor(() => expect(answer.b).toBeDefined());
    answer.b!(docsOf('B'));
    await waitFor(() => expect(screen.getByTestId('download-project-md').getAttribute('href')).toBe(hrefOf('B')));
    await act(async () => answer.a!(docsOf('A')));
    expect(screen.getByTestId('download-project-md').getAttribute('href')).toBe(hrefOf('B'));
  });

  it('drops the documents of the project left while the documents of the new one load', async () => {
    const answer: Record<string, (docs: ProjectDoc[]) => void> = {};
    mockPage((id) => (id === 'a' ? Promise.resolve({ docs: docsOf('A') }) : new Promise((resolve) => { answer[id] = (docs) => resolve({ docs }); })));
    renderHub();
    await waitFor(() => expect(screen.getByTestId('download-project-md').getAttribute('href')).toBe(hrefOf('A')));
    fireEvent.click(screen.getByRole('button', { name: 'Ir para b' }));
    await waitFor(() => expect(screen.queryByTestId('download-project-md')).toBeNull());
    await waitFor(() => expect(answer.b).toBeDefined());
    answer.b!(docsOf('B'));
    await waitFor(() => expect(screen.getByTestId('download-project-md').getAttribute('href')).toBe(hrefOf('B')));
  });
});

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
  it('lists the services with their repositories and the platform, and nothing for a project without services', () => {
    const o = on();
    const hub = (extra: object) => (
      <MemoryRouter>
        <ProjectHubView project={{ ...project, ...extra }} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>
    );
    const { rerender } = render(hub({ services: [{ name: 'orders', repoUrl: 'https://github.com/acme/shop-orders' }, { name: 'inventory', repoUrl: null }], platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] }));
    expect(screen.getByTestId('project-service-orders').querySelector('a')!.getAttribute('href')).toBe('https://github.com/acme/shop-orders');
    expect(screen.getByTestId('project-service-orders').querySelector('a')!.getAttribute('aria-label')).toBe('Abrir orders no GitHub');
    expect(screen.getByTestId('project-service-inventory').textContent).toContain('Repositório ainda não criado');
    expect(screen.getByTestId('project-platform').textContent).toContain('nats (nats:2.10.22-alpine)');
    rerender(hub({}));
    expect(screen.queryByTestId('project-services')).toBeNull();
  });

  it('offers the main documents to download, and says which one main does not have yet', () => {
    const o = on();
    const hub = (docs: ProjectDoc[] | undefined) => (
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} docs={docs} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>
    );
    const { rerender } = render(hub([{ file: 'project.md', text: '# Hello' }, { file: 'briefing.md', text: null }]));
    const link = screen.getByTestId('download-project-md');
    expect(link.getAttribute('download')).toBe('project.md');
    expect(link.getAttribute('href')).toBe('data:text/markdown;charset=utf-8,%23%20Hello');
    expect(screen.queryByTestId('download-briefing-md')).toBeNull();
    expect(screen.getByTestId('project-doc-briefing.md').textContent).toContain('Ainda não publicado');
    rerender(hub(undefined));
    expect(screen.queryByTestId('project-docs')).toBeNull();
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
    expect(screen.queryByTestId('start-hello-003')).toBeNull();
    expect(screen.getByText('Inicia com o programa do backlog')).toBeTruthy();
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
  it('opens the new spec form straight from a ?novaSpec=1 link and drops the parameter when it closes', () => {
    const o = on();
    const Where = () => <output data-testid="where">{useLocation().search}</output>;
    render(
      <MemoryRouter initialEntries={['/projects/hello-app?novaSpec=1']}>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
        <Where />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('new-spec-description')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cancel-new-spec'));
    expect(screen.queryByTestId('new-spec-description')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('');
  });
  it('a project with no spec teaches the path and offers Nova spec, which opens the form', () => {
    const o = on();
    render(
      <MemoryRouter>
        <ProjectHubView project={{ ...project, specs: [] }} notFound={false} runs={[]} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('no-specs').textContent).toContain('descrever, responder as perguntas e avaliar, iniciar a execução e validar o resultado');
    fireEvent.click(screen.getByTestId('empty-new-spec'));
    expect(screen.getByTestId('new-spec-description')).toBeTruthy();
    expect(screen.queryByTestId('no-specs')).toBeNull();
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
  it('an awaiting-validation spec without a run brings it up on Validar', () => {
    const o = on();
    const awaiting = { ...project, specs: [{ specId: 'hello-009', status: 'awaiting-validation', activeRunId: null }] };
    render(
      <MemoryRouter>
        <ProjectHubView project={awaiting} notFound={false} runs={[]} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onValidate={o.validate} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('validate-hello-009'));
    expect(o.validate).toHaveBeenCalledWith('hello-009');
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
  it('explains every column of the runs table and every status flag, and lets each column sort and filter', () => {
    const o = on();
    const runs = [row({ runId: 'hello-001-r1', n: 1, specId: 'hello-001', projectId: 'hello-app', status: 'deploy-failed', at: null, tokens: 10, cost: 0.1, stoppable: false })];
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    const table = within(screen.getByRole('table'));
    for (const column of ['Execução', 'Spec', 'Quando', 'Status', 'Tokens', 'Custo']) {
      const header = table.getByRole('columnheader', { name: new RegExp(`^${column}`) });
      expect(within(header).getByRole('button', { name: column })).toBeTruthy();
      expect(within(header).getAllByRole('button')).toHaveLength(2);
    }
    expect(table.getByRole('button', { name: 'O serviço não subiu no ambiente local.' })).toBeTruthy();
    expect(screen.getByLabelText('Filtrar execuções')).toBeTruthy();
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
  it('filters the specs by alias and by status, and says when none match', () => {
    const o = on();
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    const specs = within(screen.getByTestId('project-specs'));
    fireEvent.change(specs.getByLabelText('Filtrar especificações'), { target: { value: '003' } });
    expect(specs.getByText('hello-003')).toBeTruthy();
    expect(specs.queryByText('hello-000')).toBeNull();
    expect(screen.getByText('1 de 4')).toBeTruthy();
    fireEvent.change(specs.getByLabelText('Filtrar especificações'), { target: { value: '' } });
    fireEvent.change(specs.getByLabelText('Status'), { target: { value: 'done' } });
    expect(specs.getByText('hello-000')).toBeTruthy();
    expect(specs.queryByText('hello-003')).toBeNull();
    fireEvent.change(specs.getByLabelText('Filtrar especificações'), { target: { value: 'zzz' } });
    expect(specs.getByText('Nenhuma spec corresponde ao filtro.')).toBeTruthy();
    fireEvent.click(specs.getByRole('button', { name: 'Limpar filtros' }));
    expect(specs.getByText('hello-001')).toBeTruthy();
    expect(specs.getByText('hello-003')).toBeTruthy();
  });
  it('groups the specs by who must act next, the human first, and leaves out the empty groups', () => {
    const o = on();
    const grouped = { ...project, specs: [
      { specId: 'hello-010', status: 'done', activeRunId: null },
      { specId: 'hello-011', status: 'awaiting-validation', activeRunId: null },
      { specId: 'hello-012', status: 'planned', activeRunId: null },
    ] };
    const { container } = render(
      <MemoryRouter>
        <ProjectHubView project={grouped} notFound={false} runs={[]} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    const groups = Array.from(container.querySelectorAll('li[role="presentation"]'), (li) => li.textContent);
    expect(groups).toEqual(['Precisam de você', 'Prontas', 'Concluídas']);
    expect(screen.getByTestId('validate-hello-011')).toBeTruthy();
  });
  it('pages the specs ten at a time, and each page shows the group headings of its own rows', () => {
    const o = on();
    const many = [
      { specId: 'hello-000', status: 'awaiting-validation', activeRunId: null },
      ...Array.from({ length: 10 }, (_, i) => ({ specId: `hello-${String(i + 1).padStart(3, '0')}`, status: 'planned', activeRunId: null })),
      { specId: 'hello-011', status: 'done', activeRunId: null },
      { specId: 'hello-012', status: 'done', activeRunId: null },
    ];
    const { container } = render(
      <MemoryRouter>
        <ProjectHubView project={{ ...project, specs: many }} notFound={false} runs={[]} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
    const specs = within(screen.getByTestId('project-specs'));
    const ids = () => specs.queryAllByText(/^hello-\d{3}$/).map((el) => el.textContent);
    const headings = () => Array.from(container.querySelectorAll('li[role="presentation"]'), (li) => li.textContent);
    expect(ids()).toEqual(many.slice(0, 10).map((s) => s.specId));
    expect(headings()).toEqual(['Precisam de você', 'Prontas']);
    expect(specs.getByText('1–10 de 13')).toBeTruthy();
    fireEvent.click(specs.getByRole('button', { name: 'Próxima página' }));
    expect(ids()).toEqual(['hello-010', 'hello-011', 'hello-012']);
    expect(headings()).toEqual(['Prontas', 'Concluídas']);
    expect(specs.getByText('11–13 de 13')).toBeTruthy();
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

describe('project apps', () => {
  const done = { ...project, specs: [{ specId: 'a', status: 'done', activeRunId: null }, { specId: 'b', status: 'complete', activeRunId: null }] };
  const view = (apps: Parameters<typeof ProjectHubView>[0]['apps'], p: Parameters<typeof ProjectHubView>[0]['project'] = done, runs: Parameters<typeof ProjectHubView>[0]['runs'] = [], onStartApp = vi.fn()) => {
    const o = on();
    return render(
      <MemoryRouter>
        <ProjectHubView project={p} notFound={false} runs={runs} drafts={[]} apps={apps} onStartApp={onStartApp} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>,
    );
  };
  it('shows the Web UI and Swagger buttons once every spec is concluded', () => {
    view({ web: 'http://h:20052', swagger: 'http://h:20052/docs' });
    expect(screen.getByTestId('open-web-ui').getAttribute('href')).toBe('http://h:20052');
    expect(screen.getByTestId('open-swagger').getAttribute('href')).toBe('http://h:20052/docs');
  });
  it('shows only the button that exists', () => {
    view({ web: null, swagger: 'http://h:20052/docs' });
    expect(screen.queryByTestId('open-web-ui')).toBeNull();
    expect(screen.getByTestId('open-swagger')).toBeTruthy();
  });
  it('says the app is down when nothing answers', () => {
    view({ web: null, swagger: null });
    expect(screen.getByTestId('apps-offline')).toBeTruthy();
  });
  it('starts the application from the button when nothing answers', () => {
    const start = vi.fn();
    view({ web: null, swagger: null }, done, [], start);
    fireEvent.click(screen.getByTestId('start-app'));
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('disables the button while a run brings the application up', () => {
    view({ web: null, swagger: null }, done, [row({ runId: 'r1', specId: 'b', projectId: 'hello-app', status: 'running', at: null, tokens: 0, cost: 0, stoppable: true, kind: 'deploy' })]);
    expect((screen.getByTestId('start-app') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('start-app').textContent).toBe('Subindo a aplicação…');
  });
  it('shows no start button while the application is up', () => {
    view({ web: 'http://h:20052', swagger: null });
    expect(screen.queryByTestId('start-app')).toBeNull();
  });
  it('stays hidden while a spec is not concluded', () => {
    view({ web: 'http://h:20052', swagger: null }, project);
    expect(screen.queryByTestId('project-apps')).toBeNull();
  });
  it('appLinks needs the service online; Web UI also needs a page on its root', () => {
    const service = { url: 'http://dind:20052', healthcheck: 'ok', smoke: [], port: 20052, kind: 'api' as const, docsPath: '/docs' };
    const report = { service } as unknown as Parameters<typeof appLinks>[0];
    const at = (s: object) => appLinks(report, { checkedAt: '', status: 200, online: false, ...s }, 'h');
    expect(at({ online: true, ui: true })).toEqual({ swagger: 'http://h:20052/docs', web: 'http://h:20052' });
    expect(at({ online: true, ui: false })).toEqual({ swagger: 'http://h:20052/docs', web: null });
    expect(at({ online: false, ui: true })).toEqual({ swagger: null, web: null });
  });
});

describe('the backlog banner on the project page', () => {
  const o = on();
  const view = (extra: object) => (
    <MemoryRouter>
      <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} {...extra} />
    </MemoryRouter>
  );
  it('shows the banner of a backlog whose run lost its process as interrupted', async () => {
    const program: ProgramView = { version: 1, draftId: 'hello-001', status: 'running', updatedAt: '', items: [{ specId: 'hello-001-base', key: 'base', rank: 1, dependsOn: [], status: 'running', runId: 'hello-002-r1', completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0, costUsd: null, interrupted: { runId: 'hello-002-r1' } }] };
    vi.spyOn(refineApi, 'program').mockResolvedValue({ program });
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ state: { backlog: { items: [{ key: 'base', title: 'Fundação' }] } } } as never);
    vi.spyOn(runApi, 'run').mockResolvedValue({ phase: 4 } as never);
    render(view({ backlogs: ['hello-001'] }));
    expect(await screen.findByText(/Backlog interrompido · 0 de 1 concluída/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Interrompida: Fundação · 4 · Verificação');
  });
  it('puts the runs right after the backlog banner, before the specs', async () => {
    const program: ProgramView = { version: 1, draftId: 'hello-001', status: 'running', updatedAt: '', items: [{ specId: 'hello-001-base', key: 'base', rank: 1, dependsOn: [], status: 'running', runId: 'hello-002-r1', completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0, costUsd: null, interrupted: { runId: 'hello-002-r1' } }] };
    vi.spyOn(refineApi, 'program').mockResolvedValue({ program });
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ state: { backlog: { items: [{ key: 'base', title: 'Fundação' }] } } } as never);
    vi.spyOn(runApi, 'run').mockResolvedValue({ phase: 4 } as never);
    render(view({ backlogs: ['hello-001'] }));
    const banner = await screen.findByText(/Backlog interrompido · 0 de 1 concluída/);
    const runsHeading = screen.getByRole('heading', { name: 'Execuções' });
    expect(banner.compareDocumentPosition(runsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(runsHeading.compareDocumentPosition(screen.getByTestId('project-specs')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  afterEach(() => vi.restoreAllMocks());
});

describe('the attention banner', () => {
  it('shows a run that waits for the owner, with a button to open it', () => {
    const o = on();
    const waiting = [row({ runId: 'hello-003-r1', specId: 'hello-003', projectId: 'hello-app', status: 'awaiting-validation', at: '2026-09-25T10:00:00.000Z', tokens: 10, cost: 0.01, stoppable: false })];
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={waiting} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>
    );
    const banner = screen.getByTestId('attention-banner');
    expect(banner.textContent).toContain('hello-003');
    expect(banner.textContent).toContain('Precisa de você');
    expect(within(banner).getByRole('link', { name: 'Abrir run' })).toBeTruthy();
  });
});
