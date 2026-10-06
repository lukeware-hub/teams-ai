import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { runApi, type AcceptanceCriterion, type Report, type RunDetail } from '../api.js';
import { InfoTip } from '../components/InfoTip.js';

/** Run and spec statuses in the words the Run page uses for them. */
const STATUS_LABEL: Record<string, string> = {
  running: 'em execução',
  draining: 'finalizando',
  interrupted: 'interrompida',
  done: 'concluída',
  failed: 'falhou',
  deadlocked: 'travada',
  refining: 'em refinamento',
  'paused:quota': 'pausada por cota',
  'paused:auth': 'pausada por autenticação',
  'awaiting-validation': 'aguardando validação',
  'deploy-failed': 'deploy falhou',
  'verification-failed': 'verificação falhou',
  'phase-failed': 'fase falhou',
};
const statusLabel = (status: string) => STATUS_LABEL[status] ?? status;
const RESULT: Record<string, { label: string; tone: string }> = {
  passed: { label: 'Passou', tone: 'tone-good' },
  failed: { label: 'Falhou', tone: 'tone-bad' },
  blocked: { label: 'Bloqueado', tone: 'tone-bad' },
  missing: { label: 'Sem teste', tone: 'tone-warn' },
  'not-applicable': { label: 'Não se aplica', tone: '' },
};
function ResultChip({ status }: { status: string }) {
  const r = RESULT[status];
  return <span className={`status-chip ${r?.tone ?? ''}`}>{r?.label ?? status}</span>;
}
const SEVERITY: Record<string, { label: string; tone: string }> = {
  critical: { label: 'Gravidade crítica', tone: 'tone-bad' },
  high: { label: 'Gravidade alta', tone: 'tone-bad' },
  medium: { label: 'Gravidade média', tone: 'tone-warn' },
  low: { label: 'Gravidade baixa', tone: '' },
};
const healthText = (text: string) => text.replace(/^HTTP (\d+) after (\d+) attempts$/, (_, code: string, n: string) => `HTTP ${code} na ${n}ª tentativa`);
const criterionText = (c: AcceptanceCriterion) => `Dado ${c.given}, quando ${c.when}, então ${c.then}`;
function deployFailure(deploy: Report['deploy']): string {
  const f = deploy.lastFailure;
  const rollback = !f?.rolledBack ? '' : f.rollbackHealthy === false ? ' (versão anterior restaurada, mas sem resposta)' : ' (versão anterior restaurada)';
  const failure = f ? `: a tentativa ${f.attempt} falhou na etapa “${f.stage}” — ${f.detail}${rollback}` : '';
  return `Não publicado${failure} · ${deploy.attempts} ${deploy.attempts === 1 ? 'tentativa' : 'tentativas'}`;
}

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

