import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { BacklogView } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
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

/** The time since `since`, counting each second; empty without a start. */
export function Elapsed({ since }: { since: string | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [since]);
  return since ? <span className="tabular-nums">{elapsedText(since, now)}</span> : null;
}

const tones = { accent: 'border-accent-line bg-accent-soft text-accent-ink', good: 'border-good-line bg-good-soft text-good', bad: 'border-warn-line bg-warn-soft text-warn' } as const;

/** A process in progress in a colored box: a spinner, its title, the time since `since`, and its lines. */
export function ProcessBox({ title, since = null, tone = 'accent', testId, children }: { title: ReactNode; since?: string | null; tone?: keyof typeof tones; testId: string; children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [since]);
  return (
    <div className={`flex items-start gap-[0.7rem] rounded-lg border px-[0.8rem] py-[0.7rem] [&_.info-tip]:text-current ${tones[tone]}`} role="status" aria-live="polite" data-testid={testId}>
      <span className="button-spinner mt-[0.15rem]" aria-hidden="true" data-testid={`${testId}-spinner`} />
      <div className="grid flex-1 gap-[0.15rem]" data-testid={`${testId}-body`}>
        <b className="text-[0.8125rem]" data-testid={`${testId}-title`}>{title}</b>
        {since && <span className="text-[0.75rem] leading-[1.35] tabular-nums" aria-hidden="true" data-testid="evaluation-timer">Tempo: {elapsedText(since, now)}</span>}
        {children}
      </div>
    </div>
  );
}

/** The stage a review is named after: what it reads, and that the earlier documents are context only. */
export function stageInfo(file: string, jevReads: boolean, firstStage: boolean): string {
  const jev = jevReads ? 'o Jev dá a nota só dele' : 'o Jev não lê o documento (projeto confidencial ou sem resposta)';
  const earlier = firstStage ? '' : ' Os documentos anteriores entram como resumo, só para consulta.';
  return `Esta rodada trabalha só com ${file}: o agente dono do documento o revisa, ${jev} e o Graphify lê só este arquivo.${earlier}`;
}

/** The waiting for the Claude quota, the moment it ends as a clock time. */
const untilText = (iso: string): string => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** The stage cost line: rounds, time, charge and calls, from the journal. */
export function stageCostText(file: string, cost: { rounds: number; steps: number; durationMs: number; costUsd: number }): string {
  const rounds = cost.rounds === 1 ? '1 rodada' : `${cost.rounds} rodadas`;
  const calls = cost.steps === 1 ? '1 chamada' : `${cost.steps} chamadas`;
  return `Etapa ${file} · ${rounds} · ${formatDuration(cost.durationMs)} · US$ ${cost.costUsd.toFixed(2).replace('.', ',')} · ${calls}`;
}

const SLOW_AFTER_MS = 60_000;

/** Says a step has run past a minute, the time a stage review should take; empty while every step is within it. */
function SlowStepNote({ running }: { running: RunningStep[] }) {
  const oldest = running.map((step) => step.startedAt ?? '').filter(Boolean).sort()[0];
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!oldest) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [oldest]);
  if (!oldest || now - Date.parse(oldest) <= SLOW_AFTER_MS) return null;
  return <span className="text-[0.75rem] leading-[1.35]" data-testid="processing-banner-slow">Este passo está demorando mais que o normal.</span>;
}

/** The evaluation in progress, shown at the top of the refinement page on every tab. */
export function ProcessingBanner({ backlog, cycle, stage, jevDown, running = [], title = 'Avaliação em andamento', since = null, info = evaluationInfo, file = null, waiting = null, cost = null, onStop, stopping = false }: { backlog: BacklogView | null | undefined; cycle: number; stage: string; jevDown: boolean; running?: RunningStep[]; title?: string; since?: string | null; info?: string; file?: string | null; waiting?: { until: string } | null; cost?: { rounds: number; steps: number; durationMs: number; costUsd: number } | null; onStop?: () => void; stopping?: boolean }) {
  const items = backlog?.items ?? [];
  const specs = items.filter((i) => backlog?.specs?.[i.key]?.spec).length;
  const preplans = Object.values(backlog?.preplans ?? {}).filter((row) => row.preplan).length;
  return (
    <ProcessBox title={<>{title} <InfoTip text={info} /></>} since={since} tone={jevDown ? 'bad' : 'good'} testId="processing-banner">
      <span className="text-[0.75rem] leading-[1.35]" data-testid="processing-banner-round">Rodada {cycle} · {stage}</span>
      {waiting && <span className="text-[0.75rem] leading-[1.35]" data-testid="processing-banner-waiting">Aguardando a cota do Claude até {untilText(waiting.until)}.</span>}
      {running.length > 0 && <span className="text-[0.75rem] leading-[1.35]" data-testid="running-models">Em uso agora: {running.map(runningStepLabel).join('; ')}</span>}
      <SlowStepNote running={running} />
      {cost && file && <span className="text-[0.75rem] leading-[1.35]" data-testid="processing-banner-cost">{stageCostText(file, cost)}</span>}
      {backlog?.enabled && <span className="text-[0.75rem] leading-[1.35]" data-testid="processing-banner-backlog">{processingText(backlog)}</span>}
      {backlog?.detail && (
        <span className="flex items-center gap-2 text-[0.75rem] leading-[1.35]" data-testid="detail-progress">
          <span className="button-spinner" aria-hidden="true" data-testid="processing-banner-detail-spinner" />Detalhando… {specs}/{items.length} specs · {preplans}/{items.length} pré-planos
        </span>
      )}
      {onStop && <ActionButton className="secondary justify-self-start" data-testid="processing-banner-stop" busy={stopping} onClick={onStop}>Parar avaliação</ActionButton>}
    </ProcessBox>
  );
}
