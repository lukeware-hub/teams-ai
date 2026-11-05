import { useState } from 'react';
import { agentOf, specLabel } from '@server/usage/cost-report.js';
import type { CostFact } from '@server/usage/cost-types.js';
import { costsApi } from '../../api.js';
import { Pagination, SortHeader, usePagedTable, type TableView } from '../../components/DataTable.js';
import { Icon } from '../../components/Icons.js';
import { Loading } from '../../components/Loading.js';
import { Select } from '../../components/Select.js';
import { emptyState, panel, responsiveCell, responsiveHead, responsiveRow, when } from '../project-shared.js';
import { type Option, PanelTitle, headRow, numCell, table, tableWrap } from './CostParts.js';
import { money, tokenCount } from './format.js';
import { AGENT_LABEL, PHASE_LABEL, STAGE_LABEL, labelOf } from './labels.js';

/** The steps of a project, one page at a time, filtered by stage, agent, spec and text. */
export function StepsPanel({ projectId, agents, specs, version }: { projectId: string; agents: Option[]; specs: Option[]; version: number }) {
  const [agente, setAgente] = useState('');
  const [spec, setSpec] = useState('');
  // A new agent or spec is a new scope, so the table goes back to its first page.
  const view = usePagedTable(
    `${projectId}/${agente}/${spec}`,
    (req) => costsApi.steps(projectId, req, { agente, spec }),
    (stage) => labelOf(STAGE_LABEL, stage),
    String(version),
  );
  return (
    <section className={panel} data-testid="costs-steps">
      <PanelTitle icon="list" title="Steps" />
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="relative block min-w-0 flex-[0_1_20rem] max-md:basis-full [&_svg]:pointer-events-none [&_svg]:absolute [&_svg]:top-1/2 [&_svg]:left-3 [&_svg]:-translate-y-1/2 [&_svg]:text-ink-faint">
          <span className="sr-only">Buscar nos steps</span>
          <Icon name="search" size={16} />
          <input className="w-full min-w-0 appearance-none pl-[2.375rem]" type="search" value={view.query} onChange={(e) => view.setQuery(e.target.value)} placeholder="Buscar por spec, run, tarefa ou modelo" />
        </label>
        <FilterSelect label="Etapa" all="Todas as etapas" value={view.facet} options={view.options} onChange={view.setFacet} />
        <FilterSelect label="Agente" all="Todos os agentes" value={agente} options={agents} onChange={setAgente} />
        <FilterSelect label="Spec" all="Todas as specs" value={spec} options={specs} onChange={setSpec} />
        <p className="m-0 text-[0.8125rem] text-ink-soft tabular-nums" aria-live="polite">
          {view.filtered || agente || spec ? `${view.matched} de ${view.total}` : ''}
        </p>
      </div>
      {view.failed ? <p role="alert" className="error mt-3 mb-0">Não foi possível ler os steps.</p> : null}
      {!view.loaded ? (view.failed ? null : <Loading />) : view.matched === 0 ? <p className={`${emptyState} mt-3`}>Nenhum step com estes filtros.</p> : <StepTable view={view} />}
    </section>
  );
}

function FilterSelect({ label, all, value, options, onChange }: { label: string; all: string; value: string; options: Option[]; onChange: (value: string) => void }) {
  return (
    <label className="block min-w-0 flex-none max-md:basis-full">
      <span className="sr-only">{label}</span>
      <Select wrapperClassName="md:w-52" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>
    </label>
  );
}

function StepTable({ view }: { view: TableView<CostFact> }) {
  return (
    <div className={tableWrap}>
      <table className={table}>
        <thead className={responsiveHead}>
          <tr className={headRow}>
            <SortHeader view={view} column="data">Data</SortHeader>
            <th scope="col">Etapa</th>
            <th scope="col">Spec</th>
            <th scope="col">Run</th>
            <th scope="col">Repositório</th>
            <th scope="col">Tarefa</th>
            <th scope="col">Agente</th>
            <th scope="col">Fase</th>
            <th scope="col">Modelo</th>
            <SortHeader view={view} column="tokens" className="text-right">Tokens</SortHeader>
            <SortHeader view={view} column="custo" className="text-right">Custo</SortHeader>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((f, i) => (
            <tr key={`${f.at}-${i}`} className={responsiveRow} data-testid="costs-step-row">
              <td className={responsiveCell} data-label="Data">{when(f.at)}</td>
              <td className={responsiveCell} data-label="Etapa">{labelOf(STAGE_LABEL, f.stage)}</td>
              <td className={responsiveCell} data-label="Spec">{f.specId ? specLabel(f.specId) : '—'}</td>
              <td className={`${responsiveCell} wrap-anywhere`} data-label="Run">{f.runId ?? '—'}</td>
              <td className={responsiveCell} data-label="Repositório">{f.repository ?? '—'}</td>
              <td className={`${responsiveCell} wrap-anywhere`} data-label="Tarefa">{f.taskId ?? '—'}</td>
              <td className={responsiveCell} data-label="Agente">{labelOf(AGENT_LABEL, agentOf(f))}</td>
              <td className={responsiveCell} data-label="Fase">{labelOf(PHASE_LABEL, f.phase)}</td>
              <td className={responsiveCell} data-label="Modelo">{f.model ?? 'sem modelo'}</td>
              <td className={numCell} data-label="Tokens">{tokenCount(f.tokens.inputTokens + f.tokens.outputTokens)}</td>
              <td className={numCell} data-label="Custo">{f.costUsd === null ? 'sem custo' : money(f.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination view={view} />
    </div>
  );
}
