import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { serviceLinks } from '@server/deploy/service-links';
import { refineApi, runApi, startedPath, type DraftRow, type NameRequest, type NameSuggestion, type ProjectRow, type Report, type RunRow, type ServiceStatus, type SpecRow, type StoredEvent } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { SortHeader, TableFilters, useTableView } from '../components/DataTable.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { BacklogBanner } from '../refine/ProgramPanel.js';
import { Bone, Skeleton } from '../components/Loading.js';
import { ACTIVE, CONTINUABLE, HELP, LABEL, RECENT_RUNS, action, chip, emptyState, grouped, money, panel, plural, row, rowActions, rowId, rows, runName, sectionHeading, sectionTitle, when } from './project-shared.js';
import { phaseState, phases, phaseTitle, runState } from '../run/selectors.js';
import { useJournal } from '../useSse.js';

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

/** Where the finished project can be opened: the Swagger and the web UI, each only when it exists and answers. */
export interface AppLinks { swagger: string | null; web: string | null }

export function appLinks(report: Report | null, status: ServiceStatus, hostname: string): AppLinks {
  const found: AppLinks = { swagger: null, web: null };
  for (const s of report?.services ?? (report?.service ? [{ service: '', ...report.service }] : [])) {
    const own = status.services?.find((x) => x.service === s.service) ?? status;
    if (!own.online) continue;
    const links = serviceLinks(s, hostname);
    found.swagger ??= links.docsUrl;
    if (own.ui) found.web ??= links.appUrl;
  }
  return found;
}

const PROCESS_PHASES = [1, 2, 3, 4, 5, 6];

