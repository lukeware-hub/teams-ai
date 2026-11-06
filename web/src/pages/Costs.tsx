import { Link } from 'react-router-dom';
import type { CostOverview } from '@server/usage/cost-report.js';
import { costsApi } from '../api.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { costsProjectPath } from '../routes.js';
import { emptyState, panel, responsiveCell, responsiveHead, responsiveRow, stats } from './project-shared.js';
import { ErrorBlock, EscalationNote, Indicator, PanelTitle, PeriodChips, RefreshButton, ShareBar, ShareList, UnreadChip, UpdatedAt, headRow, numCell, shareRow, table, tableWrap } from './costs/CostParts.js';
import { money, ofTotal, shareOf, tokens } from './costs/format.js';
import { AGENT_LABEL, HELP, MODEL_LABEL, STAGE_LABEL, labelOf } from './costs/labels.js';
import { useCostData, usePeriod } from './costs/useCostData.js';

/** Every project's cost, the agents and the models, for one period. */
export function CostsPage() {
  const [period, choose] = usePeriod();
  const { data, error, reload, updatedAt } = useCostData('overview', costsApi.overview, period);
  const retry = () => void reload();
  return (
    <main data-testid="costs-main" className="grid min-w-0 gap-4">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="m-0 text-[1.375rem] leading-[1.3] text-ink">Custos</h1>
          <p className="mt-1.5 mb-0 max-w-[60ch] text-[0.9375rem] leading-normal text-ink-soft">Quanto cada projeto gastou, onde e com qual agente.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 max-sm:w-full max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
          <UpdatedAt at={updatedAt} />
          <RefreshButton onClick={retry} />
        </div>
      </header>
      <PeriodChips value={period} onChange={choose} />
      {error ? <ErrorBlock onRetry={retry} /> : null}
      {data ? <Overview data={data} /> : error ? null : <Loading />}
    </main>
  );
}

function Overview({ data }: { data: CostOverview }) {
  const { total, byStage } = data;
  return (
    <>
      <div data-testid="costs-indicators" className={stats}>
        <Indicator id="total" label="Total" help={HELP.total} value={money(total.costUsd)} detail={tokens(total.tokens)} />
        <Indicator id="refinement" label="Refinamento" help={HELP.refinement} value={money(byStage.refinement.costUsd)} detail={ofTotal(byStage.refinement.costUsd, total.costUsd)} share={shareOf(byStage.refinement.costUsd, total.costUsd)} />
        <Indicator id="development" label="Desenvolvimento" help={HELP.development} value={money(byStage.development.costUsd)} detail={ofTotal(byStage.development.costUsd, total.costUsd)} share={shareOf(byStage.development.costUsd, total.costUsd)} />
        <Indicator id="chat" label="Chat" help={HELP.chat} value={money(byStage.chat.costUsd)} detail={ofTotal(byStage.chat.costUsd, total.costUsd)} share={shareOf(byStage.chat.costUsd, total.costUsd)} />
      </div>
      {total.steps === 0 ? (
        <div className={emptyState}>
          <p>Nenhum custo registrado neste período.</p>
          <p>O custo aparece aqui depois que um refinamento ou um run chamar um modelo.</p>
        </div>
      ) : (
        <>
          <ProjectsPanel data={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <section className={`${panel} content-start`} data-testid="costs-agents">
              <PanelTitle icon="user" title="Por agente" help={HELP.agents} />
              <ShareList rows={data.agents.map((a) => shareRow(a, `${labelOf(STAGE_LABEL, a.stage)} · ${labelOf(AGENT_LABEL, a.key)}`, `${a.stage}/${a.key}`))} />
            </section>
            <section className={`${panel} content-start`} data-testid="costs-models">
              <PanelTitle icon="code" title="Por modelo" help={HELP.models} />
              <ShareList rows={data.models.map((m) => shareRow(m, labelOf(MODEL_LABEL, m.key), m.key))} />
            </section>
          </div>
        </>
      )}
      <footer data-testid="costs-footer" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.8125rem] text-ink-soft">
        <JevLine data={data} />
        <UnreadChip count={data.unreadJournals} />
      </footer>
      <EscalationNote count={data.escalationsWithoutCost} />
    </>
  );
}

