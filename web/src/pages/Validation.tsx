import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { runApi, type Report, type RunDetail } from '../api.js';

const key = (runId: string) => `teams-ai:validation:${runId}`;
function readChecks(runId: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key(runId)) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}
function writeChecks(runId: string, checks: Record<string, boolean>): void {
  try {
    localStorage.setItem(key(runId), JSON.stringify(checks));
  } catch {
    /* per-viewer convenience only */
  }
}

export function ValidationView({ detail, specStatus, onReport, onComplete }: { detail: RunDetail; specStatus: string; onReport: (text: string) => void; onComplete: () => void }) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => readChecks(detail.runId));
  const [text, setText] = useState('');
  const report: Report | null = detail.report;
  const toggle = (id: string) => {
    const next = { ...checks, [id]: !checks[id] };
    setChecks(next);
    writeChecks(detail.runId, next);
  };
  const enabled = specStatus === 'awaiting-validation' && report?.result === 'awaiting-validation';
  const note = enabled ? null : specStatus === 'done' ? 'This spec is already done.' : report ? `Actions are unavailable: the run ended ${report.result} and the spec is ${specStatus}.` : 'Actions are unavailable until the run produces a report.';
  return (
    <main>
      <p>
        <Link to={`/runs/${detail.runId}`}>← Execution</Link> · <Link to="/projects">Projects</Link>
      </p>
      <h1>
        Validation <small className="hint">{detail.runId}</small>
      </h1>
      {!report ? (
        <p>No report yet — the run is in phase {detail.phase} ({detail.status}).</p>
      ) : (
        <>
          <section className="card">
            <h2>Service</h2>
            {report.service ? (
              <>
                <p>
                  <a data-testid="service-url" href={report.service.url} target="_blank" rel="noreferrer">
                    {report.service.url}
                  </a>{' '}
                  <span className="hint">healthcheck: {report.service.healthcheck}</span>
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>AC</th>
                      <th>Smoke test</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.service.smoke.map((s) => (
                      <tr key={s.acId} data-testid={`smoke-${s.acId}`} className={`test test-${s.status}`}>
                        <td>{s.acId}</td>
                        <td>{s.testId ?? '—'}</td>
                        <td>{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p data-testid="deploy-failure" className="error">
                Not deployed{report.deploy.lastFailure ? `: attempt ${report.deploy.lastFailure.attempt} failed at ${report.deploy.lastFailure.stage} — ${report.deploy.lastFailure.detail}${report.deploy.lastFailure.rolledBack ? ' (rolled back' + (report.deploy.lastFailure.rollbackHealthy === false ? ', previous version unhealthy)' : ')') : ''}` : ''} · {report.deploy.attempts} attempts
              </p>
            )}
          </section>
          <section className="card">
            <h2>Exploratory script</h2>
            {report.exploratoryScript.length === 0 ? <p className="hint">none</p> : null}
            {report.exploratoryScript.map((block) => (
              <div key={block.acId}>
                <h3>{block.acId}</h3>
                <ul>
                  {block.steps.map((s, i) => {
                    const id = `${block.acId}-${i}`;
                    return (
                      <li key={id}>
                        <label>
                          <input type="checkbox" data-testid={`step-${id}`} checked={Boolean(checks[id])} onChange={() => toggle(id)} /> {s}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
          <section className="card">
            <h2>Assumptions</h2>
            <ul data-testid="assumptions">{report.assumptions.length ? report.assumptions.map((a, i) => <li key={i}>{a}</li>) : <li className="hint">none</li>}</ul>
          </section>
          <section className="card">
            <h2>Blocked tasks</h2>
            <ul>{report.blocked.length ? report.blocked.map((b) => <li key={b.taskId} data-testid={`blocked-${b.taskId}`}><strong>{b.taskId}</strong>: {b.reason}</li>) : <li className="hint">none</li>}</ul>
          </section>
          {report.securityFindings?.length ? (
            <section className="card">
              <h2>Security</h2>
              <ul data-testid="security-findings">
                {report.securityFindings.map((f, i) => (
                  <li key={i} data-testid={`security-${i}`}>
                    <strong>[{f.severity}]</strong> {f.taskId ? `${f.taskId} · ` : ''}{f.file}{f.line === null ? '' : `:${f.line}`} · {f.category}: {f.problem} <span className="hint">Fix: {f.fix}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="card">
            <h2>Evidence</h2>
            <table>
              <thead>
                <tr>
                  <th>AC</th>
                  <th>Tasks</th>
                  <th>Tests</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {report.evidence.map((r) => (
                  <tr key={r.criterion} data-testid={`evidence-${r.criterion}`} className={`test test-${r.status}`}>
                    <td>{r.criterion}</td>
                    <td>{r.tasks.join(', ')}</td>
                    <td>{r.tests.join(', ') || '—'}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card">
            <h2>Summary</h2>
            <p>{report.summary}</p>
            <p className="hint">
              ${report.tokens.total.costUsd.toFixed(2)} · {report.tokens.total.inputTokens} in / {report.tokens.total.outputTokens} out
            </p>
          </section>
        </>
      )}
      <section className="card">
        <h2>Actions</h2>
        {note ? <p data-testid="actions-note" className="hint">{note}</p> : null}
        <textarea data-testid="problem-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="What went wrong? This reopens refinement with your report." disabled={!enabled} />
        <p className="controls">
          <button data-testid="report-problem" disabled={!enabled || text.trim() === ''} onClick={() => onReport(text.trim())}>
            Report problem
          </button>
          <button data-testid="complete-spec" disabled={!enabled} onClick={onComplete}>
            Complete spec
          </button>
        </p>
      </section>
    </main>
  );
}

export function ValidationPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [specStatus, setSpecStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const load = async () => {
    if (!runId) return;
    const d = await runApi.run(runId);
    setDetail(d);
    const projects = await runApi.projects();
    setSpecStatus(projects.find((p) => p.projectId === d.projectId)?.specs.find((s) => s.specId === d.specId)?.status ?? '');
  };
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [runId]);
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => load().catch(() => undefined), 5000);
    return () => clearInterval(id);
  }, [polling]);
  useEffect(() => {
    if (specStatus === 'done') setPolling(false);
  }, [specStatus]);
  if (error) return <main><p className="error">{error}</p></main>;
  if (!detail) return <main><p>Loading…</p></main>;
  return (
    <ValidationView
      detail={detail}
      specStatus={specStatus}
      onReport={(text) => {
        runApi
          .reportProblem(detail.projectId, detail.specId, text)
          .then(() => navigate(`/refine/${detail.projectId}/${detail.specId}`))
          .catch((e: Error) => setError(e.message));
      }}
      onComplete={() => {
        runApi
          .complete(detail.projectId, detail.specId)
          .then(() => setPolling(true))
          .catch((e: Error) => setError(e.message));
      }}
    />
  );
}
