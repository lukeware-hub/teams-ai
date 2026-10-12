import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { refineApi, runApi, startedPath, type DraftRow, type NameRequest, type NameSuggestion, type ProjectRow, type RunRow } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { BacklogBanner } from '../refine/ProgramPanel.js';
import { Bone, Skeleton } from '../components/Loading.js';
import { ACTIVE, CONTINUABLE, HELP, RECENT_RUNS, action, chip, emptyState, grouped, money, panel, plural, row, rowActions, rowId, rows, runName, sectionHeading, sectionTitle, when } from './project-shared.js';

const header = 'card flex flex-wrap items-center justify-between gap-x-6 gap-y-2';
const title = 'm-0 text-[1.375rem] leading-[1.3] text-ink';
const dir = 'mt-2 block text-[0.8125rem] text-ink-faint wrap-anywhere';
const desc = 'mt-1.5 mb-0 max-w-[60ch] text-[0.9375rem] leading-normal text-ink-soft';
// Stat strip: at-a-glance health of the project before scrolling into the lists below.
const stats = 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3';
const stat = 'edge-lit grid gap-[0.2rem] rounded-lg border px-4 py-[0.85rem]';
const statValue = 'text-[1.375rem] leading-[1.1] font-[650] tabular-nums';
const statLabel = 'text-[0.8125rem] text-ink-soft';
const section = 'grid min-w-0 gap-3';
const sectionHead = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2';
// Section icon badge: breaks up stacked panels that would otherwise read as one grey wall.
const sectionIcon = 'grid size-6 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink';
const empty = 'm-0 rounded-lg border border-line bg-surface-sunken px-4 py-3 text-[0.875rem] text-ink-soft';
const newSpecLabel = 'text-[0.8125rem] font-semibold';
// Runs in flight stand out from the history instead of blending into the table.
const live = '[&>td]:bg-good-soft [&>td:first-child]:shadow-[inset_3px_0_0_var(--good-live)]';

