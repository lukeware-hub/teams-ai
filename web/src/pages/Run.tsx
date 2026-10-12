import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { parseRunId } from '@server/core/ids';
import { runApi, type RunDetail, type StoredEvent } from '../api.js';
import { Dialog } from '../components/Dialog.js';
import { Icon, type IconName } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { Markdown } from '../components/Markdown.js';
import { safeHttpUrl } from '../safeUrl.js';
import { StepList } from '../components/StepList.js';
import { TaskDetail } from '../components/TaskDetail.js';
import { currentActivity, evidence, explainBlockReason, explainPhase, explainStop, firstSentence, formatDuration, lastDeployFailure, liveBlocked, mergedPrs, pausedUntil, phaseActivity, phases, phaseTitle, rootBlockers, runState, stepDoing, stopBefore, stopSummary, tokens, type ActivityItem, type PhaseRow, type StopOwner } from '../run/selectors.js';
import { useJournal } from '../useSse.js';
import './run.css';

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const money = (n: number) => `US$ ${n.toFixed(4)}`;
/** The run's own part of its id (`run-2`, `complete-run-1`), for legacy ids too; the whole id when it does not parse. */
const runLabel = (runId: string) => {
  const r = parseRunId(runId);
  return r ? `${r.kind === 'run' ? '' : `${r.kind}-`}run-${r.n}` : runId;
};
const steps = (n: number) => `${n} ${n === 1 ? 'etapa' : 'etapas'}`;
// Journal keys of the token breakdown by phase; any other key shows as recorded.
const PHASE_LABEL: Record<string, string> = { decide: 'Decisões automáticas', phase: 'Especificação, plano e relatório', phase3: 'Tarefas' };
// Journal role ids. The id stays beside the name because plan owners and step rows on this screen use it.
const ROLE_LABEL: Record<string, string> = { dev: 'Desenvolvimento', sm: 'Scrum Master', po: 'Product Owner', test: 'Testes', sec: 'Segurança', devops: 'DevOps', system1: 'Decisões automáticas' };
const TIP = {
  merged: 'Tarefas cujo pull request já entrou na branch main. A barra mostra a mesma proporção.',
  steps: 'Cada chamada a um agente (Dev, Scrum Master, revisão, segurança) ou decisão automática conta como uma etapa.',
  cost: 'Estimativa em dólares, calculada a partir dos tokens que os modelos consumiram nesta run.',
  input: 'Texto novo enviado aos modelos: instruções, código e contexto. O que veio do cache é contado à parte.',
  cache: 'Contexto gravado ou reaproveitado do cache dos modelos. Ler do cache custa bem menos que enviar o texto de novo.',
  output: 'Texto gerado pelos modelos: código, planos, revisões e respostas.',
  byRole: 'Consumo de cada papel do time de agentes. Decisões automáticas são escolhas rápidas do orquestrador, como qual modelo usar em cada tarefa.',
  byPhase: 'Onde o consumo aconteceu: nas tarefas, nas etapas de especificação, plano e relatório, ou nas decisões automáticas.',
  phases: 'As etapas da run, em ordem: especificação técnica, plano, implementação das tarefas, verificação, deploy e relatório. Uma fase repetida mostra a última tentativa. Clique numa fase para ver o que foi feito e os problemas que aconteceram.',
  now: 'Os agentes trabalhando neste momento e há quanto tempo. O custo de uma etapa só entra no consumo quando ela termina.',
  owner: 'Sistema: falha do orquestrador, de um agente ou do ambiente. Plano: o plan.json precisa mudar. Você: depende de uma ação sua, como ajustar a spec ou as permissões no GitHub.',
  blocked: 'Tarefas que pararam por um motivo próprio. As que só esperavam por uma delas não aparecem aqui.',
  reprocess: 'Inicia uma nova run desta spec. A especificação técnica e o plano que já estão na main são reaproveitados; as tarefas rodam de novo e consomem tokens.',
};

type UsageRow = [string, { inputTokens: number; outputTokens: number; costUsd: number; steps: number }];

