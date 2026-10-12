import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { runApi, type AcceptanceCriterion, type Report, type RunDetail, type ServiceStatus } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { explainBlockReason, rootBlockers, stopBefore, stopSummary } from '../run/selectors.js';
import { PUBLISHED_PORTS, serviceLinks } from '@server/deploy/service-links';
import './validation.css';

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
/** Agent text marks commands, URLs and JSON with backticks: show them as code instead of loose quote marks. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}
/** A service's state: still checking, answering or not. */
function StatePill({ checking, online, testId }: { checking: boolean; online: boolean; testId?: string }) {
  return <span data-testid={testId} className={`status-pill tone-${checking ? 'neutral' : online ? 'good' : 'bad'}`}>{checking ? 'Verificando' : online ? 'No ar' : 'Fora do ar'}</span>;
}
const openLink = (href: string, testId: string, text: string, primary: boolean) => (
  <a className={`${primary ? 'primary-button' : 'link-button'} run-action`} data-testid={testId} href={href} target="_blank" rel="noreferrer">
    {text}
    <Icon name="external" size={16} />
  </a>
);
const recheckButton = (checking: boolean, onRecheck: () => void) => (
  <button type="button" className="link-button" data-testid="recheck-service" onClick={onRecheck} disabled={checking}>
    <Icon name="refresh" size={14} />
    Verificar de novo
  </button>
);
const startButton = (starting: boolean, canStart: boolean, onStart: () => void, [idle, busy]: readonly [string, string]) => (
  <button type="button" className="primary-button" data-testid="start-service" disabled={starting || !canStart} onClick={onStart}>
    <Icon name="play" size={16} />
    {starting ? busy : idle}
  </button>
);
interface ControlProps { status: ServiceStatus | null; starting: boolean; canStart: boolean; onStart: () => void; onRecheck: () => void }

/** Is the service up, where to open it, and a button to bring it up when it is not. */
function ServiceControls({ service, status, starting, canStart, onStart, onRecheck }: { service: NonNullable<Report['service']> } & ControlProps) {
  const links = serviceLinks(service, window.location.hostname);
  const checking = status === null;
  const online = status?.online === true;
  return (
    <div className="service-controls">
      <div className="service-status">
        <StatePill checking={checking} online={online} testId="service-online" />
        {recheckButton(checking, onRecheck)}
      </div>
      <div className="service-actions">
        {online && links.docsUrl ? openLink(links.docsUrl, 'open-docs', 'Abrir Swagger', true) : null}
        {online && links.appUrl && !links.docsUrl ? openLink(links.appUrl, 'open-app', service.kind === 'front' ? 'Abrir aplicação' : 'Abrir serviço', true) : null}
        {!checking && !online ? startButton(starting, canStart, onStart, ['Subir serviço', 'Subindo o serviço…']) : null}
      </div>
      {!links.appUrl ? (
        <p data-testid="service-unpublished" className="hint">
          Este serviço usa uma porta fora da faixa que o Teams AI publica no seu computador ({PUBLISHED_PORTS.from} a {PUBLISHED_PORTS.to}), por isso não dá para abri-lo daqui.
        </p>
      ) : null}
    </div>
  );
}