// A stage figure on the phone: third row, one of three columns, a rule above it.
const stageCell = '@max-[44rem]:row-start-3 @max-[44rem]:border-t @max-[44rem]:border-line @max-[44rem]:pt-2 @max-[44rem]:text-left';

function ProjectsPanel({ data }: { data: CostOverview }) {
  return (
    <section className={`${panel} content-start`} data-testid="costs-projects">
      <PanelTitle icon="folder" title="Por projeto" help={HELP.projects} />
      <div className={tableWrap}>
        <table className={table}>
          <thead className={responsiveHead}>
            <tr className={headRow}>
              <th scope="col">Projeto</th>
              <th scope="col" className="text-right">Refinamento</th>
              <th scope="col" className="text-right">Desenvolvimento</th>
              <th scope="col" className="text-right">Chat</th>
              <th scope="col" className="text-right">Total</th>
              <th scope="col" className="text-right">Execuções</th>
            </tr>
          </thead>
          <tbody>
            {data.projects.map((p) => (
              <tr key={p.projectId ?? 'sem-projeto'} className={`${responsiveRow} relative @max-[44rem]:grid-cols-3 @max-[44rem]:gap-x-3 @max-[44rem]:gap-y-2`} data-testid={`costs-project-${p.projectId ?? 'sem-projeto'}`}>
                <td className={`${responsiveCell} @max-[44rem]:col-span-2 @max-[44rem]:row-start-1 @max-[44rem]:text-[1rem] @max-[44rem]:font-semibold @max-[44rem]:before:hidden`} data-label="Projeto">
                  {p.projectId ? <Link to={costsProjectPath(p.projectId)} className="wrap-anywhere after:absolute after:inset-0 after:content-['']">{p.name}</Link> : p.name}
                </td>
                <td className={`${numCell} ${stageCell} @max-[44rem]:col-start-1`} data-label="Refinamento">{money(p.byStage.refinement.costUsd)}</td>
                <td className={`${numCell} ${stageCell} @max-[44rem]:col-start-2`} data-label="Desenvolvimento">{money(p.byStage.development.costUsd)}</td>
                <td className={`${numCell} ${stageCell} @max-[44rem]:col-start-3`} data-label="Chat">{money(p.byStage.chat.costUsd)}</td>
                <td className={`${numCell} @max-[44rem]:col-span-3 @max-[44rem]:row-start-2 @max-[44rem]:items-stretch @max-[44rem]:py-1 @max-[44rem]:before:hidden`} data-label="Total">
                  <span className="block @max-[44rem]:text-[1.25rem] @max-[44rem]:font-[650]">{money(p.total.costUsd)}</span>
                  <span className="flex justify-end @max-[44rem]:justify-start @max-[44rem]:[&>span]:w-full @max-[44rem]:[&_[aria-hidden]]:flex-1">
                    <ShareBar share={shareOf(p.total.costUsd, data.total.costUsd)} />
                  </span>
                </td>
                <td className={`${numCell} @max-[44rem]:col-start-3 @max-[44rem]:row-start-1 @max-[44rem]:items-end @max-[44rem]:text-right`} data-label="Execuções">{p.runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The Jev money no project owns; over a short period the ledger cannot say, so it says so. */
function JevLine({ data }: { data: CostOverview }) {
  if (data.jevUnassignedUsd === null && data.period === 'tudo') return null;
  return (
    <span className="inline-flex items-center gap-1">
      Jev fora de projetos:
      {data.jevUnassignedUsd === null ? <span>Indisponível neste período</span> : <strong className="text-ink tabular-nums">{money(data.jevUnassignedUsd)}</strong>}
      <InfoTip label="Jev fora de projetos" text={HELP.jev} />
    </span>
  );
}
