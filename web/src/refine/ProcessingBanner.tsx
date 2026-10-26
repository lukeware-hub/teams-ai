import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { BacklogView } from '../api.js';
import { InfoTip } from '../components/InfoTip.js';
import { processingText } from './BacklogPanel.js';
import { formatDuration } from '../run/selectors.js';
import { runningStepLabel, type RunningStep } from './running-steps.js';

const evaluationInfo = 'Cada clique em Avaliar abre uma rodada: o Jev confere a consistência dos documentos, o Claude gera as specs, os agentes PO, SM e Front revisam e sugerem ajustes, e o Jev também aponta critérios ainda não prontos, descarta perguntas repetidas e sinaliza contradições com o histórico.';

/** The time from `since` to `now` as mm:ss, or h:mm:ss from an hour on. */
export function elapsedText(since: string, now: number): string {
  const total = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const clock = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return h > 0 ? `${h}:${clock}` : clock;
}

/** The record of the last evaluation: how long it took once it ended, or a dash when there is none or its times are missing. */
export function lastEvaluationText(evaluation: { startedAt: string; endedAt: string | null } | undefined): string {
  if (!evaluation?.startedAt) return '—';
  if (evaluation.endedAt === null) return 'em andamento';
  const ms = Date.parse(evaluation.endedAt) - Date.parse(evaluation.startedAt);
  return Number.isNaN(ms) ? '—' : formatDuration(ms);
}

const tones = { good: 'border-good-line bg-good-soft text-good', bad: 'border-warn-line bg-warn-soft text-warn' } as const;

/** A process in progress in a colored box: a spinner, its title, the time since `since`, and its lines. */
export function ProcessBox({ title, since = null, tone = 'good', testId, children }: { title: ReactNode; since?: string | null; tone?: keyof typeof tones; testId: string; children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [since]);
  return (
    <div className={`flex items-center gap-[0.7rem] rounded-lg border px-[0.8rem] py-[0.7rem] [&_.info-tip]:text-current ${tones[tone]}`} role="status" aria-live="polite" data-testid={testId}>
      <span className="button-spinner" aria-hidden="true" />
      <div className="grid flex-1 gap-[0.15rem]">
        <b className="text-[0.8125rem]">{title}</b>
        {since && <span className="text-[0.75rem] leading-[1.35] tabular-nums" data-testid="evaluation-timer">Tempo: {elapsedText(since, now)}</span>}
        {children}
      </div>
    </div>
  );
}

/** The evaluation in progress, shown at the top of the refinement page on every tab. */
export function ProcessingBanner({ backlog, cycle, stage, jevDown, running = [], title = 'Avaliação em andamento', since = null }: { backlog: BacklogView | null | undefined; cycle: number; stage: string; jevDown: boolean; running?: RunningStep[]; title?: string; since?: string | null }) {
  const items = backlog?.items ?? [];
  const specs = items.filter((i) => backlog?.specs?.[i.key]?.spec).length;
  const preplans = Object.values(backlog?.preplans ?? {}).filter((row) => row.preplan).length;
  return (
    <ProcessBox title={<>{title} <InfoTip text={evaluationInfo} /></>} since={since} tone={jevDown ? 'bad' : 'good'} testId="processing-banner">
      <span className="text-[0.75rem] leading-[1.35]">Rodada {cycle} · {stage}</span>
      {running.length > 0 && <span className="text-[0.75rem] leading-[1.35]" data-testid="running-models">Em uso agora: {running.map(runningStepLabel).join('; ')}</span>}
      {backlog?.enabled && <span className="text-[0.75rem] leading-[1.35]">{processingText(backlog)}</span>}
      {backlog?.detail && (
        <span className="flex items-center gap-2 text-[0.75rem] leading-[1.35]" data-testid="detail-progress">
          <span className="button-spinner" aria-hidden="true" />Detalhando… {specs}/{items.length} specs · {preplans}/{items.length} pré-planos
        </span>
      )}
    </ProcessBox>
  );
}
