import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import type { backlogProgress } from './backlog-progress.js';
import { Elapsed, untilText } from './ProcessingBanner.js';
import { ProgressBar } from './ProgressBar.js';
import { TILE } from './StepCard.js';

type Props = {
  progress: ReturnType<typeof backlogProgress>;
  /** When the preparation started (ISO time); the clock runs from it. */
  since?: string | null;
  /** The Claude quota pause in progress: no step starts until then. */
  waiting?: { until: string } | null;
  /** True once the closing is complete. */
  ready: boolean;
  last: string | null;
  total: string;
  repeated: boolean;
};

const ICON = { done: 'check', current: 'clock', ahead: 'chevron-right', problem: 'alert' } as const;
const TONE = { done: 'text-good', current: 'text-warn', ahead: 'text-ink-soft', problem: 'text-warn' } as const;

/** Where the backlog stands towards the start: the percent done, each check, and what the agents do now. */
export function BacklogProgress({ progress, since, waiting = null, ready, last, total, repeated }: Props) {
  const { percent, done, rows, now, more } = progress;
  const current = rows.findIndex((r) => r.state !== 'done');
  return (
    <section data-testid="finish-panel" aria-labelledby="finish-panel-title" className="card grid min-w-0 gap-3 px-4 py-3">
      <header className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden="true" className={`grid size-9 flex-none place-items-center rounded-tile ${TILE.violet}`}><Icon name="activity" size={18} /></span>
        <h3 id="finish-panel-title" className="m-0 flex flex-1 items-center gap-1 text-[1rem] font-semibold tracking-[-0.01em] normal-case text-ink">Progresso do backlog<InfoTip text="O percentual conta o que já foi feito sobre o que o início exige: specs, planos e listas de tarefas de cada item, mais documentos, dependências, arquitetura e perguntas. Só chega a 100% quando todas as verificações passam. Montado pelos agentes." /></h3>
        <span data-testid="progress-percent" className={`text-[1rem] font-semibold tabular-nums ${ready ? 'text-good' : 'text-ink'}`}>{percent}%</span>
      </header>
      <div className="grid gap-1.5 sm:pl-12">
        <ProgressBar label="Progresso do backlog" done={done} total={progress.total} testId="progress-bar" />
        <p className="m-0 flex flex-wrap gap-x-3 text-[0.8125rem] tabular-nums text-ink-soft">
          <span data-testid="progress-missing">{ready ? 'Pronto para iniciar' : `Faltam ${100 - percent}%`}</span>
          {waiting && <span data-testid="progress-waiting" role="status" className="flex items-center gap-1.5 text-warn"><Icon name="clock" size={14} />Aguardando a cota do Claude até {untilText(waiting.until)}</span>}
          {since && <span data-testid="progress-time">Tempo <Elapsed since={since} /></span>}
        </p>
      </div>
      <ol className="m-0 grid list-none gap-2.5 p-0 sm:pl-12">
        {rows.map((x, i) => (
          <li key={x.id} data-testid={`progress-${x.id}`} data-state={x.state} aria-current={i === current ? 'step' : undefined} className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[0.875rem] leading-[1.45]">
            <span className={`inline-flex flex-none self-center ${TONE[x.state]}`} aria-hidden="true"><Icon name={ICON[x.state]} size={16} /></span>
            <span className={x.state === 'ahead' ? 'text-ink-soft' : 'font-semibold text-ink'}>{x.label}</span>
            {x.value && <span className="min-w-0 text-[0.8125rem] tabular-nums text-ink-soft">{x.value}</span>}
          </li>
        ))}
      </ol>
      {now.length > 0 && (
        <ul data-testid="progress-now" aria-label="Em andamento agora" className="m-0 grid list-none gap-1.5 border-t border-line p-0 pt-3 text-[0.8125rem] leading-[1.45] sm:pl-12">
          {now.map((n, i) => (
            <li key={i} className="flex min-w-0 items-center gap-2">
              {waiting ? <span className="inline-flex flex-none text-warn" aria-hidden="true"><Icon name="clock" size={14} /></span> : <span className="button-spinner flex-none" aria-hidden="true" />}
              <span className="min-w-0 flex-1 text-ink">{n.label}</span>
              {n.since && <span className="flex-none tabular-nums text-ink-soft"><Elapsed since={n.since} /></span>}
            </li>
          ))}
          {more > 0 && <li data-testid="progress-more" className="text-ink-soft">e mais {more}</li>}
        </ul>
      )}
      <div className="grid gap-1 border-t border-line pt-3 text-[0.8125rem] leading-[1.45] tabular-nums text-ink-soft">
        {last && <p data-testid="finish-panel-last" className="m-0">{last}</p>}
        <p data-testid="finish-panel-total" className="m-0">Total do refinamento: {total}</p>
        {repeated && <p data-testid="finish-panel-repeated" role="status" className="m-0 flex items-center gap-1.5 text-warn"><Icon name="alert" size={14} />A última avaliação começou no mesmo texto da anterior: nada mudou nos documentos.</p>}
      </div>
    </section>
  );
}
