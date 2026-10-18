import type { BacklogView } from '../api.js';
import { InfoTip } from '../components/InfoTip.js';
import { processingText } from './BacklogPanel.js';

const evaluationInfo = 'Cada clique em Avaliar abre uma rodada: o Jev confere a consistência dos documentos, o Claude gera o spec.json e o project.json, os agentes PO, SM e Front revisam e sugerem ajustes, e o Jev também aponta critérios ainda não prontos, descarta perguntas repetidas e sinaliza contradições com o histórico.';

/** The evaluation in progress, shown at the top of the refinement page on every tab. */
export function ProcessingBanner({ backlog, cycle, stage, jevDown, title = 'Avaliação em andamento' }: { backlog: BacklogView | null | undefined; cycle: number; stage: string; jevDown: boolean; title?: string }) {
  const items = backlog?.items ?? [];
  const specs = items.filter((i) => backlog?.specs?.[i.key]?.spec).length;
  const preplans = Object.values(backlog?.preplans ?? {}).filter((row) => row.preplan).length;
  return (
    <div className={`flex items-center gap-[0.7rem] rounded-lg border px-[0.8rem] py-[0.7rem] [&_.info-tip]:text-current ${jevDown ? 'border-bad-line bg-bad-soft text-bad' : 'border-good-line bg-good-soft text-good'}`} role="status" aria-live="polite" data-testid="processing-banner">
      <span className="button-spinner" aria-hidden="true" />
      <div className="grid flex-1 gap-[0.15rem]">
        <b className="text-[0.8125rem]">{title} <InfoTip text={evaluationInfo} /></b>
        <span className="text-[0.75rem] leading-[1.35]">Rodada {cycle} · {stage}</span>
        {backlog?.enabled && <span className="text-[0.75rem] leading-[1.35]">{processingText(backlog)}</span>}
        {backlog?.detail && (
          <span className="flex items-center gap-2 text-[0.75rem] leading-[1.35]" data-testid="detail-progress">
            <span className="button-spinner" aria-hidden="true" />Detalhando… {specs}/{items.length} specs · {preplans}/{items.length} pré-planos
          </span>
        )}
      </div>
    </div>
  );
}
