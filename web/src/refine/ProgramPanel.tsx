import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { refineApi, runApi, type ProgramView, type RefineState } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { phaseTitle } from '../run/selectors.js';
import { bkChip, bkMeta, bkTone } from './BacklogPanel.js';

const HELP = 'Depois do início, os agentes executam o backlog inteiro sozinhos, na ordem de prioridade e de dependência, até duas specs ao mesmo tempo quando elas não mexem no mesmo código: planejam, implementam, testam, publicam e marcam cada spec como concluída. Uma spec que falha é isolada e só bloqueia as que dependem dela; as demais seguem. Executar agora passa uma spec à frente da fila.';

const LABEL = { pending: 'na fila', running: 'em execução', completing: 'concluindo', done: 'concluída', failed: 'falhou', blocked: 'bloqueada' } as const;
const TONE = { pending: bkTone.refining, running: bkTone.P0, completing: bkTone.P0, done: bkTone.planned, failed: bkTone.error, blocked: bkTone.error } as const;

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

/** The banner of a started backlog: a spinner while it runs, the progress, and each spec running now with its phase. */
export function ProgramStatus({ program, titles, phases, link }: { program: ProgramView | null; titles: Record<string, string>; phases: Record<string, number>; link?: string }) {
  const done = program?.items.filter((i) => i.status === 'done').length ?? 0;
  const total = program?.items.length ?? 0;
  const running = program?.status !== 'finished';
  const now = program?.items.filter((i) => i.status === 'running' || i.status === 'completing') ?? [];
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-surface px-4 py-[0.85rem]" role="status">
      {running && <span className="loading-spinner mt-[0.15rem] flex-none" aria-hidden="true" />}
      <div className="grid flex-1 gap-[0.4rem] [&_p]:m-0 [&_p]:text-[0.8125rem] [&_p]:text-ink-soft">
        <b>{!program ? 'Preparando a execução do backlog…' : `${running ? 'Executando o backlog' : 'Backlog executado'} · ${done} de ${total} concluídas`}</b>
        {program && <progress className="h-2 w-full appearance-none overflow-hidden rounded-full border-0 bg-surface-muted [&::-moz-progress-bar]:bg-good-live [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:bg-good-live" max={total} value={done} />}
        {now.map((i) => (
          <p key={i.specId}>
            Agora: {titles[i.key] ?? i.key}{i.runId && phases[i.runId] !== undefined && ` · ${phaseTitle(phases[i.runId]!)}`}
            {i.runId && <> · <Link to={`/runs/${i.runId}`}>Acompanhar a run</Link></>}
          </p>
        ))}
        {link && <p><Link to={link}>Abrir a execução do backlog</Link></p>}
      </div>
    </div>
  );
}

export function ProgramPanel({ program, titles, onPrioritize }: { program: ProgramView; titles: Record<string, string>; onPrioritize?: (specId: string) => void }) {
  const done = program.items.filter((i) => i.status === 'done').length;
  const totalCost = program.items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
  return (
    <div className="program-panel my-4 grid gap-3" data-testid="program-panel">
      <h4 className="m-0 flex items-center gap-2">
        <Icon name="play" size={20} />Execução do backlog · {done} de {program.items.length} concluídas
        {totalCost > 0 && <span className={bkMeta} data-testid="program-total-cost"> · {fmtCost(totalCost)}</span>}
        <InfoTip text={HELP} />
      </h4>
      {program.status === 'finished' && <p className="text-[0.8125rem] text-ink-soft">Programa encerrado{program.items.some((i) => i.status === 'failed' || i.status === 'blocked') ? ': há specs que falharam ou ficaram bloqueadas.' : '.'}</p>}
      <ol className="m-0 grid list-none gap-[0.4rem] p-0">
        {[...program.items].sort((a, b) => a.rank - b.rank).map((i) => (
          <li key={i.specId} className="rounded-md border border-line bg-surface" data-testid={`program-item-${i.key}`}>
            <div className="program-row">
              <span className={`${bkChip} ${TONE[i.status]}`}>{LABEL[i.status]}</span>
              <b>{titles[i.key] ?? i.key}</b>
              <span className={bkMeta}>#{i.rank}</span>
              {i.costUsd != null && <span className={bkMeta} data-testid={`program-item-cost-${i.key}`}>{fmtCost(i.costUsd)}</span>}
              {i.runId && <Link to={`/runs/${i.runId}`}>{i.runId}</Link>}
              {i.status === 'pending' && (i.priority ? <span className={`${bkChip} ${bkTone.P0}`}>prioritária</span> : onPrioritize && <button type="button" className="secondary" onClick={() => onPrioritize(i.specId)}>Executar agora</button>)}
              {i.status === 'failed' && onPrioritize && <button type="button" className="secondary" onClick={() => onPrioritize(i.specId)}>Tentar de novo</button>}
            </div>
            {i.reason && <p>{i.reason}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
