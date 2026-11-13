import { runApi, type RoleActivity } from '../../api.js';
import { InfoTip } from '../../components/InfoTip.js';
import { Pagination, usePagedTable } from '../../components/DataTable.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { cardCell, cardRow, cardTable, cardTitleCell, money, panel, responsiveHead, sectionHeading, sectionTitle, when } from '../project-shared.js';

const COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ['agent', 'Agente', 'O papel do agente que trabalhou neste repositório.'],
  ['steps', 'Etapas', 'Quantas etapas o agente executou, e quantas terminaram bem ou falharam.'],
  ['tasks', 'Tarefas', 'Tarefas que o agente criou, iniciou e concluiu. Traço quando o papel não cria tarefas.'],
  ['files', 'Arquivos', 'Quantos arquivos o agente alterou.'],
  ['tests', 'Testes', 'Testes que passaram e que falharam nas etapas do agente. Traço quando o papel não roda testes.'],
  ['cost', 'Custo', 'Quanto o agente gastou neste repositório, em dólar.'],
  ['last', 'Última atividade', 'O que o agente fez por último e quando.'],
];

/** What each agent role did in the repository's runs: steps, tasks it owns, files, tests, cost and last activity. */
export function AgentActivity({ projectId, repo }: { projectId: string; repo: string }) {
  const view = usePagedTable(`${projectId}/${repo}/agents`, (req) => runApi.repositoryDashboardTable<RoleActivity>(projectId, repo, 'agents', req), (role) => ROLE_LABEL[role] ?? role);
  return (
    <section className={panel} data-testid="repo-agents">
      <div data-testid="agent-activity-title" className={sectionTitle}>
        <h2 data-testid="agent-activity-heading" className={sectionHeading}>Atividade por agente</h2>
        <InfoTip label="Atividade por agente" text="O trabalho de cada agente neste repositório: quantas tarefas fez, em quantos arquivos mexeu e quando agiu pela última vez." />
      </div>
      {!view.loaded ? (
        <p data-testid="agent-activity-loading" className="hint" role="status">Carregando a atividade…</p>
      ) : view.total === 0 ? (
        <p data-testid="agent-activity-empty" className="hint">sem dados: nenhum agente atuou neste repositório.</p>
      ) : (
        <div data-testid="agent-activity-scroll" className={`@container ${cardTable} overflow-x-auto`}>
          <table data-testid="agent-activity-table" className="w-full text-[0.8125rem]">
            <thead data-testid="agent-activity-head" className={responsiveHead}>
              <tr data-testid="agent-activity-head-row" className="text-left text-ink-soft">
                {COLUMNS.map(([key, label, help]) => (
                  <th key={key} data-testid={`agent-activity-th-${key}`} scope="col">
                    <span className="inline-flex items-center gap-1 whitespace-nowrap hyphens-none">
                      {label}
                      <InfoTip label={label} text={help} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody data-testid="agent-activity-body">
              {view.rows.map((a) => (
                <tr key={a.role} className={cardRow} data-testid={`agent-${a.role}`}>
                  <th data-testid={`agent-activity-role-${a.role}`} scope="row" className={cardTitleCell}>{ROLE_LABEL[a.role] ?? a.role}</th>
                  <td data-testid={`agent-activity-steps-${a.role}`} className={cardCell('2')} data-label="Etapas">{`${a.steps} (${a.ok} ok, ${a.failed} falha${a.failed === 1 ? '' : 's'})`}</td>
                  <td data-testid={`agent-activity-tasks-${a.role}`} className={cardCell('2')} data-label="Tarefas">{a.created === null ? '—' : `${a.created} criadas · ${a.started} iniciadas · ${a.finished} concluídas`}</td>
                  <td data-testid={`agent-activity-files-${a.role}`} className={cardCell('1')} data-label="Arquivos">{a.files}</td>
                  <td data-testid={`agent-activity-tests-${a.role}`} className={cardCell('2')} data-label="Testes">{a.tests === null ? '—' : `${a.tests.passed} passaram · ${a.tests.failed} falharam`}</td>
                  <td data-testid={`agent-activity-cost-${a.role}`} className={cardCell('1')} data-label="Custo">{money(a.costUsd)}</td>
                  <td data-testid={`agent-activity-last-${a.role}`} className={cardCell('2')} data-label="Última atividade">{a.lastAt ? `${a.lastDoing} · ${when(a.lastAt)}` : '—'}</td>
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
