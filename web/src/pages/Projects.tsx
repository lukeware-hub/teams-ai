import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { runApi, type ProjectRow, type RunRow } from '../api.js';

const ACTIVE = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);
const money = (n: number) => `$${n.toFixed(2)}`;

export function ProjectsView(p: {
  projects: ProjectRow[];
  runs: Record<string, RunRow[]>;
  error: string | null;
  onStart: (projectId: string, specId: string) => void;
  onResume: (runId: string) => void;
  onStop: (runId: string) => void;
  onAdd: (dir: string) => void;
}) {
  const [dir, setDir] = useState('');
  return (
    <main>
      <h1>Projects</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          p.onAdd(dir);
        }}
      >
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/path/to/project" />
        <button type="submit" disabled={dir.trim() === ''}>
          Add project
        </button>
      </form>
      {p.error ? <p className="error">{p.error}</p> : null}
      {p.projects.map((pr) => (
        <section className="card" key={pr.projectId}>
          <header>
            <h2>{pr.projectId}</h2>
            <code className="hint">{pr.dir}</code>
          </header>
          <table>
            <thead>
              <tr>
                <th>Spec</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pr.specs.map((s) => (
                <tr key={s.specId}>
                  <td>{s.specId}</td>
                  <td>{s.status}</td>
                  <td>
                    {s.activeRunId ? (
                      <Link data-testid={`open-${s.specId}`} to={`/runs/${s.activeRunId}`}>
                        Open run
                      </Link>
                    ) : s.status === 'done' ? null : (
                      <button data-testid={`start-${s.specId}`} onClick={() => p.onStart(pr.projectId, s.specId)}>
                        Start run
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Spec</th>
                <th>Status</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(p.runs[pr.projectId] ?? []).map((r) => (
                <tr key={r.runId}>
                  <td>
                    <Link to={`/runs/${r.runId}`}>{r.runId}</Link>
                  </td>
                  <td>{r.specId}</td>
                  <td>{r.status}</td>
                  <td>{r.tokens}</td>
                  <td>{money(r.cost)}</td>
                  <td className="controls">
                    {r.status === 'paused:auth' || r.status === 'interrupted' ? (
                      <button data-testid={`resume-${r.runId}`} onClick={() => p.onResume(r.runId)}>
                        Resume
                      </button>
                    ) : null}
                    {r.stoppable && ACTIVE.has(r.status) ? (
                      <button data-testid={`stop-${r.runId}`} onClick={() => p.onStop(r.runId)}>
                        Stop
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [runs, setRuns] = useState<Record<string, RunRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const list = await runApi.projects();
      setProjects(list);
      const all: Record<string, RunRow[]> = {};
      for (const p of list) all[p.projectId] = await runApi.runs(p.projectId);
      setRuns(all);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh]);
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
  };
  return (
    <ProjectsView
      projects={projects}
      runs={runs}
      error={error}
      onStart={(p, s) => void act(() => runApi.startRun(p, s))()}
      onResume={(r) => void act(() => runApi.resumeRun(r))()}
      onStop={(r) => void act(() => runApi.stopRun(r))()}
      onAdd={(d) => void act(() => runApi.addProject(d))()}
    />
  );
}
