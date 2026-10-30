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
        <p className="m-0 flex flex-wrap gap-x-3">
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
        </p>
      ) : null}
      {d.attempts.length ? null : <p className="hint m-0">Nenhuma tentativa registrada ainda.</p>}
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
    </div>
  );
}
