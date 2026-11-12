import type { StoredEvent } from '../api.js';
import { safeHttpUrl } from '../safeUrl.js';
import { taskDetail } from '../run/selectors.js';
import { StepList } from './StepList.js';

/** The pull request and the attempts of one task, shown inside the task dialog. */
export function TaskDetail({ events, taskId, loadStep }: { events: StoredEvent[]; taskId: string; loadStep: (stepId: string) => Promise<{ prompt: string; output: unknown }> }) {
  const d = taskDetail(events, taskId);
  return (
    <div data-testid={`detail-${taskId}`} className="grid gap-5">
      {d.pr || d.lockHeld ? (
        <p className="m-0 flex flex-wrap gap-x-3" data-testid="task-detail-links">
          {d.pr ? (
            safeHttpUrl(d.pr.url) ? (
              <a href={safeHttpUrl(d.pr.url)} target="_blank" rel="noreferrer" data-testid="task-detail-pr-link">
                PR #{d.pr.number}
              </a>
            ) : (
              <span data-testid="task-detail-pr-text">PR #{d.pr.number}</span>
            )
          ) : null}
          {d.lockHeld ? <span className="hint" data-testid="task-detail-lock-hint">mantém o bloqueio de mesclagem</span> : null}
        </p>
      ) : null}
      {d.attempts.length ? null : <p className="hint m-0" data-testid="task-detail-empty">Nenhuma tentativa registrada ainda.</p>}
      {d.attempts.map((a) => (
        <div key={a.attempt} data-testid={`attempt-${a.attempt}`}>
          <h3 className="mt-0" data-testid={`task-detail-attempt-title-${a.attempt}`}>Tentativa {a.attempt}</h3>
          <StepList steps={a.steps} loadStep={loadStep} />
          {a.gates.length ? (
            <p className="gates m-0 mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1.5" data-testid={`task-detail-gates-${a.attempt}`}>
              <span className="hint" data-testid={`task-detail-gates-label-${a.attempt}`}>Portões:</span>{' '}
              {a.gates.map((g) => (
                <span key={g.gate} className={`test m-0 test-${g.passed ? 'passed' : 'failed'}`} title={g.failedTests.length ? g.failedTests.join(', ') : undefined} data-testid={`task-detail-gate-${a.attempt}-${g.gate}`}>
                  {g.gate} {g.passed ? 'passou' : 'falhou'}
                  {g.failedTests.length ? ` (${g.failedTests.length})` : ''}
                </span>
              ))}
            </p>
          ) : null}
          {a.review ? (
            <p data-testid={`task-detail-review-${a.attempt}`}>
              Revisão: perfil {a.review.profile}, risco {a.review.risk}
              {a.review.drift ? `, desvio ${a.review.drift}` : ''}
              {a.review.findings.length ? `, ${a.review.findings.length} apontamento(s)` : ', aprovada'}
            </p>
          ) : null}
          {a.security ? (
            <div data-testid={`security-${a.attempt}`}>
              <p data-testid={`task-detail-security-summary-${a.attempt}`}>
                Segurança: {a.security.findings.length ? `${a.security.findings.length} apontamento(s)` : 'aprovada'}
              </p>
              {a.security.findings.length ? (
                <ul data-testid={`task-detail-security-findings-${a.attempt}`}>
                  {a.security.findings.map((f, i) => (
                    <li key={i} data-testid={`task-detail-security-finding-${a.attempt}-${f.file}-${f.category}`}>
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
    </div>
  );
}
