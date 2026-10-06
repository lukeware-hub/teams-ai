import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { refineApi, runApi, type DraftRow, type ProjectRow, type RunRow } from '../api.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import './projects.css';

const CONTINUABLE = new Set(['awaiting-validation', 'done']);

const ACTIVE = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);
const RECENT_RUNS = 5;
const money = (n: number) => `US$ ${n.toFixed(2)}`;
// Thousands split by a narrow space: a dot or a comma would read as a decimal point next to the US$ amounts.
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Spec and run states are feminine (a spec, a execução); refinement states masculine (o refinamento).
// 'idle' is not a server status: a spec frozen for running ('running') with no run in progress.
const LABEL: Record<string, string> = {
  idle: 'pronta para executar', refining: 'em refinamento', planned: 'planejada', running: 'em execução', draining: 'finalizando',
  'paused:quota': 'pausada por cota', 'paused:auth': 'aguardando login', interrupted: 'interrompida', 'awaiting-validation': 'aguardando validação',
  done: 'concluída', complete: 'concluída', drained: 'encerrada', blocked: 'bloqueada', deadlocked: 'travada',
  'phase-failed': 'fase falhou', 'verification-failed': 'verificação falhou', 'deploy-failed': 'deploy falhou', unknown: 'sem status',
  drafting: 'em edição', evaluating: 'em avaliação', answering: 'aguardando respostas', ready: 'pronto para iniciar', error: 'com erro',
};
const TONE: Record<string, string> = {
  done: 'good', complete: 'good', ready: 'good',
  running: 'neutral', draining: 'neutral', evaluating: 'neutral',
  'paused:quota': 'warn', 'paused:auth': 'warn', interrupted: 'warn', 'awaiting-validation': 'warn', answering: 'warn',
  blocked: 'bad', deadlocked: 'bad', 'phase-failed': 'bad', 'verification-failed': 'bad', 'deploy-failed': 'bad', error: 'bad',
};
const chip = (status: string) => <span className={TONE[status] ? `status-pill tone-${TONE[status]}` : 'status-pill'}>{LABEL[status] ?? status}</span>;

const HELP = {
  specs: 'Cada spec descreve uma entrega do projeto. O status mostra a etapa: pronta para executar, em execução, pausada, aguardando validação ou concluída. Continuar spec reabre a spec para um novo refinamento.',
  runStatus: 'Pausada por cota: continua sozinha quando o limite de uso renovar. Aguardando login: a sessão do Claude expirou; entre de novo e use Retomar. Interrompida: o processo parou; use Retomar. Finalizando: encerrando depois de Parar.',
  tokens: 'Total de tokens lidos e escritos pelos modelos de IA nesta execução.',
  cost: 'Custo estimado das chamadas aos modelos de IA nesta execução, em dólares.',
  drafts: 'Specs ainda em escrita, antes da execução. Em avaliação: a IA está revisando os documentos. Aguardando respostas: há perguntas ou sugestões para você. Pronto para iniciar: tudo aprovado; abra e inicie a execução.',
  newProjects: 'Projetos criados em Novo projeto que ainda estão em refinamento. Eles entram na lista de projetos quando a primeira execução começar.',
};

