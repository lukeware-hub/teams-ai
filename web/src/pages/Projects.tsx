import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { refineApi, runApi, type DraftRow, type NameRequest, type NameSuggestion, type ProjectRow } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Bone, Skeleton } from '../components/Loading.js';
import { chip, plural } from './project-shared.js';
import './projects.css';

const HELP = {
  newProjects: 'Projetos criados em Novo projeto que ainda estão em refinamento. Eles entram na lista de projetos quando a primeira execução começar.',
};

/** The filter bar and three project cards, drawn with the real classes so the loaded list lands in place. */
function ProjectsSkeleton() {
  return (
    <Skeleton>
      <div className="projects-toolbar">
        <span className="projects-filter"><Bone size="control" /></span>
      </div>
      <div className="project-grid">
        {[0, 1, 2].map((i) => (
          <div className="card project-card" key={i}>
            <div className="project-card-body">
              <p className="project-card-title"><Bone size="half" /></p>
              <p className="project-card-desc"><Bone /><Bone /><Bone size="short" /></p>
              <p className="project-card-facts"><Bone size="half" /></p>
            </div>
            <div className="project-card-actions"><Bone size="action" /><Bone size="action" /></div>
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
  onAdd: (dir: string) => void;
  onNewProject: (projectId: string, name: string, description: string, firstSpecId: string) => void;
  onSuggestName?: (input: NameRequest) => Promise<NameSuggestion>;
  onDeleteDraft: (projectId: string, specId: string) => void;
  onDeleteProject: (projectId: string) => void;
}) {
  const [repoUrl, setRepoUrl] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [firstSpecId, setFirstSpecId] = useState('');
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
            p.onNewProject(newProjectId, newProjectName, newProjectDescription, firstSpecId);
          }}
        >
          <div>
            <h2 id="new-project-title">Novo projeto</h2>
            <p className="projects-form-hint">Defina um nome e um ID em inglês (letras minúsculas, números e hífens), ou peça à IA para sugerir o ID a partir do nome e da descrição. Se quiser, descreva o projeto com suas palavras: os agentes usam o texto para começar o refinamento e fazer as perguntas.</p>
          </div>
          <div className="projects-form-fields">
            <label><span>ID do projeto</span><input data-testid="new-project-id" autoFocus value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)} placeholder="ex.: order-service" /></label>
            <label><span>Nome do projeto</span><input data-testid="new-project-name" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="ex.: Portal interno" /></label>
          </div>
          {p.onSuggestName ? (
            <div className="projects-suggest">
              <button type="button" className="secondary" data-testid="suggest-project-id" disabled={suggesting || (newProjectName.trim() === '' && newProjectDescription.trim() === '')} onClick={() => void suggest()}>
                <Icon name="lightbulb" size={16} />
                {suggesting ? 'Sugerindo…' : 'Sugerir ID com IA'}
              </button>
              {firstSpecId ? <span data-testid="first-spec-id">Primeira spec: <code>{firstSpecId}</code></span> : null}
              {suggestError ? <span className="error" role="alert">{suggestError}</span> : null}
            </div>
          ) : null}
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
      {p.loading ? <ProjectsSkeleton /> : p.projects.length === 0 ? (
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
            <input ref={filterRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar por projeto, nome ou spec" />
          </label>
          <p className="projects-count" aria-live="polite">{q ? `${visible.length} de ${total}` : total}</p>
        </div>
      )}
      {p.projects.length > 0 && visible.length === 0 ? (
        <div className="projects-empty">
          <Icon name="search" size={24} />
          <p>{`Nenhum projeto corresponde a “${query.trim()}”.`}</p>
          <p>Busque pelo ID do projeto, pelo nome, pela pasta ou por uma spec.</p>
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
      {visible.length > 0 ? (
        <div className="project-grid">
          {visible.map((pr) => {
            const percent = pr.specs.length === 0 ? null : Math.round((pr.specs.filter((s) => s.status === 'done' || s.status === 'complete').length / pr.specs.length) * 100);
            return (
              <article className="card project-card" key={pr.projectId}>
                <div className="project-card-body">
                  <h2 className="project-card-title">{pr.name || pr.projectId}</h2>
                  <p className="project-card-desc">{pr.description || 'Sem descrição.'}</p>
                  <p className="project-card-facts">
                    {plural(pr.specs.length, 'spec', 'specs')}
                    {percent === null ? null : ` · ${percent}% concluído`}
                  </p>
                </div>
                <div className="project-card-actions">
                  <button type="button" className="project-action project-action-danger" data-testid={`delete-project-${pr.projectId}`} aria-label={`Excluir projeto ${pr.projectId}`} onClick={() => setPendingDeleteProject(pr)}>
                    <Icon name="trash" size={14} />
                    Excluir
                  </button>
                  <Link className="project-action secondary" data-testid={`open-project-${pr.projectId}`} aria-label={`Abrir projeto ${pr.projectId}`} to={`/projects/${pr.projectId}`}>
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
                  <button type="button" className="project-action project-action-danger" data-testid={`delete-${d.projectId}-${d.specId}`} aria-label={`Excluir refinamento de ${d.projectId} / ${d.specId}`} onClick={() => setPendingDeleteDraft({ projectId: d.projectId, specId: d.specId })}>
                    <Icon name="trash" size={14} />
                    Excluir
                  </button>
                  <Link className="project-action secondary" data-testid={`refine-${d.projectId}-${d.specId}`} aria-label={`Abrir refinamento de ${d.projectId} / ${d.specId}`} to={`/refine/${d.projectId}/${d.specId}`}>
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
          onConfirm={() => {
            p.onDeleteDraft(pendingDeleteDraft.projectId, pendingDeleteDraft.specId);
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
          onConfirm={() => {
            p.onDeleteProject(pendingDeleteProject.projectId);
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
      onAdd={(d) => void act(() => runApi.addProject(d))()}
      onNewProject={(id, name, description, firstSpecId) => void go(() => refineApi.newProject(id, name, description, firstSpecId))()}
      onSuggestName={refineApi.suggestName}
      deleteError={deleteError}
      onDeleteDraft={(p, s) => void (async () => {
        setDeleteError(null);
        try {
          await refineApi.delete(p, s);
        } catch (e) {
          setDeleteError({ projectId: p, specId: s, message: (e as Error).message });
        }
        await refresh();
      })()}
      onDeleteProject={(projectId) => void act(() => runApi.deleteProject(projectId))()}
    />
  );
}
