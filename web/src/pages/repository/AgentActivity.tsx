import type { RoleActivity } from '../../api.js';
import { ROLE_LABEL } from '../../run/roles.js';
import { money, panel, responsiveCell, responsiveHead, responsiveRow, responsiveTable, sectionHeading, sectionTitle, when } from '../project-shared.js';

/** What each agent role did in the repository's runs: steps, tasks it owns, files, tests, cost and last activity. */
export function AgentActivity({ agents }: { agents: RoleActivity[] }) {
  return (
    <section className={panel} data-testid="repo-agents">
      <div className={sectionTitle}>
        <h2 className={sectionHeading}>Atividade por agente</h2>
      </div>
      {agents.length === 0 ? (
        <p className="hint">sem dados: nenhum agente atuou neste repositório.</p>
      ) : (
        <div className={`@container ${responsiveTable} -mx-1 overflow-x-auto`}>
          <table className="w-full text-[0.8125rem]">
            <thead className={responsiveHead}>
              <tr className="text-left text-ink-soft">
                <th scope="col">Agente</th>
                <th scope="col">Etapas</th>
                <th scope="col">Tarefas</th>
                <th scope="col">Arquivos</th>
                <th scope="col">Testes</th>
                <th scope="col">Custo</th>
                <th scope="col">Última atividade</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.role} className={responsiveRow} data-testid={`agent-${a.role}`}>
                  <th scope="row" className={`${responsiveCell} text-left font-medium`}>{ROLE_LABEL[a.role] ?? a.role}</th>
                  <td className={responsiveCell} data-label="Etapas">{`${a.steps} (${a.ok} ok, ${a.failed} falha${a.failed === 1 ? '' : 's'})`}</td>
                  <td className={responsiveCell} data-label="Tarefas">{a.created === null ? '—' : `${a.created} criadas · ${a.started} iniciadas · ${a.finished} concluídas`}</td>
                  <td className={responsiveCell} data-label="Arquivos">{a.files}</td>
                  <td className={responsiveCell} data-label="Testes">{a.tests === null ? '—' : `${a.tests.passed} passaram · ${a.tests.failed} falharam`}</td>
                  <td className={responsiveCell} data-label="Custo">{money(a.costUsd)}</td>
                  <td className={responsiveCell} data-label="Última atividade">{a.lastAt ? `${a.lastDoing} · ${when(a.lastAt)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
