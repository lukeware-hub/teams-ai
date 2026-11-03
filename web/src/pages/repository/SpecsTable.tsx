import { runApi, type RepoSpecView } from '../../api.js';
import { Pagination, usePagedTable } from '../../components/DataTable.js';

/** The specs of the repository, one page at a time from the server; each row shows its state, plan, tasks and dependencies. */
export function SpecsTable({ projectId, repo }: { projectId: string; repo: string }) {
  const view = usePagedTable(`${projectId}/${repo}/specs`, (req) => runApi.repositorySpecsPage(projectId, repo, req));
  if (!view.loaded) return <p data-testid="repository-specs-loading" className="hint" role="status">Carregando as especificações…</p>;
  if (view.total === 0) return <p data-testid="repository-specs-empty" className="hint">Nenhuma spec neste repositório.</p>;
  return (
    <div data-testid="repository-specs-scroll" className="-mx-1 overflow-x-auto">
      <table data-testid="repository-specs-table" className="w-full text-[0.8125rem]">
        <thead data-testid="repository-specs-head">
          <tr data-testid="repository-specs-head-row" className="text-left text-ink-soft">
            <th data-testid="repository-specs-th-spec" scope="col">Spec</th>
            <th data-testid="repository-specs-th-priority" scope="col">Prioridade</th>
            <th data-testid="repository-specs-th-state" scope="col">Estado</th>
            <th data-testid="repository-specs-th-plan" scope="col">Plano</th>
            <th data-testid="repository-specs-th-tasks" scope="col">Tarefas</th>
            <th data-testid="repository-specs-th-depends" scope="col">Depende de</th>
          </tr>
        </thead>
        <tbody data-testid="repository-specs-body">
          {view.rows.map((row: RepoSpecView) => (
            <tr key={row.specId} data-testid={`repo-spec-${row.specId}`}>
              <td data-testid={`repository-spec-title-${row.specId}`}>{row.title ?? row.specId}</td>
              <td data-testid={`repository-spec-priority-${row.specId}`}>{row.priority ?? 'sem dados'}</td>
              <td data-testid={`repository-spec-state-${row.specId}`}>{row.blocked ? 'Bloqueada' : row.status}</td>
              <td data-testid={`repository-spec-plan-${row.specId}`}>{row.plan ? 'Sim' : 'Não'}</td>
              <td data-testid={`repository-spec-tasks-${row.specId}`}>{`${row.status === 'done' ? row.tasks : 0} de ${row.tasks}`}</td>
              <td data-testid={`repository-spec-depends-${row.specId}`}>{row.dependsOn.length > 0 ? row.dependsOn.join(', ') : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination view={view} />
    </div>
  );
}
