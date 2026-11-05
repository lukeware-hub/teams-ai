import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ExecutionRedirect, NotFound } from './App.js';
import { Breadcrumb } from './components/Breadcrumb.js';
import { afterStartPath, costsProjectPath, executionPath, projectPath, refinePath, repoPath, runPath, validationPath } from './routes.js';

describe('route builders', () => {
  it('build every destination from ids', () => {
    expect(projectPath('hello-word')).toBe('/projects/hello-word');
    expect(executionPath('hello-word')).toBe('/projects/hello-word#execucao');
    expect(repoPath('p', 'api')).toBe('/projects/p/api');
    expect(refinePath('p', 's')).toBe('/refine/p/s');
    expect(runPath('r1')).toBe('/runs/r1');
    expect(validationPath('r1')).toBe('/runs/r1/validation');
    expect(costsProjectPath('kayron-hub')).toBe('/costs/kayron-hub');
  });

  it('encodes ids that are not path safe', () => {
    expect(runPath('a/b')).toBe('/runs/a%2Fb');
  });

  it('sends a started execution to the project, never to refinement or the old program screen', () => {
    expect(afterStartPath('hello-word')).toBe('/projects/hello-word#execucao');
    expect(afterStartPath('hello-word')).not.toContain('/refine');
    expect(afterStartPath('hello-word')).not.toContain('/program');
  });
});

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}{l.hash}</p>;
}

describe('old execution address', () => {
  it('redirects to the project execution section', () => {
    render(
      <MemoryRouter initialEntries={['/refine/hello-word/hello-word-001/program']}>
        <Routes>
          <Route path="/refine/:projectId/:specId/program" element={<ExecutionRedirect />} />
          <Route path="/projects/:projectId" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/projects/hello-word#execucao');
  });

  it('replaces the entry, so Back leaves to the page before it', () => {
    function Back() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate(-1)}>voltar</button>;
    }
    render(
      <MemoryRouter initialEntries={['/projects', '/refine/p/s/program']} initialIndex={1}>
        <Back />
        <Where />
        <Routes>
          <Route path="/refine/:projectId/:specId/program" element={<ExecutionRedirect />} />
          <Route path="/projects/:projectId" element={null} />
          <Route path="/projects" element={null} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/projects/p#execucao');
    fireEvent.click(screen.getByText('voltar'));
    expect(screen.getByTestId('where').textContent).toBe('/projects');
  });
});

describe('not found', () => {
  it('offers the way back to projects', () => {
    render(<MemoryRouter><NotFound /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Voltar para projetos' }).getAttribute('href')).toBe('/projects');
  });
});

describe('breadcrumb', () => {
  it('always starts at Projetos and links every level above the page', () => {
    render(
      <MemoryRouter>
        <Breadcrumb testId="b" trail={[{ label: 'p', to: '/projects/p', testId: 'b-p' }, { label: 's', testId: 'b-s' }, { label: 'run', testId: 'b-r' }]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('b-home-label').closest('a')?.getAttribute('href')).toBe('/projects');
    expect(screen.getByTestId('b-p').getAttribute('href')).toBe('/projects/p');
    expect(screen.getByTestId('b-r').getAttribute('aria-current')).toBe('page');
  });
});

describe('no loose paths', () => {
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
  it('pages build screen paths only through routes.ts', () => {
    const loose = sources(__dirname).filter((f) => !/routes\.ts$|api\.ts$|App\.tsx$/.test(f)).filter((f) => /[`'"]\/(runs|refine|costs)\/|[`'"]\/projects\/\$\{/.test(readFileSync(f, 'utf8')));
    expect(loose).toEqual([]);
  });
});
