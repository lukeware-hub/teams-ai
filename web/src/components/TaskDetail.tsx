import { useState } from 'react';
import type { StoredEvent } from '../api.js';
import { taskDetail } from '../run/selectors.js';

type Artifact = { prompt: string; output: unknown };

export function TaskDetail({ events, taskId, loadStep }: { events: StoredEvent[]; taskId: string; loadStep: (stepId: string) => Promise<Artifact> }) {
  const d = taskDetail(events, taskId);
  const [open, setOpen] = useState<Record<string, Artifact | 'loading'>>({});
  const toggle = async (stepId: string) => {
    if (open[stepId]) {
      setOpen((o) => {
        const n = { ...o };
        delete n[stepId];
        return n;
      });
      return;
    }
    setOpen((o) => ({ ...o, [stepId]: 'loading' }));
    const art = await loadStep(stepId);
    setOpen((o) => ({ ...o, [stepId]: art }));
  };
  return (
    <section className="card" data-testid={`detail-${taskId}`}>
      <header>
        <h2>{taskId}</h2>
        {d.pr ? (
          <a href={d.pr.url} target="_blank" rel="noreferrer">
            PR #{d.pr.number}
          </a>
        ) : null}
        {d.lockHeld ? <span className="hint">holds merge lock</span> : null}
      </header>
      {d.blockedReason ? <p className="error">Blocked: {d.blockedReason}</p> : null}
      {d.attempts.map((a) => (
        <div key={a.attempt} data-testid={`attempt-${a.attempt}`}>
          <h3>Attempt {a.attempt}</h3>
          <ul>
            {a.steps.map((s) => {
              const art = open[s.stepId];
              return (
                <li key={s.stepId}>
                  <button data-testid={`step-${s.stepId}`} onClick={() => void toggle(s.stepId)}>
                    {s.stepId}
                  </button>{' '}
                  {s.kind} · {s.role}
                  {s.tier ? ` · ${s.tier}` : ''} · {s.ok === null ? 'running' : s.ok ? 'ok' : `failed (${s.failure})`}
                  {s.usage ? ` · ${s.usage.inputTokens + s.usage.outputTokens} tokens` : ''}
                  {art && art !== 'loading' ? (
                    <pre className="output">
                      {art.prompt}
                      {'\n---\n'}
                      {JSON.stringify(art.output, null, 2)}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {a.gates.length ? <p>Gates: {a.gates.map((g) => `${g.gate} ${g.passed ? 'passed' : 'failed'}${g.failedTests.length ? ` (${g.failedTests.join(', ')})` : ''}`).join(' · ')}</p> : null}
          {a.review ? (
            <p>
              Review: {a.review.profile} profile, risk {a.review.risk}
              {a.review.drift ? `, drift ${a.review.drift}` : ''}
              {a.review.findings.length ? `, ${a.review.findings.length} finding(s)` : ', approved'}
            </p>
          ) : null}
        </div>
      ))}
    </section>
  );
}
