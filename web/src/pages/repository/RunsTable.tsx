import { Link } from 'react-router-dom';
import { InfoTip } from '../../components/InfoTip.js';
import { runPath } from '../../routes.js';
import { runApi, type DashboardRunRow } from '../../api.js';
import { Pagination, usePagedTable } from '../../components/DataTable.js';
import { cardCell, cardRow, cardTable, cardTitleCell, chip, money, panel, responsiveHead, sectionHeading, sectionTitle, when } from '../project-shared.js';
import { RUN_KIND_LABEL } from './labels.js';

/** The runs of the repository's specs, newest first, one page at a time; each row links to its run page. */
export function RunsTable({ projectId, repo }: { projectId: string; repo: string }) {
  const view = usePagedTable(`${projectId}/${repo}/runs`, (req) => runApi.repositoryDashboardTable<DashboardRunRow>(projectId, repo, 'runs', req));
  return (
    <section className={panel} data-testid="repo-runs">
      <div data-testid="runs-table-title" className={sectionTitle}>
        <h2 data-testid="runs-table-heading" className={sectionHeading}>Runs</h2>
        <InfoTip label="Runs" text="As rodadas dos agentes que mexeram neste repositório, com as tarefas mescladas em cada uma." />
      </div>
      {!view.loaded ? (
        <p data-testid="runs-table-loading" className="hint" role="status">Carregando as runs…</p>
      ) : view.total === 0 ? (
        <p data-testid="runs-table-empty" className="hint">sem dados: nenhuma run neste repositório.</p>
      ) : (
        <div data-testid="runs-table-scroll" className={`@container ${cardTable} overflow-x-auto`}>
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
                <tr key={r.runId} className={cardRow} data-testid={`run-${r.runId}`}>
                  <td data-testid={`runs-table-run-cell-${r.runId}`} className={cardTitleCell} data-label="Run">
                    <Link to={runPath(r.runId)} className="wrap-anywhere">{r.runId}</Link>
                  </td>
                  <td data-testid={`runs-table-kind-${r.runId}`} className={cardCell('1')} data-label="Tipo">{RUN_KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td data-testid={`runs-table-state-${r.runId}`} className={cardCell('1')} data-label="Estado">{chip(r.status)}</td>
                  <td data-testid={`runs-table-start-${r.runId}`} className={cardCell('2')} data-label="Início">{when(r.at)}</td>
                  <td data-testid={`runs-table-merged-${r.runId}`} className={cardCell('1')} data-label="Tarefas mescladas">{r.merged}</td>
                  <td data-testid={`runs-table-cost-${r.runId}`} className={cardCell('1')} data-label="Custo">{money(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination view={view} />
        </div>
      )}
    </section>
  );
}