export function ProjectsView(p: {
  projects: ProjectRow[];
  runs: Record<string, RunRow[]>;
  drafts: DraftRow[];
  error: string | null;
  onStart: (projectId: string, specId: string) => void;
  onResume: (runId: string) => void;
  onStop: (runId: string) => void;
  onAdd: (dir: string) => void;
  onNewProject: (projectId: string, name: string, description: string) => void;
  onNewSpec: (projectId: string, specId: string, description: string) => void;
  onContinue: (projectId: string, specId: string) => void;
  onDelete: (projectId: string, specId: string) => void;
}) {
  const [repoUrl, setRepoUrl] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [newSpecDescription, setNewSpecDescription] = useState<Record<string, string>>({});
  const [newSpecId, setNewSpecId] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState<'new' | 'git' | null>(null);
  const [query, setQuery] = useState('');
  const [allRuns, setAllRuns] = useState<Record<string, boolean>>({});
  const filterRef = useRef<HTMLInputElement>(null);
  const runsOf = (projectId: string) => p.runs[projectId] ?? [];
  const lastRunOf = (projectId: string, specId: string) => runsOf(projectId).find((r) => r.specId === specId && !r.runId.includes('-complete-'))?.runId ?? '';
  const openDrafts = p.drafts.filter((d) => d.state !== 'started');
  const q = query.trim().toLowerCase();
  const matches = (...values: string[]) => q === '' || values.some((v) => v.toLowerCase().includes(q));
  const visible = p.projects.filter((pr) =>
    matches(pr.projectId, pr.dir, ...pr.specs.map((s) => s.specId), ...runsOf(pr.projectId).map((r) => r.runId), ...openDrafts.filter((d) => d.projectId === pr.projectId).map((d) => d.specId)),
  );
  const unregistered = openDrafts.filter((d) => !d.registered && matches(d.projectId, d.specId));
  const total = plural(p.projects.length, 'projeto', 'projetos');
  const toggle = (next: 'new' | 'git') => setPanel(panel === next ? null : next);
  const [pendingDelete, setPendingDelete] = useState<{ projectId: string; specId: string } | null>(null);
  const deleteDraft = (projectId: string, specId: string) => setPendingDelete({ projectId, specId });
  return (
    <main className="projects-shell">
      <header className="projects-header">
        <div className="projects-heading">
          <h1>Projetos</h1>
          <p>Crie ou importe projetos, refine especificações e acompanhe as execuções.</p>
        </div>
        <div className="projects-header-actions">
          <button type="button" className="secondary projects-toggle" aria-expanded={panel === 'git'} aria-controls="import-project-panel" onClick={() => toggle('git')}>
            <Icon name="download" size={16} />
            Importar do Git
          </button>
          <button type="button" className="primary-button projects-toggle" aria-expanded={panel === 'new'} aria-controls="new-project-panel" onClick={() => toggle('new')}>
            <Icon name="plus" size={16} />
            Novo projeto
          </button>
        </div>
      </header>
      {panel === 'new' ? (
        <form
          id="new-project-panel"
          className="card projects-form"
          aria-labelledby="new-project-title"
          onSubmit={(e) => {
            e.preventDefault();
            p.onNewProject(newProjectId, newProjectName, newProjectDescription);
          }}
        >
          <div>
            <h2 id="new-project-title">Novo projeto</h2>
            <p className="projects-form-hint">Defina um ID (letras minúsculas, números e hífens) e um nome. Se quiser, descreva o projeto com suas palavras: os agentes usam o texto para começar o refinamento e fazer as perguntas.</p>
          </div>
          <div className="projects-form-fields">
            <label><span>ID do projeto</span><input data-testid="new-project-id" autoFocus value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)} placeholder="ex.: portal-interno" /></label>
            <label><span>Nome do projeto</span><input data-testid="new-project-name" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="ex.: Portal interno" /></label>
          </div>
          <label className="projects-form-description">
            <span>Descrição (opcional)</span>
            <textarea data-testid="new-project-description" rows={5} value={newProjectDescription} onChange={(e) => setNewProjectDescription(e.target.value)} placeholder="O que é, para quem serve, o que precisa fazer e o que fica de fora." />
          </label>
          <div className="projects-form-actions">
            <button data-testid="new-project" className="primary-button" type="submit" disabled={newProjectId.trim() === '' || newProjectName.trim() === ''}>Criar projeto</button>
          </div>
        </form>
      ) : null}
      {panel === 'git' ? (
        <form
          id="import-project-panel"
          className="card projects-form"
          aria-labelledby="import-project-title"
          onSubmit={(e) => {
            e.preventDefault();
            p.onAdd(repoUrl);
          }}
        >
          <div>
            <h2 id="import-project-title">Importar do Git</h2>
            <p className="projects-form-hint">Cole o link de um repositório que já tenha <code>docs/project.json</code>. O código é baixado e o projeto entra na lista.</p>
          </div>
          <div className="projects-form-fields projects-import-fields">
            <label><span>URL do repositório</span><input type="url" autoFocus value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/sua-org/seu-projeto.git" /></label>
            <button className="primary-button" type="submit" disabled={repoUrl.trim() === ''}>
              <Icon name="download" size={16} />
              Baixar e adicionar
            </button>
          </div>
        </form>
      ) : null}
      {p.error ? <p className="error" role="alert">{p.error}</p> : null}
      {p.projects.length === 0 ? (
        <div className="projects-empty">
          <Icon name="list" size={24} />
          <p>Seus projetos aparecem aqui.</p>
          <p>Use <strong>Novo projeto</strong> para começar do zero ou <strong>Importar do Git</strong> para trazer um repositório existente.</p>
        </div>
      ) : (
        <div className="projects-toolbar">
          <label className="projects-filter">
            <span className="projects-sr-only">Filtrar projetos</span>
            <Icon name="search" size={16} />
            <input ref={filterRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar por projeto, spec ou execução" />
          </label>
          <p className="projects-count" aria-live="polite">{q ? `${visible.length} de ${total}` : total}</p>
        </div>
      )}
      {p.projects.length > 0 && visible.length === 0 ? (
        <div className="projects-empty">
          <Icon name="search" size={24} />
          <p>{`Nenhum projeto corresponde a “${query.trim()}”.`}</p>
          <p>Busque pelo ID do projeto, pela pasta, por uma spec ou por uma execução.</p>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              filterRef.current?.focus();
            }}
          >
            Limpar filtro
          </button>
        </div>
      ) : null}
      {visible.map((pr) => {
        const runs = runsOf(pr.projectId);
        const showAll = allRuns[pr.projectId] ?? false;
        const drafts = openDrafts.filter((d) => d.projectId === pr.projectId);
        const specDraft = newSpecId[pr.projectId] ?? '';
        const specDescription = newSpecDescription[pr.projectId] ?? '';
        return (
          <article className="card project-panel" key={pr.projectId} aria-labelledby={`project-${pr.projectId}`}>
            <header className="project-panel-header">
              <div className="project-panel-title">
                <h2 id={`project-${pr.projectId}`}>{pr.projectId}</h2>
                <code>{pr.dir}</code>
              </div>
              <p className="project-facts">{plural(pr.specs.length, 'spec', 'specs')} · {plural(runs.length, 'execução', 'execuções')}</p>
            </header>
            <section className="project-section">
              <div className="project-section-heading">
                <div className="project-section-title">
                  <h3>Especificações</h3>
                  <InfoTip label="Especificações" text={HELP.specs} />
                </div>
                <form
                  className={`project-new-spec${specDraft.trim() === '' ? '' : ' with-description'}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    p.onNewSpec(pr.projectId, specDraft, specDescription);
                  }}
                >
                  <input data-testid={`new-spec-id-${pr.projectId}`} aria-label="ID da nova spec" value={specDraft} onChange={(e) => setNewSpecId({ ...newSpecId, [pr.projectId]: e.target.value })} placeholder="ID da nova spec" />
                  <button className="project-action" data-testid={`new-spec-${pr.projectId}`} type="submit" disabled={specDraft.trim() === ''}>
                    <Icon name="plus" size={14} />
                    Nova spec
                  </button>
                  {specDraft.trim() === '' ? null : (
                    <textarea data-testid={`new-spec-description-${pr.projectId}`} aria-label="Descrição da nova spec" rows={5} value={specDescription} onChange={(e) => setNewSpecDescription({ ...newSpecDescription, [pr.projectId]: e.target.value })} placeholder="Descreva a nova spec com suas palavras (opcional). Os documentos do projeto já estão carregados; os agentes validam o texto e fazem as perguntas." />
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
                      {chip(s.activeRunId ? (runs.find((r) => r.runId === s.activeRunId)?.status ?? 'running') : s.status === 'running' ? 'idle' : s.status)}
                      <span className="project-row-actions">
                        {CONTINUABLE.has(s.status) ? (
                          <button type="button" className="project-action" data-testid={`continue-${s.specId}`} aria-label={`Continuar spec ${s.specId}`} onClick={() => p.onContinue(pr.projectId, s.specId)}>
                            Continuar spec
                          </button>
                        ) : null}
                        {s.activeRunId ? (
                          <Link className="project-action secondary" data-testid={`open-${s.specId}`} aria-label={`Abrir execução de ${s.specId}`} to={`/runs/${s.activeRunId}`}>
                            Abrir execução
                            <Icon name="arrow-right" size={14} />
                          </Link>
                        ) : s.status === 'awaiting-validation' ? (
                          <Link className="project-action secondary" data-testid={`validate-${s.specId}`} aria-label={`Validar ${s.specId}`} to={`/runs/${lastRunOf(pr.projectId, s.specId)}/validation`}>
                            Validar
                            <Icon name="arrow-right" size={14} />
                          </Link>
                        ) : s.status === 'done' ? null : (
                          <button type="button" className="project-action secondary" data-testid={`start-${s.specId}`} aria-label={`Iniciar execução de ${s.specId}`} onClick={() => p.onStart(pr.projectId, s.specId)}>
                            <Icon name="play" size={14} />
                            Iniciar execução
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="project-section">
              <div className="project-section-title">
                <h3>Execuções</h3>
              </div>
              {runs.length === 0 ? (
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
                        {(showAll ? runs : runs.slice(0, RECENT_RUNS)).map((r) => (
                          <tr key={r.runId}>
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
                  {runs.length > RECENT_RUNS ? (
                    <button type="button" className="project-more" aria-expanded={showAll} aria-controls={`runs-${pr.projectId}`} onClick={() => setAllRuns({ ...allRuns, [pr.projectId]: !showAll })}>
                      {showAll ? 'Mostrar menos' : `Mostrar todas (${runs.length})`}
                      <Icon name="chevron" size={14} />
                    </button>
                  ) : null}
                </>
              )}
            </section>
            {drafts.length > 0 ? (
              <section className="project-section">
                <div className="project-section-title">
                  <h3>Refinamentos em andamento</h3>
                  <InfoTip label="Refinamentos em andamento" text={HELP.drafts} />
                </div>
                <ul className="project-rows">
                  {drafts.map((d) => (
                    <li className="project-row" key={d.specId}>
                      <span className="project-row-id">{d.specId}</span>
                      {chip(d.state)}
                      <span className="project-row-actions">
                        <button type="button" className="project-action project-action-danger" data-testid={`delete-${d.projectId}-${d.specId}`} aria-label={`Excluir refinamento de ${d.specId}`} onClick={() => deleteDraft(d.projectId, d.specId)}>
                          <Icon name="trash" size={14} />
                          Excluir
                        </button>
                        <Link className="project-action secondary" data-testid={`refine-${d.projectId}-${d.specId}`} aria-label={`Abrir refinamento de ${d.specId}`} to={`/refine/${d.projectId}/${d.specId}`}>
                          Abrir
                          <Icon name="arrow-right" size={14} />
                        </Link>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </article>
        );
      })}
      {unregistered.length > 0 ? (
        <section className="card project-panel project-orphans" aria-labelledby="new-projects-title">
          <div className="project-section-title">
            <h2 id="new-projects-title">Novos projetos em refinamento</h2>
            <InfoTip label="Novos projetos em refinamento" text={HELP.newProjects} />
          </div>
          <ul className="project-rows">
            {unregistered.map((d) => (
              <li className="project-row" key={`${d.projectId}/${d.specId}`}>
                <span className="project-row-id">{d.projectId} / {d.specId}</span>
                {chip(d.state)}
                <span className="project-row-actions">
                  <button type="button" className="project-action project-action-danger" data-testid={`delete-${d.projectId}-${d.specId}`} aria-label={`Excluir refinamento de ${d.projectId} / ${d.specId}`} onClick={() => deleteDraft(d.projectId, d.specId)}>
                    <Icon name="trash" size={14} />
                    Excluir
                  </button>
                  <Link className="project-action secondary" data-testid={`refine-${d.projectId}-${d.specId}`} aria-label={`Abrir refinamento de ${d.projectId} / ${d.specId}`} to={`/refine/${d.projectId}/${d.specId}`}>
                    Abrir
                    <Icon name="arrow-right" size={14} />
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {pendingDelete ? (
        <Dialog title="Excluir refinamento" onClose={() => setPendingDelete(null)}>
          <p>Excluir o refinamento de {pendingDelete.projectId} / {pendingDelete.specId}? O projeto volta a poder ser criado do zero. Essa ação não pode ser desfeita.</p>
          <div className="projects-form-actions">
            <button type="button" className="secondary" data-testid="delete-cancel" onClick={() => setPendingDelete(null)}>Cancelar</button>
            <button
              type="button"
              className="project-action project-action-danger"
              data-testid="delete-confirm"
              onClick={() => {
                p.onDelete(pendingDelete.projectId, pendingDelete.specId);
                setPendingDelete(null);
              }}
            >
              Excluir
            </button>
          </div>
        </Dialog>
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
      onNewProject={(id, name, description) => void go(() => refineApi.newProject(id, name, description))()}
      onNewSpec={(p, s, description) => void go(() => refineApi.newSpec(p, s, description))()}
      onContinue={(p, s) => void go(() => refineApi.continueSpec(p, s))()}
      onDelete={(p, s) => void act(() => refineApi.delete(p, s))()}
    />
  );
}
