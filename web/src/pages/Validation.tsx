import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { runApi, type AcceptanceCriterion, type Report, type RunDetail, type ServiceStatus } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { explainBlockReason, rootBlockers, stopBefore, stopSummary } from '../run/selectors.js';
import { PUBLISHED_PORTS, serviceLinks } from '@server/deploy/service-links';
import { RUN_UI } from './Run.js';
import { Workspace } from '../components/Workspace.js';

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
// Ids stay on one line and long test names break between words, so a narrow screen scrolls the table instead of wrapping letter by letter.
const TABLE = 'mt-0 wrap-break-word';
const TD_ID = 'font-mono text-[0.8125rem] font-semibold whitespace-nowrap text-accent-text';
const TD_MONO = 'font-mono text-[0.78rem] text-ink-soft';
// Assumptions, blocked tasks and security findings: plain bordered rows.
const FINDINGS = `${RUN_UI.boxList} [&>li]:px-[0.9rem] [&>li]:py-[0.7rem] [&>li]:text-[0.875rem] [&>li]:leading-normal`;
// Commands, URLs and JSON the agents quoted between backticks.
const CODE = '[&_code]:rounded-sm [&_code]:bg-surface-muted [&_code]:px-[0.35rem] [&_code]:py-[0.05rem] [&_code]:text-[0.8125rem] [&_code]:text-ink [&_code]:wrap-anywhere';
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
const openLink = (href: string, testId: string, text: string, primary: boolean, label?: string) => (
  <a className={`${primary ? 'primary-button' : 'link-button'} ${RUN_UI.action}`} data-testid={testId} href={href} target="_blank" rel="noreferrer" aria-label={label}>
    {text}
    <Icon name="external" size={16} />
  </a>
);
const recheckButton = (checking: boolean, onRecheck: () => void) => (
  <button type="button" className="link-button min-h-8 px-[0.65rem] text-[0.8125rem]" data-testid="recheck-service" onClick={onRecheck} disabled={checking}>
    Verificar de novo
    <Icon name="refresh" size={14} />
  </button>
);
const startButton = (starting: boolean, canStart: boolean, onStart: () => void, [idle, busy]: readonly [string, string]) => (
  <button type="button" className="primary-button" data-testid="start-service" disabled={starting || !canStart} onClick={onStart}>
    {starting ? busy : idle}
    <Icon name="play" size={16} />
  </button>
);
// Service status and the buttons that open or start it.
const SERVICE = {
  controls: 'mb-[0.9rem] grid gap-3',
  status: 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
  actions: 'flex flex-wrap gap-2 empty:hidden',
};
interface ControlProps { status: ServiceStatus | null; starting: boolean; canStart: boolean; onStart: () => void; onRecheck: () => void }

/** Is the service up, where to open it, and a button to bring it up when it is not. */
function ServiceControls({ service, status, starting, canStart, onStart, onRecheck }: { service: NonNullable<Report['service']> } & ControlProps) {
  const links = serviceLinks(service, window.location.hostname);
  const checking = status === null;
  const online = status?.online === true;
  return (
    <div className={SERVICE.controls}>
      <div className={SERVICE.status}>
        <StatePill checking={checking} online={online} testId="service-online" />
        {recheckButton(checking, onRecheck)}
      </div>
      <div className={SERVICE.actions}>
        {online && links.docsUrl ? openLink(links.docsUrl, 'open-docs', 'Abrir Swagger', true) : null}
        {online && links.appUrl && !links.docsUrl ? openLink(links.appUrl, 'open-app', service.kind === 'front' ? 'Abrir aplicação' : 'Abrir serviço', true) : null}
        {!checking && !online ? startButton(starting, canStart, onStart, ['Subir serviço', 'Subindo o serviço…']) : null}
      </div>
      {!links.appUrl ? (
        <p data-testid="service-unpublished" className="hint m-0">
          Este serviço usa uma porta fora da faixa que o Teams AI publica no seu computador ({PUBLISHED_PORTS.from} a {PUBLISHED_PORTS.to}), por isso não dá para abri-lo daqui.
        </p>
      ) : null}
    </div>
  );
}

const label = (docsUrl: string | null, kind?: string) => (docsUrl ? 'Abrir Swagger' : kind === 'front' ? 'Abrir aplicação' : 'Abrir serviço');

