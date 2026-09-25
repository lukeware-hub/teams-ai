import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { refineApi, runApi, type DraftRow, type ProjectRow, type RunRow } from '../api.js';

const CONTINUABLE = new Set(['awaiting-validation', 'done']);

const ACTIVE = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);
const money = (n: number) => `$${n.toFixed(2)}`;

export function ProjectsView(p: {
  projects: ProjectRow[];
  runs: Record<string, RunRow[]>;
  drafts: DraftRow[];
  error: string | null;
  onStart: (projectId: string, specId: string) => void;
  onResume: (runId: string) => void;
  onStop: (runId: string) => void;
  onAdd: (dir: string) => void;
  onNewProject: (projectId: string, name: string) => void;
  onNewSpec: (projectId: string, specId: string) => void;
  onContinue: (projectId: string, specId: string) => void;
}) {
  const [dir, setDir] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newSpecId, setNewSpecId] = useState<Record<string, string>>({});
  const openDrafts = p.drafts.filter((d) => d.state !== 'started');
  return (
    <main>
      <h1>Projects</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          p.onNewProject(newProjectId, newProjectName);
        }}
      >
        <p className="hint">New project starts the guided refinement flow and creates the project files.</p>
        <input data-testid="new-project-id" value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)} placeholder="project id" />
        <input data-testid="new-project-name" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="name" />
        <button data-testid="new-project" type="submit" disabled={newProjectId.trim() === '' || newProjectName.trim() === ''}>
          New project
        </button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          p.onAdd(dir);
        }}
      >
        <p className="hint">Add existing project requires a directory that already contains docs/project.json.</p>
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
                    {CONTINUABLE.has(s.status) ? (
                      <button data-testid={`continue-${s.specId}`} onClick={() => p.onContinue(pr.projectId, s.specId)}>
                        Continue spec
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <input
              data-testid={`new-spec-id-${pr.projectId}`}
              value={newSpecId[pr.projectId] ?? ''}
              onChange={(e) => setNewSpecId({ ...newSpecId, [pr.projectId]: e.target.value })}
              placeholder="new spec id"
            />
            <button data-testid={`new-spec-${pr.projectId}`} onClick={() => p.onNewSpec(pr.projectId, newSpecId[pr.projectId] ?? '')}>
              New spec
            </button>
          </p>
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
          {openDrafts
            .filter((d) => d.projectId === pr.projectId)
            .map((d) => (
              <p key={d.specId}>
                <Link data-testid={`refine-${d.projectId}-${d.specId}`} to={`/refine/${d.projectId}/${d.specId}`}>
                  Open refinement ({d.specId}, {d.state})
                </Link>
              </p>
            ))}
        </section>
      ))}
      {openDrafts.some((d) => !d.registered) ? (
        <section className="card">
          <h2>Drafts (unregistered)</h2>
          {openDrafts
            .filter((d) => !d.registered)
            .map((d) => (
              <p key={`${d.projectId}/${d.specId}`}>
                <Link data-testid={`refine-${d.projectId}-${d.specId}`} to={`/refine/${d.projectId}/${d.specId}`}>
                  {d.projectId} / {d.specId} ({d.state})
                </Link>
              </p>
            ))}
        </section>
      ) : null}
    </main>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [runs, setRuns] = useState<Record<string, RunRow[]>>({});
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const refresh = useCallback(async () => {
    try {
      const list = await runApi.projects();
      setProjects(list);
      const all: Record<string, RunRow[]> = {};
      for (const p of list) all[p.projectId] = await runApi.runs(p.projectId);
      setRuns(all);
      setDrafts(await refineApi.list());
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
  const go = (fn: () => Promise<{ sessionId: string }>) => async () => {
    setError(null);
    try {
      const { sessionId } = await fn();
      navigate(`/refine/${sessionId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <ProjectsView
      projects={projects}
      runs={runs}
      drafts={drafts}
      error={error}
      onStart={(p, s) => void act(() => runApi.startRun(p, s))()}
      onResume={(r) => void act(() => runApi.resumeRun(r))()}
      onStop={(r) => void act(() => runApi.stopRun(r))()}
      onAdd={(d) => void act(() => runApi.addProject(d))()}
      onNewProject={(id, name) => void go(() => refineApi.newProject(id, name))()}
      onNewSpec={(p, s) => void go(() => refineApi.newSpec(p, s))()}
      onContinue={(p, s) => void go(() => refineApi.continueSpec(p, s))()}
    />
  );
}
