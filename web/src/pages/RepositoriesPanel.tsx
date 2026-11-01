import { Link } from 'react-router-dom';
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
      <div className="grid min-w-0 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className={sectionTitle}>
            <span className="grid size-6 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink"><Icon name="code" size={14} /></span>
            <h2 className={sectionHeading}>{`Repositórios (${repositories.length})`}</h2>
            <InfoTip label="Repositórios" text="Cada repositório da arquitetura, com as suas specs, planos e tarefas." />
          </div>
        </div>
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
          {repositories.map((repo) => (
            <li key={repo.name} className="card grid min-w-0 gap-2 p-4" data-testid={`repo-card-${repo.name}`}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="wrap-anywhere">{repo.name}</strong>
                <span className="count-pill">{KIND_LABEL[repo.kind ?? ''] ?? repo.kind ?? 'sem tipo'}</span>
                <span className="count-pill" data-testid={`repo-status-${repo.name}`}>{STATUS_LABEL[repo.status]}{repo.blockers > 0 ? ` · ${repo.blockers} bloqueio(s)` : ''}</span>
              </div>
              <p className="m-0 text-[0.8125rem] text-ink-soft">{repo.responsibility}</p>
              <p className="m-0 text-[0.8125rem] text-ink-soft">{`${repo.specs} specs · ${repo.plans} planos · ${repo.tasks} tarefas`}</p>
              <p className="m-0 text-[0.8125rem] text-ink-soft">{`Tarefas: ${repo.tasksDone} de ${repo.tasks} concluídas`}</p>
              <Link className="link-button justify-self-start" to={`/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(repo.name)}`}>Abrir painel</Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