/** The whole process of the execution that is going or was stopped: each phase in order, with the state its journal gives. */
function RunProcessSection({ run, events }: { run: RunRow; events: StoredEvent[] }) {
  const unique = events.filter((e, i) => events.findIndex((x) => x.seq === e.seq) === i);
  const journal = phases(unique);
  const blocked = [...runState(unique).tasks.values()].filter((t) => t.state === 'blocked').length;
  const order = [...new Set([...PROCESS_PHASES, ...journal.map((j) => j.phase)])].sort((a, b) => a - b);
  return (
    <section className={panel} data-testid="run-process">
      <div className={section}>
        <div className={sectionHead}>
          <div className={sectionTitle}>
            <span className={sectionIcon}><Icon name="code" size={14} /></span>
            <h3 className={sectionHeading}>Processo da execução</h3>
          </div>
          <Link className={action.primary} to={`/runs/${run.runId}`}>Abrir execução</Link>
        </div>
        <ol className="m-0 grid list-none gap-2 p-0">
          {order.map((phase) => {
            const row = journal.find((j) => j.phase === phase);
            const [label, tone] = row ? phaseState(row, run.status, blocked) : ['aguardando', ''];
            return (
              <li key={phase} data-testid="process-phase" className="flex flex-wrap items-center gap-2 text-[0.875rem] text-ink">
                <span className="font-semibold">{phaseTitle(phase)}</span>
                <span className={tone ? `status-pill tone-${tone}` : 'status-pill'}>{label}</span>
                {row && row.attempt > 1 ? <span className="text-ink-soft">{row.attempt}ª tentativa</span> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

export function ProjectHubView(p: {
  project: ProjectRow | null;
  notFound: boolean;
  runs: RunRow[];
  drafts: DraftRow[];
  /** Started specs whose backlog may be running, shown first with the way to their execution screen. */
  backlogs?: string[];
  /** Links of the latest delivery; shown only when every spec is concluded. */
  apps?: AppLinks | null;
  /** The execution that is going or was stopped, and its journal: the project shows its whole process. */
  processRun?: RunRow | null;
  processEvents?: StoredEvent[];
  error: string | null;
  deleteError: string | null;
  onStart: (specId: string) => void | Promise<void>;
  onResume: (runId: string) => void | Promise<void>;
  onStop: (runId: string) => void | Promise<void>;
  onNewSpec: (specId: string, description: string) => void | Promise<void>;
  onContinue: (specId: string) => void | Promise<void>;
  onRestart: (specId: string) => void | Promise<void>;
  /** Brings up a spec delivered elsewhere (an import) that has no run here, then opens its validation. */
  onValidate?: (specId: string) => void;
  /** Brings the concluded project's application up from its last delivery. */
  onStartApp?: () => void;
  onDeleteDraft: (specId: string) => void;
  onSuggestName?: (input: NameRequest) => Promise<NameSuggestion>;
}) {
  const [showAll, setShowAll] = useState(false);
  const runsView = useTableView(p.runs, {
    sorts: { run: runName, spec: (r) => r.specId, at: (r) => (r.at ? Date.parse(r.at) : null), status: (r) => LABEL[r.status] ?? r.status, tokens: (r) => r.tokens, cost: (r) => r.cost },
    text: (r) => [runName(r), r.runId, r.specId],
    facet: (r) => r.status,
    facetLabel: (status) => LABEL[status] ?? status,
  });
  // The chip's status: the active run's, or 'idle' for a running spec with no run.
  const shownStatus = (s: SpecRow) => (s.activeRunId ? (p.runs.find((r) => r.runId === s.activeRunId)?.status ?? 'running') : s.status === 'running' ? 'idle' : s.status);
  const specsView = useTableView(p.project?.specs ?? [], {
    sorts: {},
    text: (s) => [s.specId],
    facet: shownStatus,
    facetLabel: (status) => LABEL[status] ?? status,
  });
  const [specDraft, setSpecDraft] = useState('');
  const [specDescription, setSpecDescription] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingRestart, setPendingRestart] = useState<string | null>(null);
  // A link with ?novaSpec=1 (project card, chat, finished run) opens the form straight away.
  const [search, setSearch] = useSearchParams();
  const [creating, setCreating] = useState(search.get('novaSpec') === '1');
  const [idShown, setIdShown] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const closeNewSpec = () => {
    if (search.has('novaSpec')) {
      search.delete('novaSpec');
      setSearch(search, { replace: true });
    }
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
  const lastRunOf = (specId: string) => p.runs.find((r) => r.specId === specId && r.kind === 'run')?.runId ?? p.runs.find((r) => r.specId === specId && r.kind === 'deploy')?.runId ?? '';
  if (p.notFound) {
    return (
      <main>
        <div className={emptyState}>
          <Icon name="search" size={24} />
          <p>Esse projeto não foi encontrado.</p>
          <Link className="link-button" to="/projects">Voltar para Projetos<Icon name="arrow-left" size={16} /></Link>
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
              <div className="h-2 w-32 overflow-hidden rounded-full bg-surface-muted"><span className="block size-full origin-left rounded-full bg-good-live transition-transform duration-[var(--duration-slow)] ease-[var(--ease-out)]" style={{ transform: `scaleX(${percent / 100})` }} /></div>
              <span className="text-[0.8125rem] font-[650] text-ink-soft tabular-nums">{percent}%</span>
            </div>
          )}
          {pr.repoUrl ? (
            <a className="link-button" data-testid="github-link" href={pr.repoUrl} target="_blank" rel="noreferrer">
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
      {p.processRun ? <RunProcessSection run={p.processRun} events={p.processEvents ?? []} /> : null}
      {allConcluded && p.apps ? (
        <section className={panel} data-testid="project-apps">
          <div className={section}>
            <div className={sectionHead}>
              <div className={sectionTitle}>
                <span className={sectionIcon}><Icon name="external" size={14} /></span>
                <h3 className={sectionHeading}>Aplicação no ar</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                {p.apps.web ? <a className="primary-button" data-testid="open-web-ui" href={p.apps.web} target="_blank" rel="noreferrer">Abrir Web UI<Icon name="external" size={16} /></a> : null}
                {p.apps.swagger ? <a className="link-button" data-testid="open-swagger" href={p.apps.swagger} target="_blank" rel="noreferrer">Abrir Swagger<Icon name="external" size={16} /></a> : null}
              </div>
            </div>
            {p.apps.web || p.apps.swagger ? null : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="hint m-0" data-testid="apps-offline">A aplicação não está no ar.</p>
                {p.onStartApp ? <button type="button" className="primary-button" data-testid="start-app" disabled={activeRuns.length > 0} onClick={p.onStartApp}>{activeRuns.length > 0 ? 'Subindo a aplicação…' : 'Iniciar aplicação'}</button> : null}
              </div>
            )}
          </div>
        </section>
      ) : null}
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
                <li className="grid items-center gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4" key={s.name} data-testid={`project-service-${s.name}`}>
                  <strong>{s.name}</strong>
                  {s.repoUrl ? (
                    <a className="link-button justify-self-start" href={s.repoUrl} target="_blank" rel="noreferrer" aria-label={`Abrir ${s.name} no GitHub`}>
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
      <section className={panel} data-testid="project-specs">
        <div className={section}>
          <div className={sectionHead}>
            <div className={sectionTitle}>
              <span className={sectionIcon}><Icon name="list" size={14} /></span>
              <h3 className={sectionHeading}>Especificações</h3>
              <InfoTip label="Especificações" text={HELP.specs} />
            </div>
            {creating ? null : (
              <button type="button" className={allConcluded ? action.primary : action.secondary} data-testid="open-new-spec" onClick={() => setCreating(true)}>
                Nova spec
                <Icon name="plus" size={14} />
              </button>
            )}
          </div>
          {creating ? (
            <form
              className="mt-3 flex flex-col flex-nowrap items-stretch gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setSubmitting(true);
                void Promise.resolve(p.onNewSpec(specDraft.trim(), specDescription)).finally(() => setSubmitting(false));
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
                <button type="button" className={`${action.secondary} min-w-[auto]`} data-testid="cancel-new-spec" aria-label="Cancelar" onClick={closeNewSpec}><Icon name="close" size={14} /></button>
                {idShown ? (
                  <ActionButton key="new-spec" type="submit" className={action.plain} data-testid="new-spec" busy={submitting} disabled={suggesting || specDraft.trim() === '' || specDescription.trim() === ''} icon={<Icon name="arrow-right" size={14} />}>Começar refinamento</ActionButton>
                ) : (
                  <ActionButton key="continue-new-spec" className={action.plain} data-testid="continue-new-spec" disabled={specDescription.trim() === ''} onClick={continueNewSpec} icon={<Icon name="arrow-right" size={14} />}>Continuar</ActionButton>
                )}
              </div>
            </form>
          ) : null}
          {allConcluded && !creating ? <p className="m-0 rounded-lg border border-good-line bg-good-soft px-3.5 py-2.5 text-[0.875rem] text-ink" data-testid="all-concluded">Todas as specs foram concluídas. Crie uma nova spec para a próxima entrega.</p> : null}
          {pr.specs.length > 0 ? <TableFilters view={specsView} subject="especificações" placeholder="Filtrar por alias da spec" facetName="Status" /> : null}
          {pr.specs.length === 0 ? (
            creating ? null : (
              <div className={emptyState} data-testid="no-specs">
                <Icon name="list" size={24} />
                <p>Este projeto ainda não tem specs.</p>
                <p>Uma spec descreve uma entrega. O caminho é: descrever, responder as perguntas e avaliar, iniciar a execução e validar o resultado.</p>
                <button type="button" className={action.primary} data-testid="empty-new-spec" onClick={() => setCreating(true)}>
                  Nova spec
                  <Icon name="plus" size={14} />
                </button>
              </div>
            )
          ) : specsView.rows.length === 0 ? (
            <p className={empty}>Nenhuma spec corresponde ao filtro.</p>
          ) : (
            <ul className={rows}>
              {specsView.rows.map((s) => (
                <li className={row} key={s.specId}>
                  <span className={rowId}>{s.specId}</span>
                  {chip(shownStatus(s))}
                  <span className={rowActions}>
                    {CONTINUABLE.has(s.status) ? (
                      <ActionButton className={action.secondary} data-testid={`continue-${s.specId}`} aria-label={`Continuar spec ${s.specId}`} onClick={() => p.onContinue(s.specId)} icon={<Icon name="arrow-right" size={14} />}>
                        Continuar spec
                      </ActionButton>
                    ) : null}
                    {CONTINUABLE.has(s.status) ? (
                      <button type="button" className={action.secondary} data-testid={`restart-${s.specId}`} aria-label={`Reiniciar spec ${s.specId}`} onClick={() => setPendingRestart(s.specId)}>
                        Reiniciar
                        <Icon name="refresh" size={14} />
                      </button>
                    ) : null}
                    {s.activeRunId ? (
                      <Link className={action.primary} data-testid={`open-${s.specId}`} aria-label={`Abrir execução de ${s.specId}`} to={`/runs/${s.activeRunId}`}>
                        Abrir execução
                        <Icon name="arrow-right" size={14} />
                      </Link>
                    ) : s.status === 'awaiting-validation' ? (
                      lastRunOf(s.specId) ? (
                        <Link className={action.primary} data-testid={`validate-${s.specId}`} aria-label={`Validar ${s.specId}`} to={`/runs/${lastRunOf(s.specId)}/validation`}>
                          Validar
                          <Icon name="arrow-right" size={14} />
                        </Link>
                      ) : (
                        <ActionButton key="validate" className={action.primary} data-testid={`validate-${s.specId}`} aria-label={`Validar ${s.specId}`} onClick={() => p.onValidate?.(s.specId)} icon={<Icon name="arrow-right" size={14} />}>
                          Validar
                        </ActionButton>
                      )
                    ) : s.status === 'done' ? (
                      lastRunOf(s.specId) ? (
                        <Link className={action.secondary} data-testid={`validation-${s.specId}`} aria-label={`Ver validação de ${s.specId}`} to={`/runs/${lastRunOf(s.specId)}/validation`}>
                          Ver validação
                          <Icon name="arrow-right" size={14} />
                        </Link>
                      ) : null
                    ) : s.status === 'planned' ? (
                      <span className="text-ink-soft">Inicia com o programa do backlog</span>
                    ) : (
                      <ActionButton key="start" className={action.primary} data-testid={`start-${s.specId}`} aria-label={`Iniciar execução de ${s.specId}`} onClick={() => p.onStart(s.specId)} icon={<Icon name="play" size={14} />}>
                        Iniciar execução
                      </ActionButton>
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
              <TableFilters view={runsView} subject="execuções" placeholder="Filtrar por execução ou spec" facetName="Status" />
              <div className="relative -mx-[0.6rem] min-w-0 overflow-x-auto [&_td]:h-12 [&_td]:py-2 [&_td]:align-middle [&_td]:whitespace-nowrap [&_th]:align-middle [&_th]:whitespace-nowrap">
                <table className="m-0 min-w-[60rem] table-fixed" id={`runs-${pr.projectId}`}>
                  <colgroup><col className="w-[13%]" /><col className="w-[20%]" /><col className="w-[14%]" /><col className="w-[17%]" /><col className="w-[11%]" /><col className="w-[10%]" /><col className="w-[15%]" /></colgroup>
                  <thead>
                    <tr>
                      <SortHeader view={runsView} column="run" tip={<InfoTip text={HELP.runName} />}>Execução</SortHeader>
                      <SortHeader view={runsView} column="spec" tip={<InfoTip text={HELP.runSpec} />}>Spec</SortHeader>
                      <SortHeader view={runsView} column="at" tip={<InfoTip text={HELP.runAt} />}>Quando</SortHeader>
                      <SortHeader view={runsView} column="status" tip={<InfoTip text={HELP.runStatus} />}>Status</SortHeader>
                      <SortHeader view={runsView} column="tokens" className="num" tip={<InfoTip text={HELP.tokens} />}>Tokens</SortHeader>
                      <SortHeader view={runsView} column="cost" className="num" tip={<InfoTip text={HELP.cost} />}>Custo</SortHeader>
                      <th scope="col"><span className="sr-only">Ações</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runsView.rows.length === 0 ? <tr><td colSpan={7} className="text-ink-soft">Nenhuma execução corresponde ao filtro.</td></tr> : null}
                    {(showAll ? runsView.rows : runsView.rows.slice(0, RECENT_RUNS)).map((r) => (
                      <tr key={r.runId} className={ACTIVE.has(r.status) ? live : r.locked ? '[&>td]:text-ink-soft' : ''}>
                        <td><Link className="font-medium no-underline hover:underline" to={`/runs/${r.runId}`} title={r.runId}>{runName(r)}</Link></td>
                        <td className="truncate" title={r.specId}>{r.specId}</td>
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
                              <ActionButton className={action.danger} data-testid={`stop-${r.runId}`} aria-label={`Parar ${r.runId}`} onClick={() => p.onStop(r.runId)} icon={<Icon name="stop" size={14} />}>
                                Parar
                              </ActionButton>
                            ) : null}
                            {!r.locked && (r.status === 'paused:auth' || r.status === 'interrupted') ? (
                              <ActionButton className={action.secondary} data-testid={`resume-${r.runId}`} aria-label={`Retomar ${r.runId}`} onClick={() => p.onResume(r.runId)} icon={<Icon name="play" size={14} />}>
                                Retomar
                              </ActionButton>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {runsView.rows.length > RECENT_RUNS ? (
                <button type="button" className="min-w-[auto] inline-flex h-8 items-center gap-1.5 justify-self-start border-0 bg-transparent p-0 text-[0.8125rem] text-ink-soft hover:not-disabled:text-ink hover:not-disabled:underline hover:not-disabled:underline-offset-3 aria-expanded:[&_svg]:rotate-180 pointer-coarse:h-[var(--control-height)]" aria-expanded={showAll} aria-controls={`runs-${pr.projectId}`} onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Mostrar menos' : `Mostrar todas (${runsView.rows.length})`}
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
                      Excluir
                      <Icon name="trash" size={14} />
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
          onConfirm={async () => {
            await p.onRestart(pendingRestart);
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
          onConfirm={async () => {
            await p.onDeleteDraft(pendingDelete);
            setPendingDelete(null);
          }}
        >
          O projeto volta a poder ser criado do zero. Essa ação não pode ser desfeita.
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

/** Links of the latest delivery, once every spec is concluded; null until then or when its status cannot be read. */
async function latestApps(project: ProjectRow, rows: RunRow[]): Promise<AppLinks | null> {
  if (project.specs.length === 0 || !project.specs.every((s) => s.status === 'done' || s.status === 'complete')) return null;
  const last = rows.filter((r) => r.kind === 'run' || r.kind === 'deploy').sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))[0];
  if (!last) return { swagger: null, web: null }; // an import has no run here: nothing is up yet
  try {
    const [detail, status] = await Promise.all([runApi.run(last.runId), runApi.serviceStatus(last.runId)]);
    return appLinks(detail.report, status, window.location.hostname);
  } catch {
    return null;
  }
}

export function ProjectHub() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [backlogs, setBacklogs] = useState<string[]>([]);
  const [apps, setApps] = useState<AppLinks | null>(null);
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
        const rows = await runApi.runs(projectId);
        setRuns(rows);
        setApps(await latestApps(found, rows));
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
  const autoStarted = useRef(false);
  // A concluded project with nothing answering is brought up once; the polling below then shows its links.
  useEffect(() => {
    const last = project?.specs.at(-1);
    const down = apps !== null && !apps.web && !apps.swagger;
    if (!projectId || !last || !down || autoStarted.current || runs.some((r) => ACTIVE.has(r.status))) return;
    autoStarted.current = true;
    runApi.deployAgain(projectId, last.specId).then(refresh, (e: Error) => setError(e.message));
  }, [project, apps, runs, projectId, refresh]);
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
  const processRun = runs.find((r) => r.kind === 'run' && (ACTIVE.has(r.status) || r.status === 'interrupted')) ?? null;
  const { events: processEvents } = useJournal(processRun ? runApi.runEvents(processRun.runId) : null);
  if (!projectId) return null;
  if (!project && !notFound) return <ProjectHubSkeleton projectId={projectId} error={error} />;
  return (
    <ProjectHubView
      project={project}
      notFound={notFound}
      runs={runs}
      drafts={drafts}
      backlogs={backlogs}
      apps={apps}
      processRun={processRun}
      processEvents={processEvents}
      error={error}
      deleteError={deleteError}
      onStart={(specId) => act(async () => {
        // A spec the running program owns is prioritized there: follow it on the program's execution screen.
        const r = await runApi.startRun(projectId, specId);
        if (r.queued) navigate(startedPath(projectId, r));
      })()}
      onResume={(runId) => void act(() => runApi.resumeRun(runId))()}
      onStop={(runId) => void act(() => runApi.stopRun(runId))()}
      onNewSpec={(specId, description) => void go(() => refineApi.newSpec(projectId, specId, description))()}
      onContinue={(specId) => void go(() => refineApi.continueSpec(projectId, specId))()}
      onRestart={(specId) => void go(() => refineApi.restartSpec(projectId, specId))()}
      onStartApp={() => void act(() => runApi.deployAgain(projectId, project!.specs.at(-1)!.specId))()}
      onValidate={(specId) => void act(async () => navigate(`/runs/${(await runApi.deployAgain(projectId, specId)).runId}/validation`))()}
      onSuggestName={refineApi.suggestName}
      onDeleteDraft={(specId) => (async () => {
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
