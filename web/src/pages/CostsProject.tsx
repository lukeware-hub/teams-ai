import { Link, useParams } from 'react-router-dom';
import type { ProjectCosts, SpecRow } from '@server/usage/cost-report.js';
import { ApiError, costsApi } from '../api.js';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { PROJECTS, projectPath } from '../routes.js';
import { emptyState, panel, plural, responsiveCell, responsiveHead, responsiveRow, stats } from './project-shared.js';
import { type Option, ErrorBlock, Indicator, PanelTitle, PeriodChips, RefreshButton, UnreadChip, headRow, numCell, table, tableWrap } from './costs/CostParts.js';
import { money, ofTotal, sumMoney, tokens, unpricedNote } from './costs/format.js';
import { AGENT_LABEL, CHAT_AGENT, HELP, labelOf } from './costs/labels.js';
import { StagePanel } from './costs/StagePanel.js';
import { StepsPanel } from './costs/StepsPanel.js';
import { useCostData, usePeriod } from './costs/useCostData.js';

/** One project's cost: refinement and development as two totals, the specs, and the steps. */
export function CostsProjectPage() {
  const { projectId = '' } = useParams();
  const [period, choose] = usePeriod();
  const { data, error, version, reload } = useCostData(projectId, (p) => costsApi.project(projectId, p), period);
  const retry = () => void reload();
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  return (
    <main data-testid="costs-project-main" className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Breadcrumb
          testId="costs-breadcrumb"
          trail={[
            { label: data?.name ?? projectId, to: projectPath(projectId), testId: 'costs-breadcrumb-project' },
            { label: 'Custos', testId: 'costs-breadcrumb-current' },
          ]}
        />
        <RefreshButton onClick={retry} />
      </div>
      <h1 className="sr-only">Custos de {data?.name ?? projectId}</h1>
      <PeriodChips value={period} onChange={choose} />
      {error ? <ErrorBlock onRetry={retry} /> : null}
      {data ? <ProjectView projectId={projectId} data={data} version={version} /> : error ? null : <Loading />}
    </main>
  );
}

function NotFound() {
  return (
    <main data-testid="costs-project-not-found">
      <div data-testid="costs-project-not-found-state" className={emptyState}>
        <Icon name="search" size={24} />
        <p>Esse projeto não foi encontrado.</p>
        <Link className="link-button" to={PROJECTS}>
          Voltar para projetos
          <Icon name="arrow-left" size={16} />
        </Link>
      </div>
    </main>
  );
}

function ProjectView({ projectId, data, version }: { projectId: string; data: ProjectCosts; version: number }) {
  const { refinement, development, chat, specs } = data;
  const total = sumMoney([refinement.total, development.total, chat]);
  return (
    <>
      <div data-testid="costs-indicators" className={stats}>
        <Indicator id="total" label="Total" help={HELP.total} value={money(total.costUsd)} detail={tokens(total.tokens)} />
        <Indicator id="refinement" label="Refinamento" help={HELP.refinement} value={money(refinement.total.costUsd)} detail={ofTotal(refinement.total.costUsd, total.costUsd)} />
        <Indicator id="development" label="Desenvolvimento" help={HELP.development} value={money(development.total.costUsd)} detail={ofTotal(development.total.costUsd, total.costUsd)} />
        <Indicator id="chat" label="Chat" value={money(chat.costUsd)} detail={ofTotal(chat.costUsd, total.costUsd)} />
      </div>
      {total.steps === 0 ? (
        <div className={emptyState}>
          <p>Nenhum custo registrado neste período.</p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <StagePanel id="refinement" title="Refinamento" help={HELP.refinement} costs={refinement} />
            <StagePanel id="development" title="Desenvolvimento" help={HELP.development} costs={development} development />
          </div>
          <SpecPanel specs={specs} />
          <StepsPanel projectId={projectId} agents={agentOptionsOf(data)} specs={specs.map((s) => ({ value: s.key, label: s.label }))} version={version} />
        </>
      )}
      <footer data-testid="costs-chat" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.8125rem] text-ink-soft">
        <span className="inline-flex items-center gap-1">
          Chat: <strong className="text-ink tabular-nums">{money(chat.costUsd)}</strong> · {plural(chat.steps, 'resposta', 'respostas')}
          {unpricedNote(chat.semCusto)}
          <InfoTip label="Chat" text={HELP.chat} />
        </span>
        <UnreadChip count={data.unreadJournals} />
      </footer>
    </>
  );
}

function SpecPanel({ specs }: { specs: SpecRow[] }) {
  return (
    <section className={panel} data-testid="costs-specs">
      <PanelTitle icon="file" title="Por spec" help={HELP.resumed} />
      {specs.length === 0 ? (
        <p className="mt-3 mb-0 hint">Nenhuma spec com custo neste período.</p>
      ) : (
        <div className={tableWrap}>
          <table className={table}>
            <thead className={responsiveHead}>
              <tr className={headRow}>
                <th scope="col">Spec</th>
                <th scope="col" className="text-right">Refinamento</th>
                <th scope="col" className="text-right">Desenvolvimento</th>
                <th scope="col" className="text-right">Total</th>
                <th scope="col" className="text-right">Runs</th>
              </tr>
            </thead>
            <tbody>
              {specs.map((s) => (
                <tr key={s.key} className={responsiveRow} data-testid={`costs-spec-${s.key}`}>
                  <td className={`${responsiveCell} wrap-anywhere`} data-label="Spec">{s.label}</td>
                  <td className={numCell} data-label="Refinamento">{money(s.refinement)}</td>
                  <td className={numCell} data-label="Desenvolvimento">{money(s.development)}</td>
                  <td className={numCell} data-label="Total">{money(s.total)}</td>
                  <td className={numCell} data-label="Runs">{s.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The agents the steps filter by: those of both stages, and the chat's agent when the chat has answers. */
function agentOptionsOf(data: ProjectCosts): Option[] {
  const keys = new Set([...data.refinement.byAgent, ...data.development.byAgent].map((a) => a.key));
  if (data.chat.steps > 0) keys.add(CHAT_AGENT);
  return [...keys].map((key) => ({ value: key, label: labelOf(AGENT_LABEL, key) }));
}
