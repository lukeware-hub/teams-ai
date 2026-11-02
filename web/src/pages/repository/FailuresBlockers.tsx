import { Link } from 'react-router-dom';
import type { Capped, DashboardItem } from '../../api.js';
import { panel, sectionHeading, sectionTitle } from '../project-shared.js';

/** Failures and blockers of the repository, each with the run or task it is about. Hidden while both are empty. */
export function FailuresBlockers({ failures, blockers }: { failures: Capped<DashboardItem>; blockers: Capped<DashboardItem> }) {
  if (failures.total === 0 && blockers.total === 0) return null;
  return (
    <section className={panel} data-testid="repo-attention">
      <div className="grid gap-4 md:grid-cols-2">
        <Column title="Falhas" data={failures} testId="repo-failures" />
        <Column title="Bloqueios" data={blockers} testId="repo-blockers" />
      </div>
    </section>
  );
}

function Column({ title, data, testId }: { title: string; data: Capped<DashboardItem>; testId: string }) {
  return (
    <div className="grid content-start gap-2" data-testid={testId}>
      <div className={sectionTitle}>
        <h2 className={sectionHeading}>{`${title} (${data.total})`}</h2>
      </div>
      {data.total === 0 ? (
        <p className="hint">Nenhum item.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0 text-[0.8125rem]">
          {data.list.map((item, i) => (
            <li key={`${item.kind}-${item.runId ?? ''}-${item.taskId ?? ''}-${i}`} className="grid gap-0.5">
              <span className="wrap-anywhere">{item.text}</span>
              {item.runId && <Link to={`/runs/${encodeURIComponent(item.runId)}${item.taskId ? `?task=${encodeURIComponent(item.taskId)}` : ''}`}>Abrir run</Link>}
            </li>
          ))}
        </ul>
      )}
      {data.total > data.list.length && <p className="hint">{`Mostrando ${data.list.length} de ${data.total}.`}</p>}
    </div>
  );
}