/** A services run: one line per service with its state and its link, then one recheck and one start for them all. */
function ServiceList({ services, status, starting, canStart, onStart, onRecheck }: { services: NonNullable<Report['services']> } & ControlProps) {
  const checking = status === null;
  const onlineOf = (service: string) => status?.services?.find((s) => s.service === service)?.online === true;
  return (
    <div className="service-controls">
      <ul className="service-list">
        {services.map((s) => {
          const links = serviceLinks(s, window.location.hostname);
          const href = links.docsUrl ?? links.appUrl;
          return (
            <li key={s.service} data-testid={`service-${s.service}`}>
              <strong className="task-id">{s.service}</strong>
              <StatePill checking={checking} online={onlineOf(s.service)} />
              {onlineOf(s.service) && href ? openLink(href, `open-${s.service}`, links.docsUrl ? 'Abrir Swagger' : s.kind === 'front' ? 'Abrir aplicação' : 'Abrir serviço', false) : null}
              {!links.appUrl ? <span className="hint">porta fora da faixa publicada</span> : null}
            </li>
          );
        })}
      </ul>
      <div className="service-actions">
        {recheckButton(checking, onRecheck)}
        {!checking && services.some((s) => !onlineOf(s.service)) ? startButton(starting, canStart, onStart, ['Subir serviços', 'Subindo os serviços…']) : null}
      </div>
    </div>
  );
}
const criterionText = (c: AcceptanceCriterion) => `Dado ${c.given}, quando ${c.when}, então ${c.then}`;
function deployFailure(deploy: Report['deploy']): string {
  if (deploy.attempts === 0) return 'Não publicado: a execução parou antes da publicação.';
  const f = deploy.lastFailure;
  const rollback = !f?.rolledBack ? '' : f.rollbackHealthy === false ? ' (versão anterior restaurada, mas sem resposta)' : ' (versão anterior restaurada)';
  const failure = f ? `: a tentativa ${f.attempt} falhou na etapa “${f.stage}”${f.service ? ` do serviço ${f.service}` : ''} — ${f.detail}${rollback}` : '';
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

interface ServiceProps {
  /** null until the first check answers. */
  serviceStatus?: ServiceStatus | null;
  startingService?: boolean;
  onStartService?: () => void;
  onRecheckService?: () => void;
  /** The run completing the spec, while it goes. */
  completing?: string | null;
}

export function ValidationView({ detail, specStatus, actionError = null, serviceStatus = null, startingService = false, onStartService = () => undefined, onRecheckService = () => undefined, completing = null, onReport, onComplete }: { detail: RunDetail; specStatus: string; actionError?: string | null; onReport: (text: string) => void; onComplete: () => void } & ServiceProps) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => readChecks(detail.runId));
  const [text, setText] = useState('');
  const report: Report | null = detail.report;
  const toggle = (id: string) => {
    const next = { ...checks, [id]: !checks[id] };
    setChecks(next);
    writeChecks(detail.runId, next);
  };
  const enabled = specStatus === 'awaiting-validation' && report?.result === 'awaiting-validation' && !completing;
  const specState = specStatus ? ` e a especificação está “${statusLabel(specStatus)}”` : '';
  const note = enabled ? null : specStatus === 'done' ? 'Esta especificação já foi concluída.' : report ? `Ações indisponíveis: a execução terminou como “${statusLabel(report.result)}”${specState}.` : 'As ações ficam disponíveis quando a execução gerar o relatório.';
  const steps = report?.exploratoryScript.flatMap((b) => b.steps.map((_, i) => `${b.acId}-${i}`)) ?? [];
  const stepsDone = steps.filter((id) => checks[id]).length;
  // The same explanation the Run page gives a run that stopped, so the cause is at the top here too.
  const blocked = (detail.finished?.blocked ?? report?.blocked ?? []) as Array<{ taskId: string; reason: string }>;
  const causes = rootBlockers(blocked);
  const stop = stopSummary({ status: detail.status, reason: typeof detail.finished?.reason === 'string' ? detail.finished.reason : null, causes, deployFailure: report?.deploy.lastFailure ?? null });
  const before = stop ? stopBefore(detail.status, blocked) : null;
  const raw = stop && !causes.some((c) => c.reason === stop.raw) ? stop.raw : '';
  return (
    <main className="run-page validation-page">
      <nav className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/projects" aria-label="Voltar para projetos">
          <Icon name="home" size={16} />
          <span>Projetos</span>
        </Link>
        <span aria-hidden="true">›</span>
        <strong>{detail.projectId}</strong>
        <span aria-hidden="true">›</span>
        <Link to={`/runs/${detail.runId}`}>{detail.runId}</Link>
        <span aria-hidden="true">›</span>
        <span>Validação</span>
      </nav>
      <header className="card run-head">
        <div className="run-head-main">
          <h1>Validação</h1>
          <div className="run-meta">
            <span className={`status-pill tone-${enabled ? 'neutral' : specStatus === 'done' ? 'good' : 'warn'}`}>{statusLabel(report && specStatus ? specStatus : detail.status)}</span>
            <span className="hint">
              {detail.runId} / {detail.specId}
            </span>
          </div>
          <p className="validation-lead">Confira o serviço publicado e siga o roteiro de teste. Depois, conclua a especificação ou relate um problema.</p>
        </div>
        <div className="run-actions">
          <Link className="link-button run-action" to={`/runs/${detail.runId}`}>
            <Icon name="arrow-left" size={16} />
            Execução
          </Link>
        </div>
      </header>
      {stop ? (
        <section className="card outcome-banner" data-testid="validation-stop" aria-labelledby="validation-stop-title">
          <h2 id="validation-stop-title" className="outcome-title">
            <Icon name="alert" size={18} />
            {stop.what}
          </h2>
          <dl className="outcome-rows">
            <div>
              <dt>Por quê</dt>
              <dd><strong>{stop.title}</strong></dd>
            </div>
            {before ? (
              <div>
                <dt>Antes disso</dt>
                <dd>{before}</dd>
              </div>
            ) : null}
            {causes.map((c) => (
              <div key={c.taskId} data-testid={`stop-cause-${c.taskId}`}>
                <dt className="task-id">{c.taskId}</dt>
                <dd><p><Rich text={explainBlockReason(c.reason)} /></p></dd>
              </div>
            ))}
            {raw ? (
              <div>
                <dt>Detalhe técnico</dt>
                <dd><pre className="failure-raw">{raw}</pre></dd>
              </div>
            ) : null}
            <div>
              <dt>Próximo passo</dt>
              <dd>{stop.hint}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {!report ? <p className="hint">Ainda não há relatório: a execução está na fase {detail.phase} ({statusLabel(detail.status)}).</p> : null}
      <div className="run-grid">
        <div className="run-col">
          {report ? (
            <>
              <section className="card">
                <div className="run-panel-head">
                  <h2>{report.services ? 'Serviços publicados' : 'Serviço publicado'}</h2>
                </div>
                {report.service ? (
                  <>
                    {report.services ? (
                      <ServiceList services={report.services} status={serviceStatus} starting={startingService} canStart={specStatus === 'awaiting-validation'} onStart={onStartService} onRecheck={onRecheckService} />
                    ) : (
                      <ServiceControls service={report.service} status={serviceStatus} starting={startingService} canStart={specStatus === 'awaiting-validation'} onStart={onStartService} onRecheck={onRecheckService} />
                    )}
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
                            <td className="task-id">{s.acId}</td>
                            <td className="mono">{s.testId ?? '—'}</td>
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
                <div className="plan-title">
                  <div className="run-panel-head">
                    <h2>Roteiro de teste manual</h2>
                    <InfoTip text="Passos sugeridos para você conferir cada critério de aceite no serviço publicado. As marcações ficam salvas só neste navegador." />
                  </div>
                  {steps.length ? <span className="hint">{stepsDone} de {steps.length} {steps.length === 1 ? 'passo conferido' : 'passos conferidos'}</span> : null}
                </div>
                {report.exploratoryScript.length === 0 ? <p className="hint">Nenhum passo sugerido.</p> : null}
                {report.exploratoryScript.map((block) => {
                  const criterion = detail.acceptanceCriteria.find((c) => c.id === block.acId);
                  return (
                    <div key={block.acId} className="step-group">
                      <h3>{block.acId}</h3>
                      {criterion ? <p className="hint">{criterionText(criterion)}</p> : null}
                      <ul className="step-list">
                        {block.steps.map((s, i) => {
                          const id = `${block.acId}-${i}`;
                          return (
                            <li key={id} className={checks[id] ? 'step-done' : ''}>
                              <label>
                                <input type="checkbox" data-testid={`step-${id}`} checked={Boolean(checks[id])} onChange={() => toggle(id)} />
                                <span><Rich text={s} /></span>
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
                <div className="plan-title">
                  <div className="run-panel-head">
                    <h2>Evidências por critério</h2>
                    <InfoTip text="Para cada critério de aceite: as tarefas que o implementaram e os testes automáticos que comprovam que ele funciona." />
                  </div>
                </div>
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
                        <td className="task-id">{r.criterion}</td>
                        <td className="mono">{r.tasks.join(', ')}</td>
                        <td className="mono">{r.tests.join(', ') || '—'}</td>
                        <td data-testid={`e2e-${r.criterion}`} title={r.e2eReason}>{r.e2e ? <ResultChip status={r.e2e} /> : '—'}{r.e2eReason ? ` (${r.e2eReason})` : ''}</td>
                        <td><ResultChip status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              {report.securityFindings?.length ? (
                <section className="card">
                  <div className="run-panel-head">
                    <h2>Segurança</h2>
                  </div>
                  <ul className="finding-list" data-testid="security-findings">
                    {report.securityFindings.map((f, i) => (
                      <li key={i} data-testid={`security-${i}`}>
                        <span className={`status-chip ${SEVERITY[f.severity]?.tone ?? ''}`}>{SEVERITY[f.severity]?.label ?? f.severity}</span>{' '}
                        {f.taskId ? `${f.taskId} · ` : ''}{f.file}{f.line === null ? '' : `:${f.line}`} · {f.category}: {f.problem} <span className="hint">Correção sugerida: {f.fix}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section className="card">
                <div className="run-panel-head">
                  <h2>Suposições dos agentes</h2>
                  <InfoTip text="Decisões que os agentes tomaram sozinhos quando a especificação não deixava claro. Se alguma estiver errada, relate um problema." />
                </div>
                <ul className="finding-list" data-testid="assumptions">{report.assumptions.length ? report.assumptions.map((a, i) => <li key={i}><Rich text={a} /></li>) : <li className="hint">Nenhuma suposição registrada.</li>}</ul>
              </section>
              <section className="card">
                <div className="run-panel-head">
                  <h2>Tarefas bloqueadas</h2>
                  <InfoTip text="Tarefas que os agentes não conseguiram concluir, com o motivo. Os critérios ligados a elas aparecem como bloqueados nas evidências." />
                </div>
                <ul className="finding-list">{report.blocked.length ? report.blocked.map((b) => <li key={b.taskId} data-testid={`blocked-${b.taskId}`}><strong className="task-id">{b.taskId}</strong>: <Rich text={b.reason} /></li>) : <li className="hint">Nenhuma tarefa bloqueada.</li>}</ul>
              </section>
            </>
          ) : null}
        </div>
        <aside className="run-col run-aside">
          <section className="card">
            <div className="run-panel-head">
              <h2>Sua decisão</h2>
              <InfoTip text="Concluir finaliza a entrega e marca a especificação como concluída. Relatar problema reabre o refinamento com o seu relato, para os agentes corrigirem." />
            </div>
            {completing ? <p data-testid="completing-note" className="hint">Concluindo a especificação. Acompanhe em <Link to={`/runs/${completing}`}>{completing}</Link>.</p> : note ? <p data-testid="actions-note" className="hint">{note}</p> : null}
            {actionError ? <p data-testid="action-error" className="error">{actionError}</p> : null}
            <textarea className="validation-problem" data-testid="problem-text" aria-label="Descrição do problema" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="O que deu errado? O refinamento será reaberto com este relato." disabled={!enabled} />
            <div className="validation-actions">
              <button className="primary-button" data-testid="complete-spec" disabled={!enabled} onClick={onComplete}>
                <Icon name="check" size={16} />
                {completing ? 'Concluindo…' : 'Concluir especificação'}
              </button>
              <button className="secondary" data-testid="report-problem" disabled={!enabled || text.trim() === ''} onClick={() => onReport(text.trim())}>
                <Icon name="alert" size={16} />
                Relatar problema
              </button>
            </div>
          </section>
          {report ? (
            <section className="card">
              <div className="run-panel-head">
                <h2>Resumo</h2>
              </div>
              <p className="validation-summary"><Rich text={report.summary} /></p>
              <dl className="usage-totals">
                <div>
                  <dt>Custo estimado <InfoTip text="Estimativa em dólares das chamadas aos modelos de IA nesta execução, calculada pelos preços de API." /></dt>
                  <dd className="usage-total-cost">US$ {report.tokens.total.costUsd.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>Tokens <InfoTip text="Volume de texto processado pelos modelos de IA: entrada é o que eles leram, saída é o que escreveram. O custo cresce com os tokens." /></dt>
                  <dd>{report.tokens.total.inputTokens} de entrada, {report.tokens.total.outputTokens} de saída</dd>
                </div>
              </dl>
            </section>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

/** A run that has not ended: running, draining or paused (the Run page applies the same test to the README writer). */
const isLive = (status: string) => ['running', 'draining'].includes(status) || status.startsWith('paused');

export function ValidationPage() {
  const { runId } = useParams<{ runId: string }>();
  // Keyed by run: moving to another run remounts, so the previous run's detail, errors, poll and late answers cannot leak into it.
  return runId ? <ValidationRun key={runId} runId={runId} /> : <main><Loading /></main>;
}

function ValidationRun({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [specStatus, setSpecStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [deployRun, setDeployRun] = useState<string | null>(null); // the run that brings the service back up
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
  const checkService = () => runApi.serviceStatus(runId).then(setServiceStatus).catch(() => setServiceStatus({ online: false, status: null, checkedAt: '' }));
  useEffect(() => {
    void checkService();
  }, [runId]);
  // The deploy run brings the service up with no agent; follow it to its end, then ask again whether the service answers.
  useEffect(() => {
    if (!deployRun) return;
    const timer = setInterval(() => {
      runApi
        .run(deployRun)
        .then(async (run) => {
          if (isLive(run.status)) return;
          if (run.status !== 'done') setActionError(`A subida do serviço (${deployRun}) terminou como “${statusLabel(run.status)}”${typeof run.finished?.reason === 'string' ? `: ${run.finished.reason}` : ''}.`);
          setDeployRun(null);
          await checkService();
        })
        .catch(() => undefined); // transient: the next tick asks again
    }, 4000);
    return () => clearInterval(timer);
  }, [deployRun]);
  if (error) return <main><p className="error">{error}</p></main>;
  if (!detail) return <main><Loading /></main>;
  return (
    <ValidationView
      detail={detail}
      specStatus={specStatus}
      actionError={actionError}
      serviceStatus={serviceStatus}
      startingService={deployRun !== null}
      completing={completion}
      onRecheckService={() => { setServiceStatus(null); void checkService(); }}
      onStartService={() => guarded(() => runApi.deployAgain(detail.projectId, detail.specId).then((started) => setDeployRun(started.runId)))}
      onReport={(text) =>
        guarded(() => runApi.reportProblem(detail.projectId, detail.specId, text).then(() => navigate(`/refine/${detail.projectId}/${detail.specId}`)))
      }
      onComplete={() => guarded(() => runApi.complete(detail.projectId, detail.specId).then((started) => setCompletion(started.runId)))}
    />
  );
}
