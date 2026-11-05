import type { StageCosts } from '@server/usage/cost-report.js';
import { panel, plural } from '../project-shared.js';
import { PanelTitle, ShareList, shareRow } from './CostParts.js';
import { money, unpricedNote } from './format.js';
import { AGENT_LABEL, KIND_LABEL, MODEL_LABEL, PHASE_LABEL, labelOf } from './labels.js';

/** One stage of one project, with its own total and its own breakdowns; development adds the phase and the repository. */
export function StagePanel({ id, title, help, costs, development = false }: { id: string; title: string; help: string; costs: StageCosts; development?: boolean }) {
  const { total } = costs;
  return (
    <section className={`${panel} content-start`} data-testid={`costs-stage-${id}`}>
      <PanelTitle icon="coin" title={title} help={help} />
      <p className="mt-2 mb-0 text-[0.875rem] text-ink-soft tabular-nums">
        <strong className="text-ink">{money(total.costUsd)}</strong> · {plural(total.steps, 'step', 'steps')}
        {unpricedNote(total.semCusto)}
      </p>
      {total.steps === 0 ? (
        <p className="mt-4 mb-0 hint">Nenhum custo registrado nesta etapa.</p>
      ) : (
        <div className="mt-4 grid gap-5">
          <ShareList title="Por agente" rows={costs.byAgent.map((a) => shareRow(a, labelOf(AGENT_LABEL, a.key)))} />
          <ShareList title="Por modelo" rows={costs.byModel.map((m) => shareRow(m, labelOf(MODEL_LABEL, m.key), m.key))} />
          <ShareList title="Por tipo" rows={costs.byKind.map((k) => shareRow(k, labelOf(KIND_LABEL, k.key)))} />
          {development ? (
            <>
              <ShareList title="Por fase" rows={costs.byPhase.map((p) => shareRow(p, labelOf(PHASE_LABEL, p.key)))} />
              <ShareList title="Por repositório" rows={costs.byRepository.map((r) => shareRow(r, r.key))} />
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
