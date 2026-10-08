import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ProjectsView } from './Projects.js';

const projects = [
  {
    projectId: 'hello-app',
    dir: '/p/hello',
    name: 'Hello app',
    description: 'A tiny HTTP service that greets by name.',
    specs: [
      { specId: 'hello-001', status: 'running', activeRunId: null },
      { specId: 'hello-002', status: 'running', activeRunId: 'hello-002-r1' },
      { specId: 'hello-000', status: 'done', activeRunId: null },
    ],
  },
];
const on = () => ({ add: vi.fn(), newProject: vi.fn(), deleteDraft: vi.fn(), deleteProject: vi.fn() });

describe('ProjectsView', () => {
  it('shows name, description, percent complete and the Abrir/Excluir actions', () => {
    const o = on();
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} drafts={[]} error={null} onAdd={o.add} onNewProject={o.newProject} onDeleteDraft={o.deleteDraft} onDeleteProject={o.deleteProject} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Hello app')).toBeTruthy();
    expect(screen.getByText('A tiny HTTP service that greets by name.')).toBeTruthy();
    expect(screen.getByText('33% concluído', { exact: false })).toBeTruthy();
    expect(screen.getByTestId('open-project-hello-app').getAttribute('href')).toBe('/projects/hello-app');
    fireEvent.click(screen.getByTestId('delete-project-hello-app'));
    expect(screen.getByRole('alertdialog').textContent).toContain('Hello app');
    fireEvent.click(screen.getByTestId('delete-confirm'));
    expect(o.deleteProject).toHaveBeenCalledWith('hello-app');
  });
  it('submits a directory to add and shows the error', () => {
    const o = on();
    render(
      <MemoryRouter>
        <ProjectsView projects={[]} drafts={[]} error="not a project directory" onAdd={o.add} onNewProject={o.newProject} onDeleteDraft={o.deleteDraft} onDeleteProject={o.deleteProject} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Seus projetos aparecem aqui.')).toBeTruthy();
    expect(screen.queryByLabelText('URL do repositório')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Importar do Git' }));
    fireEvent.change(screen.getByLabelText('URL do repositório'), { target: { value: 'https://github.com/acme/demo.git' } });
    fireEvent.click(screen.getByText('Baixar e adicionar'));
    expect(o.add).toHaveBeenCalledWith('https://github.com/acme/demo.git');
    expect(screen.getByText('not a project directory')).toBeTruthy();
  });
  it('creates a new project and offers unregistered drafts with delete and open', () => {
    const o = on();
    const drafts = [
      { projectId: 'hello-app', specId: 'hello-003', state: 'answering' as const, registered: true },
      { projectId: 'fresh', specId: 'fresh-001', state: 'drafting' as const, registered: false },
    ];
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} drafts={drafts} error={null} onAdd={o.add} onNewProject={o.newProject} onDeleteDraft={o.deleteDraft} onDeleteProject={o.deleteProject} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Novo projeto' }));
    fireEvent.change(screen.getByTestId('new-project-id'), { target: { value: 'shop' } });
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Shop' } });
    fireEvent.change(screen.getByTestId('new-project-description'), { target: { value: 'A shop for soap' } });
    fireEvent.click(screen.getByTestId('new-project'));
    expect(o.newProject).toHaveBeenCalledWith('shop', 'Shop', 'A shop for soap');
    // a registered project's own draft (hello-003) is not an "unregistered" one: it lives in the project hub, not here
    expect(screen.queryByTestId('refine-hello-app-hello-003')).toBeNull();
    expect(screen.getByTestId('refine-fresh-fresh-001').getAttribute('href')).toBe('/refine/fresh/fresh-001');
    fireEvent.click(screen.getByTestId('delete-fresh-fresh-001'));
    expect(screen.getByRole('alertdialog').textContent).toContain('fresh / fresh-001');
    fireEvent.click(screen.getByTestId('delete-cancel'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(o.deleteDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('delete-fresh-fresh-001'));
    fireEvent.click(screen.getByTestId('delete-confirm'));
    expect(o.deleteDraft).toHaveBeenCalledWith('fresh', 'fresh-001');
  });
  it('opens one creation form at a time and keeps what was typed', () => {
    const o = on();
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} drafts={[]} error={null} onAdd={o.add} onNewProject={o.newProject} onDeleteDraft={o.deleteDraft} onDeleteProject={o.deleteProject} />
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
  it('filters projects by id, name, description, directory and spec, and clears the filter from the empty state', () => {
    const o = on();
    const two = [...projects, { projectId: 'shop', dir: '/p/loja', name: 'Soap shop', description: 'Sells soap', specs: [{ specId: 'shop-001', status: 'done', activeRunId: null }] }];
    render(
      <MemoryRouter>
        <ProjectsView projects={two} drafts={[]} error={null} onAdd={o.add} onNewProject={o.newProject} onDeleteDraft={o.deleteDraft} onDeleteProject={o.deleteProject} />
      </MemoryRouter>,
    );
    const filter = screen.getByLabelText('Filtrar projetos') as HTMLInputElement;
    const shown = () => screen.queryAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(shown()).toEqual(['Hello app', 'Soap shop']);
    expect(screen.getByText('2 projetos')).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'sells soap' } });
    expect(shown()).toEqual(['Soap shop']);
    expect(screen.getByText('1 de 2 projetos')).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'shop-001' } });
    expect(shown()).toEqual(['Soap shop']);
    fireEvent.change(filter, { target: { value: 'nada' } });
    expect(shown()).toEqual([]);
    expect(screen.getByText('Nenhum projeto corresponde a “nada”.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro' }));
    expect(filter.value).toBe('');
    expect(shown()).toEqual(['Hello app', 'Soap shop']);
  });
});
