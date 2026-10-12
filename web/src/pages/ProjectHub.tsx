import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { refineApi, runApi, startedPath, type DraftRow, type NameRequest, type NameSuggestion, type ProjectRow, type RunRow } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Bone, Skeleton } from '../components/Loading.js';
import { ACTIVE, CONTINUABLE, HELP, RECENT_RUNS, chip, grouped, money, plural, runName, when } from './project-shared.js';
import './projects.css';
import './project-hub.css';

/** The hub before its data arrives: the real breadcrumb, then the header, the four counters and the specs panel as placeholders. */
function ProjectHubSkeleton({ projectId, error }: { projectId: string; error: string | null }) {
  return (
    <main className="projects-shell project-hub">
      <nav className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/projects" aria-label="Voltar para projetos">
          <Icon name="home" size={16} />
          <span>Projetos</span>
        </Link>
        <span aria-hidden="true">›</span>
        <strong>{projectId}</strong>
      </nav>
      {error ? <p className="error" role="alert">{error}</p> : (
        <Skeleton>
          <div className="card project-hub-header">
            <div className="project-panel-title">
              <h1><Bone size="half" /></h1>
              <p className="project-hub-desc"><Bone /><Bone /><Bone size="short" /></p>
              <code><Bone size="half" /></code>
            </div>
          </div>
          <div className="project-hub-stats">
            {[0, 1, 2, 3].map((i) => (
              <div className="project-hub-stat" key={i}>
                <span className="project-hub-stat-value"><Bone size="tiny" /></span>
                <span className="project-hub-stat-label"><Bone size="half" /></span>
              </div>
            ))}
          </div>
          <div className="card project-panel">
            <div className="project-section">
              <div className="project-section-heading">
                <h3 className="project-section-title"><Bone size="tiny" /></h3>
                <Bone size="action" />
              </div>
              <div className="project-row"><Bone size="short" /></div>
              <div className="project-row"><Bone size="half" /></div>
            </div>
          </div>
        </Skeleton>
      )}
    </main>
  );
}

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
  onRestart: (specId: string) => void;
  onDeleteDraft: (specId: string) => void;
  onSuggestName?: (input: NameRequest) => Promise<NameSuggestion>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [specDraft, setSpecDraft] = useState('');
  const [specDescription, setSpecDescription] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingRestart, setPendingRestart] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [idShown, setIdShown] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const closeNewSpec = () => {
    setCreating(false);
    setIdShown(false);
    setSpecDraft('');
    setSpecDescription('');
    setSuggestError(null);
  };
  const continueNewSpec = async () => {
    setIdShown(true);
    if (!p.onSuggestName || !p.project) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      setSpecDraft((await p.onSuggestName({ kind: 'spec', projectId: p.project.projectId, name: '', description: specDescription })).id);
    } catch (e) {
      setSuggestError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };
  const lastRunOf = (specId: string) => p.runs.find((r) => r.specId === specId && r.kind === 'run')?.runId ?? '';
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
  const allConcluded = percent === 100;
  const agentRuns = p.runs.filter((r) => r.kind === 'run').length;
  const activeRuns = p.runs.filter((r) => ACTIVE.has(r.status));
  const totalCost = p.runs.reduce((sum, r) => sum + r.cost, 0);
  return (
    <main className="projects-shell project-hub">
      <nav className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/projects" aria-label="Voltar para projetos">
          <Icon name="home" size={16} />
          <span>Projetos</span>
        </Link>
        <span aria-hidden="true">›</span>
        <strong>{pr.projectId}</strong>
      </nav>
      <header className="card project-hub-header">
        <div className="project-panel-title">
          <h1>{pr.name || pr.projectId}</h1>
          <p className="project-hub-desc">{pr.description}</p>
          <code>{pr.dir}</code>
        </div>
        <div className="project-hub-side">
          {percent === null ? null : (
            <div className="project-hub-progress" role="img" aria-label={`${percent}% concluído`}>
              <div className="project-hub-progress-bar"><span style={{ width: `${percent}%` }} /></div>
              <span className="project-hub-progress-label">{percent}%</span>
            </div>
          )}
          {pr.repoUrl ? (
            <a className="link-button" data-testid="github-link" href={pr.repoUrl} target="_blank" rel="noreferrer">
              <Icon name="github" size={16} />
              Abrir no GitHub
              <Icon name="external" size={16} />
            </a>
          ) : null}
        </div>
      </header>
      <div className="project-hub-stats">
        <div className="project-hub-stat">
          <span className="project-hub-stat-value">{pr.specs.length}</span>
          <span className="project-hub-stat-label">{plural(pr.specs.length, 'spec', 'specs')}</span>
        </div>
        <div className="project-hub-stat">
          <span className="project-hub-stat-value">{agentRuns}</span>
          <span className="project-hub-stat-label">{plural(agentRuns, 'execução', 'execuções')}</span>
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
      {pr.services?.length ? (
        <section className="card project-panel" data-testid="project-services">
          <div className="project-section">
            <div className="project-section-heading">
              <div className="project-section-title">
                <span className="project-section-icon"><Icon name="code" size={14} /></span>
                <h3>Serviços</h3>
                <InfoTip label="Serviços" text={HELP.services} />
              </div>
            </div>
            <ul className="project-service-list">
              {pr.services.map((s) => (
                <li key={s.name} data-testid={`project-service-${s.name}`}>
                  <strong>{s.name}</strong>
                  {s.repoUrl ? (
                    <a className="link-button" href={s.repoUrl} target="_blank" rel="noreferrer" aria-label={`Abrir ${s.name} no GitHub`}>
                      <Icon name="github" size={16} />
                      Abrir no GitHub
                      <Icon name="external" size={16} />
                    </a>
                  ) : (
                    <span className="hint">Repositório ainda não criado</span>
                  )}
                </li>
              ))}
            </ul>
            {pr.platform?.length ? <p className="hint" data-testid="project-platform">Plataforma: {pr.platform.map((c) => `${c.name} (${c.image})`).join(', ')}</p> : null}
          </div>
        </section>
      ) : null}
      {p.error ? <p className="error" role="alert">{p.error}</p> : null}
      <section className="card project-panel">
        <div className="project-section">
          <div className="project-section-heading">
            <div className="project-section-title">
              <span className="project-section-icon"><Icon name="list" size={14} /></span>
              <h3>Especificações</h3>
              <InfoTip label="Especificações" text={HELP.specs} />
            </div>
            {creating ? null : (
              <button type="button" className={allConcluded ? 'project-action primary' : 'project-action'} data-testid="open-new-spec" onClick={() => setCreating(true)}>
                <Icon name="plus" size={14} />
                Nova spec
              </button>
            )}
          </div>
          {creating ? (
            <form
              className="project-new-spec"
              onSubmit={(e) => {
                e.preventDefault();
                p.onNewSpec(specDraft.trim(), specDescription);
              }}
            >
              <label htmlFor="new-spec-description">Descreva o serviço</label>
              <textarea id="new-spec-description" data-testid="new-spec-description" rows={5} autoFocus value={specDescription} onChange={(e) => setSpecDescription(e.target.value)} placeholder="Ex.: listar todos os usuários com o e-mail mascarado. Os documentos do projeto entram como contexto; só esta spec passa pelo refinamento." />
              {idShown ? (
                <>
                  <label htmlFor="new-spec-id">ID da spec</label>
                  <input id="new-spec-id" data-testid="new-spec-id" value={specDraft} disabled={suggesting} onChange={(e) => setSpecDraft(e.target.value)} placeholder={suggesting ? 'Sugerindo…' : 'ex.: list-users'} />
                </>
              ) : null}
              {suggestError ? <span className="error" role="alert">{suggestError}</span> : null}
              <div className="project-new-spec-actions">
                <button type="button" className="project-action secondary" data-testid="cancel-new-spec" onClick={closeNewSpec}>Cancelar</button>
                {idShown ? (
                  <button type="submit" className="project-action" data-testid="new-spec" disabled={suggesting || specDraft.trim() === '' || specDescription.trim() === ''}>Começar refinamento</button>
                ) : (
                  <button type="button" className="project-action" data-testid="continue-new-spec" disabled={specDescription.trim() === ''} onClick={() => void continueNewSpec()}>Continuar</button>
                )}
              </div>
            </form>
          ) : null}
          {allConcluded && !creating ? <p className="project-hub-note" data-testid="all-concluded">Todas as specs foram concluídas. Crie uma nova spec para a próxima entrega.</p> : null}
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
                    {CONTINUABLE.has(s.status) ? (
                      <button type="button" className="project-action secondary" data-testid={`restart-${s.specId}`} aria-label={`Reiniciar spec ${s.specId}`} onClick={() => setPendingRestart(s.specId)}>
                        Reiniciar
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
                    ) : s.status === 'done' ? (
                      lastRunOf(s.specId) ? (
                        <Link className="project-action secondary" data-testid={`validation-${s.specId}`} aria-label={`Ver validação de ${s.specId}`} to={`/runs/${lastRunOf(s.specId)}/validation`}>
                          Ver validação
                        </Link>
                      ) : null
                    ) : (
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
                      <th scope="col">Quando</th>
                      <th scope="col">Status <InfoTip text={HELP.runStatus} /></th>
                      <th scope="col" className="num">Tokens <InfoTip text={HELP.tokens} /></th>
                      <th scope="col" className="num">Custo <InfoTip text={HELP.cost} /></th>
                      <th scope="col"><span className="projects-sr-only">Ações</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showAll ? p.runs : p.runs.slice(0, RECENT_RUNS)).map((r) => (
                      <tr key={r.runId} className={ACTIVE.has(r.status) ? 'is-live' : r.locked ? 'is-locked' : ''}>
                        <td><Link className="project-run-link" to={`/runs/${r.runId}`} title={r.runId}>{runName(r)}</Link></td>
                        <td>{r.specId}</td>
                        <td className="project-run-when">{when(r.at)}</td>
                        <td>{chip(r.status)}</td>
                        <td className="num">{grouped(r.tokens)}</td>
                        <td className="num">{money(r.cost)}</td>
                        <td>
                          <span className="project-run-actions">
                            {r.locked ? (
                              <span className="project-run-locked" data-testid={`locked-${r.runId}`} title="A spec foi concluída: esta execução não pode ser retomada nem reprocessada.">
                                <Icon name="lock" size={14} />
                                Somente leitura
                              </span>
                            ) : null}
                            {r.stoppable && ACTIVE.has(r.status) ? (
                              <button type="button" className="project-action project-action-danger" data-testid={`stop-${r.runId}`} aria-label={`Parar ${r.runId}`} onClick={() => p.onStop(r.runId)}>
                                <Icon name="stop" size={14} />
                                Parar
                              </button>
                            ) : null}
                            {!r.locked && (r.status === 'paused:auth' || r.status === 'interrupted') ? (
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
      {pendingRestart ? (
        <ConfirmDialog
          title="Reiniciar refinamento?"
          subject={`${pr.projectId} / ${pendingRestart}`}
          confirmLabel="Reiniciar"
          onCancel={() => setPendingRestart(null)}
          onConfirm={() => {
            p.onRestart(pendingRestart);
            setPendingRestart(null);
          }}
        >
          Descarta a sessão de refinamento atual e recomeça do zero a partir da main. As execuções antigas e o código já mesclado permanecem.
        </ConfirmDialog>
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
  if (!project && !notFound) return <ProjectHubSkeleton projectId={projectId} error={error} />;
  return (
    <ProjectHubView
      project={project}
      notFound={notFound}
      runs={runs}
      drafts={drafts}
      error={error}
      deleteError={deleteError}
      onStart={(specId) => void act(async () => {
        // A spec the running program owns is prioritized there: follow it on the program's execution screen.
        const r = await runApi.startRun(projectId, specId);
        if (r.queued) navigate(startedPath(projectId, r));
      })()}
      onResume={(runId) => void act(() => runApi.resumeRun(runId))()}
      onStop={(runId) => void act(() => runApi.stopRun(runId))()}
      onNewSpec={(specId, description) => void go(() => refineApi.newSpec(projectId, specId, description))()}
      onContinue={(specId) => void go(() => refineApi.continueSpec(projectId, specId))()}
      onRestart={(specId) => void go(() => refineApi.restartSpec(projectId, specId))()}
      onSuggestName={refineApi.suggestName}
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
