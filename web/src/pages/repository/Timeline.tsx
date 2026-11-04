import { Link } from 'react-router-dom';
import { runPath } from '../../routes.js';
import { runApi, type TimelineEntry } from '../../api.js';
import { Pagination, usePagedTable } from '../../components/DataTable.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { panel, sectionHeading, sectionTitle, when } from '../project-shared.js';

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
          <ol data-testid="timeline-list" className="m-0 grid list-none gap-2 p-0 text-[0.8125rem]">
            {view.rows.map((e, i) => (
              <li data-testid={`timeline-event-${e.runId}-${(view.page - 1) * view.size + i}`} key={`${e.runId}-${e.at}-${(view.page - 1) * view.size + i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span data-testid={`timeline-event-time-${e.runId}-${(view.page - 1) * view.size + i}`} className="hint tabular-nums">{when(e.at)}</span>
                {e.role && <span data-testid={`timeline-event-role-${e.runId}-${(view.page - 1) * view.size + i}`} className="count-pill">{ROLE_LABEL[e.role] ?? e.role}</span>}
                <span data-testid={`timeline-event-text-${e.runId}-${(view.page - 1) * view.size + i}`} className={e.tone === 'bad' ? 'tone-bad rounded px-1' : e.tone === 'good' ? 'tone-good rounded px-1' : ''}>{e.text}</span>
                <Link to={runPath(e.runId)}>{e.runId}</Link>
              </li>
            ))}
          </ol>
          <Pagination view={view} />
        </>
      )}
    </details>
  );
}
