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
    const on = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), add: vi.fn(), newProject: vi.fn(), newSpec: vi.fn(), cont: vi.fn() };
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} runs={runs} drafts={[]} error={null} onStart={on.start} onResume={on.resume} onStop={on.stop} onAdd={on.add} onNewProject={on.newProject} onNewSpec={on.newSpec} onContinue={on.cont} />
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
        <ProjectsView projects={[]} runs={{}} drafts={[]} error="not a project directory" onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={onAdd} onNewProject={vi.fn()} onNewSpec={vi.fn()} onContinue={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Caminho da pasta'), { target: { value: '/x' } });
    fireEvent.click(screen.getByText('Adicionar projeto'));
    expect(onAdd).toHaveBeenCalledWith('/x');
    expect(screen.getByText('not a project directory')).toBeTruthy();
  });
  it('offers new project, new spec, continue spec and open refinement', () => {
    const on = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), add: vi.fn(), newProject: vi.fn(), newSpec: vi.fn(), cont: vi.fn() };
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
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('new-project-id'), { target: { value: 'shop' } });
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Shop' } });
    fireEvent.click(screen.getByTestId('new-project'));
    expect(on.newProject).toHaveBeenCalledWith('shop', 'Shop');
    fireEvent.change(screen.getByTestId('new-spec-id-hello-app'), { target: { value: 'hello-005' } });
    fireEvent.click(screen.getByTestId('new-spec-hello-app'));
    expect(on.newSpec).toHaveBeenCalledWith('hello-app', 'hello-005');
    fireEvent.click(screen.getByTestId('continue-hello-000'));
    expect(on.cont).toHaveBeenCalledWith('hello-app', 'hello-000');
    expect(screen.queryByTestId('continue-hello-001')).toBeNull();
    expect(screen.getByTestId('refine-hello-app-hello-003').getAttribute('href')).toBe('/refine/hello-app/hello-003');
    expect(screen.getByTestId('refine-fresh-fresh-001').getAttribute('href')).toBe('/refine/fresh/fresh-001');
    expect(screen.queryByTestId('refine-hello-app-hello-004')).toBeNull();
  });
});
