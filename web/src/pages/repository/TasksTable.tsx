import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { runPath } from '../../routes.js';
import { runApi, type DashboardTaskRow, type TaskState } from '../../api.js';
import { BlockReason, Facts } from '../../components/BlockReason.js';
import { Dialog } from '../../components/Dialog.js';
import { TableFilters, usePagedTable } from '../../components/DataTable.js';
import { InfoTip } from '../../components/InfoTip.js';
import { blockExplanation } from '../../run/selectors.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { panel, sectionHeading, sectionTitle } from '../project-shared.js';
import { TASK_STATE } from './labels.js';
import { StatePill } from './StatePill.js';

// A task that did not finish successfully: only these rows open a detail.
const DID_NOT_FINISH: ReadonlySet<TaskState> = new Set(['blocked', 'failed']);
const DETAIL_BUTTON = 'secondary h-10 flex-none px-3 text-[0.8125rem]';

/** Every task of the repository, filtered by status and searched, read one page at a time: "Carregar mais" appends the next page. */
export function TasksTable({ projectId, repo }: { projectId: string; repo: string }) {
  const view = usePagedTable(
    `${projectId}/${repo}/tasks`,
    (req) => runApi.repositoryDashboardTable<DashboardTaskRow>(projectId, repo, 'tasks', req),
    (state) => TASK_STATE[state as TaskState]?.label ?? state,
  );
  const [pages, setPages] = useState<Record<number, DashboardTaskRow[]>>({});
  const [opened, setOpened] = useState<{ task: DashboardTaskRow; opener: HTMLElement } | null>(null);

  // Each loaded page is kept; a first page (a new filter or search) starts the list over.
  useEffect(() => {
    if (!view.loaded) return;
    setPages((prev) => (view.page === 1 ? { 1: view.rows } : { ...prev, [view.page]: view.rows }));
  }, [view.rows, view.page, view.loaded]);

  const rows = Object.keys(pages)
    .map(Number)
    .sort((a, b) => a - b)
    .flatMap((p) => pages[p] ?? []);
  const shown = rows.length;

  return (
    <section className={panel} data-testid="repo-tasks">
      <div data-testid="repo-tasks-title" className={sectionTitle}>
        <h2 data-testid="repo-tasks-heading" className={sectionHeading}>{`Tarefas (${view.total})`}</h2>
        <InfoTip label="Tarefas" text="Todas as tarefas do repositório com o seu estado. Abra o detalhe de uma tarefa que não foi entregue para ver o motivo." />
      </div>
      <TableFilters view={view} subject="tarefas" placeholder="Buscar por tarefa, título ou spec" facetName="Status" />
      {!view.loaded ? (
        <p data-testid="repo-tasks-loading" className="hint" role="status">Carregando…</p>
      ) : view.matched === 0 ? (
        <p data-testid="repo-tasks-empty" className="hint">Nenhuma tarefa encontrada.</p>
      ) : (
        <ul data-testid="repo-tasks-list" className="m-0 mt-3 grid list-none gap-2 p-0 text-[0.8125rem]">
          {rows.map((task) => (
            <li key={`${task.specId}-${task.taskId}`} data-testid={`repo-task-${task.taskId}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-line pt-2 first:border-t-0 max-md:grid-cols-1">
              <div className="grid min-w-0 gap-1">
                <span data-testid={`repo-task-title-${task.taskId}`} className="font-medium wrap-anywhere">{task.title}</span>
                <span className="hint">{`${task.specId} · ${ROLE_LABEL[task.owner] ?? task.owner}`}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatePill label={TASK_STATE[task.state].label} tone={TASK_STATE[task.state].tone} />
                {DID_NOT_FINISH.has(task.state) && (
                  <button data-testid={`repo-task-detail-${task.taskId}`} type="button" className={DETAIL_BUTTON} onClick={(e) => setOpened({ task, opener: e.currentTarget })}>
                    Detalhe
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {view.loaded && view.page < view.pages && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p data-testid="repo-tasks-count" className="m-0 text-[0.8125rem] text-ink-soft tabular-nums" aria-live="polite">{`${shown} de ${view.matched}`}</p>
          <button data-testid="repo-tasks-load-more" type="button" className="secondary" onClick={() => view.setPage(view.page + 1)}>
            Carregar mais
          </button>
        </div>
      )}
      {opened && <TaskDetailDialog task={opened.task} opener={opened.opener} onClose={() => setOpened(null)} />}
    </section>
  );
}

/** Why one task did not finish: the problem and the solution in plain words, the reviewer text folded away. */
function TaskDetailDialog({ task, opener, onClose }: { task: DashboardTaskRow; opener: HTMLElement; onClose: () => void }) {
  const block = blockExplanation(task.rawReason ?? '');
  return (
    <Dialog title={task.taskId} onClose={onClose} returnFocus={opener}>
      <Facts rows={[['Tarefa', task.title], ['Spec', task.specId], ['O que aconteceu', block.title]]} />
      <BlockReason block={block} />
      {task.runId && <Link to={`${runPath(task.runId)}?task=${encodeURIComponent(task.taskId)}`}>Abrir run</Link>}
    </Dialog>
  );
}
