import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { refineApi, runApi, type DraftRow, type NameRequest, type NameSuggestion, type ProjectRow } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Bone, Skeleton } from '../components/Loading.js';
import { GraphBody } from './repository/GraphPanel.js';
import { action, chip, emptyState, plural, row, rowActions, rowId, rows, sectionTitle } from './project-shared.js';

const toolbar = 'flex flex-wrap items-center gap-x-4 gap-y-2';
const filter = 'relative block min-w-0 flex-[0_1_24rem] max-md:basis-full [&_svg]:pointer-events-none [&_svg]:absolute [&_svg]:top-1/2 [&_svg]:left-3 [&_svg]:-translate-y-1/2 [&_svg]:text-ink-faint';
const grid = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-4';
const card = 'card flex flex-col gap-4 p-5 transition-[border-color,box-shadow] duration-[var(--duration-fast)] hover:border-accent-line hover:shadow-pop';
const cardBody = 'grid min-w-0 gap-1.5';
const cardTitle = 'm-0 text-[1.0625rem] leading-[1.3] text-ink wrap-anywhere';
const cardDesc = 'm-0 line-clamp-3 text-[0.875rem] leading-[1.45] text-ink-soft';
const cardFacts = 'm-0 text-[0.8125rem] text-ink-faint tabular-nums';
const cardActions = 'mt-auto flex flex-wrap gap-2 [&>*]:flex-auto';
// An open toggle reads as selected, so the form's own submit is the only filled button in view.
const toggleOpen = 'max-md:flex-[1_1_0] aria-expanded:border-accent-line aria-expanded:bg-accent-soft aria-expanded:text-accent-ink aria-expanded:shadow-none aria-expanded:hover:not-disabled:bg-accent-soft-hover';
const form = 'card grid gap-4 px-6 pt-5 pb-6 max-md:p-4';
const formHint = 'mt-1 mb-0 max-w-[72ch] text-[0.875rem] text-ink-soft';
const field = 'grid min-w-0 gap-1.5';
const fieldLabel = 'text-[0.8125rem] font-semibold text-ink-soft';

const HELP = {
  newProjects: 'Projetos criados em Novo projeto que ainda estão em refinamento. Eles entram na lista de projetos quando a primeira execução começar.',
};

/** The filter bar and three project cards, drawn with the real classes so the loaded list lands in place. */
function ProjectsSkeleton() {
  return (
    <Skeleton>
      <div className={toolbar} data-testid="projects-skeleton-toolbar">
        <span className={filter} data-testid="projects-skeleton-filter"><Bone size="control" /></span>
      </div>
      <div className={grid} data-testid="projects-skeleton-grid">
        {[0, 1, 2].map((i) => (
          <div className={card} key={i} data-testid="projects-skeleton-card">
            <div className={cardBody} data-testid="projects-skeleton-card-body">
              <p className={cardTitle} data-testid="projects-skeleton-title"><Bone size="half" /></p>
              <p className={cardDesc} data-testid="projects-skeleton-desc"><Bone /><Bone /><Bone size="short" /></p>
              <p className={cardFacts} data-testid="projects-skeleton-facts"><Bone size="half" /></p>
            </div>
            <div className={cardActions} data-testid="projects-skeleton-actions"><Bone size="action" /><Bone size="action" /></div>
          </div>
        ))}
      </div>
    </Skeleton>
  );
}

