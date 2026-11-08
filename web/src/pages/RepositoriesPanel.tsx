import { Link } from 'react-router-dom';
import { queryPage } from '@server/api/paging.js';
import { repoPath } from '../routes.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Pagination, TableFilters, usePagedTable } from '../components/DataTable.js';
import type { RepoCardView } from '../api.js';
import { Meter, panel, plural, sectionHeading, sectionTitle } from './project-shared.js';

const STATUS_LABEL: Record<RepoCardView['status'], string> = {
  blocked: 'Bloqueado',
  running: 'Em execução',
  waiting: 'Aguardando você',
  refining: 'Em refinamento',
  done: 'Concluído',
  empty: 'Sem specs',
};

const STATUS_TONE: Record<RepoCardView['status'], string> = { blocked: 'bad', running: 'neutral', waiting: 'warn', refining: 'neutral', done: 'good', empty: '' };

const KIND_LABEL: Record<string, string> = { api: 'API', jobs: 'Workers', web: 'Web', mobile: 'Mobile', workflow: 'Workflow', monolith: 'Monólito' };

const kindOf = (repo: RepoCardView) => KIND_LABEL[repo.kind ?? ''] ?? repo.kind ?? 'sem tipo';

/** The project's repositories as cards: each one's kind, what it is for, its counts, its task progress and its state; searched and filtered by kind on the page. */
export function RepositoriesPanel({ projectId, repositories }: { projectId: string; repositories: RepoCardView[] }) {
  const view = usePagedTable(`${projectId}/repositories`, (req) => Promise.resolve(queryPage(repositories, { text: (r) => [r.name, r.responsibility], facet: kindOf }, req)), (v) => v, JSON.stringify(repositories));
  return (
    <section className={panel} data-testid="project-repositories">
      <div data-testid="repositories-panel-body" className="grid min-w-0 gap-3">
        <div data-testid="repositories-panel-toolbar" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div data-testid="repositories-panel-title" className={sectionTitle}>
            <span data-testid="repositories-panel-icon" className="grid size-6 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink"><Icon name="code" size={14} /></span>
            <h2 data-testid="repositories-panel-heading" className={sectionHeading}>{`Repositórios (${repositories.length})`}</h2>
            <InfoTip label="Repositórios" text="Cada repositório da arquitetura, com as suas specs, planos e tarefas. A etiqueta mostra em que etapa ele está, e Abrir painel mostra as entregas, as execuções e as falhas dele." />
          </div>
        </div>
        <TableFilters view={view} subject="repositórios" placeholder="Buscar por nome ou responsabilidade" facetName="Tipo" />
        <ul data-testid="repositories-panel-list" className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
          {view.rows.map((repo) => (
            <li key={repo.name} className="card flex min-w-0 flex-col gap-2 p-4 text-left hyphens-manual" data-testid={`repo-card-${repo.name}`}>
              <div data-testid={`repositories-panel-card-tags-${repo.name}`} className="flex flex-wrap items-center gap-2">
                <Link data-testid={`repositories-panel-card-name-${repo.name}`} className="font-semibold text-ink wrap-anywhere" to={repoPath(projectId, repo.name)}>{repo.name}</Link>
                <span data-testid={`repositories-panel-card-kind-${repo.name}`} className="count-pill">{kindOf(repo)}</span>
                <span className={STATUS_TONE[repo.status] ? `status-pill tone-${STATUS_TONE[repo.status]}` : 'status-pill'} data-testid={`repo-status-${repo.name}`}>{STATUS_LABEL[repo.status]}{repo.blockers > 0 ? ` · ${plural(repo.blockers, 'bloqueio', 'bloqueios')}` : ''}</span>
              </div>
              <p data-testid={`repositories-panel-card-responsibility-${repo.name}`} className="m-0 line-clamp-2 text-[0.8125rem] text-ink-soft">{repo.responsibility}</p>
              <p data-testid={`repositories-panel-card-counts-${repo.name}`} className="m-0 text-[0.8125rem] text-ink-soft">{`${repo.specs} specs · ${repo.plans} planos · ${repo.tasks} tarefas`}</p>
              <p data-testid={`repositories-panel-card-progress-${repo.name}`} className="m-0 text-[0.8125rem] text-ink-soft">{`Tarefas: ${repo.tasksDone} de ${repo.tasks} concluídas`}</p>
              {repo.tasks > 0 && <Meter value={Math.round((repo.tasksDone / repo.tasks) * 100)} label={`Tarefas concluídas de ${repo.name}`} testId={`repositories-panel-card-tasks-${repo.name}`} />}
              <Link className="mt-auto self-end text-[0.8125rem] font-semibold text-accent-ink" to={repoPath(projectId, repo.name)}>Abrir painel</Link>
            </li>
          ))}
        </ul>
        <Pagination view={view} />
      </div>
    </section>
  );
}
