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
      <div className={sectionTitle}>
        <h2 className={sectionHeading}>Runs</h2>
      </div>
      {runs.total === 0 ? (
        <p className="hint">sem dados: nenhuma run neste repositório.</p>
      ) : (
        <div className={`@container ${responsiveTable} -mx-1 overflow-x-auto`}>
          <table className="w-full text-[0.8125rem]">
            <thead className={responsiveHead}>
              <tr className="text-left text-ink-soft">
                <th scope="col">Run</th>
                <th scope="col">Tipo</th>
                <th scope="col">Estado</th>
                <th scope="col">Início</th>
                <th scope="col">Tarefas mescladas</th>
                <th scope="col">Custo</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.runId} className={responsiveRow} data-testid={`run-${r.runId}`}>
                  <td className={responsiveCell} data-label="Run">
                    <Link to={`/runs/${encodeURIComponent(r.runId)}`} className="wrap-anywhere">{r.runId}</Link>
                  </td>
                  <td className={responsiveCell} data-label="Tipo">{RUN_KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className={responsiveCell} data-label="Estado">{chip(r.status)}</td>
                  <td className={responsiveCell} data-label="Início">{when(r.at)}</td>
                  <td className={responsiveCell} data-label="Tarefas mescladas">{r.merged}</td>
                  <td className={responsiveCell} data-label="Custo">{money(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination view={view} />
          {runs.total > runs.list.length && <p className="hint">{`Mostrando as ${runs.list.length} runs mais recentes de ${runs.total}.`}</p>}
        </div>
      )}
    </section>
  );
}
