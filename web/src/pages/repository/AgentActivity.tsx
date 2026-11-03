import { runApi, type RoleActivity } from '../../api.js';
import { Pagination, usePagedTable } from '../../components/DataTable.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { money, panel, responsiveCell, responsiveHead, responsiveRow, responsiveTable, sectionHeading, sectionTitle, when } from '../project-shared.js';

/** What each agent role did in the repository's runs: steps, tasks it owns, files, tests, cost and last activity. */
export function AgentActivity({ projectId, repo }: { projectId: string; repo: string }) {
  const view = usePagedTable(`${projectId}/${repo}/agents`, (req) => runApi.repositoryDashboardTable<RoleActivity>(projectId, repo, 'agents', req), (role) => ROLE_LABEL[role] ?? role);
  return (
    <section className={panel} data-testid="repo-agents">
      <div data-testid="agent-activity-title" className={sectionTitle}>
        <h2 data-testid="agent-activity-heading" className={sectionHeading}>Atividade por agente</h2>
      </div>
      {!view.loaded ? (
        <p data-testid="agent-activity-loading" className="hint" role="status">Carregando a atividade…</p>
      ) : view.total === 0 ? (
        <p data-testid="agent-activity-empty" className="hint">sem dados: nenhum agente atuou neste repositório.</p>
      ) : (
        <div data-testid="agent-activity-scroll" className={`@container ${responsiveTable} -mx-1 overflow-x-auto`}>
          <table data-testid="agent-activity-table" className="w-full text-[0.8125rem]">
            <thead data-testid="agent-activity-head" className={responsiveHead}>
              <tr data-testid="agent-activity-head-row" className="text-left text-ink-soft">
                <th data-testid="agent-activity-th-agent" scope="col">Agente</th>
                <th data-testid="agent-activity-th-steps" scope="col">Etapas</th>
                <th data-testid="agent-activity-th-tasks" scope="col">Tarefas</th>
                <th data-testid="agent-activity-th-files" scope="col">Arquivos</th>
                <th data-testid="agent-activity-th-tests" scope="col">Testes</th>
                <th data-testid="agent-activity-th-cost" scope="col">Custo</th>
                <th data-testid="agent-activity-th-last" scope="col">Última atividade</th>
              </tr>
            </thead>
            <tbody data-testid="agent-activity-body">
              {view.rows.map((a) => (
                <tr key={a.role} className={responsiveRow} data-testid={`agent-${a.role}`}>
                  <th data-testid={`agent-activity-role-${a.role}`} scope="row" className={`${responsiveCell} text-left font-medium`}>{ROLE_LABEL[a.role] ?? a.role}</th>
                  <td data-testid={`agent-activity-steps-${a.role}`} className={responsiveCell} data-label="Etapas">{`${a.steps} (${a.ok} ok, ${a.failed} falha${a.failed === 1 ? '' : 's'})`}</td>
                  <td data-testid={`agent-activity-tasks-${a.role}`} className={responsiveCell} data-label="Tarefas">{a.created === null ? '—' : `${a.created} criadas · ${a.started} iniciadas · ${a.finished} concluídas`}</td>
                  <td data-testid={`agent-activity-files-${a.role}`} className={responsiveCell} data-label="Arquivos">{a.files}</td>
                  <td data-testid={`agent-activity-tests-${a.role}`} className={responsiveCell} data-label="Testes">{a.tests === null ? '—' : `${a.tests.passed} passaram · ${a.tests.failed} falharam`}</td>
                  <td data-testid={`agent-activity-cost-${a.role}`} className={responsiveCell} data-label="Custo">{money(a.costUsd)}</td>
                  <td data-testid={`agent-activity-last-${a.role}`} className={responsiveCell} data-label="Última atividade">{a.lastAt ? `${a.lastDoing} · ${when(a.lastAt)}` : '—'}</td>
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
