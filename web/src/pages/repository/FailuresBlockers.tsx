import { Link } from 'react-router-dom';
import { runPath } from '../../routes.js';
import { runApi, type DashboardItem, type DashboardTable } from '../../api.js';
import { Pagination, TableFilters, usePagedTable } from '../../components/DataTable.js';
import { panel, sectionHeading, sectionTitle } from '../project-shared.js';

const KIND_LABEL: Record<DashboardItem['kind'], string> = { task: 'Tarefa', run: 'Run', question: 'Pergunta', secret: 'Segredo', stop: 'Parada' };

/** Failures and blockers of the repository as two cards, each searched, filtered and paged on the server; a card with no item is hidden. */
export function FailuresBlockers({ projectId, repo, failures, blockers }: { projectId: string; repo: string; failures: number; blockers: number }) {
  return (
    <>
      {failures > 0 && <ItemsCard title="Falhas" table="failures" projectId={projectId} repo={repo} testId="repo-failures" />}
      {blockers > 0 && <ItemsCard title="Bloqueios" table="blockers" projectId={projectId} repo={repo} testId="repo-blockers" />}
    </>
  );
}

function ItemsCard({ title, table, projectId, repo, testId }: { title: string; table: DashboardTable; projectId: string; repo: string; testId: string }) {
  const view = usePagedTable(`${projectId}/${repo}/${table}`, (req) => runApi.repositoryDashboardTable<DashboardItem>(projectId, repo, table, req), (kind) => KIND_LABEL[kind as DashboardItem['kind']] ?? kind);
  return (
    <section className={panel} data-testid={testId}>
      <div data-testid={`${testId}-heading-row`} className={sectionTitle}>
        <h2 data-testid={`${testId}-heading`} className={sectionHeading}>{`${title} (${view.total})`}</h2>
      </div>
      <TableFilters view={view} subject={title.toLowerCase()} placeholder="Buscar por tarefa, run ou motivo" facetName="Tipo" />
      {!view.loaded ? (
        <p data-testid={`${testId}-loading`} className="hint" role="status">Carregando…</p>
      ) : view.matched === 0 ? (
        <p data-testid={`${testId}-empty`} className="hint">Nenhum item encontrado.</p>
      ) : (
        <ul data-testid={`${testId}-list`} className="m-0 mt-3 grid list-none p-0 text-[0.8125rem]">
          {view.rows.map((item, i) => (
            <li data-testid={`${testId}-item-${item.kind}-${item.runId ?? ''}-${item.taskId ?? ''}`} key={`${item.kind}-${item.runId ?? ''}-${item.taskId ?? ''}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-t border-line py-2 first:border-t-0">
              <span data-testid={`${testId}-item-text-${item.kind}-${item.runId ?? ''}-${item.taskId ?? ''}`} className="wrap-anywhere">{item.text}</span>
              {item.runId && <Link to={`${runPath(item.runId)}${item.taskId ? `?task=${encodeURIComponent(item.taskId)}` : ''}`} className="whitespace-nowrap">Abrir run</Link>}
            </li>
          ))}
        </ul>
      )}
      <Pagination view={view} />
    </section>
  );
}
