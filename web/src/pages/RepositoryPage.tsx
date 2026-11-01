import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { runApi, type RepoDetailView } from '../api.js';
import { Icon } from '../components/Icons.js';
import { panel, sectionHeading, sectionTitle } from './project-shared.js';

const STATUS_LABEL: Record<RepoDetailView['status'], string> = {
  blocked: 'Bloqueado',
  running: 'Em execução',
  waiting: 'Aguardando você',
  refining: 'Em refinamento',
  done: 'Concluído',
  empty: 'Sem specs',
};

const KIND_LABEL: Record<string, string> = { api: 'API', jobs: 'Workers', web: 'Web', mobile: 'Mobile', workflow: 'Workflow', monolith: 'Monólito' };

/** A repository's dashboard, built from the real read model: a value the data does not have reads "sem dados". */
export function RepositoryPage() {
  const { projectId = '', repoId = '' } = useParams<{ projectId: string; repoId: string }>();
  const [detail, setDetail] = useState<RepoDetailView | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    runApi.repository(projectId, repoId).then(
      (d) => alive && setDetail(d),
      () => alive && setDetail(null),
    );
    return () => {
      alive = false;
    };
  }, [projectId, repoId]);

  if (detail === undefined) return <p className="hint" role="status">Carregando o repositório…</p>;
  if (detail === null) {
    return (
      <section className={panel} data-testid="repo-missing">
        <h1 className="m-0 text-[1.25rem] font-semibold">Repositório não encontrado</h1>
        <p className="hint">A arquitetura do projeto não nomeia {repoId}.</p>
        <Link to={`/projects/${encodeURIComponent(projectId)}`}>Voltar ao projeto</Link>
      </section>
    );
  }

  const done = detail.rows.filter((r) => r.status === 'done').reduce((sum, r) => sum + r.tasks, 0);
  return (
    <div className="grid min-w-0 gap-4" data-testid="repo-page">
      <nav aria-label="Migalhas" className="hint">
        <Link to="/">Projetos</Link> › <Link to={`/projects/${encodeURIComponent(projectId)}`}>{projectId}</Link> › <span>{detail.name}</span>
      </nav>
      <section className={panel}>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="m-0 text-[1.25rem] font-semibold wrap-anywhere">{detail.name}</h1>
          <span className="count-pill">{KIND_LABEL[detail.kind ?? ''] ?? detail.kind ?? 'sem tipo'}</span>
          <span className="count-pill" data-testid="repo-status">{STATUS_LABEL[detail.status]}</span>
        </div>
        <p className="hint">{detail.responsibility}</p>
      </section>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="repo-stats">
        <Stat label="Specs" value={String(detail.specs)} />
        <Stat label="Planos" value={String(detail.plans)} />
        <Stat label="Tarefas" value={String(detail.tasks)} />
        <Stat label="Concluídas" value={`${done} de ${detail.tasks}`} />
        <Stat label="Bloqueios" value={String(detail.blockers)} />
      </div>
      <section className={panel}>
        <div className={sectionTitle}><h2 className={sectionHeading}>Integrações</h2></div>
        {detail.integrations.length > 0 ? (
          <ul className="m-0 grid list-none gap-1 p-0 text-[0.875rem]">
            {detail.integrations.map((link) => <li key={link}>{link}</li>)}
          </ul>
        ) : (
          <p className="hint">Nenhuma integração.</p>
        )}
      </section>
      <section className={panel} data-testid="repo-specs">
        <div className={sectionTitle}><h2 className={sectionHeading}>Especificações</h2></div>
        {detail.rows.length === 0 ? (
          <p className="hint">Nenhuma spec neste repositório.</p>
        ) : (
          <div className="-mx-1 overflow-x-auto">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="text-left text-ink-soft">
                <th scope="col">Spec</th>
                <th scope="col">Prioridade</th>
                <th scope="col">Estado</th>
                <th scope="col">Plano</th>
                <th scope="col">Tarefas</th>
                <th scope="col">Depende de</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((row) => (
                <tr key={row.specId} data-testid={`repo-spec-${row.specId}`}>
                  <td>{row.title ?? row.specId}</td>
                  <td>{row.priority ?? 'sem dados'}</td>
                  <td>{row.blocked ? 'Bloqueada' : row.status}</td>
                  <td>{row.plan ? 'Sim' : 'Não'}</td>
                  <td>{`${row.status === 'done' ? row.tasks : 0} de ${row.tasks}`}</td>
                  <td>{row.dependsOn.length > 0 ? row.dependsOn.join(', ') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
      {detail.rows.some((r) => r.blocked) && (
        <section className={panel} data-testid="repo-blocked">
          <div className={sectionTitle}><h2 className={sectionHeading}>Falhas de execução</h2></div>
          <ul className="m-0 grid list-none gap-1 p-0 text-[0.875rem]">
            {detail.rows.filter((r) => r.blocked).map((r) => <li key={r.specId}>{r.title ?? r.specId}</li>)}
          </ul>
        </section>
      )}
      <details className={panel} data-testid="repo-history">
        <summary className="cursor-pointer font-semibold">Histórico (últimos {detail.history.length} eventos)</summary>
        {detail.history.length === 0 ? (
          <p className="hint">sem dados</p>
        ) : (
          <ol className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]">
            {detail.history.map((e, i) => (
              <li key={i}><Icon name="clock" size={12} /> {e.at} · {e.specId} · {e.type}</li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card grid gap-1 p-3">
      <span className="hint">{label}</span>
      <strong className="text-[1.125rem]">{value}</strong>
    </div>
  );
}
