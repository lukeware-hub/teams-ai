import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { refineApi, runApi, type ProgramView, type RefineState } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { phaseTitle } from '../run/selectors.js';
import { action, panel, sectionHeading, sectionTitle } from '../pages/project-shared.js';

const HELP = 'Depois do início, os agentes executam o backlog inteiro sozinhos, na ordem de prioridade e de dependência, até duas specs ao mesmo tempo quando elas não mexem no mesmo código: planejam, implementam, testam, publicam e marcam cada spec como concluída. Uma spec que falha é isolada e só bloqueia as que dependem dela; as demais seguem. Executar agora passa uma spec à frente da fila.';

const LABEL = { pending: 'na fila', running: 'em execução', completing: 'concluindo', done: 'concluída', failed: 'falhou', blocked: 'bloqueada' } as const;
// Same pills as the hub's spec rows; a live spec's dot pulses.
const PILL = {
  pending: 'status-pill',
  running: 'status-pill tone-neutral motion-safe:before:animate-pulse',
  completing: 'status-pill tone-neutral motion-safe:before:animate-pulse',
  done: 'status-pill tone-good',
  failed: 'status-pill tone-bad',
  blocked: 'status-pill tone-bad',
} as const;
// Rank, spec, status, cost and action share fixed columns so every row lines up; below lg status, cost and action wrap under the title.
const ROW = 'grid grid-cols-[2.5rem_minmax(0,1fr)_8rem_5.5rem_9rem] items-center gap-x-4 gap-y-2 border-b border-line px-3 py-[0.9rem] last:border-b-0 max-lg:grid-cols-[2rem_minmax(0,1fr)]';

/** Can the refinement start a run: one spec when ready, a backlog only once it is detailed (the program runs its planned specs). */
export function canStartRun(st: Pick<RefineState, 'status' | 'stale' | 'backlog'>, busy: boolean): boolean {
  if (st.status !== 'ready' || st.stale || busy) return false;
  return st.backlog?.enabled ? st.backlog.detail === true : true;
}

/** The program that runs the backlog: every spec with where it stands, the run to follow and why one failed or waits. */
const fmtCost = (v: number) => `US$ ${v.toFixed(2)}`;

/** Polls a started backlog's program every 5 seconds, with the phase of each run in progress, until it finishes. */
export function useProgram(projectId: string, specId: string, enabled: boolean) {
  const [program, setProgram] = useState<ProgramView | null>(null);
  const [phases, setPhases] = useState<Record<string, number>>({});
  const live = enabled && program?.status !== 'finished';
  useEffect(() => {
    if (!live) return;
    const poll = () => refineApi.program(projectId, specId).then(async (r) => {
      setProgram(r.program);
      const runIds = (r.program?.items ?? []).flatMap((i) => (i.status === 'running' && i.runId ? [i.runId] : []));
      setPhases(Object.fromEntries(await Promise.all(runIds.map(async (id) => [id, (await runApi.run(id)).phase] as const))));
    }).catch(() => undefined);
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => clearInterval(timer);
  }, [live, projectId, specId]);
  return { program, phases, setProgram };
}

/** The backlog's item titles by key, read once from the refinement snapshot. */
export function useBacklogTitles(projectId: string, specId: string) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    refineApi.snapshot(projectId, specId).then((s) => setTitles(Object.fromEntries((s.state.backlog?.items ?? []).map((i) => [i.key, i.title])))).catch(() => undefined);
  }, [projectId, specId]);
  return titles;
}

/** A running backlog's status card with the way to its execution screen; nothing when the spec has no backlog or it finished. */
export function BacklogBanner({ projectId, specId }: { projectId: string; specId: string }) {
  const { program, phases } = useProgram(projectId, specId, true);
  const titles = useBacklogTitles(projectId, specId);
  if (!program || program.status === 'finished') return null;
  return <ProgramStatus program={program} titles={titles} phases={phases} link={`/refine/${projectId}/${specId}/program`} />;
}

