import { Link } from 'react-router-dom';
import type { ProgramView, RefineState } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
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
export function ProgramPanel({ program, titles }: { program: ProgramView; titles: Record<string, string> }) {
  const done = program.items.filter((i) => i.status === 'done').length;
  return (
    <div className="backlog-panel program-panel" data-testid="program-panel">
      <h4><Icon name="play" size={20} />Execução do backlog · {done} de {program.items.length} concluídas<InfoTip text={HELP} /></h4>
      {program.status === 'finished' && <p className="muted">Programa encerrado{program.items.some((i) => i.status === 'failed' || i.status === 'blocked') ? ': há specs que falharam ou ficaram bloqueadas.' : '.'}</p>}
      <ol className="backlog-items">
        {[...program.items].sort((a, b) => a.rank - b.rank).map((i) => (
          <li key={i.specId} className="backlog-item" data-testid={`program-item-${i.key}`}>
            <div className="program-row">
              <span className={`bk-chip ${CLASS[i.status]}`}>{LABEL[i.status]}</span>
              <b>{titles[i.key] ?? i.key}</b>
              <span className="bk-meta">#{i.rank}</span>
              {i.runId && <Link to={`/runs/${i.runId}`}>{i.runId}</Link>}
            </div>
            {i.reason && <p className="bk-issue">{i.reason}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
