import { Link } from 'react-router-dom';
import type { Capped, TimelineEntry } from '../../api.js';
import { Pagination, usePagination } from '../../components/DataTable.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { panel, sectionHeading, sectionTitle, when } from '../project-shared.js';

/** The events of every run of the repository, newest first, paged; each with its agent and a link to its run. Open by default. */
export function Timeline({ timeline }: { timeline: Capped<TimelineEntry> }) {
  const view = usePagination(timeline.list, 'timeline');
  return (
    <details className={panel} open data-testid="repo-timeline">
      <summary className={`${sectionTitle} cursor-pointer`}>
        <h2 className={sectionHeading}>{`Linha do tempo (${timeline.total})`}</h2>
      </summary>
      {timeline.total === 0 ? (
        <p className="hint">sem dados: nenhum evento registrado.</p>
      ) : (
        <>
          <ol className="m-0 grid list-none gap-2 p-0 text-[0.8125rem]">
            {view.rows.map((e, i) => (
              <li key={`${e.runId}-${e.at}-${(view.page - 1) * view.size + i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="hint tabular-nums">{when(e.at)}</span>
                {e.role && <span className="count-pill">{ROLE_LABEL[e.role] ?? e.role}</span>}
                <span className={e.tone === 'bad' ? 'tone-bad rounded px-1' : e.tone === 'good' ? 'tone-good rounded px-1' : ''}>{e.text}</span>
                <Link to={`/runs/${encodeURIComponent(e.runId)}`}>{e.runId}</Link>
              </li>
            ))}
          </ol>
          <Pagination view={view} />
        </>
      )}
      {timeline.total > timeline.list.length && <p className="hint">{`Mostrando os ${timeline.list.length} eventos mais recentes de ${timeline.total}.`}</p>}
    </details>
  );
}