/** The banner of a started backlog: a spinner while it runs, the progress, and each spec running now with its phase. */
export function ProgramStatus({ program, titles, phases, link }: { program: ProgramView | null; titles: Record<string, string>; phases: Record<string, number>; link?: string }) {
  const done = program?.items.filter((i) => i.status === 'done').length ?? 0;
  const total = program?.items.length ?? 0;
  const running = program?.status !== 'finished';
  const now = program?.items.filter((i) => i.status === 'running' || i.status === 'completing') ?? [];
  return (
    <div className="card grid gap-4 px-6 py-5 max-md:p-4" role="status">
      <div className="flex items-center gap-3">
        {running ? <span className="loading-spinner flex-none" aria-hidden="true" /> : <span className="grid size-5 flex-none place-items-center text-good" aria-hidden="true"><Icon name="check" size={18} /></span>}
        <b className="text-[1rem] text-ink">{!program ? 'Preparando a execução do backlog…' : `${running ? 'Executando o backlog' : 'Backlog executado'} · ${done} de ${total} concluídas`}</b>
      </div>
      {program && <progress className="h-2 w-full appearance-none overflow-hidden rounded-full border-0 bg-surface-muted [&::-moz-progress-bar]:bg-good-live [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-good-live" max={total} value={done} />}
      {(now.length > 0 || link) && (
        <div className="grid gap-2 text-[0.875rem] text-ink-soft [&_p]:m-0">
          {now.map((i) => (
            <p key={i.specId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="size-2 flex-none rounded-full bg-accent-text motion-safe:animate-pulse" aria-hidden="true" />
              <span>Agora: <b className="font-semibold text-ink">{titles[i.key] ?? i.key}</b>{i.runId && phases[i.runId] !== undefined && ` · ${phaseTitle(phases[i.runId]!)}`}</span>
              {i.runId && <>· <Link to={`/runs/${i.runId}`}>Acompanhar a run</Link></>}
            </p>
          ))}
          {link && <p className="mt-1"><Link to={link} className="link-button">Abrir a execução do backlog<Icon name="arrow-right" size={16} /></Link></p>}
        </div>
      )}
    </div>
  );
}

/** Every spec of the backlog in run order: its rank, title and run, where it stands, what it cost and what can be done. */
export function ProgramPanel({ program, titles, onPrioritize }: { program: ProgramView; titles: Record<string, string>; onPrioritize?: (specId: string) => unknown }) {
  const done = program.items.filter((i) => i.status === 'done').length;
  const totalCost = program.items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
  return (
    <section className={`${panel} gap-4`} data-testid="program-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className={sectionTitle}>
          <span className="grid size-6 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink" aria-hidden="true"><Icon name="list" size={14} /></span>
          <h2 className={`${sectionHeading} ml-1`}>Specs do backlog</h2>
          <InfoTip label="Execução do backlog" text={HELP} />
        </div>
        <p className="m-0 text-[0.8125rem] text-ink-soft tabular-nums">
          <span>{done} de {program.items.length} concluídas</span>
          {totalCost > 0 && <span data-testid="program-total-cost"> · {fmtCost(totalCost)}</span>}
        </p>
      </div>
      {program.status === 'finished' && <p className="hint m-0">Programa encerrado{program.items.some((i) => i.status === 'failed' || i.status === 'blocked') ? ': há specs que falharam ou ficaram bloqueadas.' : '.'}</p>}
      <ol className="-mx-3 my-0 list-none p-0">
        {[...program.items].sort((a, b) => a.rank - b.rank).map((i) => (
          <li key={i.specId} className={`${ROW} ${i.status === 'running' || i.status === 'completing' ? 'bg-accent-soft/40' : 'hover:bg-surface-sunken'}`} data-testid={`program-item-${i.key}`}>
            <span className="font-mono text-[0.8125rem] text-ink-faint tabular-nums">#{i.rank}</span>
            <div className="grid min-w-0 gap-1">
              <b className="font-semibold text-ink wrap-anywhere">{titles[i.key] ?? i.key}</b>
              {i.runId && <Link to={`/runs/${i.runId}`} className="w-fit max-w-full truncate font-mono text-[0.75rem] no-underline hover:underline">{i.runId}</Link>}
              {i.reason && <p className={`m-0 text-[0.8125rem] wrap-anywhere ${i.status === 'failed' || i.status === 'blocked' ? 'text-bad' : 'text-ink-soft'}`}>{i.reason}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-3 max-lg:col-start-2 lg:contents">
              <span className={`${PILL[i.status]} justify-self-start`}>{LABEL[i.status]}</span>
              <span className="text-right text-[0.8125rem] text-ink-soft tabular-nums lg:justify-self-end">
                {i.costUsd != null ? <span data-testid={`program-item-cost-${i.key}`}>{fmtCost(i.costUsd)}</span> : <span className="text-ink-faint" aria-hidden="true">—</span>}
              </span>
              <span className="flex lg:justify-self-end">
                {i.status === 'pending' && (i.priority ? <span className="status-chip tone-neutral">prioritária</span> : onPrioritize && <ActionButton className={action.secondary} onClick={() => onPrioritize(i.specId)} icon={<Icon name="play" size={14} />}>Executar agora</ActionButton>)}
                {i.status === 'failed' && onPrioritize && <ActionButton className={action.secondary} onClick={() => onPrioritize(i.specId)} icon={<Icon name="refresh" size={14} />}>Tentar de novo</ActionButton>}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