/** The hub before its data arrives: the real breadcrumb, then the header, the four counters and the specs panel as placeholders. */
function ProjectHubSkeleton({ projectId, error }: { projectId: string; error: string | null }) {
  return (
    <main>
      <nav className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/projects" aria-label="Voltar para projetos">
          <Icon name="home" size={16} />
          <span>Projetos</span>
        </Link>
        <span aria-hidden="true">›</span>
        <strong>{projectId}</strong>
      </nav>
      {error ? <p className="error m-0" role="alert">{error}</p> : (
        <Skeleton>
          <div className={header}>
            <div className="min-w-0 flex-1">
              <h1 className={title}><Bone size="half" /></h1>
              <p className={desc}><Bone /><Bone /><Bone size="short" /></p>
              <code className={dir}><Bone size="half" /></code>
            </div>
          </div>
          <div className={stats}>
            {[0, 1, 2, 3].map((i) => (
              <div className={`${stat} border-line bg-surface-sunken`} key={i}>
                <span className={`${statValue} text-ink`}><Bone size="tiny" /></span>
                <span className={statLabel}><Bone size="half" /></span>
              </div>
            ))}
          </div>
          <div className={panel}>
            <div className={section}>
              <div className={sectionHead}>
                <h3 className={sectionTitle}><Bone size="tiny" /></h3>
                <Bone size="action" />
              </div>
              <div className={row}><Bone size="short" /></div>
              <div className={row}><Bone size="half" /></div>
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
  /** Started specs whose backlog may be running, shown first with the way to their execution screen. */
  backlogs?: string[];
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
      <main>
        <div className={emptyState}>
          <Icon name="search" size={24} />
          <p>Esse projeto não foi encontrado.</p>
          <Link className="link-button" to="/projects">Voltar para Projetos</Link>
        </div>
      </main>
    );
  }
  if (!p.project) return <main />;
  const pr = p.project;
  const doneCount = pr.specs.filter((s) => s.status === 'done' || s.status === 'complete').length;
  const percent = pr.specs.length === 0 ? null : Math.round((doneCount / pr.specs.length) * 100);
  const allConcluded = percent === 100;
  const agentRuns = p.runs.filter((r) => r.kind === 'run').length;
  const activeRuns = p.runs.filter((r) => ACTIVE.has(r.status));
  const totalCost = p.runs.reduce((sum, r) => sum + r.cost, 0);
  return (
    <main>
      <nav className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/projects" aria-label="Voltar para projetos">
          <Icon name="home" size={16} />
          <span>Projetos</span>
        </Link>
        <span aria-hidden="true">›</span>
        <strong>{pr.projectId}</strong>
      </nav>
      <header className={header}>
        <div className="min-w-0">
          <h1 className={title}>{pr.name || pr.projectId}</h1>
          <p className={desc}>{pr.description}</p>
          <code className={dir}>{pr.dir}</code>
        </div>
        <div className="grid flex-none justify-items-end gap-3">
          {percent === null ? null : (
            <div className="flex flex-none items-center gap-2.5" role="img" aria-label={`${percent}% concluído`}>
              <div className="h-2 w-32 overflow-hidden rounded-full bg-surface-muted"><span className="block h-full rounded-full bg-good-live transition-[width] duration-[var(--duration-fast)]" style={{ width: `${percent}%` }} /></div>
              <span className="text-[0.8125rem] font-[650] text-ink-soft tabular-nums">{percent}%</span>
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
      {(p.backlogs ?? []).map((specId) => <BacklogBanner key={specId} projectId={pr.projectId} specId={specId} />)}
      <div className={stats}>
        <div className={`${stat} border-line bg-surface shadow-card`}>
          <span className={`${statValue} text-ink`}>{pr.specs.length}</span>
          <span className={statLabel}>{plural(pr.specs.length, 'spec', 'specs')}</span>
        </div>
        <div className={`${stat} border-line bg-surface shadow-card`}>
          <span className={`${statValue} text-ink`}>{agentRuns}</span>
          <span className={statLabel}>{plural(agentRuns, 'execução', 'execuções')}</span>
        </div>
        <div className={`${stat} ${activeRuns.length > 0 ? 'border-good-line bg-good-soft shadow-card' : 'border-line bg-surface shadow-card'}`}>
          <span className={`${statValue} ${activeRuns.length > 0 ? 'text-good' : 'text-ink'}`}>{activeRuns.length}</span>
          <span className={statLabel}>em andamento</span>
        </div>
        <div className={`${stat} border-line bg-surface shadow-card`}>
          <span className={`${statValue} text-ink`}>{money(totalCost)}</span>
          <span className={statLabel}>custo total</span>
        </div>
      </div>
      {pr.services?.length ? (
        <section className={panel} data-testid="project-services">
          <div className={section}>
            <div className={sectionHead}>
              <div className={sectionTitle}>
                <span className={sectionIcon}><Icon name="code" size={14} /></span>
                <h3 className={sectionHeading}>Serviços</h3>
                <InfoTip label="Serviços" text={HELP.services} />
              </div>
            </div>
            <ul className="m-0 grid list-none gap-2 p-0">
              {pr.services.map((s) => (
                <li className="flex flex-wrap items-center gap-3" key={s.name} data-testid={`project-service-${s.name}`}>
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
      {p.error ? <p className="error m-0" role="alert">{p.error}</p> : null}
      <section className={panel}>
        <div className={section}>
          <div className={sectionHead}>
            <div className={sectionTitle}>
              <span className={sectionIcon}><Icon name="list" size={14} /></span>
              <h3 className={sectionHeading}>Especificações</h3>
              <InfoTip label="Especificações" text={HELP.specs} />
            </div>
            {creating ? null : (
              <button type="button" className={allConcluded ? action.primary : action.plain} data-testid="open-new-spec" onClick={() => setCreating(true)}>
                <Icon name="plus" size={14} />
                Nova spec
              </button>
            )}
          </div>
          {creating ? (
            <form
              className="mt-3 flex flex-col flex-nowrap items-stretch gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                p.onNewSpec(specDraft.trim(), specDescription);
              }}
            >
              <label className={newSpecLabel} htmlFor="new-spec-description">Descreva o serviço</label>
              <textarea className="w-full min-w-0 resize-y text-[0.8125rem]" id="new-spec-description" data-testid="new-spec-description" rows={5} autoFocus value={specDescription} onChange={(e) => setSpecDescription(e.target.value)} placeholder="Ex.: listar todos os usuários com o e-mail mascarado. Os documentos do projeto entram como contexto; só esta spec passa pelo refinamento." />
              {idShown ? (
                <>
                  <label className={newSpecLabel} htmlFor="new-spec-id">ID da spec</label>
                  <input className="h-8 w-full max-w-[24rem] min-w-0 text-[0.8125rem] pointer-coarse:h-[var(--control-height)]" id="new-spec-id" data-testid="new-spec-id" value={specDraft} disabled={suggesting} onChange={(e) => setSpecDraft(e.target.value)} placeholder={suggesting ? 'Sugerindo…' : 'ex.: list-users'} />
                </>
              ) : null}
              {suggestError ? <span className="error" role="alert">{suggestError}</span> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className={action.secondary} data-testid="cancel-new-spec" onClick={closeNewSpec}>Cancelar</button>
                {idShown ? (
                  <button type="submit" className={action.plain} data-testid="new-spec" disabled={suggesting || specDraft.trim() === '' || specDescription.trim() === ''}>Começar refinamento</button>
                ) : (
                  <button type="button" className={action.plain} data-testid="continue-new-spec" disabled={specDescription.trim() === ''} onClick={() => void continueNewSpec()}>Continuar</button>
                )}
              </div>
            </form>
          ) : null}
          {allConcluded && !creating ? <p className="m-0 rounded-lg border border-good-line bg-good-soft px-3.5 py-2.5 text-[0.875rem] text-ink" data-testid="all-concluded">Todas as specs foram concluídas. Crie uma nova spec para a próxima entrega.</p> : null}
          {pr.specs.length === 0 ? (
            <p className={empty}>Nenhuma spec criada ainda. Use Nova spec para criar a primeira.</p>
          ) : (
            <ul className={rows}>
              {pr.specs.map((s) => (
                <li className={row} key={s.specId}>
                  <span className={rowId}>{s.specId}</span>
                  {chip(s.activeRunId ? (p.runs.find((r) => r.runId === s.activeRunId)?.status ?? 'running') : s.status === 'running' ? 'idle' : s.status)}
                  <span className={rowActions}>
                    {CONTINUABLE.has(s.status) ? (
                      <button type="button" className={action.secondary} data-testid={`continue-${s.specId}`} aria-label={`Continuar spec ${s.specId}`} onClick={() => p.onContinue(s.specId)}>
                        Continuar spec
                      </button>
                    ) : null}
                    {CONTINUABLE.has(s.status) ? (
                      <button type="button" className={action.secondary} data-testid={`restart-${s.specId}`} aria-label={`Reiniciar spec ${s.specId}`} onClick={() => setPendingRestart(s.specId)}>
                        Reiniciar
                      </button>
                    ) : null}
                    {s.activeRunId ? (
                      <Link className={action.primary} data-testid={`open-${s.specId}`} aria-label={`Abrir execução de ${s.specId}`} to={`/runs/${s.activeRunId}`}>
                        Abrir execução
                        <Icon name="arrow-right" size={14} />
                      </Link>
                    ) : s.status === 'awaiting-validation' ? (
                      <Link className={action.primary} data-testid={`validate-${s.specId}`} aria-label={`Validar ${s.specId}`} to={`/runs/${lastRunOf(s.specId)}/validation`}>
                        Validar
                        <Icon name="arrow-right" size={14} />
                      </Link>
                    ) : s.status === 'done' ? (
                      lastRunOf(s.specId) ? (
                        <Link className={action.secondary} data-testid={`validation-${s.specId}`} aria-label={`Ver validação de ${s.specId}`} to={`/runs/${lastRunOf(s.specId)}/validation`}>
                          Ver validação
                        </Link>
                      ) : null
                    ) : (
                      <button type="button" className={action.primary} data-testid={`start-${s.specId}`} aria-label={`Iniciar execução de ${s.specId}`} onClick={() => p.onStart(s.specId)}>
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
      <section className={panel}>
        <div className={section}>
          <div className={sectionTitle}>
            <span className={sectionIcon}><Icon name="code" size={14} /></span>
            <h3 className={sectionHeading}>Execuções</h3>
          </div>
          {p.runs.length === 0 ? (
            <p className={empty}>Nenhuma execução registrada ainda. Use Iniciar execução em uma spec para começar.</p>
          ) : (
            <>
              <div className="relative -mx-[0.6rem] min-w-0 overflow-x-auto [&_td]:h-12 [&_td]:py-2 [&_td]:align-middle [&_td]:whitespace-nowrap [&_th]:align-middle [&_th]:whitespace-nowrap">
                <table className="m-0" id={`runs-${pr.projectId}`}>
                  <thead>
                    <tr>
                      <th scope="col">Execução</th>
                      <th scope="col">Spec</th>
                      <th scope="col">Quando</th>
                      <th scope="col">Status <InfoTip text={HELP.runStatus} /></th>
                      <th scope="col" className="num">Tokens <InfoTip text={HELP.tokens} /></th>
                      <th scope="col" className="num">Custo <InfoTip text={HELP.cost} /></th>
                      <th scope="col"><span className="sr-only">Ações</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showAll ? p.runs : p.runs.slice(0, RECENT_RUNS)).map((r) => (
                      <tr key={r.runId} className={ACTIVE.has(r.status) ? live : r.locked ? '[&>td]:text-ink-soft' : ''}>
                        <td><Link className="font-medium no-underline hover:underline" to={`/runs/${r.runId}`} title={r.runId}>{runName(r)}</Link></td>
                        <td>{r.specId}</td>
                        <td className="whitespace-nowrap text-ink-soft tabular-nums">{when(r.at)}</td>
                        <td>{chip(r.status)}</td>
                        <td className="num">{grouped(r.tokens)}</td>
                        <td className="num">{money(r.cost)}</td>
                        <td>
                          <span className="flex flex-wrap justify-end gap-2">
                            {r.locked ? (
                              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[0.8125rem] text-ink-faint" data-testid={`locked-${r.runId}`} title="A spec foi concluída: esta execução não pode ser retomada nem reprocessada.">
                                <Icon name="lock" size={14} />
                                Somente leitura
                              </span>
                            ) : null}
                            {r.stoppable && ACTIVE.has(r.status) ? (
                              <button type="button" className={action.danger} data-testid={`stop-${r.runId}`} aria-label={`Parar ${r.runId}`} onClick={() => p.onStop(r.runId)}>
                                <Icon name="stop" size={14} />
                                Parar
                              </button>
                            ) : null}
                            {!r.locked && (r.status === 'paused:auth' || r.status === 'interrupted') ? (
                              <button type="button" className={action.secondary} data-testid={`resume-${r.runId}`} aria-label={`Retomar ${r.runId}`} onClick={() => p.onResume(r.runId)}>
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
                <button type="button" className="inline-flex h-8 items-center gap-1.5 justify-self-start border-0 bg-transparent p-0 text-[0.8125rem] text-ink-soft hover:not-disabled:text-ink hover:not-disabled:underline hover:not-disabled:underline-offset-3 aria-expanded:[&_svg]:rotate-180 pointer-coarse:h-[var(--control-height)]" aria-expanded={showAll} aria-controls={`runs-${pr.projectId}`} onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Mostrar menos' : `Mostrar todas (${p.runs.length})`}
                  <Icon name="chevron" size={14} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>
      {p.drafts.length > 0 ? (
        <section className={panel}>
          <div className={section}>
            <div className={sectionTitle}>
              <span className={sectionIcon}><Icon name="file" size={14} /></span>
              <h3 className={sectionHeading}>Refinamentos em andamento</h3>
              <InfoTip label="Refinamentos em andamento" text={HELP.drafts} />
            </div>
            <ul className={rows}>
              {p.drafts.map((d) => (
                <li className={row} key={d.specId}>
                  <span className={rowId}>{d.specId}</span>
                  {chip(d.state)}
                  <span className={rowActions}>
                    <button type="button" className={action.danger} data-testid={`delete-${d.specId}`} aria-label={`Excluir refinamento de ${d.specId}`} onClick={() => setPendingDelete(d.specId)}>
                      <Icon name="trash" size={14} />
                      Excluir
                    </button>
                    <Link className={action.primary} data-testid={`refine-${d.specId}`} aria-label={`Abrir refinamento de ${d.specId}`} to={`/refine/${pr.projectId}/${d.specId}`}>
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
  const [backlogs, setBacklogs] = useState<string[]>([]);
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
        const own = (await refineApi.list()).filter((d) => d.projectId === projectId);
        setDrafts(own.filter((d) => d.state !== 'started'));
        setBacklogs((current) => {
          const next = own.filter((d) => d.state === 'started').map((d) => d.specId);
          return next.join() === current.join() ? current : next;
        });
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
      backlogs={backlogs}
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