export function ValidationView({ detail, specStatus, actionError = null, onReport, onComplete }: { detail: RunDetail; specStatus: string; actionError?: string | null; onReport: (text: string) => void; onComplete: () => void }) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => readChecks(detail.runId));
  const [text, setText] = useState('');
  const report: Report | null = detail.report;
  const toggle = (id: string) => {
    const next = { ...checks, [id]: !checks[id] };
    setChecks(next);
    writeChecks(detail.runId, next);
  };
  const enabled = specStatus === 'awaiting-validation' && report?.result === 'awaiting-validation';
  const specState = specStatus ? ` e a especificação está “${statusLabel(specStatus)}”` : '';
  const note = enabled ? null : specStatus === 'done' ? 'Esta especificação já foi concluída.' : report ? `Ações indisponíveis: a execução terminou como “${statusLabel(report.result)}”${specState}.` : 'As ações ficam disponíveis quando a execução gerar o relatório.';
  return (
    <main>
      <p>
        <Link to={`/runs/${detail.runId}`}>← Execução</Link> · <Link to="/projects">Projetos</Link>
      </p>
      <h1>
        Validação <small className="hint">{detail.runId}</small>
      </h1>
      <p className="hint">Confira o serviço publicado e siga o roteiro de teste. Depois, conclua a especificação ou relate um problema.</p>
      {!report ? (
        <p>Ainda não há relatório: a execução está na fase {detail.phase} ({statusLabel(detail.status)}).</p>
      ) : (
        <>
          <section className="card">
            <h2>Serviço publicado</h2>
            {report.service ? (
              <>
                <p>
                  <a data-testid="service-url" href={report.service.url} target="_blank" rel="noreferrer">
                    {report.service.url}
                  </a>{' '}
                  <span className="hint">Verificação de saúde: {healthText(report.service.healthcheck)}</span>{' '}
                  <InfoTip text="Chamada automática feita logo após a publicação para confirmar que o serviço está no ar e respondendo." />
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Critério</th>
                      <th>Teste rápido <InfoTip text="Smoke test: teste automático curto, rodado no serviço publicado, que confirma o essencial de cada critério." /></th>
                      <th>Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.service.smoke.map((s) => (
                      <tr key={s.acId} data-testid={`smoke-${s.acId}`} className={`result-${s.status}`}>
                        <td>{s.acId}</td>
                        <td>{s.testId ?? '—'}</td>
                        <td><ResultChip status={s.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p data-testid="deploy-failure" className="error">
                {deployFailure(report.deploy)}
              </p>
            )}
          </section>
          <section className="card">
            <h2>Roteiro de teste manual <InfoTip text="Passos sugeridos para você conferir cada critério de aceite no serviço publicado. As marcações ficam salvas só neste navegador." /></h2>
            {report.exploratoryScript.length === 0 ? <p className="hint">Nenhum passo sugerido.</p> : null}
            {report.exploratoryScript.map((block) => {
              const criterion = detail.acceptanceCriteria.find((c) => c.id === block.acId);
              return (
                <div key={block.acId}>
                  <h3>{block.acId}</h3>
                  {criterion ? <p className="hint">{criterionText(criterion)}</p> : null}
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
              );
            })}
          </section>
          <section className="card">
            <h2>Suposições dos agentes <InfoTip text="Decisões que os agentes tomaram sozinhos quando a especificação não deixava claro. Se alguma estiver errada, relate um problema." /></h2>
            <ul data-testid="assumptions">{report.assumptions.length ? report.assumptions.map((a, i) => <li key={i}>{a}</li>) : <li className="hint">Nenhuma suposição registrada.</li>}</ul>
          </section>
          <section className="card">
            <h2>Tarefas bloqueadas <InfoTip text="Tarefas que os agentes não conseguiram concluir, com o motivo. Os critérios ligados a elas aparecem como bloqueados nas evidências." /></h2>
            <ul>{report.blocked.length ? report.blocked.map((b) => <li key={b.taskId} data-testid={`blocked-${b.taskId}`}><strong>{b.taskId}</strong>: {b.reason}</li>) : <li className="hint">Nenhuma tarefa bloqueada.</li>}</ul>
          </section>
          {report.securityFindings?.length ? (
            <section className="card">
              <h2>Segurança</h2>
              <ul data-testid="security-findings">
                {report.securityFindings.map((f, i) => (
                  <li key={i} data-testid={`security-${i}`}>
                    <span className={`status-chip ${SEVERITY[f.severity]?.tone ?? ''}`}>{SEVERITY[f.severity]?.label ?? f.severity}</span> {f.taskId ? `${f.taskId} · ` : ''}{f.file}{f.line === null ? '' : `:${f.line}`} · {f.category}: {f.problem} <span className="hint">Correção sugerida: {f.fix}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="card">
            <h2>Evidências por critério <InfoTip text="Para cada critério de aceite: as tarefas que o implementaram e os testes automáticos que comprovam que ele funciona." /></h2>
            <table>
              <thead>
                <tr>
                  <th>Critério</th>
                  <th>Tarefas</th>
                  <th>Testes</th>
                  <th>Teste E2E <InfoTip text="Teste ponta a ponta: simula uma pessoa usando o serviço publicado, do início ao fim do fluxo." /></th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {report.evidence.map((r) => (
                  <tr key={r.criterion} data-testid={`evidence-${r.criterion}`} className={`result-${r.status}`}>
                    <td>{r.criterion}</td>
                    <td>{r.tasks.join(', ')}</td>
                    <td>{r.tests.join(', ') || '—'}</td>
                    <td data-testid={`e2e-${r.criterion}`} title={r.e2eReason}>{r.e2e ? <ResultChip status={r.e2e} /> : '—'}{r.e2eReason ? ` (${r.e2eReason})` : ''}</td>
                    <td><ResultChip status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card">
            <h2>Resumo</h2>
            <p>{report.summary}</p>
            <p className="hint">
              Custo estimado: US$ {report.tokens.total.costUsd.toFixed(2)}{' '}
              <InfoTip text="Estimativa em dólares das chamadas aos modelos de IA nesta execução, calculada pelos preços de API." />
              {' · '}Tokens: {report.tokens.total.inputTokens} de entrada, {report.tokens.total.outputTokens} de saída{' '}
              <InfoTip text="Volume de texto processado pelos modelos de IA: entrada é o que eles leram, saída é o que escreveram. O custo cresce com os tokens." />
            </p>
          </section>
        </>
      )}
      <section className="card">
        <h2>Sua decisão <InfoTip text="Concluir finaliza a entrega e marca a especificação como concluída. Relatar problema reabre o refinamento com o seu relato, para os agentes corrigirem." /></h2>
        {note ? <p data-testid="actions-note" className="hint">{note}</p> : null}
        {actionError ? <p data-testid="action-error" className="error">{actionError}</p> : null}
        <textarea data-testid="problem-text" aria-label="Descrição do problema" value={text} onChange={(e) => setText(e.target.value)} placeholder="O que deu errado? O refinamento será reaberto com este relato." disabled={!enabled} />
        <p className="controls">
          <button data-testid="report-problem" disabled={!enabled || text.trim() === ''} onClick={() => onReport(text.trim())}>
            Relatar problema
          </button>
          <button data-testid="complete-spec" disabled={!enabled} onClick={onComplete}>
            Concluir especificação
          </button>
        </p>
      </section>
    </main>
  );
}

/** A run that has not ended: running, draining or paused (the Run page applies the same test to the README writer). */
const isLive = (status: string) => ['running', 'draining'].includes(status) || status.startsWith('paused');

export function ValidationPage() {
  const { runId } = useParams<{ runId: string }>();
  // Keyed by run: moving to another run remounts, so the previous run's detail, errors, poll and late answers cannot leak into it.
  return runId ? <ValidationRun key={runId} runId={runId} /> : <main><p>Carregando…</p></main>;
}

function ValidationRun({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [specStatus, setSpecStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<string | null>(null); // the run that completes the spec, followed until it ends
  const inFlight = useRef(false); // a double click must send one request, not two (the second would 409 and mask the first's success)
  const guarded = (call: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setActionError(null);
    call().catch((e: Error) => setActionError(e.message)).finally(() => { inFlight.current = false; });
  };
  const load = async () => {
    const d = await runApi.run(runId);
    setDetail(d);
    const projects = await runApi.projects();
    setSpecStatus(projects.find((p) => p.projectId === d.projectId)?.specs.find((s) => s.specId === d.specId)?.status ?? '');
    setActionError(null); // whatever an earlier click reported is stale once the page matches the server again
  };
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [runId]);
  // The spec turns done only if the completion run succeeds, so follow that run itself: waiting on the spec alone never ends when it fails.
  useEffect(() => {
    if (!completion) return;
    const timer = setInterval(() => {
      runApi
        .run(completion)
        .then(async (run) => {
          if (isLive(run.status)) return;
          if (run.status === 'done') await load();
          // Interrupted: its process died, so it will never finish; the spec is unchanged and Complete spec can be tried again.
          else if (run.status === 'interrupted') setActionError(`A execução de conclusão ${completion} foi interrompida. Clique em Concluir especificação para tentar de novo.`);
          else setActionError(`A execução de conclusão ${completion} terminou como “${statusLabel(run.status)}”${typeof run.finished?.reason === 'string' ? `: ${run.finished.reason}` : ''}.`);
          setCompletion(null);
        })
        .catch(() => undefined); // transient: the next tick asks again
    }, 5000);
    return () => clearInterval(timer);
  }, [completion]);
  if (error) return <main><p className="error">{error}</p></main>;
  if (!detail) return <main><p>Carregando…</p></main>;
  return (
    <ValidationView
      detail={detail}
      specStatus={specStatus}
      actionError={actionError}
      onReport={(text) =>
        guarded(() => runApi.reportProblem(detail.projectId, detail.specId, text).then(() => navigate(`/refine/${detail.projectId}/${detail.specId}`)))
      }
      onComplete={() => guarded(() => runApi.complete(detail.projectId, detail.specId).then((started) => setCompletion(started.runId)))}
    />
  );
}
