import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { refineApi, runApi, type ProgramView, type RefineState } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { phaseTitle } from '../run/selectors.js';
import './backlog.css';

const HELP = 'Depois do início, os agentes executam o backlog inteiro sozinhos, uma spec por vez, na ordem de prioridade e de dependência: planejam, implementam, testam, publicam e marcam cada spec como concluída. Uma spec que falha é isolada e só bloqueia as que dependem dela; as demais seguem. Acompanhe cada execução pelo link da run.';

const LABEL = { pending: 'na fila', running: 'em execução', completing: 'concluindo', done: 'concluída', failed: 'falhou', blocked: 'bloqueada' } as const;
const CLASS = { pending: 'bk-refining', running: 'bk-p0', completing: 'bk-p0', done: 'bk-planned', failed: 'bk-error', blocked: 'bk-error' } as const;

/** Can the refinement start a run: one spec when ready, a backlog only once it is detailed (the program runs its planned specs). */
export function canStartRun(st: Pick<RefineState, 'status' | 'stale' | 'backlog'>, busy: boolean): boolean {
  if (st.status !== 'ready' || st.stale || busy) return false;
  return st.backlog?.enabled ? st.backlog.detail === true : true;
}

/** The program that runs the backlog: every spec with where it stands, the run to follow and why one failed or waits. */
const fmtCost = (v: number) => `US$ ${v.toFixed(2)}`;

/** Polls a started backlog's program every 5 seconds, with the phase of the spec running now, until it finishes. */
export function useProgram(projectId: string, specId: string, enabled: boolean) {
  const [program, setProgram] = useState<ProgramView | null>(null);
  const [phase, setPhase] = useState<number | null>(null);
  const live = enabled && program?.status !== 'finished';
  useEffect(() => {
    if (!live) return;
    const poll = () => refineApi.program(projectId, specId).then(async (r) => {
      setProgram(r.program);
      const runId = r.program?.items.find((i) => i.status === 'running')?.runId;
      setPhase(runId ? (await runApi.run(runId)).phase : null);
    }).catch(() => undefined);
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => clearInterval(timer);
  }, [live, projectId, specId]);
  return { program, phase };
}

/** The banner of a started backlog: a spinner while it runs, the progress, and the spec and phase running now. */
export function ProgramStatus({ program, titles, phase, link }: { program: ProgramView | null; titles: Record<string, string>; phase: number | null; link?: string }) {
  const done = program?.items.filter((i) => i.status === 'done').length ?? 0;
  const total = program?.items.length ?? 0;
  const running = program?.status !== 'finished';
  const now = program?.items.find((i) => i.status === 'running' || i.status === 'completing');
  return (
    <div className="program-status" role="status">
      {running && <span className="loading-spinner" aria-hidden="true" />}
      <div>
        <b>{!program ? 'Preparando a execução do backlog…' : `${running ? 'Executando o backlog' : 'Backlog executado'} · ${done} de ${total} concluídas`}</b>
        {program && <progress max={total} value={done} />}
        {now && (
          <p>
            Agora: {titles[now.key] ?? now.key}{phase !== null && ` · ${phaseTitle(phase)}`}
            {now.runId && <> · <Link to={`/runs/${now.runId}`}>Acompanhar a run</Link></>}
          </p>
        )}
        {link && <p><Link to={link}>Abrir a execução do backlog</Link></p>}
      </div>
    </div>
  );
}

export function ProgramPanel({ program, titles }: { program: ProgramView; titles: Record<string, string> }) {
  const done = program.items.filter((i) => i.status === 'done').length;
  const totalCost = program.items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
  return (
    <div className="backlog-panel program-panel" data-testid="program-panel">
      <h4>
        <Icon name="play" size={20} />Execução do backlog · {done} de {program.items.length} concluídas
        {totalCost > 0 && <span className="bk-meta" data-testid="program-total-cost"> · {fmtCost(totalCost)}</span>}
        <InfoTip text={HELP} />
      </h4>
      {program.status === 'finished' && <p className="muted">Programa encerrado{program.items.some((i) => i.status === 'failed' || i.status === 'blocked') ? ': há specs que falharam ou ficaram bloqueadas.' : '.'}</p>}
      <ol className="backlog-items">
        {[...program.items].sort((a, b) => a.rank - b.rank).map((i) => (
          <li key={i.specId} className="backlog-item" data-testid={`program-item-${i.key}`}>
            <div className="program-row">
              <span className={`bk-chip ${CLASS[i.status]}`}>{LABEL[i.status]}</span>
              <b>{titles[i.key] ?? i.key}</b>
              <span className="bk-meta">#{i.rank}</span>
              {i.costUsd != null && <span className="bk-meta" data-testid={`program-item-cost-${i.key}`}>{fmtCost(i.costUsd)}</span>}
              {i.runId && <Link to={`/runs/${i.runId}`}>{i.runId}</Link>}
            </div>
            {i.reason && <p className="bk-issue">{i.reason}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
