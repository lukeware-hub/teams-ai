import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { refineApi, runApi, type DraftRow, type NameRequest, type NameSuggestion, type ProjectRow } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Bone, Skeleton } from '../components/Loading.js';
import { action, chip, emptyState, panel, plural, row, rowActions, rowId, rows, sectionTitle } from './project-shared.js';

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
      <div className={toolbar}>
        <span className={filter}><Bone size="control" /></span>
      </div>
      <div className={grid}>
        {[0, 1, 2].map((i) => (
          <div className={card} key={i}>
            <div className={cardBody}>
              <p className={cardTitle}><Bone size="half" /></p>
              <p className={cardDesc}><Bone /><Bone /><Bone size="short" /></p>
              <p className={cardFacts}><Bone size="half" /></p>
            </div>
            <div className={cardActions}><Bone size="action" /><Bone size="action" /></div>
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
  onDeleteProject: (projectId: string) => void | Promise<void>;
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
  const [pendingDeleteDraft, setPendingDeleteDraft] = useState<{ projectId: string; specId: string } | null>(null);
  const [pendingDeleteProject, setPendingDeleteProject] = useState<ProjectRow | null>(null);
  return (
    <main>
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="m-0 text-ink">Projetos</h1>
          <p className="mt-1 mb-0 text-[0.9375rem] text-ink-soft">Crie ou importe projetos, refine especificações e acompanhe as execuções.</p>
        </div>
        <div className="flex flex-wrap gap-2 max-md:flex-[1_1_100%]">
          <button type="button" className={`secondary ${toggleOpen}`} aria-expanded={panel === 'git'} aria-controls="import-project-panel" onClick={() => toggle('git')}>
            Importar do Git
            <Icon name="download" size={16} />
          </button>
          <button type="button" className={`primary-button ${toggleOpen}`} aria-expanded={panel === 'new'} aria-controls="new-project-panel" onClick={() => toggle('new')}>
            Novo projeto
            <Icon name="plus" size={16} />
          </button>
        </div>
      </header>
      {panel === 'new' ? (
        <form
          id="new-project-panel"
          className={form}
          aria-labelledby="new-project-title"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitting(true);
            void Promise.resolve(p.onNewProject(newProjectId, newProjectName, newProjectDescription, firstSpecId)).finally(() => setSubmitting(false));
          }}
        >
          <div>
            <h2 id="new-project-title">Novo projeto</h2>
            <p className={formHint}>Defina um nome e um ID em inglês (letras minúsculas, números e hífens), ou peça à IA para sugerir o ID a partir do nome e da descrição. Se quiser, descreva o projeto com suas palavras: os agentes usam o texto para começar o refinamento e fazer as perguntas.</p>
          </div>
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-2">
            <label className={field}><span className={fieldLabel}>ID do projeto</span><input className="w-full min-w-0" data-testid="new-project-id" autoFocus value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)} placeholder="ex.: order-service" /></label>
            <label className={field}><span className={fieldLabel}>Nome do projeto</span><input className="w-full min-w-0" data-testid="new-project-name" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="ex.: Portal interno" /></label>
          </div>
          {p.onSuggestName ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[0.8125rem] text-ink-soft">
              <ActionButton className="secondary" data-testid="suggest-project-id" busy={suggesting} disabled={newProjectName.trim() === '' && newProjectDescription.trim() === ''} onClick={suggest} icon={<Icon name="lightbulb" size={16} />}>
                {suggesting ? 'Sugerindo…' : 'Sugerir ID com IA'}
              </ActionButton>
              {firstSpecId ? <span data-testid="first-spec-id">Primeira spec: <code>{firstSpecId}</code></span> : null}
              {suggestError ? <span className="error" role="alert">{suggestError}</span> : null}
            </div>
          ) : null}
          <label className={field}>
            <span className={fieldLabel}>Descrição (opcional)</span>
            <textarea className="w-full min-w-0 resize-y" data-testid="new-project-description" rows={5} value={newProjectDescription} onChange={(e) => setNewProjectDescription(e.target.value)} placeholder="O que é, para quem serve, o que precisa fazer e o que fica de fora." />
          </label>
          <div className="flex justify-end">
            <ActionButton data-testid="new-project" className="primary-button" type="submit" busy={submitting} disabled={newProjectId.trim() === '' || newProjectName.trim() === ''} icon={<Icon name="plus" size={16} />}>Criar projeto</ActionButton>
          </div>
        </form>
      ) : null}
      {panel === 'git' ? (
        <form
          id="import-project-panel"
          className={form}
          aria-labelledby="import-project-title"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitting(true);
            void Promise.resolve(p.onAdd(repoUrl)).finally(() => setSubmitting(false));
          }}
        >
          <div>
            <h2 id="import-project-title">Importar do Git</h2>
            <p className={formHint}>Cole o link de um repositório que já tenha <code>docs/project.json</code>. O código é baixado e o projeto entra na lista.</p>
          </div>
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <label className={field}><span className={fieldLabel}>URL do repositório</span><input className="w-full min-w-0" type="url" autoFocus value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/sua-org/seu-projeto.git" /></label>
            <ActionButton className="primary-button max-md:w-full" type="submit" busy={submitting} disabled={repoUrl.trim() === ''} icon={<Icon name="download" size={16} />}>
              Baixar e adicionar
            </ActionButton>
          </div>
        </form>
      ) : null}
      {p.error ? <p className="error m-0" role="alert">{p.error}</p> : null}
      {p.loading ? <ProjectsSkeleton /> : p.projects.length === 0 ? (
        <div className={emptyState}>
          <Icon name="list" size={24} />
          <p>Seus projetos aparecem aqui.</p>
          <p>Use <strong>Novo projeto</strong> para começar do zero ou <strong>Importar do Git</strong> para trazer um repositório existente.</p>
        </div>
      ) : (
        <div className={toolbar}>
          <label className={filter}>
            <span className="sr-only">Filtrar projetos</span>
            <Icon name="search" size={16} />
            <input ref={filterRef} className="w-full min-w-0 appearance-none pl-[2.375rem]" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar por projeto, nome ou spec" />
          </label>
          <p className="m-0 text-[0.8125rem] text-ink-soft tabular-nums" aria-live="polite">{q ? `${visible.length} de ${total}` : total}</p>
        </div>
      )}
      {p.projects.length > 0 && visible.length === 0 ? (
        <div className={emptyState}>
          <Icon name="search" size={24} />
          <p>{`Nenhum projeto corresponde a “${query.trim()}”.`}</p>
          <p>Busque pelo ID do projeto, pelo nome, pela pasta ou por uma spec.</p>
          <button
            type="button"
            aria-label="Limpar filtro"
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
        <div className={grid}>
          {visible.map((pr) => {
            const percent = pr.specs.length === 0 ? null : Math.round((pr.specs.filter((s) => s.status === 'done' || s.status === 'complete').length / pr.specs.length) * 100);
            return (
              <article className={card} key={pr.projectId}>
                <div className={cardBody}>
                  <h2 className={cardTitle}>{pr.name || pr.projectId}</h2>
                  <p className={cardDesc}>{pr.description || 'Sem descrição.'}</p>
                  <p className={cardFacts}>
                    {plural(pr.specs.length, 'spec', 'specs')}
                    {percent === null ? null : ` · ${percent}% concluído`}
                  </p>
                </div>
                <div className={cardActions}>
                  <button type="button" className={action.danger} data-testid={`delete-project-${pr.projectId}`} aria-label={`Excluir projeto ${pr.projectId}`} onClick={() => setPendingDeleteProject(pr)}>
                    Excluir
                    <Icon name="trash" size={14} />
                  </button>
                  <Link className={action.secondary} data-testid={`new-spec-${pr.projectId}`} aria-label={`Nova spec no projeto ${pr.projectId}`} to={`/projects/${pr.projectId}?novaSpec=1`}>
                    Nova spec
                    <Icon name="plus" size={14} />
                  </Link>
                  <Link className={action.secondary} data-testid={`open-project-${pr.projectId}`} aria-label={`Abrir projeto ${pr.projectId}`} to={`/projects/${pr.projectId}`}>
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
        <section className={`${panel} gap-3`} aria-labelledby="new-projects-title">
          <div className={sectionTitle}>
            <h2 className="flex-[0_1_auto] text-[1.125rem] leading-[1.3]" id="new-projects-title">Novos projetos em refinamento</h2>
            <InfoTip label="Novos projetos em refinamento" text={HELP.newProjects} />
          </div>
          <ul className={rows}>
            {unregistered.map((d) => (
              <li className={row} key={`${d.projectId}/${d.specId}`}>
                <span className={rowId}>{d.projectId} / {d.specId}</span>
                {chip(d.state)}
                <span className={`${rowActions} max-lg:flex-col max-lg:[&>*]:w-full max-lg:[&>*]:!ml-0`}>
                  <button type="button" className={action.danger} data-testid={`delete-${d.projectId}-${d.specId}`} aria-label={`Excluir refinamento de ${d.projectId} / ${d.specId}`} onClick={() => setPendingDeleteDraft({ projectId: d.projectId, specId: d.specId })}>
                    Excluir
                    <Icon name="trash" size={14} />
                  </button>
                  <Link className={action.secondary} data-testid={`refine-${d.projectId}-${d.specId}`} aria-label={`Abrir refinamento de ${d.projectId} / ${d.specId}`} to={`/refine/${d.projectId}/${d.specId}`}>
                    Abrir
                    <Icon name="arrow-right" size={14} />
                  </Link>
                </span>
                {p.deleteError?.projectId === d.projectId && p.deleteError.specId === d.specId ? <p className="error" role="alert">{p.deleteError.message}</p> : null}
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
          title="Excluir projeto?"
          subject={pendingDeleteProject.name || pendingDeleteProject.projectId}
          confirmLabel="Excluir projeto"
          onCancel={() => setPendingDeleteProject(null)}
          onConfirm={async () => {
            await p.onDeleteProject(pendingDeleteProject.projectId);
            setPendingDeleteProject(null);
          }}
        >
          Apaga specs, execuções e arquivos do projeto no disco. O repositório no GitHub não é apagado. Essa ação não pode ser desfeita. Pare execuções em andamento antes de excluir.
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ projectId: string; specId: string; message: string } | null>(null);
  const navigate = useNavigate();
  const refresh = useCallback(async () => {
    try {
      setProjects(await runApi.projects());
      setDrafts(await refineApi.list());
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
      onDeleteProject={(projectId) => act(() => runApi.deleteProject(projectId))()}
    />
  );
}
