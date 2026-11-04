import { Link } from 'react-router-dom';
import { repoPath } from '../routes.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import type { RepoCardView } from '../api.js';
import { panel, sectionHeading, sectionTitle } from './project-shared.js';

const STATUS_LABEL: Record<RepoCardView['status'], string> = {
  blocked: 'Bloqueado',
  running: 'Em execução',
  waiting: 'Aguardando você',
  refining: 'Em refinamento',
  done: 'Concluído',
  empty: 'Sem specs',
};

const KIND_LABEL: Record<string, string> = { api: 'API', jobs: 'Workers', web: 'Web', mobile: 'Mobile', workflow: 'Workflow', monolith: 'Monólito' };

/** The project's repositories as cards: each one's kind, what it is for, its counts, its task progress and its state. */
export function RepositoriesPanel({ projectId, repositories }: { projectId: string; repositories: RepoCardView[] }) {
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
        <ul data-testid="repositories-panel-list" className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
          {repositories.map((repo) => (
            <li key={repo.name} className="card flex min-w-0 flex-col gap-2 p-4" data-testid={`repo-card-${repo.name}`}>
              <div data-testid={`repositories-panel-card-tags-${repo.name}`} className="flex flex-wrap items-center gap-2">
                <strong data-testid={`repositories-panel-card-name-${repo.name}`} className="wrap-anywhere">{repo.name}</strong>
                <span data-testid={`repositories-panel-card-kind-${repo.name}`} className="count-pill">{KIND_LABEL[repo.kind ?? ''] ?? repo.kind ?? 'sem tipo'}</span>
                <span className="count-pill" data-testid={`repo-status-${repo.name}`}>{STATUS_LABEL[repo.status]}{repo.blockers > 0 ? ` · ${repo.blockers} bloqueio(s)` : ''}</span>
              </div>
              <p data-testid={`repositories-panel-card-responsibility-${repo.name}`} className="m-0 text-[0.8125rem] text-ink-soft">{repo.responsibility}</p>
              <p data-testid={`repositories-panel-card-counts-${repo.name}`} className="m-0 text-[0.8125rem] text-ink-soft">{`${repo.specs} specs · ${repo.plans} planos · ${repo.tasks} tarefas`}</p>
              <p data-testid={`repositories-panel-card-progress-${repo.name}`} className="m-0 text-[0.8125rem] text-ink-soft">{`Tarefas: ${repo.tasksDone} de ${repo.tasks} concluídas`}</p>
              <Link className="link-button mt-auto self-end" to={repoPath(projectId, repo.name)}>Abrir painel</Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