export function ProjectsView(p: {
  projects: ProjectRow[];
  drafts: DraftRow[];
  loading?: boolean;
  error: string | null;
  deleteError?: { projectId: string; specId: string; message: string } | null;
  onAdd: (dir: string) => void | Promise<void>;
  onNewProject: (projectId: string, name: string, description: string, firstSpecId: string) => void | Promise<void>;
  onSuggestName?: (input: NameRequest) => Promise<NameSuggestion>;
  onDeleteDraft: (projectId: string, specId: string) => void | Promise<void>;
  onDeleteProject: (projectId: string, deleteGithub: boolean) => void | Promise<void>;
  /** The GitHub repositories of a project and its services, as owner/name. */
  onGithubRepos?: (projectId: string) => Promise<string[]>;
  /** Projects whose deletion the server is running now, possibly started by an earlier page load. */
  deleting?: string[];
}) {
  const [repoUrl, setRepoUrl] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [firstSpecId, setFirstSpecId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const suggest = async () => {
    if (!p.onSuggestName) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const s = await p.onSuggestName({ kind: 'project', name: newProjectName, description: newProjectDescription });
      setNewProjectId(s.id);
      setFirstSpecId(s.firstSpecId ?? '');
    } catch (e) {
      setSuggestError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };
  const [panel, setPanel] = useState<'new' | 'git' | null>(null);
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const openDrafts = p.drafts.filter((d) => d.state !== 'started');
  const q = query.trim().toLowerCase();
  const matches = (...values: string[]) => q === '' || values.some((v) => v.toLowerCase().includes(q));
  const visible = p.projects.filter((pr) => matches(pr.projectId, pr.name, pr.description, pr.dir, ...pr.specs.map((s) => s.specId)));
  const unregistered = openDrafts.filter((d) => !d.registered && matches(d.projectId, d.specId));
  const total = plural(p.projects.length, 'projeto', 'projetos');
  const toggle = (next: 'new' | 'git') => setPanel(panel === next ? null : next);
  // The project whose code graph is open in a dialog.
  const [graphOf, setGraphOf] = useState<string | null>(null);
  const [pendingDeleteDraft, setPendingDeleteDraft] = useState<{ projectId: string; specId: string } | null>(null);
  const [pendingDeleteProject, setPendingDeleteProject] = useState<ProjectRow | null>(null);
  const [deleteStep, setDeleteStep] = useState<'loading' | 'repos' | 'confirm'>('loading');
  const [githubRepos, setGithubRepos] = useState<string[]>([]);
  const [deleteGithub, setDeleteGithub] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [deleteDialogError, setDeleteDialogError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const busyIds = [...deletingIds, ...(p.deleting ?? []).filter((id) => !deletingIds.includes(id))];
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeDelete = () => {
    setPendingDeleteProject(null);
    setTimeout(() => opener.current?.focus(), 0);
  };
  const openDeleteProject = async (project: ProjectRow) => {
    setPendingDeleteProject(project);
    setDeleteStep('loading');
    setGithubRepos([]);
    setDeleteGithub(false);
    setTypedName('');
    setDeleteDialogError(null);
    try {
      const repos = (await p.onGithubRepos?.(project.projectId)) ?? [];
      setGithubRepos(repos);
      setDeleteStep(repos.length > 0 ? 'repos' : 'confirm');
    } catch (e) {
      setDeleteDialogError(`Não foi possível listar os repositórios no GitHub: ${(e as Error).message}. Só os arquivos locais serão apagados.`);
      setDeleteStep('confirm');
    }
  };
  const confirmDeleteProject = () => {
    const project = pendingDeleteProject;
    if (!project) return;
    closeDelete();
    setDeleteFailure(null);
    setDeletingIds((ids) => [...ids, project.projectId]);
    void Promise.resolve(p.onDeleteProject(project.projectId, deleteGithub))
      .catch((e: Error) => setDeleteFailure(`Não foi possível excluir ${project.projectId}: ${e.message}`))
      .finally(() => setDeletingIds((ids) => ids.filter((id) => id !== project.projectId)));
  };
  const deleteReposDetail = (
    <>
      <p className="confirm-label" data-testid="projects-delete-repos-label">Repositórios no GitHub ({githubRepos.length})</p>
      <label className="confirm-check" data-testid="projects-delete-repos-check">
        <input type="checkbox" data-testid="projects-delete-repos-checkbox" checked={deleteGithub} onChange={(e) => setDeleteGithub(e.target.checked)} />
        Apagar também no GitHub
      </label>
      <ul className="confirm-repos" data-testid="projects-delete-repos-list">
        {githubRepos.map((r) => (
          <li key={r} data-testid={`projects-delete-repos-item-${r}`}><code data-testid={`projects-delete-repos-code-${r}`}>{r}</code></li>
        ))}
      </ul>
    </>
  );
  const deleteConfirmDetail = (
    <>
      {githubRepos.length === 0 ? null : deleteGithub ? (
        <>
          <p className="confirm-label" data-testid="projects-delete-confirm-github-label">Também serão apagados no GitHub ({githubRepos.length}):</p>
          <ul className="confirm-repos" data-testid="projects-delete-confirm-repos-list">
            {githubRepos.map((r) => (
              <li key={r} data-testid={`projects-delete-confirm-repos-item-${r}`}><code data-testid={`projects-delete-confirm-repos-code-${r}`}>{r}</code></li>
            ))}
          </ul>
        </>
      ) : (
        <p className="confirm-label" data-testid="projects-delete-confirm-github-off">Os repositórios no GitHub não serão apagados.</p>
      )}
      <p className="confirm-warning" data-testid="projects-delete-warning">Depois que a exclusão começar, não tem como cancelar.</p>
      {deleteDialogError ? <div className="error" role="alert" data-testid="projects-delete-dialog-error">{deleteDialogError}</div> : null}
      <label className="confirm-field" data-testid="projects-delete-name-field">
        <span data-testid="projects-delete-name-label">Digite <code data-testid="projects-delete-name-code">{pendingDeleteProject?.projectId}</code> para confirmar</span>
        <input data-testid="delete-project-name" value={typedName} onChange={(e) => setTypedName(e.target.value)} autoComplete="off" />
      </label>
    </>
  );
  return (
    <main data-testid="projects-main">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4" data-testid="projects-header">
        <div className="min-w-0 flex-[1_1_20rem]" data-testid="projects-title-block">
          <h1 className="m-0 text-ink" data-testid="projects-title">Projetos</h1>
          <p className="mt-1 mb-0 text-[0.9375rem] text-ink-soft" data-testid="projects-subtitle">Crie ou importe projetos, refine especificações e acompanhe as execuções.</p>
        </div>
        <div className="flex flex-wrap gap-2 max-md:flex-[1_1_100%]" data-testid="projects-actions">
          <button type="button" className={`secondary ${toggleOpen}`} data-testid="projects-import-git-button" aria-expanded={panel === 'git'} aria-controls="import-project-panel" onClick={() => toggle('git')}>
            Importar do Git
            <Icon name="download" size={16} />
          </button>
          <button type="button" className={`primary-button ${toggleOpen}`} data-testid="projects-new-button" aria-expanded={panel === 'new'} aria-controls="new-project-panel" onClick={() => toggle('new')}>
            Novo projeto
            <Icon name="plus" size={16} />
          </button>
        </div>
      </header>
      {panel === 'new' ? (
        <form
          id="new-project-panel" data-testid="projects-new-form"
          className={form}
          aria-labelledby="new-project-title"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitting(true);
            void Promise.resolve(p.onNewProject(newProjectId, newProjectName, newProjectDescription, firstSpecId)).finally(() => setSubmitting(false));
          }}
        >
          <div data-testid="projects-new-heading">
            <h2 id="new-project-title" data-testid="projects-new-title">Novo projeto</h2>
            <p className={formHint} data-testid="projects-new-hint">Defina um nome e um ID em inglês (letras minúsculas, números e hífens), ou peça à IA para sugerir o ID a partir do nome e da descrição. Se quiser, descreva o projeto com suas palavras: os agentes usam o texto para começar o refinamento e fazer as perguntas.</p>
          </div>
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-2" data-testid="projects-new-fields">
            <label className={field} data-testid="projects-new-id-field"><span className={fieldLabel} data-testid="projects-new-id-label">ID do projeto</span><input className="w-full min-w-0" data-testid="new-project-id" autoFocus value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)} placeholder="ex.: order-service" /></label>
            <label className={field} data-testid="projects-new-name-field"><span className={fieldLabel} data-testid="projects-new-name-label">Nome do projeto</span><input className="w-full min-w-0" data-testid="new-project-name" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="ex.: Portal interno" /></label>
          </div>
          {p.onSuggestName ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[0.8125rem] text-ink-soft" data-testid="projects-suggest-row">
              <ActionButton className="secondary" data-testid="suggest-project-id" busy={suggesting} disabled={newProjectName.trim() === '' && newProjectDescription.trim() === ''} onClick={suggest} icon={<Icon name="lightbulb" size={16} />}>
                {suggesting ? 'Sugerindo…' : 'Sugerir ID com IA'}
              </ActionButton>
              {firstSpecId ? <span data-testid="first-spec-id">Primeira spec: <code>{firstSpecId}</code></span> : null}
              {suggestError ? <span className="error" role="alert" data-testid="projects-suggest-error">{suggestError}</span> : null}
            </div>
          ) : null}
          <label className={field} data-testid="projects-description-field">
            <span className={fieldLabel} data-testid="projects-description-label">Descrição (opcional)</span>
            <textarea className="w-full min-w-0 resize-y" data-testid="new-project-description" rows={5} value={newProjectDescription} onChange={(e) => setNewProjectDescription(e.target.value)} placeholder="O que é, para quem serve, o que precisa fazer e o que fica de fora." />
          </label>
          <div className="flex justify-end" data-testid="projects-new-actions">
            <ActionButton data-testid="new-project" className="primary-button" type="submit" busy={submitting} disabled={newProjectId.trim() === '' || newProjectName.trim() === ''} icon={<Icon name="plus" size={16} />}>Criar projeto</ActionButton>
          </div>
        </form>
      ) : null}
      {panel === 'git' ? (
        <form
          id="import-project-panel" data-testid="projects-git-form"
          className={form}
          aria-labelledby="import-project-title"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitting(true);
            void Promise.resolve(p.onAdd(repoUrl)).finally(() => setSubmitting(false));
          }}
        >
          <div data-testid="projects-git-heading">
            <h2 id="import-project-title" data-testid="projects-git-title">Importar do Git</h2>
            <p className={formHint} data-testid="projects-git-hint">Cole o link de um repositório que já tenha <code data-testid="projects-git-code">docs/project.json</code>. O código é baixado e o projeto entra na lista.</p>
          </div>
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto]" data-testid="projects-git-fields">
            <label className={field} data-testid="projects-git-url-field"><span className={fieldLabel} data-testid="projects-git-url-label">URL do repositório</span><input className="w-full min-w-0" data-testid="projects-git-url-input" type="url" autoFocus value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/sua-org/seu-projeto.git" /></label>
            <ActionButton className="primary-button max-md:w-full" type="submit" busy={submitting} disabled={repoUrl.trim() === ''} icon={<Icon name="download" size={16} />}>
              Baixar e adicionar
            </ActionButton>
          </div>
        </form>
      ) : null}
      {p.error ? <p className="error m-0" role="alert" data-testid="projects-error">{p.error}</p> : null}
      {busyIds.map((id) => (
        <p key={id} className="m-0 text-[0.875rem] text-ink-soft" role="status" data-testid={`projects-deleting-${id}`}>O projeto {id} está sendo excluído em background.</p>
      ))}
      {deleteFailure ? <p className="error m-0" role="alert" data-testid="projects-delete-failure">{deleteFailure}</p> : null}
      {p.loading ? <ProjectsSkeleton /> : p.projects.length === 0 ? (
        <div className={emptyState} data-testid="projects-empty">
          <Icon name="list" size={24} />
          <p data-testid="projects-empty-title">Seus projetos aparecem aqui.</p>
          <p data-testid="projects-empty-hint">Use <strong data-testid="projects-empty-new-label">Novo projeto</strong> para começar do zero ou <strong data-testid="projects-empty-import-label">Importar do Git</strong> para trazer um repositório existente.</p>
        </div>
      ) : (
        <div className={toolbar} data-testid="projects-toolbar">
          <label className={filter} data-testid="projects-filter-field">
            <span className="sr-only" data-testid="projects-filter-label">Filtrar projetos</span>
            <Icon name="search" size={16} />
            <input ref={filterRef} data-testid="projects-filter-input" className="w-full min-w-0 appearance-none pl-[2.375rem]" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar por projeto, nome ou spec" />
          </label>
          <p className="m-0 text-[0.8125rem] text-ink-soft tabular-nums" aria-live="polite" data-testid="projects-count">{q ? `${visible.length} de ${total}` : total}</p>
        </div>
      )}
      {p.projects.length > 0 && visible.length === 0 ? (
        <div className={emptyState} data-testid="projects-no-match">
          <Icon name="search" size={24} />
          <p data-testid="projects-no-match-title">{`Nenhum projeto corresponde a “${query.trim()}”.`}</p>
          <p data-testid="projects-no-match-hint">Busque pelo ID do projeto, pelo nome, pela pasta ou por uma spec.</p>
          <button
            type="button"
            aria-label="Limpar filtro"
            data-testid="projects-clear-filter-button"
            onClick={() => {
              setQuery('');
              filterRef.current?.focus();
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}
      {visible.length > 0 ? (
        <div className={grid} data-testid="projects-grid">
          {visible.map((pr) => {
            const percent = pr.specs.length === 0 ? null : Math.round((pr.specs.filter((s) => s.status === 'done' || s.status === 'complete').length / pr.specs.length) * 100);
            const busy = busyIds.includes(pr.projectId);
            return (
              <article className={card} key={pr.projectId} data-testid={`projects-card-${pr.projectId}`}>
                <div className={cardBody} data-testid={`projects-card-body-${pr.projectId}`}>
                  <h2 className={cardTitle} data-testid={`projects-card-title-${pr.projectId}`}>{pr.name || pr.projectId}</h2>
                  <p className={cardDesc} data-testid={`projects-card-desc-${pr.projectId}`}>{pr.description || 'Sem descrição.'}</p>
                  <p className={cardFacts} data-testid={`projects-card-facts-${pr.projectId}`}>
                    {plural(pr.specs.length, 'spec', 'specs')}
                    {percent === null ? null : ` · ${percent}% concluído`}
                  </p>
                </div>
                <div className={cardActions} data-testid={`projects-card-actions-${pr.projectId}`}>
                  <button type="button" className={`${action.danger} aria-disabled:pointer-events-none aria-disabled:opacity-60`} data-testid={`delete-project-${pr.projectId}`} aria-label={`Excluir projeto ${pr.projectId}`} aria-disabled={busy || undefined} onClick={(e) => { if (busy) return; opener.current = e.currentTarget; void openDeleteProject(pr); }}>
                    Excluir
                    {busy ? <span className="button-spinner" aria-hidden="true" /> : <Icon name="trash" size={14} />}
                  </button>
                  <Link className={`${action.secondary} aria-disabled:pointer-events-none aria-disabled:opacity-60`} data-testid={`new-spec-${pr.projectId}`} aria-label={`Nova spec no projeto ${pr.projectId}`} aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} to={`/projects/${pr.projectId}?novaSpec=1`}>
                    Nova spec
                    <Icon name="plus" size={14} />
                  </Link>
                  <button type="button" className={action.secondary} data-testid={`graph-project-${pr.projectId}`} aria-label={`Ver o grafo do código do projeto ${pr.projectId}`} onClick={(e) => { opener.current = e.currentTarget; setGraphOf(pr.projectId); }}>
                    Graphify
                    <Icon name="code" size={14} />
                  </button>
                  <Link className={`${action.secondary} aria-disabled:pointer-events-none aria-disabled:opacity-60`} data-testid={`open-project-${pr.projectId}`} aria-label={`Abrir projeto ${pr.projectId}`} aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} to={`/projects/${pr.projectId}`}>
                    Abrir
                    <Icon name="arrow-right" size={14} />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
      {unregistered.length > 0 ? (
        <section className={`${panel} gap-3`} aria-labelledby="new-projects-title" data-testid="projects-drafts-section">
          <div className={sectionTitle} data-testid="projects-drafts-title-row">
            <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="new-projects-title" data-testid="projects-drafts-title">Novos projetos em refinamento</h2>
            <InfoTip label="Novos projetos em refinamento" text={HELP.newProjects} />
          </div>
          <ul className={rows} data-testid="projects-drafts-list">
            {unregistered.map((d) => (
              <li className={row} key={`${d.projectId}/${d.specId}`} data-testid={`projects-draft-${d.projectId}-${d.specId}`}>
                <span className={rowId} data-testid={`projects-draft-id-${d.projectId}-${d.specId}`}>{d.projectId} / {d.specId}</span>
                {chip(d.state)}
                <span className={`${rowActions} max-lg:flex-col max-lg:[&>*]:w-full max-lg:[&>*]:!ml-0`} data-testid={`projects-draft-actions-${d.projectId}-${d.specId}`}>
                  <button type="button" className={action.danger} data-testid={`delete-${d.projectId}-${d.specId}`} aria-label={`Excluir refinamento de ${d.projectId} / ${d.specId}`} onClick={() => setPendingDeleteDraft({ projectId: d.projectId, specId: d.specId })}>
                    Excluir
                    <Icon name="trash" size={14} />
                  </button>
                  <Link className={action.secondary} data-testid={`refine-${d.projectId}-${d.specId}`} aria-label={`Abrir refinamento de ${d.projectId} / ${d.specId}`} to={`/refine/${d.projectId}/${d.specId}`}>
                    Abrir
                    <Icon name="arrow-right" size={14} />
                  </Link>
                </span>
                {p.deleteError?.projectId === d.projectId && p.deleteError.specId === d.specId ? <p className="error" role="alert" data-testid={`projects-draft-error-${d.projectId}-${d.specId}`}>{p.deleteError.message}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {pendingDeleteDraft ? (
        <ConfirmDialog
          title="Excluir refinamento?"
          subject={`${pendingDeleteDraft.projectId} / ${pendingDeleteDraft.specId}`}
          confirmLabel="Excluir"
          onCancel={() => setPendingDeleteDraft(null)}
          onConfirm={async () => {
            await p.onDeleteDraft(pendingDeleteDraft.projectId, pendingDeleteDraft.specId);
            setPendingDeleteDraft(null);
          }}
        >
          O projeto volta a poder ser criado do zero. Essa ação não pode ser desfeita.
        </ConfirmDialog>
      ) : null}
      {pendingDeleteProject ? (
        <ConfirmDialog
          key={deleteStep}
          title={deleteStep === 'confirm' ? 'Confirmar exclusão' : 'Excluir projeto?'}
          subject={pendingDeleteProject.projectId}
          confirmLabel={deleteStep === 'confirm' ? 'Excluir projeto' : 'Continuar'}
          tone={deleteStep === 'confirm' ? 'danger' : 'accent'}
          icon="trash"
          confirmDisabled={deleteStep === 'loading' || (deleteStep === 'confirm' && typedName !== pendingDeleteProject.projectId)}
          detail={deleteStep === 'confirm' ? deleteConfirmDetail : deleteStep === 'repos' ? deleteReposDetail : null}
          onCancel={closeDelete}
          onConfirm={deleteStep === 'confirm' ? confirmDeleteProject : () => setDeleteStep('confirm')}
        >
          {deleteStep === 'loading'
            ? 'Carregando repositórios…'
            : deleteStep === 'repos'
              ? 'Marque para apagar também os repositórios no GitHub. Os arquivos locais são apagados de qualquer forma.'
              : 'Serão apagados os specs, as execuções e os arquivos locais. Execuções em andamento são paradas. Não pode ser desfeito.'}
        </ConfirmDialog>
      ) : null}
      {graphOf ? (
        <Dialog title={`Grafo do código · ${graphOf}`} returnFocus={opener.current} onClose={() => setGraphOf(null)}>
          <div className="grid gap-3 p-5">
            <GraphBody projectId={graphOf} />
          </div>
        </Dialog>
      ) : null}
    </main>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [deleting, setDeleting] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ projectId: string; specId: string; message: string } | null>(null);
  const navigate = useNavigate();
  const refresh = useCallback(async () => {
    try {
      setProjects(await runApi.projects());
      setDrafts(await refineApi.list());
      setDeleting(await runApi.deletingProjects());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
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
      drafts={drafts}
      loading={loading}
      error={error}
      deleting={deleting}
      onAdd={(d) => act(() => runApi.addProject(d))()}
      onNewProject={(id, name, description, firstSpecId) => go(() => refineApi.newProject(id, name, description, firstSpecId))()}
      onSuggestName={refineApi.suggestName}
      deleteError={deleteError}
      onDeleteDraft={(p, s) => (async () => {
        setDeleteError(null);
        try {
          await refineApi.delete(p, s);
        } catch (e) {
          setDeleteError({ projectId: p, specId: s, message: (e as Error).message });
        }
        await refresh();
      })()}
      onDeleteProject={async (projectId, deleteGithub) => {
        try {
          await runApi.deleteProject(projectId, deleteGithub);
        } finally {
          await refresh();
        }
      }}
      onGithubRepos={(projectId) => runApi.githubRepos(projectId)}
    />
  );
}
