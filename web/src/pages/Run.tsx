import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { runApi, type RunDetail, type StoredEvent } from '../api.js';
import { TaskDetail } from '../components/TaskDetail.js';
import { evidence, pausedUntil, phases, runState, tokens } from '../run/selectors.js';
import { useJournal } from '../useSse.js';

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const ORDER = ['implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'ready', 'planned', 'merged', 'blocked', 'superseded'];

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
        <Link to="/projects">← Projects</Link>
      </p>
      <h1>
        {detail.runId}{' '}
        <small className="hint">
          {detail.projectId} / {detail.specId}
        </small>
      </h1>
      <p data-testid="status">
        Status: <strong>{status}</strong>
        {ended ? ' (ended)' : ''}
        {until ? <span data-testid="paused-until"> — paused until {hhmm(until)}</span> : null}
      </p>
      {error ? <p className="error">{error}</p> : null}
      <section className="card">
        <h2>Phases</h2>
        <p>
          {phases(unique).map((p) => (
            <span key={p.phase} data-testid="phase" className={`phase phase-${p.result}`}>
              {p.phase} {p.result}
            </span>
          ))}
        </p>
      </section>
      <section className="card">
        <h2>Tasks</h2>
        {groups.map(([s, ids]) => (
          <div key={s} data-testid={`group-${s}`}>
            <h3>{s}</h3>
            <ul>
              {ids.map((id) => {
                const tk = state.tasks.get(id)!;
                return (
                  <li key={id}>
                    <button data-testid={`task-${id}`} onClick={() => setSelected(id)}>
                      {id}
                    </button>{' '}
                    {tk.def.title} · attempts {tk.attempts}
                    {tk.replanned ? ' · replanned' : ''}
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
              <th>Role</th>
              <th>In</th>
              <th>Out</th>
              <th>Cost</th>
              <th>Steps</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(t.byRole).map(([r, u]) => (
              <tr key={r} data-testid={`tokens-${r}`}>
                <td>{r}</td>
                <td>{u.inputTokens}</td>
                <td>{u.outputTokens}</td>
                <td>${u.costUsd.toFixed(4)}</td>
                <td>{u.steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table>
          <thead>
            <tr>
              <th>Phase</th>
              <th>In</th>
              <th>Out</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(t.byPhase).map(([p, u]) => (
              <tr key={p}>
                <td>{p}</td>
                <td>{u.inputTokens}</td>
                <td>{u.outputTokens}</td>
                <td>${u.costUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Total ${t.total.costUsd.toFixed(4)} over {t.total.steps} steps
        </p>
      </section>
      <section className="card">
        <h2>Evidence</h2>
        <table>
          <thead>
            <tr>
              <th>AC</th>
              <th>Tests</th>
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
                    <span className="hint">no test</span>
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
        <p>Loading…</p>
      </main>
    );
  return <RunView detail={detail} events={events} ended={ended} error={error} loadStep={(stepId) => runApi.step(runId, stepId)} />;
}
