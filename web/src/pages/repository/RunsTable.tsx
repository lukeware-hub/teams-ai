import { Link } from 'react-router-dom';
import type { Capped, DashboardRunRow } from '../../api.js';
import { Pagination, usePagination } from '../../components/DataTable.js';
import { chip, money, panel, responsiveCell, responsiveHead, responsiveRow, responsiveTable, sectionHeading, sectionTitle, when } from '../project-shared.js';
import { RUN_KIND_LABEL } from './labels.js';

/** The runs of the repository's specs, newest first, paged; each row links to its run page. */
export function RunsTable({ runs }: { runs: Capped<DashboardRunRow> }) {
  const view = usePagination(runs.list, 'runs');
  return (
    <section className={panel} data-testid="repo-runs">
      <div data-testid="runs-table-title" className={sectionTitle}>
        <h2 data-testid="runs-table-heading" className={sectionHeading}>Runs</h2>
      </div>
      {runs.total === 0 ? (
        <p data-testid="runs-table-empty" className="hint">sem dados: nenhuma run neste repositório.</p>
      ) : (
        <div data-testid="runs-table-scroll" className={`@container ${responsiveTable} -mx-1 overflow-x-auto`}>
          <table data-testid="runs-table" className="w-full text-[0.8125rem]">
            <thead data-testid="runs-table-head" className={responsiveHead}>
              <tr data-testid="runs-table-head-row" className="text-left text-ink-soft">
                <th data-testid="runs-table-th-run" scope="col">Run</th>
                <th data-testid="runs-table-th-kind" scope="col">Tipo</th>
                <th data-testid="runs-table-th-state" scope="col">Estado</th>
                <th data-testid="runs-table-th-start" scope="col">Início</th>
                <th data-testid="runs-table-th-merged" scope="col">Tarefas mescladas</th>
                <th data-testid="runs-table-th-cost" scope="col">Custo</th>
              </tr>
            </thead>
            <tbody data-testid="runs-table-body">
              {view.rows.map((r) => (
                <tr key={r.runId} className={responsiveRow} data-testid={`run-${r.runId}`}>
                  <td data-testid={`runs-table-run-cell-${r.runId}`} className={responsiveCell} data-label="Run">
                    <Link to={`/runs/${encodeURIComponent(r.runId)}`} className="wrap-anywhere">{r.runId}</Link>
                  </td>
                  <td data-testid={`runs-table-kind-${r.runId}`} className={responsiveCell} data-label="Tipo">{RUN_KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td data-testid={`runs-table-state-${r.runId}`} className={responsiveCell} data-label="Estado">{chip(r.status)}</td>
                  <td data-testid={`runs-table-start-${r.runId}`} className={responsiveCell} data-label="Início">{when(r.at)}</td>
                  <td data-testid={`runs-table-merged-${r.runId}`} className={responsiveCell} data-label="Tarefas mescladas">{r.merged}</td>
                  <td data-testid={`runs-table-cost-${r.runId}`} className={responsiveCell} data-label="Custo">{money(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination view={view} />
          {runs.total > runs.list.length && <p data-testid="runs-table-truncated" className="hint">{`Mostrando as ${runs.list.length} runs mais recentes de ${runs.total}.`}</p>}
        </div>
      )}
    </section>
  );
}