function UsageList({ title, tip, rows, label, testIdPrefix }: { title: string; tip: string; rows: UsageRow[]; label: (key: string) => ReactNode; testIdPrefix?: string }) {
  return (
    <>
      <div className="usage-head">
        <h3>{title}</h3>
        <InfoTip label={title} text={tip} />
      </div>
      <ul className="usage-list">
        {rows.map(([key, u]) => (
          <li key={key} data-testid={testIdPrefix ? `${testIdPrefix}${key}` : undefined}>
            <span className="usage-name">{label(key)}</span>
            <span className="usage-cost">{money(u.costUsd)}</span>
            <span className="usage-meta">
              {u.inputTokens} entrada · {u.outputTokens} saída · {steps(u.steps)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

const roleName = (role: string) =>
  ROLE_LABEL[role] ? (
    <>
      {ROLE_LABEL[role]}
      <span className="usage-id">{role}</span>
    </>
  ) : (
    role
  );

const OWNER_ICON: Record<string, IconName> = { dev: 'code', devops: 'server', test: 'check', sec: 'shield', po: 'clipboard', sm: 'list' };
const ORIGIN_LABEL: Record<string, string> = { fix: 'correção', 'deploy-fix': 'correção de deploy' };
const PATHS_SHOWN = 3;

/** The executable plan: what each task is, who does it, which criteria it satisfies and which files it touches. */
function PlanCard({ plan }: { plan: NonNullable<RunDetail['plan']> }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <section className="card" data-testid="plan-artifact">
      <div className="plan-title">
        <h2>
          Plano executável <InfoTip label="Plano executável" text="Como a spec foi dividida em tarefas. Cada tarefa tem um responsável, cumpre critérios de aceite (AC) e altera os arquivos listados. Sai da fase 2." />
        </h2>
        <span className="hint">
          {plan.tasks.length} {plan.tasks.length === 1 ? 'tarefa' : 'tarefas'}
        </span>
      </div>
      <dl className="plan-facts">
        <div>
          <dt>
            <Icon name="code" size={16} />
            Tecnologia
          </dt>
          <dd>{'services' in plan ? Object.entries(plan.services).map(([name, s]) => `${name}: ${s.stack}`).join(' · ') : plan.stack}</dd>
        </div>
        <div>
          <dt>
            <Icon name="file" size={16} />
            Versão da spec <InfoTip label="Versão da spec" text="Identificador da versão da spec usada para gerar este plano. Muda quando a spec muda." />
          </dt>
          <dd>
            <code title={plan.specHash}>{plan.specHash.slice(0, 19)}…</code>
          </dd>
        </div>
      </dl>
      <ul className="plan-list">
        {plan.tasks.map((task) => {
          const open = expanded.has(task.id);
          const paths = open ? task.affectedPaths : task.affectedPaths.slice(0, PATHS_SHOWN);
          const hidden = task.affectedPaths.length - PATHS_SHOWN;
          const owner = ROLE_LABEL[task.owner] ?? task.owner;
          return (
            <li key={task.id} data-testid={`plan-task-${task.id}`}>
              <div className="plan-line">
                <span className="task-id">{task.id}</span>
                <span className="task-title">{task.title}</span>
                <span className="plan-chips">
                  {task.service ? <span className="tag" title="Serviço">{task.service}</span> : null}
                  {task.origin !== 'plan' ? <span className="tag">{ORIGIN_LABEL[task.origin] ?? task.origin}</span> : null}
                  <span className="owner-chip" title={`Responsável pela tarefa: ${owner}`}>
                    <Icon name={OWNER_ICON[task.owner] ?? 'user'} size={14} />
                    {owner}
                  </span>
                </span>
              </div>
              <div className="plan-facets">
                <span className="plan-facet-icon" role="img" aria-label="Critérios de aceite" title="Critérios de aceite que esta tarefa cumpre">
                  <Icon name="check" size={14} />
                </span>
                <span className="plan-facet-items">
                  {task.criteriaRefs.length ? task.criteriaRefs.map((ac) => <span key={ac} className="plan-ac">{ac}</span>) : <span className="hint">Sem critério direto</span>}
                </span>
                <span className="plan-facet-icon" role="img" aria-label="Arquivos alterados" title="Arquivos que esta tarefa cria ou altera">
                  <Icon name="file" size={14} />
                </span>
                <span className="plan-facet-items">
                  {paths.map((path) => <code key={path} className="plan-path">{path}</code>)}
                  {hidden > 0 ? (
                    <button type="button" className="plan-more" aria-expanded={open} onClick={() => toggle(task.id)}>
                      {open ? 'Mostrar menos' : `+${hidden}`}
                    </button>
                  ) : null}
                </span>
                {task.dependsOn.length ? (
                  <>
                    <span className="plan-facet-icon" role="img" aria-label="Depende de" title="Só começa depois que estas tarefas forem mescladas">
                      <Icon name="clock" size={14} />
                    </span>
                    <span className="plan-facet-items">
                      {task.dependsOn.map((id) => <code key={id} className="plan-path">{id}</code>)}
                    </span>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <details>
        <summary>Ver plan.json</summary>
        <pre>{JSON.stringify(plan, null, 2)}</pre>
      </details>
    </section>
  );
}

const TEST_RESULT: Record<string, { label: string; tone: string; icon: IconName }> = {
  passed: { label: 'Passou', tone: 'good', icon: 'check' },
  failed: { label: 'Falhou', tone: 'bad', icon: 'close' },
};
/** `test::[AC-001] health endpoint answers 200` reads as `health endpoint answers 200`; the full id stays in the tooltip. */
const testName = (id: string) => id.replace(/^.*?::/, '').replace(/^\[[^\]]+\]\s*/, '');

/** Acceptance-criteria coverage: each criterion with its text and the tests that prove it. */
function EvidenceCard({ criteria, rows }: { criteria: RunDetail['acceptanceCriteria']; rows: ReturnType<typeof evidence> }) {
  const covered = rows.filter((r) => r.tests.length > 0 && r.tests.every((t) => t.status === 'passed')).length;
  return (
    <section className="card" data-testid="evidence">
      <div className="plan-title">
        <h2>
          Evidências <InfoTip label="Evidências" text="Cada critério de aceite (AC) deve ter ao menos um teste automatizado passando. Aqui estão os testes ligados a cada critério, com o resultado da última rodada de cada um." />
        </h2>
        <span className="hint">
          {covered} de {rows.length} {rows.length === 1 ? 'critério coberto' : 'critérios cobertos'}
        </span>
      </div>
      <ul className="evidence-list">
        {rows.map((row) => {
          const criterion = criteria.find((c) => c.id === row.acId);
          const failed = row.tests.some((t) => t.status !== 'passed');
          const state = !row.tests.length ? { tone: 'neutral', icon: 'clock' as IconName, label: 'Sem teste ainda' } : failed ? { tone: 'bad', icon: 'close' as IconName, label: 'Há teste falhando' } : { tone: 'good', icon: 'check' as IconName, label: 'Coberto' };
          return (
            <li key={row.acId} data-testid={`evidence-${row.acId}`}>
              <span className={`evidence-state tone-${state.tone}`} role="img" aria-label={state.label} title={state.label}>
                <Icon name={state.icon} size={14} />
              </span>
              <div className="evidence-body">
                <p className="evidence-head">
                  <span className="task-id">{row.acId}</span>
                  {criterion?.smoke ? <span className="tag" title="Também roda como teste rápido depois do deploy">smoke</span> : null}
                </p>
                {criterion ? (
                  <p className="evidence-criterion">
                    <b>Dado</b> {criterion.given} <b>quando</b> {criterion.when} <b>então</b> {criterion.then}
                  </p>
                ) : null}
                {row.tests.length ? (
                  <ul className="evidence-tests">
                    {row.tests.map((x) => {
                      const result = TEST_RESULT[x.status] ?? { label: x.status, tone: 'warn', icon: 'info' as IconName };
                      return (
                        <li key={x.id} title={x.id}>
                          <span className={`status-pill tone-${result.tone}`}>
                            <Icon name={result.icon} size={12} />
                            {result.label}
                          </span>
                          <span className="evidence-test-name">{testName(x.id)}</span>
                          <span className="hint">tarefa {x.taskId}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="hint">Ainda sem cobertura: nenhum teste liga a este critério.</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const ownerChip = (owner: StopOwner, testId?: string) => (
  <span className={`owner-chip owner-${owner}`} data-testid={testId}>
    {owner}
  </span>
);

/** Label/value rows of a failure dialog; a null row is skipped. */
function Facts({ rows }: { rows: Array<[string, ReactNode] | null> }) {
  return (
    <dl className="failure-facts">
      {rows
        .filter((row): row is [string, ReactNode] => row !== null)
        .map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

const PHASE_STATE: Record<PhaseRow['result'], [label: string, tone: string]> = { done: ['concluída', 'good'], failed: ['falhou', 'bad'], running: ['em execução', 'neutral'], stopped: ['interrompida', ''] };

/** A phase row's chip. The journal alone keeps a paused or dead run's phase running, so the run status refines it. */
function phaseState(p: PhaseRow, runStatus: string, blockedTasks: number): [label: string, tone: string] {
  if (p.result === 'running' && runStatus.startsWith('paused')) return ['pausada', 'warn'];
  if (p.result === 'running' && runStatus === 'interrupted') return PHASE_STATE.stopped;
  if (p.result === 'done' && p.phase === 3 && blockedTasks > 0) return ['com bloqueios', 'warn'];
  return PHASE_STATE[p.result];
}

/** Plain-language events, oldest first, each with its time and link. */
function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <ol className="activity-list">
      {items.map((item, i) => (
        <li key={i} className={item.tone ? `activity activity-${item.tone}` : 'activity'}>
          <time dateTime={item.at}>{hhmm(item.at)}</time>
          <span>
            {item.text}
            {safeHttpUrl(item.url ?? '') ? (
              <>
                {' '}
                <a href={safeHttpUrl(item.url ?? '')} target="_blank" rel="noreferrer" aria-label={`Abrir: ${item.text}`}>
                  <Icon name="external" size={14} />
                </a>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** What the run is doing right now: the agent steps in flight with a live timer, or else the last thing that happened. */
function NowCard({ events }: { events: StoredEvent[] }) {
  const { running, last } = currentActivity(events);
  const [now, setNow] = useState(() => Date.now());
  const ticking = running.length > 0;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return (
    <section className="card" data-testid="now">
      <div className="run-panel-head">
        <h2>Agora</h2>
        <InfoTip label="Agora" text={TIP.now} />
      </div>
      {running.length ? (
        <ul className="now-list">
          {running.map((s) => (
            <li key={s.stepId} data-testid="now-step">
              <strong>{ROLE_LABEL[s.role] ?? s.role}</strong> {stepDoing(s.kind)}
              {s.taskId ? ` a tarefa ${s.taskId}` : ''}
              <span className="now-meta">
                {s.model ? `${s.model} · ` : ''}há {formatDuration(now - Date.parse(s.startedAt))}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Nenhum agente trabalhando neste momento.</p>
      )}
      {last ? (
        <p className="now-last" data-testid="now-last">
          <span className="hint">Último acontecimento, às {hhmm(last.at)}:</span> {last.text}
        </p>
      ) : null}
    </section>
  );
}
const IN_FLIGHT = new Set(['implementing', 'validating', 'reviewing', 'rebasing', 'merging']);
const ORDER = ['implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'ready', 'planned', 'merged', 'blocked', 'superseded'];
const statusLabel = (status: string) => ({ done: 'concluído', complete: 'concluído', failed: 'falhou', implementing: 'implementando', validating: 'validando', reviewing: 'revisando', rebasing: 'rebaseando', merging: 'mesclando', ready: 'pronta', planned: 'planejada', merged: 'mesclada', blocked: 'bloqueada', superseded: 'substituída', running: 'em execução', draining: 'finalizando', interrupted: 'interrompida', 'deploy-failed': 'deploy falhou', 'verification-failed': 'verificação falhou', 'phase-failed': 'fase falhou', deadlocked: 'travada', 'awaiting-validation': 'aguardando validação' } as Record<string, string>)[status] ?? status;
const statusTone = (status: string) => (['done', 'complete', 'merged'].includes(status) ? 'good' : ['blocked', 'failed', 'deploy-failed', 'verification-failed', 'phase-failed', 'deadlocked'].includes(status) ? 'bad' : status.startsWith('paused') || status === 'awaiting-validation' ? 'warn' : status === 'running' ? 'neutral' : 'neutral');

export interface ReadmeAction {
  onGenerate: () => void;
  busy: boolean;
  error: string | null;
}

export interface RedeployAction {
  onRedeploy: () => void;
  busy: boolean;
  error: string | null;
}

/** Starts a new run of the same spec: the resume route only takes paused:auth and interrupted runs. */
export interface ReprocessAction {
  onReprocess: () => void;
  busy: boolean;
  error: string | null;
}

/** Requests a graceful stop: in-flight steps finish, nothing new starts. The only way to turn a run stuck on a
 * blocked task (other tasks still progressing, so the run itself never settles on its own) into one that has
 * finished and can be reprocessed. */
export interface StopAction {
  onStop: () => void;
  busy: boolean;
  error: string | null;
}

/** Resumes the same run id (unlike Reprocessar, which starts a new one): the only move for a run the journal alone
 * reads as still going, but whose process actually died without ever writing RUN_FINISHED. */
export interface ResumeAction {
  onResume: () => void;
  busy: boolean;
  error: string | null;
}

type DetailTarget = { kind: 'outcome' } | { kind: 'phase'; phase: number } | { kind: 'cause'; reason: string };

const STOPPABLE = new Set(['running', 'paused:quota', 'paused:auth']);
// Same condition as the project hub's own Retomar button (project-shared.tsx's ACTIVE/resume gating): a dead
// process (interrupted) or an expired Claude session (paused:auth) resume; a quota pause lifts on its own.
const RESUMABLE = new Set(['interrupted', 'paused:auth']);

export function RunView({ detail, events, ended, error, loadStep, readmeAction, redeployAction, reprocessAction, stopAction, resumeAction }: { detail: RunDetail; events: StoredEvent[]; ended: boolean; error: string | null; loadStep: (stepId: string) => Promise<{ prompt: string; output: unknown }>; readmeAction?: ReadmeAction; redeployAction?: RedeployAction; reprocessAction?: ReprocessAction; stopAction?: StopAction; resumeAction?: ResumeAction }) {
  const unique = events.filter((e, i) => events.findIndex((x) => x.seq === e.seq) === i);
  const state = runState(unique);
  const finished = [...unique].reverse().find((e) => e.type === 'RUN_FINISHED');
  // The journal wins while it streams; before the first event and after the stream ends the server's snapshot is authoritative.
  // Except for 'interrupted': a dead process writes nothing, so the journal alone would read as running forever.
  // Only the server can tell (it checks the pid), and `detail` is re-fetched periodically to pick that up live.
  // The server turns the delivering run done once its spec is concluded; the journal never records that.
  const result = finished ? String(finished.data.result) : null;
  const status = result === 'awaiting-validation' && detail.status === 'done' ? 'done' : result ?? (detail.status === 'interrupted' ? 'interrupted' : ended || unique.length === 0 ? detail.status : state.status);
  const until = pausedUntil(unique);
  const t = tokens(unique);
  const phaseList = phases(unique);
  const activity = phaseActivity(unique);
  const [selected, setSelected] = useState<string | null>(null);
  // The trigger gets focus back when the dialog closes.
  const [opened, setOpened] = useState<(DetailTarget & { opener: HTMLElement }) | null>(null);
  const openDetail = (target: DetailTarget) => (e: ReactMouseEvent<HTMLButtonElement>) => setOpened({ ...target, opener: e.currentTarget });
  const groups = ORDER.map((s) => [s, state.order.filter((id) => state.tasks.get(id)!.state === s)] as const).filter(([, ids]) => ids.length);
  // Before the run finishes, RUN_FINISHED.blocked does not exist yet: a task stuck mid-run still shows its own cause,
  // from its own TASK_BLOCKED event, instead of waiting for the whole run to stop before anyone can see why.
  const blocked = (finished?.data.blocked as Array<{ taskId: string; reason: string }> | undefined) ?? liveBlocked(unique, state.order.filter((id) => state.tasks.get(id)!.state === 'blocked'));
  const causes = rootBlockers(blocked);
  // Tasks blocked for the same reason are one cause, listed once with all their ids.
  const causeGroups = causes.reduce<Array<{ reason: string; taskIds: string[] }>>((acc, c) => {
    const group = acc.find((g) => g.reason === c.reason);
    if (group) group.taskIds.push(c.taskId);
    else acc.push({ reason: c.reason, taskIds: [c.taskId] });
    return acc;
  }, []);
  // A phase-failed run stopped at its last failed phase; earlier ones (a failed verification) did not stop it.
  const failedPhase = [...phaseList].reverse().find((p) => p.result === 'failed')?.phase ?? null;
  const stop = stopSummary({ status, reason: finished?.data.reason ? String(finished.data.reason) : null, causes, deployFailure: lastDeployFailure(unique) ?? detail.report?.deploy?.lastFailure ?? null, failedPhase });
  const before = stop ? stopBefore(status, blocked) : null;
  const redeploying = !detail.locked && stop?.action === 'redeploy' && redeployAction !== undefined;
  const prs = mergedPrs(unique);
  const totalTasks = state.order.length;
  // Merged is the only finished state, so the bar also shows work in flight and blocked work: otherwise a run
  // sits at "0 de N" for as long as its tasks are being implemented, validated and reviewed.
  const tally = [...state.tasks.values()].reduce((acc, t) => {
    if (t.state === 'merged') acc.merged += 1;
    else if (IN_FLIGHT.has(t.state)) acc.active += 1;
    else if (t.state === 'blocked') acc.blocked += 1;
    return acc;
  }, { merged: 0, active: 0, blocked: 0 });
  const doneTasks = tally.merged;
  const blockedTasks = [...state.tasks.values()].filter((t) => t.state === 'blocked').length;
  const closeDetail = () => setOpened(null);
  let detailDialog: ReactNode = null;
  if (opened?.kind === 'outcome' && stop) {
    detailDialog = (
      <Dialog title="Detalhe técnico" onClose={closeDetail} returnFocus={opened.opener}>
        <p className="failure-lead">{stop.what} O texto abaixo é o motivo como o orquestrador o registrou.</p>
        <pre className="failure-raw">{stop.raw}</pre>
      </Dialog>
    );
  }
  const openedPhase = opened?.kind === 'phase' ? phaseList.find((p) => p.phase === opened.phase) : undefined;
  if (opened && openedPhase) {
    const failed = openedPhase.result === 'failed';
    const why = explainPhase(openedPhase);
    const { items, steps: agentSteps } = activity.get(openedPhase.phase) ?? { items: [], steps: [] };
    const problems = items.filter((i) => i.tone === 'bad');
    const [label, tone] = phaseState(openedPhase, status, blockedTasks);
    detailDialog = (
      <Dialog title={failed ? `${phaseTitle(openedPhase.phase)} falhou` : phaseTitle(openedPhase.phase)} onClose={closeDetail} returnFocus={opened.opener}>
        <Facts
          rows={[
            ['Situação', <span className={tone ? `status-pill tone-${tone}` : 'status-pill'}>{label}</span>],
            ['Início', hhmm(openedPhase.startedAt)],
            openedPhase.endedAt ? ['Duração', formatDuration(Date.parse(openedPhase.endedAt) - Date.parse(openedPhase.startedAt))] : null,
            openedPhase.attempt > 1 ? ['Tentativa', `${openedPhase.attempt}ª`] : null,
            failed ? ['O que aconteceu', why.title] : null,
            failed ? ['Quem resolve', ownerChip(why.owner)] : null,
            failed ? ['Próximo passo', why.hint] : null,
          ]}
        />
        {problems.length ? (
          <section className="failure-section" data-testid="phase-problems">
            <h3>Problemas</h3>
            <ActivityList items={problems} />
          </section>
        ) : null}
        <section className="failure-section" data-testid="phase-timeline">
          <h3>O que foi feito</h3>
          {items.length ? <ActivityList items={items} /> : <p className="hint">Nenhum acontecimento registrado nesta fase ainda.</p>}
          {openedPhase.phase === 3 ? <p className="hint">O trabalho de cada tarefa fica no card Tarefas: clique numa tarefa para ver as etapas dela.</p> : null}
        </section>
        {agentSteps.length ? (
          <section className="failure-section">
            <h3>Etapas dos agentes</h3>
            <StepList steps={agentSteps} loadStep={loadStep} />
          </section>
        ) : null}
        {openedPhase.reason ? (
          <section className="failure-section">
            <h3>Texto técnico</h3>
            <pre className="failure-raw">{openedPhase.reason}</pre>
          </section>
        ) : null}
      </Dialog>
    );
  }
  const openedCause = opened?.kind === 'cause' ? causeGroups.find((g) => g.reason === opened.reason) : undefined;
  if (opened && openedCause) {
    const why = explainStop(openedCause.reason);
    const text = explainBlockReason(openedCause.reason);
    const ids = openedCause.taskIds;
    detailDialog = (
      <Dialog title={ids.length === 1 ? `Por que ${ids[0]} ficou bloqueada` : `Por que ${ids.length} tarefas ficaram bloqueadas`} onClose={closeDetail} returnFocus={opened.opener}>
        <Facts rows={[[ids.length === 1 ? 'Tarefa' : 'Tarefas', ids.join(', ')], why ? ['O que aconteceu', why.title] : null, ['Quem resolve', ownerChip(why?.owner ?? 'Sistema')], ['Próximo passo', why?.hint ?? 'Leia o motivo abaixo. Quando a causa estiver resolvida, reprocesse a spec.']]} />
        <section className="failure-section">
          <h3>Motivo registrado</h3>
          <div className="failure-text">
            {text.split(/\n\s*\n/).map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </section>
        {text !== openedCause.reason ? (
          <section className="failure-section">
            <h3>Texto técnico</h3>
            <pre className="failure-raw">{openedCause.reason}</pre>
          </section>
        ) : null}
      </Dialog>
    );
  }
  // Only an older server sends no repoUrl, and then a merged PR URL names the repository; null means no GitHub address is known.
  const repoUrl = detail.repoUrl === undefined ? prs.find((p) => p.url)?.url?.replace(/\/pull\/\d+.*$/, '') ?? null : detail.repoUrl;
  return (
    <main className="run-page">
      <nav className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/projects" aria-label="Voltar para projetos">
          <Icon name="home" size={16} />
          <span>Projetos</span>
        </Link>
        <span aria-hidden="true">›</span>
        <Link to={`/projects/${detail.projectId}`}>{detail.projectId}</Link>
        <span aria-hidden="true">›</span>
        <span>{detail.specId}</span>
        <span aria-hidden="true">›</span>
        <strong>{runLabel(detail.runId)}</strong>
      </nav>
      <header className="card run-head">
        <div className="run-head-main">
          <h1>{detail.runId}</h1>
          <div className="run-meta">
            <span data-testid="status" className={`status-pill tone-${statusTone(status)}`}>
              {statusLabel(status)}
              {ended ? ' (encerrada)' : ''}
            </span>
            <span className="hint">
              {detail.projectId} / {detail.specId}
            </span>
            {until ? <span data-testid="paused-until" className="hint">pausada até {hhmm(until)}</span> : null}
            {status === 'interrupted' ? <span data-testid="interrupted-hint" className="hint">o processo não está mais rodando; use Retomar</span> : null}
          </div>
        </div>
        <div className="run-actions">
          {resumeAction && !detail.locked && RESUMABLE.has(status) ? (
            <button type="button" className="primary-button run-action" data-testid="resume" disabled={resumeAction.busy} onClick={resumeAction.onResume}>
              <Icon name="play" size={16} />
              {resumeAction.busy ? 'Retomando…' : 'Retomar'}
            </button>
          ) : null}
          {stopAction && STOPPABLE.has(status) ? (
            <button type="button" className="secondary run-action" data-testid="stop" disabled={stopAction.busy} onClick={stopAction.onStop}>
              <Icon name="stop" size={16} />
              {stopAction.busy ? 'Parando…' : 'Parar execução'}
            </button>
          ) : null}
          {detail.report ? (
            <Link className="link-button run-action" data-testid="validation-link" to={`/runs/${detail.runId}/validation`}>
              Validação
              <Icon name="arrow-right" size={16} />
            </Link>
          ) : null}
          {repoUrl ? (
            <a className="primary-button run-action" data-testid="github-link" href={repoUrl} target="_blank" rel="noreferrer">
              <Icon name="github" size={16} />
              Abrir no GitHub
              <Icon name="external" size={16} />
            </a>
          ) : null}
        </div>
        {resumeAction?.error ? <p className="error" data-testid="resume-error">{resumeAction.error}</p> : null}
        {detail.locked ? (
          <p className="hint" data-testid="locked-notice">
            Esta execução é somente leitura porque a spec foi concluída. Para a próxima entrega, crie uma <Link to={`/projects/${detail.projectId}`}>nova spec no projeto</Link>.
          </p>
        ) : null}
        {stopAction?.error ? <p className="error" data-testid="stop-error">{stopAction.error}</p> : null}
        {totalTasks ? (
          <div className="run-progress">
            <div className="run-progress-bar" role="progressbar" aria-label="Tarefas mescladas" aria-valuemin={0} aria-valuemax={totalTasks} aria-valuenow={doneTasks} aria-valuetext={`${doneTasks} de ${totalTasks} mescladas, ${tally.active} em andamento, ${tally.blocked} bloqueadas`}>
              {tally.merged ? <span className="seg-merged" style={{ flexBasis: `${(tally.merged / totalTasks) * 100}%` }} /> : null}
              {tally.active ? <span className="seg-active" style={{ flexBasis: `${(tally.active / totalTasks) * 100}%` }} /> : null}
              {tally.blocked ? <span className="seg-blocked" style={{ flexBasis: `${(tally.blocked / totalTasks) * 100}%` }} /> : null}
            </div>
            <p className="run-summary">
              <span>
                <span data-testid="task-progress">
                  {doneTasks} de {totalTasks} tarefas mescladas
                </span>
                <InfoTip label="Tarefas mescladas" text={TIP.merged} />
              </span>
              {tally.active ? (
                <span data-testid="task-active" className="progress-active">
                  {tally.active} em andamento
                </span>
              ) : null}
              {tally.blocked ? (
                <span data-testid="task-blocked" className="progress-blocked">
                  {tally.blocked} {tally.blocked === 1 ? 'bloqueada' : 'bloqueadas'}
                </span>
              ) : null}
              <span>
                {steps(t.total.steps)}
                <InfoTip label="Etapas" text={TIP.steps} />
              </span>
              <span>
                {money(t.total.costUsd)}
                <InfoTip label="Custo estimado" text={TIP.cost} />
              </span>
            </p>
          </div>
        ) : null}
      </header>
      {stop ? (
        <section className="card outcome-banner" data-testid="outcome-banner" aria-labelledby="run-outcome-title">
          <h2 id="run-outcome-title" className="outcome-title">
            <Icon name="alert" size={18} />
            {stop.what}
          </h2>
          <dl className="outcome-rows">
            <div>
              <dt>Por quê</dt>
              <dd>
                <strong>{stop.title}</strong>
                {stop.raw ? (
                  <button type="button" className="secondary run-detail-button" data-testid="outcome-detail" onClick={openDetail({ kind: 'outcome' })}>
                    Ver detalhe técnico
                  </button>
                ) : null}
              </dd>
            </div>
            {before ? (
              <div>
                <dt>Antes disso</dt>
                <dd data-testid="outcome-before">{before}</dd>
              </div>
            ) : null}
            {stop.rollback ? (
              <div>
                <dt>Estado</dt>
                <dd data-testid="outcome-rollback">{stop.rollback}</dd>
              </div>
            ) : null}
            <div>
              <dt>
                Quem resolve
                <InfoTip label="Quem resolve" text={TIP.owner} />
              </dt>
              <dd>{ownerChip(stop.owner, 'outcome-owner')}</dd>
            </div>
            <div>
              <dt>Próximo passo</dt>
              <dd>
                <p data-testid="outcome-hint">{stop.hint}</p>
                <div className="outcome-actions">
                  {redeploying ? (
                    <button type="button" className="primary-button" data-testid="redeploy" disabled={redeployAction.busy} onClick={redeployAction.onRedeploy}>
                      {redeployAction.busy ? 'Iniciando o deploy…' : 'Tentar deploy de novo'}
                    </button>
                  ) : null}
                  {reprocessAction && !detail.locked ? (
                    <span className="outcome-action">
                      <button type="button" className={redeploying ? 'secondary' : 'primary-button'} data-testid="reprocess" disabled={reprocessAction.busy} onClick={reprocessAction.onReprocess}>
                        <Icon name="refresh" size={16} />
                        {reprocessAction.busy ? 'Iniciando nova run…' : 'Reprocessar'}
                      </button>
                      <InfoTip label="Reprocessar" text={TIP.reprocess} />
                    </span>
                  ) : null}
                  {detail.report ? (
                    <Link className="link-button" to={`/runs/${detail.runId}/validation`}>
                      Ver relatório
                      <Icon name="arrow-right" size={16} />
                    </Link>
                  ) : null}
                </div>
                {redeployAction?.error ? <p className="error" data-testid="redeploy-error">{redeployAction.error}</p> : null}
                {reprocessAction?.error ? <p className="error" data-testid="reprocess-error">{reprocessAction.error}</p> : null}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
      <div className="run-grid">
        <div className="run-col">
          {causeGroups.length ? (
            <section className="card" data-testid="block-cause">
              <div className="run-panel-head">
                <h2>Tarefas bloqueadas</h2>
                <InfoTip label="Tarefas bloqueadas" text={TIP.blocked} />
              </div>
              {!stop && stopAction && STOPPABLE.has(status) ? (
                <p className="hint" data-testid="block-cause-live-hint">
                  A run continua com as outras tarefas. Veja o motivo em cada uma; se nenhuma vai se resolver sozinha, pare a execução para liberar o reprocessamento.
                </p>
              ) : null}
              <ul className="cause-list">
                {causeGroups.map((g) => (
                  <li key={g.reason} data-testid="cause-group" className="cause-row">
                    <span className="cause-tasks">
                      {g.taskIds.map((id) => (
                        <button key={id} type="button" className="task-id" onClick={() => setSelected(id)}>
                          {id}
                        </button>
                      ))}
                    </span>
                    <span className="cause-title">{explainStop(g.reason)?.title ?? firstSentence(explainBlockReason(g.reason))}</span>
                    <button type="button" className="secondary run-detail-button" aria-label={`Ver detalhe do bloqueio de ${g.taskIds.join(', ')}`} onClick={openDetail({ kind: 'cause', reason: g.reason })}>
                      Ver detalhe
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="card run-readme" data-testid="readme">
            <header>
              <h2>README do projeto</h2>
              <span className="run-readme-path">docs/README.md</span>
              {readmeAction && !detail.locked ? (
                <button type="button" className="secondary run-readme-action" data-testid="readme-generate" disabled={readmeAction.busy} onClick={readmeAction.onGenerate}>
                  {readmeAction.busy ? 'O sm está escrevendo…' : detail.readme ? 'Reescrever com o sm' : 'Gerar README com o sm'}
                </button>
              ) : null}
            </header>
            {readmeAction?.error ? <p className="error" data-testid="readme-error">{readmeAction.error}</p> : null}
            {detail.readme ? (
              <Markdown source={detail.readme} />
            ) : (
              <p className="hint" data-testid="readme-empty">
                Nenhum README gerado ainda. O Scrum Master (sm) escreve o resumo do projeto na fase de relatório, ao fim da run.
              </p>
            )}
          </section>
          {error ? <p className="error">{error}</p> : null}
          <section className="card">
            <h2>Tarefas</h2>
            {groups.length === 0 ? <p className="hint">Nenhuma tarefa planejada ainda.</p> : null}
            {groups.map(([s, ids]) => (
              <div key={s} className="task-group" data-testid={`group-${s}`}>
                <h3>
                  {statusLabel(s)} <span className="count">{ids.length}</span>
                </h3>
                <ul>
                  {ids.map((id) => {
                    const tk = state.tasks.get(id)!;
                    return (
                      <li key={id} className="task-row">
                        <button className="task-id" data-testid={`task-${id}`} onClick={() => setSelected(id)}>
                          {id}
                        </button>
                        <span className="task-title">{tk.def.title}</span>
                        {tk.def.service ? <span className="tag" title="Serviço">{tk.def.service}</span> : null}
                        <span className="task-meta">
                          {tk.attempts > 0 ? `${tk.attempts} ${tk.attempts === 1 ? 'tentativa' : 'tentativas'}` : null}
                          {tk.replanned ? <span className="tag">replanejada</span> : null}
                          {tk.def.origin && tk.def.origin !== 'plan' ? <span className={`tag tag-${tk.def.origin}`}>{tk.def.origin}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
          {detail.plan ? <PlanCard plan={detail.plan} /> : null}
          {selected ? <TaskDetail events={unique} taskId={selected} loadStep={loadStep} /> : null}
          <EvidenceCard criteria={detail.acceptanceCriteria} rows={evidence(unique, detail.acceptanceCriteria.map((c) => c.id))} />
        </div>
        <aside className="run-col run-aside">
          {status === 'running' || status === 'draining' || status.startsWith('paused') ? <NowCard events={unique} /> : null}
          <section className="card">
            <div className="run-panel-head">
              <h2>Fases</h2>
              <InfoTip label="Fases" text={TIP.phases} />
            </div>
            {phaseList.length ? (
              <ol className="run-phases">
                {phaseList.map((p) => {
                  const [label, tone] = phaseState(p, status, blockedTasks);
                  const problems = activity.get(p.phase)?.items.filter((i) => i.tone === 'bad').length ?? 0;
                  return (
                    <li key={p.phase} data-testid="phase" className="phase">
                      <button type="button" className="phase-name phase-link" aria-label={`Ver o que aconteceu em ${phaseTitle(p.phase)}`} onClick={openDetail({ kind: 'phase', phase: p.phase })}>
                        {phaseTitle(p.phase)}
                      </button>{' '}
                      <span className={tone ? `status-pill tone-${tone}` : 'status-pill'}>{label}</span>
                      {p.attempt > 1 ? <span className="phase-meta">{p.attempt}ª tentativa</span> : null}
                      {problems && p.result !== 'failed' ? (
                        <span className="phase-meta phase-warn" data-testid="phase-problems-count">
                          {problems === 1 ? '1 problema registrado' : `${problems} problemas registrados`}
                        </span>
                      ) : null}
                      {p.result === 'failed' ? (
                        <div className="phase-failure">
                          <p>
                            <strong>O que fazer:</strong> {explainPhase(p).hint}
                          </p>
                          <button type="button" className="secondary run-detail-button" aria-label={`Ver detalhe da falha em ${phaseTitle(p.phase)}`} onClick={openDetail({ kind: 'phase', phase: p.phase })}>
                            Ver detalhe
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="hint">Nenhuma fase iniciada ainda.</p>
            )}
          </section>
          {prs.length ? (
            <section className="card">
              <h2>Pull requests mesclados</h2>
              <ul className="pr-list">
                {prs.map((p) => (
                  <li key={p.taskId}>
                    <span className="task-id">{p.taskId}</span>
                    {safeHttpUrl(p.url) ? (
                      <a href={safeHttpUrl(p.url)} target="_blank" rel="noreferrer">
                        PR #{p.number}
                        <Icon name="external" size={14} />
                      </a>
                    ) : (
                      <span>PR #{p.number}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="card">
            <h2>Consumo dos modelos</h2>
            <dl className="usage-totals" data-testid="tokens-total">
              <div>
                <dt>
                  Custo estimado
                  <InfoTip label="Custo estimado" text={TIP.cost} />
                </dt>
                <dd className="usage-total-cost">{money(t.total.costUsd)}</dd>
              </div>
              <div>
                <dt>
                  Tokens de entrada
                  <InfoTip label="Tokens de entrada" text={TIP.input} />
                </dt>
                <dd>{t.total.inputTokens}</dd>
              </div>
              <div>
                <dt>
                  Contexto em cache
                  <InfoTip label="Contexto em cache" text={TIP.cache} />
                </dt>
                <dd>{t.total.cacheReadTokens + t.total.cacheWriteTokens}</dd>
              </div>
              <div>
                <dt>
                  Tokens de saída
                  <InfoTip label="Tokens de saída" text={TIP.output} />
                </dt>
                <dd>{t.total.outputTokens}</dd>
              </div>
              <div>
                <dt>
                  Etapas
                  <InfoTip label="Etapas" text={TIP.steps} />
                </dt>
                <dd>{t.total.steps}</dd>
              </div>
            </dl>
            {Object.keys(t.byRole).length ? <UsageList title="Por agente" tip={TIP.byRole} rows={Object.entries(t.byRole)} label={roleName} testIdPrefix="tokens-" /> : null}
            {Object.keys(t.byPhase).length ? <UsageList title="Por fase" tip={TIP.byPhase} rows={Object.entries(t.byPhase)} label={(key) => PHASE_LABEL[key] ?? key} /> : null}
          </section>
        </aside>
      </div>
      {detailDialog}
    </main>
  );
}

// The start route answers 409 in English when the spec already has a live run.
const reprocessError = (message: string) => {
  const live = /already has run (\S+) \(([^)]+)\)/.exec(message);
  return live ? `Esta spec já tem a run ${live[1]} (${statusLabel(live[2]!)}). Abra essa run em vez de iniciar outra.` : `Não foi possível reprocessar: ${message}`;
};

// The stop route answers 409 in English when the pid file is gone: the process already died (the status pill should
// already say "interrompida" by the next poll) or it was never spawned by this UI (started from a terminal).
const stopError = (message: string) =>
  /has no live process started from the UI/.test(message)
    ? 'Esse processo já não está rodando (ou nunca foi iniciado por esta UI). Atualize a página; se a run continuar como interrompida, use Retomar.'
    : `Não foi possível parar: ${message}`;

export function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  // Reprocessar opens the new run on this same route: a fresh instance keeps none of the old run's state.
  return <RunScreen key={runId} runId={runId} />;
}

function RunScreen({ runId }: { runId: string | undefined }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writerRun, setWriterRun] = useState<string | null>(null);
  const [readmeError, setReadmeError] = useState<string | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessFailure, setReprocessFailure] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopFailure, setStopFailure] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeFailure, setResumeFailure] = useState<string | null>(null);
  useEffect(() => {
    if (runId)
      runApi
        .run(runId)
        .then(setDetail)
        .catch((e: Error) => setLoadError(e.message));
  }, [runId]);
  // A dead process writes nothing to the journal, so the live SSE tail alone would read as running forever; only the
  // server can tell (it checks the pid), hence this periodic re-fetch of its one-shot status.
  useEffect(() => {
    if (!runId) return;
    const id = setInterval(() => {
      runApi.run(runId).then(setDetail).catch(() => undefined);
    }, 7000);
    return () => clearInterval(id);
  }, [runId]);
  // The README is written by a separate `spec readme` run; follow it until it ends, then reload this run's README.
  useEffect(() => {
    if (!writerRun || !runId) return;
    const id = setInterval(() => {
      runApi
        .run(writerRun)
        .then(async (writer) => {
          if (['running', 'draining'].includes(writer.status) || writer.status.startsWith('paused')) return;
          setWriterRun(null);
          if (writer.status !== 'done') setReadmeError(`O sm não conseguiu escrever o README (${writer.status}). Veja a run ${writerRun}.`);
          setDetail(await runApi.run(runId));
        })
        .catch((e: Error) => {
          setWriterRun(null);
          setReadmeError(e.message);
        });
    }, 4000);
    return () => clearInterval(id);
  }, [writerRun, runId]);
  const generateReadme = () => {
    if (!runId) return;
    setReadmeError(null);
    runApi
      .writeReadme(runId)
      .then((r) => setWriterRun(r.runId))
      .catch((e: Error) => setReadmeError(e.message));
  };
  const reprocess = () => {
    if (!detail) return;
    setReprocessing(true);
    setReprocessFailure(null);
    runApi
      .startRun(detail.projectId, detail.specId)
      .then((r) => navigate(`/runs/${r.runId}`))
      .catch((e: Error) => {
        setReprocessing(false);
        setReprocessFailure(reprocessError(e.message));
      });
  };
  const stopExecution = () => {
    if (!runId) return;
    setStopping(true);
    setStopFailure(null);
    runApi
      .stopRun(runId)
      .then(() => setStopping(false))
      .catch((e: Error) => {
        setStopping(false);
        setStopFailure(stopError(e.message));
      });
  };
  const resumeExecution = () => {
    if (!runId) return;
    setResuming(true);
    setResumeFailure(null);
    runApi
      .resumeRun(runId)
      .then(() => runApi.run(runId))
      .then((d) => {
        setResuming(false);
        setDetail(d);
      })
      .catch((e: Error) => {
        setResuming(false);
        setResumeFailure(e.message);
      });
  };
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
        <Loading />
      </main>
    );
  return (
    <RunView
      detail={detail}
      events={events}
      ended={ended}
      error={error}
      loadStep={(stepId) => runApi.step(runId, stepId)}
      readmeAction={{ onGenerate: generateReadme, busy: writerRun !== null, error: readmeError }}
      reprocessAction={{ onReprocess: reprocess, busy: reprocessing, error: reprocessFailure }}
      stopAction={{ onStop: stopExecution, busy: stopping, error: stopFailure }}
      resumeAction={{ onResume: resumeExecution, busy: resuming, error: resumeFailure }}
    />
  );
}
