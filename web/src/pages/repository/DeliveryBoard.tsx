import { Link } from 'react-router-dom';
import type { DashboardSpec, DashboardTask, SpecState } from '../../api.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { panel, sectionHeading, sectionTitle } from '../project-shared.js';
import { SPEC_ORDER, SPEC_STATE, TASK_STATE } from './labels.js';
import { StatePill } from './StatePill.js';

/** The specs of the repository grouped by state, each spec opening its tasks with their state, attempts and run link. */
export function DeliveryBoard({ specs, tasks }: { specs: DashboardSpec[]; tasks: DashboardTask[] }) {
  return (
    <section className={panel} data-testid="repo-board">
      <div className={sectionTitle}>
        <h2 className={sectionHeading}>Entregas por spec</h2>
      </div>
      {specs.length === 0 ? (
        <p className="hint">sem dados: nenhuma spec neste repositório.</p>
      ) : (
        SPEC_ORDER.map((state) => <Group key={state} state={state} specs={specs.filter((s) => s.state === state)} tasks={tasks} />)
      )}
    </section>
  );
}

function Group({ state, specs, tasks }: { state: SpecState; specs: DashboardSpec[]; tasks: DashboardTask[] }) {
  if (specs.length === 0) return null;
  return (
    <div className="grid gap-1" data-testid={`board-${state}`}>
      <h3 className="m-0 text-[0.8125rem] font-semibold normal-case text-ink-soft">
        {SPEC_STATE[state].label} <span className="count-pill">{specs.length}</span>
      </h3>
      {specs.map((spec) => (
        <details key={spec.specId} className="rounded-lg border border-line px-3 py-2" data-testid={`spec-${spec.specId}`}>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[0.875rem]">
            <span className="font-medium wrap-anywhere">{spec.title ?? spec.specId}</span>
            {spec.priority && <span className="count-pill">{spec.priority}</span>}
            <StatePill label={SPEC_STATE[spec.state].label} tone={SPEC_STATE[spec.state].tone} />
            <span className="hint">{`${spec.delivered} de ${spec.total} tarefas`}</span>
          </summary>
          <TaskList specId={spec.specId} tasks={tasks.filter((t) => t.specId === spec.specId)} />
        </details>
      ))}
    </div>
  );
}

function TaskList({ specId, tasks }: { specId: string; tasks: DashboardTask[] }) {
  if (tasks.length === 0) return <p className="hint mt-2">Nenhuma tarefa planejada ainda.</p>;
  return (
    <ul className="m-0 mt-2 grid list-none gap-2 p-0 text-[0.8125rem]" data-testid={`tasks-${specId}`}>
      {tasks.map((t) => (
        <li key={`${t.taskId}-${t.runId ?? ''}`} className="grid gap-1 border-t border-line pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium wrap-anywhere">{t.title}</span>
            <span className="hint">{ROLE_LABEL[t.owner] ?? t.owner}</span>
            <StatePill label={TASK_STATE[t.state].label} tone={TASK_STATE[t.state].tone} />
            {t.attempts > 0 && <span className="hint">{`${t.attempts} tentativa${t.attempts === 1 ? '' : 's'}`}</span>}
            {t.pr !== null && <span className="hint">{`PR #${t.pr}`}</span>}
            {t.runId && (
              <Link to={`/runs/${encodeURIComponent(t.runId)}?task=${encodeURIComponent(t.taskId)}`}>Abrir run</Link>
            )}
          </div>
          {t.reason && <p className="m-0 text-ink-soft">{t.reason}</p>}
        </li>
      ))}
    </ul>
  );
}
