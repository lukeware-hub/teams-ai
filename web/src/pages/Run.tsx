import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { runApi, type RunDetail, type StoredEvent } from '../api.js';
import { TaskDetail } from '../components/TaskDetail.js';
import { evidence, pausedUntil, phases, runState, tokens } from '../run/selectors.js';
import { useJournal } from '../useSse.js';

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const money = (n: number) => `US$ ${n.toFixed(4)}`;
const ORDER = ['implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'ready', 'planned', 'merged', 'blocked', 'superseded'];
const statusLabel = (status: string) => ({ done: 'concluído', complete: 'concluído', failed: 'falhou', implementing: 'implementando', validating: 'validando', reviewing: 'revisando', rebasing: 'rebaseando', merging: 'mesclando', ready: 'pronta', planned: 'planejada', merged: 'mesclada', blocked: 'bloqueada', superseded: 'substituída', running: 'em execução' } as Record<string, string>)[status] ?? status;
const statusTone = (status: string) => (['done', 'complete', 'merged'].includes(status) ? 'good' : ['blocked', 'failed'].includes(status) ? 'bad' : status.startsWith('paused') ? 'warn' : status === 'running' ? 'neutral' : 'neutral');

export function RunView({ detail, events, ended, error, loadStep }: { detail: RunDetail; events: StoredEvent[]; ended: boolean; error: string | null; loadStep: (stepId: string) => Promise<{ prompt: string; output: unknown }> }) {
  const unique = events.filter((e, i) => events.findIndex((x) => x.seq === e.seq) === i);
  const state = runState(unique);
  const finished = [...unique].reverse().find((e) => e.type === 'RUN_FINISHED');
  // The journal wins while it streams; before the first event and after the stream ends the server's snapshot is authoritative.
  const status = finished ? String(finished.data.result) : ended || unique.length === 0 ? detail.status : state.status;
  const until = pausedUntil(unique);
  const t = tokens(unique);
  const [selected, setSelected] = useState<string | null>(null);
  const groups = ORDER.map((s) => [s, state.order.filter((id) => state.tasks.get(id)!.state === s)] as const).filter(([, ids]) => ids.length);
  return (
    <main>
      <p>
        <Link to="/projects">← Projetos</Link>
      </p>
      <h1>
        {detail.runId}{' '}
        <small className="hint">
          {detail.projectId} / {detail.specId}
        </small>
      </h1>
      <div className="run-meta">
        <span data-testid="status" className={`status-pill tone-${statusTone(status)}`}>
          {statusLabel(status)}
          {ended ? ' (encerrada)' : ''}
        </span>
        {until ? <span data-testid="paused-until" className="hint">pausada até {hhmm(until)}</span> : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      <section className="card">
        <h2>Fases</h2>
        <p>
          {phases(unique).map((p) => (
            <span key={p.phase} data-testid="phase" className={`phase phase-${p.result}`}>
              {p.phase} {statusLabel(p.result)}
            </span>
          ))}
        </p>
      </section>
      <section className="card">
        <h2>Tarefas</h2>
        {groups.map(([s, ids]) => (
          <div key={s} className="task-group" data-testid={`group-${s}`}>
            <h3>{statusLabel(s)}</h3>
            <ul>
              {ids.map((id) => {
                const tk = state.tasks.get(id)!;
                return (
                  <li key={id} className="task-row">
                    <button className="task-id" data-testid={`task-${id}`} onClick={() => setSelected(id)}>
                      {id}
                    </button>
                    <span className="task-title">{tk.def.title}</span>
                    <span className="task-meta">
                      tentativas {tk.attempts}
                      {tk.replanned ? ' · replanejada' : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
      {selected ? <TaskDetail events={unique} taskId={selected} loadStep={loadStep} /> : null}
      <section className="card">
        <h2>Tokens</h2>
        <table>
          <thead>
            <tr>
              <th>Papel</th>
              <th className="num">Entrada</th>
              <th className="num">Saída</th>
              <th className="num">Custo</th>
              <th className="num">Etapas</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(t.byRole).map(([r, u]) => (
              <tr key={r} data-testid={`tokens-${r}`}>
                <td>{r}</td>
                <td className="num">{u.inputTokens}</td>
                <td className="num">{u.outputTokens}</td>
                <td className="num">{money(u.costUsd)}</td>
                <td className="num">{u.steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table>
          <thead>
            <tr>
              <th>Fase</th>
              <th className="num">Entrada</th>
              <th className="num">Saída</th>
              <th className="num">Custo</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(t.byPhase).map(([p, u]) => (
              <tr key={p}>
                <td>{p}</td>
                <td className="num">{u.inputTokens}</td>
                <td className="num">{u.outputTokens}</td>
                <td className="num">{money(u.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="tokens-total">
          Total de <strong>{money(t.total.costUsd)}</strong> em {t.total.steps} etapas
        </p>
      </section>
      <section className="card">
        <h2>Evidências</h2>
        <table>
          <thead>
            <tr>
              <th>AC</th>
              <th>Testes</th>
            </tr>
          </thead>
          <tbody>
            {evidence(
              unique,
              detail.acceptanceCriteria.map((a) => a.id),
            ).map((row) => (
              <tr key={row.acId} data-testid={`evidence-${row.acId}`}>
                <td>{row.acId}</td>
                <td>
                  {row.tests.length ? (
                    row.tests.map((x) => (
                      <span key={x.id} className={`test test-${x.status}`}>
                        {x.id} ({x.status}, {x.taskId})
                      </span>
                    ))
                  ) : (
                    <span className="hint">nenhum teste</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

export function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (runId)
      runApi
        .run(runId)
        .then(setDetail)
        .catch((e: Error) => setLoadError(e.message));
  }, [runId]);
  const { events, ended, error } = useJournal(runId && detail ? runApi.runEvents(runId) : null);
  if (loadError)
    return (
      <main>
        <p className="error">{loadError}</p>
      </main>
    );
  if (!detail || !runId)
    return (
      <main>
        <p>Carregando…</p>
      </main>
    );
  return <RunView detail={detail} events={events} ended={ended} error={error} loadStep={(stepId) => runApi.step(runId, stepId)} />;
}