/** A services run: one line per service with its state and its link, then one recheck and one start for them all. */
function ServiceList({ services, status, starting, canStart, onStart, onRecheck }: { services: NonNullable<Report['services']> } & ControlProps) {
  const checking = status === null;
  const onlineOf = (service: string) => status?.services?.find((s) => s.service === service)?.online === true;
  return (
    <div className={SERVICE.controls}>
      <ul className="m-0 grid list-none gap-2 p-0">
        {services.map((s) => {
          const links = serviceLinks(s, window.location.hostname);
          const href = links.docsUrl ?? links.appUrl;
          return (
            <li key={s.service} data-testid={`service-${s.service}`} className="flex flex-wrap items-center gap-3">
              <strong>{s.service}</strong>
              <StatePill checking={checking} online={onlineOf(s.service)} />
              {onlineOf(s.service) && href ? openLink(href, `open-${s.service}`, label(links.docsUrl, s.kind), false, `${label(links.docsUrl, s.kind)} (${s.service})`) : null}
              {!links.appUrl ? <span className="hint">porta fora da faixa publicada ({PUBLISHED_PORTS.from} a {PUBLISHED_PORTS.to})</span> : null}
            </li>
          );
        })}
      </ul>
      <div className={SERVICE.status}>{recheckButton(checking, onRecheck)}</div>
      <div className={SERVICE.actions}>
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
    <main className={`${RUN_UI.page} ${CODE}`}>
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
      <header className={RUN_UI.head}>
        <div className="min-w-0">
          <h1 className={RUN_UI.title}>Validação</h1>
          <div className={RUN_UI.meta}>
            <span className={`status-pill tone-${enabled ? 'neutral' : specStatus === 'done' ? 'good' : 'warn'}`}>{statusLabel(report && specStatus ? specStatus : detail.status)}</span>
            <span className="hint">
              {detail.runId} / {detail.specId}
            </span>
          </div>
          <p className="mt-3 mb-0 max-w-[60ch] text-[0.875rem] text-ink-soft">Confira o serviço publicado e siga o roteiro de teste. Depois, conclua a especificação ou relate um problema.</p>
        </div>
        <div className={RUN_UI.actions}>
          <Link className={`link-button ${RUN_UI.action}`} to={`/runs/${detail.runId}`}>
            Execução
            <Icon name="arrow-left" size={16} />
          </Link>
        </div>
      </header>
      <Workspace
        columns={RUN_UI.columns}
        panels={[
          {
            id: 'checks',
            label: 'Serviço e roteiro',
            content: (
              <div className={RUN_UI.column}>
                {stop ? (
                  <section className={RUN_UI.banner} data-testid="validation-stop" aria-labelledby="validation-stop-title">
                    <h2 id="validation-stop-title" className={RUN_UI.bannerTitle}>
                      <Icon name="alert" size={18} />
                      {stop.what}
                    </h2>
                    <dl className={RUN_UI.bannerRows}>
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
                          <dt>{c.taskId}</dt>
                          <dd><p><Rich text={explainBlockReason(c.reason)} /></p></dd>
                        </div>
                      ))}
                      {raw ? (
                        <div>
                          <dt>Detalhe técnico</dt>
                          <dd><pre className={RUN_UI.raw}>{raw}</pre></dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>Próximo passo</dt>
                        <dd>{stop.hint}</dd>
                      </div>
                    </dl>
                  </section>
                ) : null}
                {!report ? <p className="hint m-0">Ainda não há relatório: a execução está na fase {detail.phase} ({statusLabel(detail.status)}).</p> : null}
                {report ? (
                  <>
                    <section className="card">
                      <div className={RUN_UI.panelHead}>
                        <h2>{report.services ? 'Serviços publicados' : 'Serviço publicado'}</h2>
                      </div>
                      {report.service ? (
                        <>
                          {report.services ? (
                            <ServiceList services={report.services} status={serviceStatus} starting={startingService} canStart={specStatus === 'awaiting-validation'} onStart={onStartService} onRecheck={onRecheckService} />
                          ) : (
                            <ServiceControls service={report.service} status={serviceStatus} starting={startingService} canStart={specStatus === 'awaiting-validation'} onStart={onStartService} onRecheck={onRecheckService} />
                          )}
                          <div className="overflow-x-auto">
                            <table className={`${TABLE} min-w-[26rem]`}>
                              <thead>
                                <tr>
                                  <th>Critério</th>
                                  <th>Teste rápido <InfoTip text="Smoke test: teste automático curto, rodado no serviço publicado, que confirma o essencial de cada critério." /></th>
                                  <th>Resultado</th>
                                </tr>
                              </thead>
                              <tbody>
                                {report.service.smoke.map((s) => (
                                  <tr key={`${s.service ?? ''}-${s.acId}`} data-testid={`smoke-${s.service ? `${s.service}-` : ''}${s.acId}`} className={`result-${s.status}`}>
                                    <td className={TD_ID}>{s.acId}{s.service ? ` (${s.service})` : ''}</td>
                                    <td className={TD_MONO}>{s.testId ?? '—'}</td>
                                    <td><ResultChip status={s.status} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      ) : (
                        <p data-testid="deploy-failure" className="error">
                          {deployFailure(report.deploy)}
                        </p>
                      )}
                    </section>
                    <section className="card">
                      <div className={`mb-[0.85rem] ${RUN_UI.cardTitle}`}>
                        <div className={RUN_UI.headRow}>
                          <h2>Roteiro de teste manual</h2>
                          <InfoTip text="Passos sugeridos para você conferir cada critério de aceite no serviço publicado. As marcações ficam salvas só neste navegador." />
                        </div>
                        {steps.length ? <span className="hint">{stepsDone} de {steps.length} {steps.length === 1 ? 'passo conferido' : 'passos conferidos'}</span> : null}
                      </div>
                      {report.exploratoryScript.length === 0 ? <p className="hint">Nenhum passo sugerido.</p> : null}
                      {report.exploratoryScript.map((block) => {
                        const criterion = detail.acceptanceCriteria.find((c) => c.id === block.acId);
                        return (
                          <div key={block.acId}>
                            {/* Manual script: one bordered list per criterion, a real checkbox on every row. */}
                            <h3 className={`mb-1 font-mono text-[0.8125rem] tracking-normal text-accent-text normal-case mt-5`}>{block.acId}</h3>
                            {criterion ? <p className="hint mt-0 mb-[0.6rem] leading-normal">{criterionText(criterion)}</p> : null}
                            <ul className={RUN_UI.boxList}>
                              {block.steps.map((s, i) => {
                                const id = `${block.acId}-${i}`;
                                return (
                                  <li key={id}>
                                    <label className="flex cursor-pointer items-start gap-3 px-[0.9rem] py-[0.7rem] leading-normal text-ink hover:bg-surface-sunken">
                                      <input type="checkbox" className="m-0 mt-[0.2rem] size-[1.05rem] min-w-0 flex-none cursor-pointer p-0" data-testid={`step-${id}`} checked={Boolean(checks[id])} onChange={() => toggle(id)} />
                                      <span className={`min-w-0 text-[0.875rem] wrap-anywhere ${checks[id] ? 'text-ink-soft' : ''}`}><Rich text={s} /></span>
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
                      <div className={`mb-[0.85rem] ${RUN_UI.cardTitle}`}>
                        <div className={RUN_UI.headRow}>
                          <h2>Evidências por critério</h2>
                          <InfoTip text="Para cada critério de aceite: as tarefas que o implementaram e os testes automáticos que comprovam que ele funciona." />
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className={`${TABLE} min-w-[38rem]`}>
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
                                <td className={TD_ID}>{r.criterion}</td>
                                <td className={TD_MONO}>{r.tasks.join(', ')}</td>
                                <td className={TD_MONO}>{r.tests.join(', ') || '—'}</td>
                                <td data-testid={`e2e-${r.criterion}`} title={r.e2eReason}>{r.e2e ? <ResultChip status={r.e2e} /> : '—'}{r.e2eReason ? ` (${r.e2eReason})` : ''}</td>
                                <td><ResultChip status={r.status} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    {report.securityFindings?.length ? (
                      <section className="card">
                        <div className={RUN_UI.panelHead}>
                          <h2>Segurança</h2>
                        </div>
                        <ul className={FINDINGS} data-testid="security-findings">
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
                      <div className={RUN_UI.panelHead}>
                        <h2>Suposições dos agentes</h2>
                        <InfoTip text="Decisões que os agentes tomaram sozinhos quando a especificação não deixava claro. Se alguma estiver errada, relate um problema." />
                      </div>
                      <ul className={FINDINGS} data-testid="assumptions">{report.assumptions.length ? report.assumptions.map((a, i) => <li key={i}><Rich text={a} /></li>) : <li className="hint">Nenhuma suposição registrada.</li>}</ul>
                    </section>
                    <section className="card">
                      <div className={RUN_UI.panelHead}>
                        <h2>Tarefas bloqueadas</h2>
                        <InfoTip text="Tarefas que os agentes não conseguiram concluir, com o motivo. Os critérios ligados a elas aparecem como bloqueados nas evidências." />
                      </div>
                      <ul className={FINDINGS}>{report.blocked.length ? report.blocked.map((b) => <li key={b.taskId} data-testid={`blocked-${b.taskId}`}><strong className="font-mono text-[0.8125rem] text-accent-text">{b.taskId}</strong>: <Rich text={b.reason} /></li>) : <li className="hint">Nenhuma tarefa bloqueada.</li>}</ul>
                    </section>
                  </>
                ) : null}
              </div>
            ),
          },
          {
            id: 'decision',
            label: 'Sua decisão',
            content: (
              <aside className={RUN_UI.aside}>
                <section className="card">
                  <div className={RUN_UI.panelHead}>
                    <h2>Sua decisão</h2>
                    <InfoTip text="Concluir finaliza a entrega e marca a especificação como concluída. Relatar problema reabre o refinamento com o seu relato, para os agentes corrigirem." />
                  </div>
                  {completing ? <p data-testid="completing-note" className={`hint ${RUN_UI.asideNote}`}>Concluindo a especificação. Acompanhe em <Link to={`/runs/${completing}`}>{completing}</Link>.</p> : note ? <p data-testid="actions-note" className={`hint ${RUN_UI.asideNote}`}>{note}</p> : null}
                  {actionError ? <p data-testid="action-error" className={`error ${RUN_UI.asideNote}`}>{actionError}</p> : null}
                  <textarea className="m-0 mt-1 mb-[0.9rem] w-full resize-y px-[0.8rem] py-[0.65rem] text-[0.875rem] leading-normal disabled:cursor-not-allowed disabled:bg-surface-muted" data-testid="problem-text" aria-label="Descrição do problema" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="O que deu errado? O refinamento será reaberto com este relato." disabled={!enabled} />
                  <div className="grid gap-2 [&_button]:w-full">
                    <button className="primary-button" data-testid="complete-spec" disabled={!enabled} onClick={onComplete}>
                      {completing ? 'Concluindo…' : 'Concluir especificação'}
                      <Icon name="check" size={16} />
                    </button>
                    <button className="secondary" data-testid="report-problem" disabled={!enabled || text.trim() === ''} onClick={() => onReport(text.trim())}>
                      Relatar problema
                      <Icon name="alert" size={16} />
                    </button>
                  </div>
                </section>
                {report ? (
                  <section className="card">
                    <div className={RUN_UI.panelHead}>
                      <h2>Resumo</h2>
                    </div>
                    <p className="mt-0 mb-[0.9rem] max-h-64 overflow-auto text-[0.875rem] leading-[1.55] text-ink"><Rich text={report.summary} /></p>
                    <dl className={RUN_UI.totals}>
                      <div>
                        <dt>Custo estimado <InfoTip text="Estimativa em dólares das chamadas aos modelos de IA nesta execução, calculada pelos preços de API." /></dt>
                        <dd className="font-[650]">US$ {report.tokens.total.costUsd.toFixed(2)}</dd>
                      </div>
                      <div>
                        <dt>Tokens <InfoTip text="Volume de texto processado pelos modelos de IA: entrada é o que eles leram, saída é o que escreveram. O custo cresce com os tokens." /></dt>
                        <dd>{report.tokens.total.inputTokens} de entrada, {report.tokens.total.outputTokens} de saída</dd>
                      </div>
                    </dl>
                  </section>
                ) : null}
              </aside>
            ),
          },
        ]}
      />
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
