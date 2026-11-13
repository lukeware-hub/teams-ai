import { Link } from 'react-router-dom';
import { InfoTip } from '../../components/InfoTip.js';
import { runPath, validationPath } from '../../routes.js';
import type { DashboardSpec, DashboardTask, SpecState } from '../../api.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { panel, sectionHeading, sectionTitle } from '../project-shared.js';
import { SPEC_ORDER, SPEC_STATE, TASK_STATE } from './labels.js';
import { StatePill } from './StatePill.js';

/** Chips and links of a spec or task: wrap under the title on phones, sit on the right of it on wide screens. */
const META = 'flex flex-wrap items-center gap-2 md:justify-end';

/** The specs of the repository grouped by state, each spec opening its tasks with their state, attempts and run link. */
export function DeliveryBoard({ specs, tasks }: { specs: DashboardSpec[]; tasks: DashboardTask[] }) {
  const tasksBySpec = new Map<string, DashboardTask[]>();
  for (const t of tasks) tasksBySpec.set(t.specId, [...(tasksBySpec.get(t.specId) ?? []), t]);
  return (
    <section className={panel} data-testid="repo-board">
      <div data-testid="delivery-board-title" className={sectionTitle}>
        <h2 data-testid="delivery-board-heading" className={sectionHeading}>Entregas por spec</h2>
        <InfoTip label="Entregas por spec" text="Cada spec do repositório com as suas tarefas. Abra a run de uma tarefa para ver os detalhes; a spec que espera a sua validação tem o botão Validar." />
      </div>
      {specs.length === 0 ? (
        <p data-testid="delivery-board-empty" className="hint">sem dados: nenhuma spec neste repositório.</p>
      ) : (
        SPEC_ORDER.map((state) => <Group key={state} state={state} specs={specs.filter((s) => s.state === state)} tasksBySpec={tasksBySpec} />)
      )}
    </section>
  );
}

function Group({ state, specs, tasksBySpec }: { state: SpecState; specs: DashboardSpec[]; tasksBySpec: Map<string, DashboardTask[]> }) {
  if (specs.length === 0) return null;
  return (
    <div className="grid gap-1" data-testid={`board-${state}`}>
      <h3 data-testid={`delivery-board-group-heading-${state}`} className="m-0 flex items-center gap-2 text-[0.8125rem] font-semibold normal-case text-ink-soft">
        {SPEC_STATE[state].label} <span data-testid={`delivery-board-group-count-${state}`} className="count-pill">{specs.length}</span>
      </h3>
      {specs.map((spec) => (
        <details key={spec.specId} className="rounded-lg border border-line px-3 py-2" data-testid={`spec-${spec.specId}`}>
          <summary data-testid={`delivery-spec-summary-${spec.specId}`} className="flex cursor-pointer flex-col gap-1.5 text-[0.875rem] md:flex-row md:items-center md:gap-3">
            <span data-testid={`delivery-spec-title-${spec.specId}`} className="font-medium wrap-anywhere md:flex-1">{spec.title ?? spec.specId}</span>
            <span className={META}>
            {spec.priority && <span data-testid={`delivery-spec-priority-${spec.specId}`} className="count-pill">{spec.priority}</span>}
            <StatePill label={SPEC_STATE[spec.state].label} tone={SPEC_STATE[spec.state].tone} />
            <span data-testid={`delivery-spec-progress-${spec.specId}`} className="hint whitespace-nowrap tabular-nums">{`${spec.delivered} de ${spec.total} tarefas`}</span>
            {spec.validationRunId && (
              // The summary toggles the spec; the link only opens the validation page.
              <Link data-testid={`delivery-validate-${spec.specId}`} className="link-button ml-auto" to={validationPath(spec.validationRunId)} onClick={(e) => e.stopPropagation()}>
                Validar entrega
              </Link>
            )}
            </span>
          </summary>
          <TaskList specId={spec.specId} tasks={tasksBySpec.get(spec.specId) ?? []} />
        </details>
      ))}
    </div>
  );
}

function TaskList({ specId, tasks }: { specId: string; tasks: DashboardTask[] }) {
  if (tasks.length === 0) return <p data-testid={`delivery-tasks-empty-${specId}`} className="hint mt-2">Nenhuma tarefa planejada ainda.</p>;
  return (
    <ul className="m-0 mt-2 grid list-none gap-2 p-0 text-[0.8125rem]" data-testid={`tasks-${specId}`}>
      {tasks.map((t) => (
        <li data-testid={`delivery-task-${t.taskId}-${t.runId ?? ''}`} key={`${t.taskId}-${t.runId ?? ''}`} className="grid gap-1.5 border-t border-line pt-2">
          <div data-testid={`delivery-task-header-${t.taskId}`} className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
            <span data-testid={`delivery-task-title-${t.taskId}`} className="font-medium wrap-anywhere md:flex-1">{t.title}</span>
            <span className={META}>
            <span data-testid={`delivery-task-owner-${t.taskId}`} className="hint">{ROLE_LABEL[t.owner] ?? t.owner}</span>
            <StatePill label={TASK_STATE[t.state].label} tone={TASK_STATE[t.state].tone} />
            {t.attempts > 0 && <span data-testid={`delivery-task-attempts-${t.taskId}`} className="hint">{`${t.attempts} tentativa${t.attempts === 1 ? '' : 's'}`}</span>}
            {t.pr !== null && <span data-testid={`delivery-task-pr-${t.taskId}`} className="hint">{`PR #${t.pr}`}</span>}
            {t.runId && (
              <Link className="ml-auto" to={`${runPath(t.runId)}?task=${encodeURIComponent(t.taskId)}`}>Abrir run</Link>
            )}
            </span>
          </div>
          {t.reason && <p data-testid={`delivery-task-reason-${t.taskId}`} className="m-0 text-ink-soft">{t.reason}</p>}
        </li>
      ))}
    </ul>
  );
}
