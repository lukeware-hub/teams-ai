import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, runApi, type RepoDashboard, type RepoDetailView } from '../api.js';
import { usePolling } from '../usePolling.js';
import { action, panel, sectionHeading, sectionTitle } from './project-shared.js';
import { AgentActivity } from './repository/AgentActivity.js';
import { DeliveryBoard } from './repository/DeliveryBoard.js';
import { FailuresBlockers } from './repository/FailuresBlockers.js';
import { IndicatorCards } from './repository/IndicatorCards.js';
import { RepoHeader } from './repository/RepoHeader.js';
import { RunsTable } from './repository/RunsTable.js';
import { Timeline } from './repository/Timeline.js';

const POLL_MS = 5000;

/** A repository's dashboard: its state and shortcuts, its indicators, its specs, what each agent did, its runs and its timeline. */
export function RepositoryPage() {
  const { projectId = '', repoId = '' } = useParams<{ projectId: string; repoId: string }>();
  const [detail, setDetail] = useState<RepoDetailView | null | undefined>(undefined);
  // Why there is no detail: the server does not know the repository, or the request failed.
  const [failure, setFailure] = useState<'missing' | 'failed' | null>(null);
  const [dashboard, setDashboard] = useState<RepoDashboard | null | undefined>(undefined);

  const loadDetail = useCallback(() => {
    setDetail(undefined);
    setFailure(null);
    return runApi.repository(projectId, repoId).then(
      (d) => setDetail(d),
      (err: unknown) => {
        setDetail(null);
        setFailure(err instanceof ApiError && err.status === 404 ? 'missing' : 'failed');
      },
    );
  }, [projectId, repoId]);
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // A failed refresh keeps the last dashboard on screen; only a first failure reads as no data.
  const loadDashboard = useCallback(
    () => runApi.repositoryDashboard(projectId, repoId).then(setDashboard, () => setDashboard((prev) => (prev === undefined ? null : prev))),
    [projectId, repoId],
  );
  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);
  usePolling(loadDashboard, POLL_MS);

  if (detail === undefined) return <p data-testid="repository-loading" className="hint" role="status">Carregando o repositório…</p>;
  if (detail === null && failure === 'failed') {
    return (
      <section className={panel} data-testid="repo-error">
        <h1 data-testid="repository-error-title" className="m-0 text-[1.25rem] font-semibold">Não foi possível carregar o repositório.</h1>
        <p data-testid="repository-error-hint" className="hint">Verifique a conexão com o servidor e tente de novo.</p>
        <button data-testid="repository-error-retry" type="button" className={action.secondary} onClick={() => void loadDetail()}>
          Tentar de novo
        </button>
      </section>
    );
  }
  if (detail === null) {
    return (
      <section className={panel} data-testid="repo-missing">
        <h1 data-testid="repository-missing-title" className="m-0 text-[1.25rem] font-semibold">Repositório não encontrado</h1>
        <p data-testid="repository-missing-hint" className="hint">A arquitetura do projeto não nomeia {repoId}.</p>
        <Link to={`/projects/${encodeURIComponent(projectId)}`}>Voltar ao projeto</Link>
      </section>
    );
  }

  return (
    <div className="grid min-w-0 gap-4" data-testid="repo-page">
      <nav data-testid="repository-breadcrumb" aria-label="Migalhas" className="hint">
        <Link to="/">Projetos</Link> › <Link to={`/projects/${encodeURIComponent(projectId)}`}>{projectId}</Link> › <span data-testid="repository-breadcrumb-current">{detail.name}</span>
      </nav>
      <RepoHeader detail={detail} projectId={projectId} deploy={dashboard?.lastDeploy ?? null} />
      {dashboard === undefined && <p data-testid="repository-indicators-loading" className="hint" role="status">Carregando os indicadores…</p>}
      {dashboard === null && <p data-testid="repository-indicators-empty" className="hint">sem dados: os indicadores deste repositório não puderam ser lidos.</p>}
      {dashboard && (
        <>
          <IndicatorCards dashboard={dashboard} />
          <DeliveryBoard specs={dashboard.specs} tasks={dashboard.tasks.list} />
          <AgentActivity agents={dashboard.agents} />
          <RunsTable runs={dashboard.runs} />
          <FailuresBlockers failures={dashboard.failures} blockers={dashboard.blockers} />
        </>
      )}
      <section data-testid="repository-integrations" className={panel}>
        <div data-testid="repository-integrations-title" className={sectionTitle}>
          <h2 data-testid="repository-integrations-heading" className={sectionHeading}>Integrações</h2>
        </div>
        {detail.integrations.length > 0 ? (
          <ul data-testid="repository-integrations-list" className="m-0 grid list-none gap-1 p-0 text-[0.875rem]">
            {detail.integrations.map((link) => (
              <li data-testid="repository-integration-item" key={link}>{link}</li>
            ))}
          </ul>
        ) : (
          <p data-testid="repository-integrations-empty" className="hint">Nenhuma integração.</p>
        )}
      </section>
      <details className={panel} data-testid="repo-specs">
        <summary data-testid="repository-specs-summary" className={`${sectionTitle} cursor-pointer`}>
          <h2 data-testid="repository-specs-heading" className={sectionHeading}>Especificações</h2>
        </summary>
        {detail.rows.length === 0 ? (
          <p data-testid="repository-specs-empty" className="hint">Nenhuma spec neste repositório.</p>
        ) : (
          <div data-testid="repository-specs-scroll" className="-mx-1 overflow-x-auto">
            <table data-testid="repository-specs-table" className="w-full text-[0.8125rem]">
              <thead data-testid="repository-specs-head">
                <tr data-testid="repository-specs-head-row" className="text-left text-ink-soft">
                  <th data-testid="repository-specs-th-spec" scope="col">Spec</th>
                  <th data-testid="repository-specs-th-priority" scope="col">Prioridade</th>
                  <th data-testid="repository-specs-th-state" scope="col">Estado</th>
                  <th data-testid="repository-specs-th-plan" scope="col">Plano</th>
                  <th data-testid="repository-specs-th-tasks" scope="col">Tarefas</th>
                  <th data-testid="repository-specs-th-depends" scope="col">Depende de</th>
                </tr>
              </thead>
              <tbody data-testid="repository-specs-body">
                {detail.rows.map((row) => (
                  <tr key={row.specId} data-testid={`repo-spec-${row.specId}`}>
                    <td data-testid={`repository-spec-title-${row.specId}`}>{row.title ?? row.specId}</td>
                    <td data-testid={`repository-spec-priority-${row.specId}`}>{row.priority ?? 'sem dados'}</td>
                    <td data-testid={`repository-spec-state-${row.specId}`}>{row.blocked ? 'Bloqueada' : row.status}</td>
                    <td data-testid={`repository-spec-plan-${row.specId}`}>{row.plan ? 'Sim' : 'Não'}</td>
                    <td data-testid={`repository-spec-tasks-${row.specId}`}>{`${row.status === 'done' ? row.tasks : 0} de ${row.tasks}`}</td>
                    <td data-testid={`repository-spec-depends-${row.specId}`}>{row.dependsOn.length > 0 ? row.dependsOn.join(', ') : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
      {dashboard && <Timeline timeline={dashboard.timeline} />}
    </div>
  );
}
