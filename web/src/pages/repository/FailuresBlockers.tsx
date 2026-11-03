import { Link } from 'react-router-dom';
import type { Capped, DashboardItem } from '../../api.js';
import { Pagination, TableFilters, usePagination, useTableView } from '../../components/DataTable.js';
import { panel, sectionHeading, sectionTitle } from '../project-shared.js';

const KIND_LABEL: Record<DashboardItem['kind'], string> = { task: 'Tarefa', run: 'Run', question: 'Pergunta', secret: 'Segredo', stop: 'Parada' };

/** Failures and blockers of the repository as two cards, each filtered and paged; a card with no item is hidden. */
export function FailuresBlockers({ failures, blockers }: { failures: Capped<DashboardItem>; blockers: Capped<DashboardItem> }) {
  return (
    <>
      {failures.total > 0 && <ItemsCard title="Falhas" data={failures} testId="repo-failures" />}
      {blockers.total > 0 && <ItemsCard title="Bloqueios" data={blockers} testId="repo-blockers" />}
    </>
  );
}

function ItemsCard({ title, data, testId }: { title: string; data: Capped<DashboardItem>; testId: string }) {
  const view = useTableView(data.list, {
    sorts: {},
    text: (item) => [item.text, item.taskId ?? '', item.runId ?? ''],
    facet: (item) => item.kind,
    facetLabel: (kind) => KIND_LABEL[kind as DashboardItem['kind']] ?? kind,
  });
  const paged = usePagination(view.rows, `${view.query}|${view.facet}`);
  return (
    <section className={panel} data-testid={testId}>
      <div data-testid={`${testId}-heading-row`} className={sectionTitle}>
        <h2 data-testid={`${testId}-heading`} className={sectionHeading}>{`${title} (${data.total})`}</h2>
      </div>
      <TableFilters view={view} subject={title.toLowerCase()} placeholder="Buscar por tarefa, run ou motivo" facetName="Tipo" />
      {paged.total === 0 ? (
        <p data-testid={`${testId}-empty`} className="hint">Nenhum item encontrado.</p>
      ) : (
        <ul data-testid={`${testId}-list`} className="m-0 mt-3 grid list-none p-0 text-[0.8125rem]">
          {paged.rows.map((item, i) => (
            <li data-testid={`${testId}-item-${item.kind}-${item.runId ?? ''}-${item.taskId ?? ''}`} key={`${item.kind}-${item.runId ?? ''}-${item.taskId ?? ''}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-t border-line py-2 first:border-t-0">
              <span data-testid={`${testId}-item-text-${item.kind}-${item.runId ?? ''}-${item.taskId ?? ''}`} className="wrap-anywhere">{item.text}</span>
              {item.runId && <Link to={`/runs/${encodeURIComponent(item.runId)}${item.taskId ? `?task=${encodeURIComponent(item.taskId)}` : ''}`} className="whitespace-nowrap">Abrir run</Link>}
            </li>
          ))}
        </ul>
      )}
      <Pagination view={paged} />
      {data.total > data.list.length && <p data-testid={`${testId}-truncated`} className="hint">{`Mostrando ${data.list.length} de ${data.total}.`}</p>}
    </section>
  );
}
