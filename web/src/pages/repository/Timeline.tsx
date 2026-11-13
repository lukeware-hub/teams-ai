import { Link } from 'react-router-dom';
import { runPath } from '../../routes.js';
import { runApi, type TimelineEntry } from '../../api.js';
import { Pagination, usePagedTable } from '../../components/DataTable.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { headRow, table } from '../costs/CostParts.js';
import { cardCell, cardRow, cardTable, panel, responsiveHead, sectionHeading, sectionTitle, when } from '../project-shared.js';

/** The events of every run of the repository, newest first, one page at a time; each with its agent and a link to its run. Open by default. */
export function Timeline({ projectId, repo }: { projectId: string; repo: string }) {
  const view = usePagedTable(`${projectId}/${repo}/timeline`, (req) => runApi.repositoryDashboardTable<TimelineEntry>(projectId, repo, 'timeline', req));
  return (
    <details className={panel} open data-testid="repo-timeline">
      <summary data-testid="timeline-summary" className={`${sectionTitle} cursor-pointer`}>
        <h2 data-testid="timeline-heading" className={sectionHeading}>{`Linha do tempo (${view.total})`}</h2>
      </summary>
      {!view.loaded ? (
        <p data-testid="timeline-loading" className="hint" role="status">Carregando a linha do tempo…</p>
      ) : view.total === 0 ? (
        <p data-testid="timeline-empty" className="hint">sem dados: nenhum evento registrado.</p>
      ) : (
        <>
          <div className={`@container ${cardTable} overflow-x-auto`}>
            <table data-testid="timeline-list" className={table}>
              <thead className={responsiveHead}>
                <tr className={headRow}>
                  <th scope="col" className="whitespace-nowrap">Data e hora</th>
                  <th scope="col">Agente</th>
                  <th scope="col">Evento</th>
                  <th scope="col">Run</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((e, i) => {
                  const key = `${e.runId}-${(view.page - 1) * view.size + i}`;
                  return (
                    <tr data-testid={`timeline-event-${key}`} key={`${key}-${e.at}`} className={cardRow}>
                      <td data-testid={`timeline-event-time-${key}`} data-label="Data e hora" className={`${cardCell('1')} whitespace-nowrap text-ink-soft`}>{when(e.at)}</td>
                      <td data-label="Agente" className={cardCell('1')}>
                        {e.role ? <span data-testid={`timeline-event-role-${key}`} className="count-pill">{ROLE_LABEL[e.role] ?? e.role}</span> : '—'}
                      </td>
                      <td data-label="Evento" className={`${cardCell('2')} @max-[44rem]:before:hidden`}>
                        <span data-testid={`timeline-event-text-${key}`} className={e.tone === 'bad' ? 'tone-bad rounded px-1' : e.tone === 'good' ? 'tone-good rounded px-1' : ''}>{e.text}</span>
                      </td>
                      <td data-label="Run" className={cardCell('2')}>
                        <Link to={runPath(e.runId)}>{e.runId}</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination view={view} />
        </>
      )}
    </details>
  );
}
