import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ProjectsView } from './Projects.js';

const projects = [
  {
    projectId: 'hello-app',
    dir: '/p/hello',
    specs: [
      { specId: 'hello-001', status: 'running', activeRunId: null },
      { specId: 'hello-002', status: 'running', activeRunId: 'hello-002-r1' },
      { specId: 'hello-000', status: 'done', activeRunId: null },
    ],
  },
];
const runs = {
  'hello-app': [
    { runId: 'hello-002-r1', specId: 'hello-002', projectId: 'hello-app', status: 'running', at: '2026-09-24T10:00:00.000Z', tokens: 1500, cost: 0.25, stoppable: true },
    { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'paused:auth', at: '2026-09-24T09:00:00.000Z', tokens: 100, cost: 0.01, stoppable: false },
    { runId: 'hello-000-r1', specId: 'hello-000', projectId: 'hello-app', status: 'complete', at: '2026-09-23T09:00:00.000Z', tokens: 9000, cost: 3.33, stoppable: false },
  ],
};

describe('ProjectsView', () => {
  it('shows one action per spec status and per run status', () => {
    const on = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), add: vi.fn(), newProject: vi.fn(), newSpec: vi.fn(), cont: vi.fn(), del: vi.fn() };
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} runs={runs} drafts={[]} error={null} onStart={on.start} onResume={on.resume} onStop={on.stop} onAdd={on.add} onNewProject={on.newProject} onNewSpec={on.newSpec} onContinue={on.cont} onDelete={on.del} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('start-hello-001'));
    expect(on.start).toHaveBeenCalledWith('hello-app', 'hello-001');
    expect(screen.getByTestId('open-hello-002').getAttribute('href')).toBe('/runs/hello-002-r1');
    expect(screen.queryByTestId('start-hello-000')).toBeNull();
    fireEvent.click(screen.getByTestId('resume-hello-001-r1'));
    expect(on.resume).toHaveBeenCalledWith('hello-001-r1');
    fireEvent.click(screen.getByTestId('stop-hello-002-r1'));
    expect(on.stop).toHaveBeenCalledWith('hello-002-r1');
    expect(screen.queryByTestId('stop-hello-001-r1')).toBeNull();
    expect(screen.getByText('US$ 3.33')).toBeTruthy();
  });
  it('submits a directory to add and shows the error', () => {
    const onAdd = vi.fn();
    render(
      <MemoryRouter>
        <ProjectsView projects={[]} runs={{}} drafts={[]} error="not a project directory" onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={onAdd} onNewProject={vi.fn()} onNewSpec={vi.fn()} onContinue={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Seus projetos aparecem aqui.')).toBeTruthy();
    expect(screen.queryByLabelText('URL do repositório')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Importar do Git' }));
    fireEvent.change(screen.getByLabelText('URL do repositório'), { target: { value: 'https://github.com/acme/demo.git' } });
    fireEvent.click(screen.getByText('Baixar e adicionar'));
    expect(onAdd).toHaveBeenCalledWith('https://github.com/acme/demo.git');
    expect(screen.getByText('not a project directory')).toBeTruthy();
  });
  it('offers new project, new spec, continue spec and open refinement', () => {
    const on = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), add: vi.fn(), newProject: vi.fn(), newSpec: vi.fn(), cont: vi.fn(), del: vi.fn() };
    const drafts = [
      { projectId: 'hello-app', specId: 'hello-003', state: 'answering' as const, registered: true },
      { projectId: 'fresh', specId: 'fresh-001', state: 'drafting' as const, registered: false },
      { projectId: 'hello-app', specId: 'hello-004', state: 'started' as const, registered: true },
    ];
    render(
      <MemoryRouter>
        <ProjectsView
          projects={projects}
          runs={runs}
          drafts={drafts}
          error={null}
          onStart={on.start}
          onResume={on.resume}
          onStop={on.stop}
          onAdd={on.add}
          onNewProject={on.newProject}
          onNewSpec={on.newSpec}
          onContinue={on.cont}
          onDelete={on.del}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Novo projeto' }));
    fireEvent.change(screen.getByTestId('new-project-id'), { target: { value: 'shop' } });
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Shop' } });
    fireEvent.change(screen.getByTestId('new-project-description'), { target: { value: 'A shop for soap' } });
    fireEvent.click(screen.getByTestId('new-project'));
    expect(on.newProject).toHaveBeenCalledWith('shop', 'Shop', 'A shop for soap');
    fireEvent.change(screen.getByTestId('new-spec-id-hello-app'), { target: { value: 'hello-005' } });
    fireEvent.change(screen.getByTestId('new-spec-description-hello-app'), { target: { value: 'Greet in Portuguese' } });
    fireEvent.click(screen.getByTestId('new-spec-hello-app'));
    expect(on.newSpec).toHaveBeenCalledWith('hello-app', 'hello-005', 'Greet in Portuguese');
    fireEvent.click(screen.getByTestId('continue-hello-000'));
    expect(on.cont).toHaveBeenCalledWith('hello-app', 'hello-000');
    expect(screen.queryByTestId('continue-hello-001')).toBeNull();
    expect(screen.getByTestId('refine-hello-app-hello-003').getAttribute('href')).toBe('/refine/hello-app/hello-003');
    expect(screen.getByTestId('refine-fresh-fresh-001').getAttribute('href')).toBe('/refine/fresh/fresh-001');
    expect(screen.queryByTestId('refine-hello-app-hello-004')).toBeNull();
    fireEvent.click(screen.getByTestId('delete-fresh-fresh-001'));
    expect(screen.getByRole('dialog').textContent).toContain('fresh / fresh-001');
    fireEvent.click(screen.getByTestId('delete-cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(on.del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('delete-hello-app-hello-003'));
    fireEvent.click(screen.getByTestId('delete-confirm'));
    expect(on.del).toHaveBeenCalledWith('hello-app', 'hello-003');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('an awaiting-validation spec links to the validation page of its last run', () => {
    const awaiting = [{ projectId: 'hello-app', dir: '/p/hello', specs: [{ specId: 'hello-009', status: 'awaiting-validation', activeRunId: null }] }];
    const awaitingRuns = { 'hello-app': [{ runId: 'hello-009-r1', specId: 'hello-009', projectId: 'hello-app', status: 'awaiting-validation', at: '2026-09-24T11:00:00.000Z', tokens: 1, cost: 0, stoppable: false }] };
    render(
      <MemoryRouter>
        <ProjectsView projects={awaiting} runs={awaitingRuns} drafts={[]} error={null} onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={vi.fn()} onNewProject={vi.fn()} onNewSpec={vi.fn()} onContinue={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('validate-hello-009').getAttribute('href')).toBe('/runs/hello-009-r1/validation');
  });
  it('opens one creation form at a time and keeps what was typed', () => {
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} runs={runs} drafts={[]} error={null} onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={vi.fn()} onNewProject={vi.fn()} onNewSpec={vi.fn()} onContinue={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    const newProject = screen.getByRole('button', { name: 'Novo projeto' });
    expect(newProject.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(newProject);
    expect(newProject.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByTestId('new-project-id'), { target: { value: 'shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Importar do Git' }));
    expect(newProject.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('new-project-id')).toBeNull();
    expect(screen.getByLabelText('URL do repositório')).toBeTruthy();
    fireEvent.click(newProject);
    expect(screen.queryByLabelText('URL do repositório')).toBeNull();
    expect((screen.getByTestId('new-project-id') as HTMLInputElement).value).toBe('shop');
  });
  it('filters projects by id, directory, spec and run, and clears the filter from the empty state', () => {
    const two = [...projects, { projectId: 'shop', dir: '/p/loja', specs: [{ specId: 'shop-001', status: 'done', activeRunId: null }] }];
    render(
      <MemoryRouter>
        <ProjectsView projects={two} runs={runs} drafts={[]} error={null} onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={vi.fn()} onNewProject={vi.fn()} onNewSpec={vi.fn()} onContinue={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    const filter = screen.getByLabelText('Filtrar projetos') as HTMLInputElement;
    const shown = () => screen.queryAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(shown()).toEqual(['hello-app', 'shop']);
    expect(screen.getByText('2 projetos')).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'LOJA' } });
    expect(shown()).toEqual(['shop']);
    expect(screen.getByText('1 de 2 projetos')).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'hello-000-r1' } });
    expect(shown()).toEqual(['hello-app']);
    fireEvent.change(filter, { target: { value: 'shop-001' } });
    expect(shown()).toEqual(['shop']);
    fireEvent.change(filter, { target: { value: 'nada' } });
    expect(shown()).toEqual([]);
    expect(screen.getByText('Nenhum projeto corresponde a “nada”.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro' }));
    expect(filter.value).toBe('');
    expect(shown()).toEqual(['hello-app', 'shop']);
  });
  it('lists the five latest runs and expands to all of them', () => {
    const seven = { 'hello-app': Array.from({ length: 7 }, (_, i) => ({ runId: `hello-001-r${7 - i}`, specId: 'hello-001', projectId: 'hello-app', status: 'complete', at: null, tokens: 10, cost: 0.1, stoppable: false })) };
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} runs={seven} drafts={[]} error={null} onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={vi.fn()} onNewProject={vi.fn()} onNewSpec={vi.fn()} onContinue={vi.fn()} onDelete={vi.fn()} />
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
});
