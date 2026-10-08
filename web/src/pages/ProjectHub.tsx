import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { refineApi, runApi, type DraftRow, type ProjectRow, type RunRow } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { ACTIVE, CONTINUABLE, HELP, RECENT_RUNS, chip, grouped, money, plural } from './project-shared.js';
import './projects.css';
import './project-hub.css';

export function ProjectHubView(p: {
  project: ProjectRow | null;
  notFound: boolean;
  runs: RunRow[];
  drafts: DraftRow[];
  error: string | null;
  deleteError: string | null;
  onStart: (specId: string) => void;
  onResume: (runId: string) => void;
  onStop: (runId: string) => void;
  onNewSpec: (specId: string, description: string) => void;
  onContinue: (specId: string) => void;
  onDeleteDraft: (specId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [specDraft, setSpecDraft] = useState('');
  const [specDescription, setSpecDescription] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const lastRunOf = (specId: string) => p.runs.find((r) => r.specId === specId && !r.runId.includes('-complete-'))?.runId ?? '';
  if (p.notFound) {
    return (
      <main className="projects-shell">
        <div className="projects-empty">
          <Icon name="search" size={24} />
          <p>Esse projeto não foi encontrado.</p>
          <Link className="link-button" to="/projects">Voltar para Projetos</Link>
        </div>
      </main>
    );
  }
  if (!p.project) return <main className="projects-shell" />;
  const pr = p.project;
  const doneCount = pr.specs.filter((s) => s.status === 'done' || s.status === 'complete').length;
  const percent = pr.specs.length === 0 ? null : Math.round((doneCount / pr.specs.length) * 100);
  const activeRuns = p.runs.filter((r) => ACTIVE.has(r.status));
  const totalCost = p.runs.reduce((sum, r) => sum + r.cost, 0);
  return (
    <main className="projects-shell project-hub">
      <Link className="project-hub-back" to="/projects">
        <Icon name="arrow-left" size={14} />
        Projetos
      </Link>
      <header className="card project-hub-header">
        <div className="project-panel-title">
          <h1>{pr.name || pr.projectId}</h1>
          <p className="project-hub-desc">{pr.description}</p>
          <code>{pr.dir}</code>
        </div>
        {percent === null ? null : (
          <div className="project-hub-progress" role="img" aria-label={`${percent}% concluído`}>
            <div className="project-hub-progress-bar"><span style={{ width: `${percent}%` }} /></div>
            <span className="project-hub-progress-label">{percent}%</span>
          </div>
        )}
      </header>
      <div className="project-hub-stats">
        <div className="project-hub-stat">
          <span className="project-hub-stat-value">{pr.specs.length}</span>
          <span className="project-hub-stat-label">{plural(pr.specs.length, 'spec', 'specs')}</span>
        </div>
        <div className="project-hub-stat">
          <span className="project-hub-stat-value">{p.runs.length}</span>
          <span className="project-hub-stat-label">{plural(p.runs.length, 'execução', 'execuções')}</span>
        </div>
        <div className={`project-hub-stat${activeRuns.length > 0 ? ' is-live' : ''}`}>
          <span className="project-hub-stat-value">{activeRuns.length}</span>
          <span className="project-hub-stat-label">em andamento</span>
        </div>
        <div className="project-hub-stat">
          <span className="project-hub-stat-value">{money(totalCost)}</span>
          <span className="project-hub-stat-label">custo total</span>
        </div>
      </div>
      {p.error ? <p className="error" role="alert">{p.error}</p> : null}
      <section className="card project-panel">
        <div className="project-section">
          <div className="project-section-heading">
            <div className="project-section-title">
              <span className="project-section-icon"><Icon name="list" size={14} /></span>
              <h3>Especificações</h3>
              <InfoTip label="Especificações" text={HELP.specs} />
            </div>
            <form
              className={`project-new-spec${specDraft.trim() === '' ? '' : ' with-description'}`}
              onSubmit={(e) => {
                e.preventDefault();
                p.onNewSpec(specDraft, specDescription);
              }}
            >
              <input data-testid="new-spec-id" aria-label="ID da nova spec" value={specDraft} onChange={(e) => setSpecDraft(e.target.value)} placeholder="ID da nova spec" />
              <button className="project-action" data-testid="new-spec" type="submit" disabled={specDraft.trim() === ''}>
                <Icon name="plus" size={14} />
                Nova spec
              </button>
              {specDraft.trim() === '' ? null : (
                <textarea data-testid="new-spec-description" aria-label="Descrição da nova spec" rows={5} value={specDescription} onChange={(e) => setSpecDescription(e.target.value)} placeholder="Descreva a nova spec com suas palavras (opcional). Os documentos do projeto já estão carregados; os agentes validam o texto e fazem as perguntas." />
              )}
            </form>
          </div>
          {pr.specs.length === 0 ? (
            <p className="project-empty">Nenhuma spec criada ainda. Use Nova spec para criar a primeira.</p>
          ) : (
            <ul className="project-rows">
              {pr.specs.map((s) => (
                <li className="project-row" key={s.specId}>
                  <span className="project-row-id">{s.specId}</span>
                  {chip(s.activeRunId ? (p.runs.find((r) => r.runId === s.activeRunId)?.status ?? 'running') : s.status === 'running' ? 'idle' : s.status)}
                  <span className="project-row-actions">
                    {CONTINUABLE.has(s.status) ? (
                      <button type="button" className="project-action secondary" data-testid={`continue-${s.specId}`} aria-label={`Continuar spec ${s.specId}`} onClick={() => p.onContinue(s.specId)}>
                        Continuar spec
                      </button>
                    ) : null}
                    {s.activeRunId ? (
                      <Link className="project-action primary" data-testid={`open-${s.specId}`} aria-label={`Abrir execução de ${s.specId}`} to={`/runs/${s.activeRunId}`}>
                        Abrir execução
                        <Icon name="arrow-right" size={14} />
                      </Link>
                    ) : s.status === 'awaiting-validation' ? (
                      <Link className="project-action primary" data-testid={`validate-${s.specId}`} aria-label={`Validar ${s.specId}`} to={`/runs/${lastRunOf(s.specId)}/validation`}>
                        Validar
                        <Icon name="arrow-right" size={14} />
                      </Link>
                    ) : s.status === 'done' ? null : (
                      <button type="button" className="project-action primary" data-testid={`start-${s.specId}`} aria-label={`Iniciar execução de ${s.specId}`} onClick={() => p.onStart(s.specId)}>
                        <Icon name="play" size={14} />
                        Iniciar execução
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section className="card project-panel">
        <div className="project-section">
          <div className="project-section-title">
            <span className="project-section-icon"><Icon name="code" size={14} /></span>
            <h3>Execuções</h3>
          </div>
          {p.runs.length === 0 ? (
            <p className="project-empty">Nenhuma execução registrada ainda. Use Iniciar execução em uma spec para começar.</p>
          ) : (
            <>
              <div className="project-table">
                <table id={`runs-${pr.projectId}`}>
                  <thead>
                    <tr>
                      <th scope="col">Execução</th>
                      <th scope="col">Spec</th>
                      <th scope="col">Status <InfoTip text={HELP.runStatus} /></th>
                      <th scope="col" className="num">Tokens <InfoTip text={HELP.tokens} /></th>
                      <th scope="col" className="num">Custo <InfoTip text={HELP.cost} /></th>
                      <th scope="col"><span className="projects-sr-only">Ações</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showAll ? p.runs : p.runs.slice(0, RECENT_RUNS)).map((r) => (
                      <tr key={r.runId} className={ACTIVE.has(r.status) ? 'is-live' : ''}>
                        <td><Link className="project-run-link" to={`/runs/${r.runId}`}>{r.runId}</Link></td>
                        <td>{r.specId}</td>
                        <td>{chip(r.status)}</td>
                        <td className="num">{grouped(r.tokens)}</td>
                        <td className="num">{money(r.cost)}</td>
                        <td>
                          <span className="project-run-actions">
                            {r.stoppable && ACTIVE.has(r.status) ? (
                              <button type="button" className="project-action project-action-danger" data-testid={`stop-${r.runId}`} aria-label={`Parar ${r.runId}`} onClick={() => p.onStop(r.runId)}>
                                <Icon name="stop" size={14} />
                                Parar
                              </button>
                            ) : null}
                            {r.status === 'paused:auth' || r.status === 'interrupted' ? (
                              <button type="button" className="project-action secondary" data-testid={`resume-${r.runId}`} aria-label={`Retomar ${r.runId}`} onClick={() => p.onResume(r.runId)}>
                                <Icon name="play" size={14} />
                                Retomar
                              </button>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {p.runs.length > RECENT_RUNS ? (
                <button type="button" className="project-more" aria-expanded={showAll} aria-controls={`runs-${pr.projectId}`} onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Mostrar menos' : `Mostrar todas (${p.runs.length})`}
                  <Icon name="chevron" size={14} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>
      {p.drafts.length > 0 ? (
        <section className="card project-panel">
          <div className="project-section">
            <div className="project-section-title">
              <span className="project-section-icon"><Icon name="file" size={14} /></span>
              <h3>Refinamentos em andamento</h3>
              <InfoTip label="Refinamentos em andamento" text={HELP.drafts} />
            </div>
            <ul className="project-rows">
              {p.drafts.map((d) => (
                <li className="project-row" key={d.specId}>
                  <span className="project-row-id">{d.specId}</span>
                  {chip(d.state)}
                  <span className="project-row-actions">
                    <button type="button" className="project-action project-action-danger" data-testid={`delete-${d.specId}`} aria-label={`Excluir refinamento de ${d.specId}`} onClick={() => setPendingDelete(d.specId)}>
                      <Icon name="trash" size={14} />
                      Excluir
                    </button>
                    <Link className="project-action primary" data-testid={`refine-${d.specId}`} aria-label={`Abrir refinamento de ${d.specId}`} to={`/refine/${pr.projectId}/${d.specId}`}>
                      Abrir
                      <Icon name="arrow-right" size={14} />
                    </Link>
                  </span>
                  {p.deleteError && pendingDelete === null ? <p className="error" role="alert">{p.deleteError}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title="Excluir refinamento?"
          subject={`${pr.projectId} / ${pendingDelete}`}
          confirmLabel="Excluir"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            p.onDeleteDraft(pendingDelete);
            setPendingDelete(null);
          }}
        >
          O projeto volta a poder ser criado do zero. Essa ação não pode ser desfeita.
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

export function ProjectHub() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const navigate = useNavigate();
  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await runApi.projects();
      const found = list.find((pr) => pr.projectId === projectId) ?? null;
      setProject(found);
      setNotFound(found === null);
      if (found) {
        setRuns(await runApi.runs(projectId));
        setDrafts((await refineApi.list()).filter((d) => d.projectId === projectId && d.state !== 'started'));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);
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
  if (!projectId) return null;
  return (
    <ProjectHubView
      project={project}
      notFound={notFound}
      runs={runs}
      drafts={drafts}
      error={error}
      deleteError={deleteError}
      onStart={(specId) => void act(() => runApi.startRun(projectId, specId))()}
      onResume={(runId) => void act(() => runApi.resumeRun(runId))()}
      onStop={(runId) => void act(() => runApi.stopRun(runId))()}
      onNewSpec={(specId, description) => void go(() => refineApi.newSpec(projectId, specId, description))()}
      onContinue={(specId) => void go(() => refineApi.continueSpec(projectId, specId))()}
      onDeleteDraft={(specId) => void (async () => {
        setDeleteError(null);
        try {
          await refineApi.delete(projectId, specId);
        } catch (e) {
          setDeleteError((e as Error).message);
        }
        await refresh();
      })()}
    />
  );
}
