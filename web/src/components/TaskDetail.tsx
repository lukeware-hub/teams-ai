import type { StoredEvent } from '../api.js';
import { safeHttpUrl } from '../safeUrl.js';
import { explainBlockReason, taskDetail } from '../run/selectors.js';
import { StepList } from './StepList.js';

export function TaskDetail({ events, taskId, loadStep }: { events: StoredEvent[]; taskId: string; loadStep: (stepId: string) => Promise<{ prompt: string; output: unknown }> }) {
  const d = taskDetail(events, taskId);
  return (
    <section className="card" data-testid={`detail-${taskId}`}>
      <header>
        <h2>{taskId}</h2>
        {d.pr ? (
          safeHttpUrl(d.pr.url) ? (
            <a href={safeHttpUrl(d.pr.url)} target="_blank" rel="noreferrer">
              PR #{d.pr.number}
            </a>
          ) : (
            <span>PR #{d.pr.number}</span>
          )
        ) : null}
        {d.lockHeld ? <span className="hint">mantém o bloqueio de mesclagem</span> : null}
      </header>
      {d.blockedReason ? <p className="error">Bloqueada: {explainBlockReason(d.blockedReason)}</p> : null}
      {d.attempts.map((a) => (
        <div key={a.attempt} data-testid={`attempt-${a.attempt}`}>
          <h3>Tentativa {a.attempt}</h3>
          <StepList steps={a.steps} loadStep={loadStep} />
          {a.gates.length ? (
            <p className="gates">
              <span className="hint">Portões:</span>{' '}
              {a.gates.map((g) => (
                <span key={g.gate} className={`test test-${g.passed ? 'passed' : 'failed'}`} title={g.failedTests.length ? g.failedTests.join(', ') : undefined}>
                  {g.gate} {g.passed ? 'passou' : 'falhou'}
                  {g.failedTests.length ? ` (${g.failedTests.length})` : ''}
                </span>
              ))}
            </p>
          ) : null}
          {a.review ? (
            <p>
              Revisão: perfil {a.review.profile}, risco {a.review.risk}
              {a.review.drift ? `, desvio ${a.review.drift}` : ''}
              {a.review.findings.length ? `, ${a.review.findings.length} apontamento(s)` : ', aprovada'}
            </p>
          ) : null}
          {a.security ? (
            <div data-testid={`security-${a.attempt}`}>
              <p>
                Segurança: {a.security.findings.length ? `${a.security.findings.length} apontamento(s)` : 'aprovada'}
              </p>
              {a.security.findings.length ? (
                <ul>
                  {a.security.findings.map((f, i) => (
                    <li key={i}>
                      [{f.severity}] {f.file}
                      {f.line === null ? '' : `:${f.line}`} {f.category}: {f.problem}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
