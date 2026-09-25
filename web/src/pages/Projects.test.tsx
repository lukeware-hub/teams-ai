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
    const on = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), add: vi.fn() };
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} runs={runs} error={null} onStart={on.start} onResume={on.resume} onStop={on.stop} onAdd={on.add} />
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
    expect(screen.getByText('$3.33')).toBeTruthy();
  });
  it('submits a directory to add and shows the error', () => {
    const onAdd = vi.fn();
    render(
      <MemoryRouter>
        <ProjectsView projects={[]} runs={{}} error="not a project directory" onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={onAdd} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), { target: { value: '/x' } });
    fireEvent.click(screen.getByText('Add project'));
    expect(onAdd).toHaveBeenCalledWith('/x');
    expect(screen.getByText('not a project directory')).toBeTruthy();
  });
});
