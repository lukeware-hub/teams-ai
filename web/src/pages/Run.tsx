import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { parseRunId } from '@server/core/ids';
import { runApi, startedPath, type RunDetail, type StoredEvent } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Dialog } from '../components/Dialog.js';
import { Icon, type IconName } from '../components/Icons.js';
import { InfoTip, Tipped } from '../components/InfoTip.js';
import { STATUS_HELP } from './project-shared.js';
import { Loading } from '../components/Loading.js';
import { Markdown } from '../components/Markdown.js';
import { safeHttpUrl } from '../safeUrl.js';
import { StepList } from '../components/StepList.js';
import { TaskDetail } from '../components/TaskDetail.js';
import { Workspace } from '../components/Workspace.js';
import { type ModelUse, currentActivity, evidence, explainBlockReason, explainPhase, explainStop, firstSentence, formatDuration, lastDeployFailure, liveBlocked, mergedPrs, pausedUntil, phaseActivity, phases, phaseState, phaseTitle, rootBlockers, runState, stepDoing, stopBefore, stopSummary, tokens, type ActivityItem, type PhaseRow, type StopOwner } from '../run/selectors.js';
import { useJournal } from '../useSse.js';

// A panel title with its info tip right beside it, not pushed to the far edge.
const HEAD_ROW = 'flex items-center gap-[0.35rem] [&_h2]:min-w-0 [&_h2]:flex-[0_1_auto]';
// Class lists the Validation screen reuses, since it shares this screen's shell.
export const RUN_UI = {
  // Agent text carries long unbroken tokens (paths, hashes, JSON), so no card may overflow its column.
  page: 'flex flex-col gap-4 lg:h-full lg:min-h-0 [&_.card]:wrap-anywhere',
  head: 'card grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-4 px-6 py-[1.35rem] max-md:grid-cols-1',
  title: 'm-0 font-bold wrap-anywhere',
  meta: 'mt-2 flex flex-wrap items-center gap-x-3 gap-y-2',
  // On narrow screens the buttons fill the row and wrap whole, never squeezing their labels.
  actions: 'flex flex-wrap justify-end gap-2 max-md:justify-stretch max-md:[&>*]:flex-auto',
  action: 'inline-flex min-h-[var(--control-height)] relative pointer-coarse:after:absolute pointer-coarse:after:-inset-[3px] pointer-coarse:after:content-[""] items-center justify-center gap-2 rounded-control px-[0.95rem] text-[0.875rem] font-semibold whitespace-nowrap no-underline',
  columns: 'lg:grid-cols-[minmax(0,1fr)_20rem]',
  column: 'grid min-w-0 content-start gap-5',
  aside: 'grid min-w-0 content-start gap-5 [&_.card]:px-[1.15rem] [&_.card]:py-[1.1rem]',
  asideNote: 'mt-0 mb-3',
  headRow: HEAD_ROW,
  panelHead: `mb-[0.85rem] ${HEAD_ROW}`,
  cardTitle: 'flex items-center justify-between gap-4',
  boxList: 'm-0 list-none divide-y divide-line overflow-hidden rounded-lg border border-line p-0',
  banner: 'card border-bad-line',
  bannerTitle: 'mb-[0.9rem] flex items-center gap-2 text-bad [&_svg]:flex-none',
  bannerRows:
    'm-0 grid [&>div]:grid [&>div]:grid-cols-[9rem_minmax(0,1fr)] [&>div]:gap-3 [&>div]:border-t [&>div]:border-line [&>div]:py-[0.7rem] max-md:[&>div]:grid-cols-1 max-md:[&>div]:gap-1 [&_dt]:flex [&_dt]:items-center [&_dt]:gap-1 [&_dt]:self-start [&_dt]:pt-[0.1rem] [&_dt]:text-[0.8125rem] [&_dt]:font-semibold [&_dt]:text-ink-soft [&_dd]:m-0 [&_dd]:grid [&_dd]:min-w-0 [&_dd]:justify-items-start [&_dd]:gap-2 [&_dd]:text-ink [&_dd_p]:m-0',
  raw: 'm-0 rounded-md border border-line bg-surface-sunken px-[0.9rem] py-3 text-[0.78rem] leading-normal whitespace-pre-wrap text-ink wrap-anywhere',
  totals:
    'm-0 grid gap-[0.4rem] [&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-3 [&_dt]:inline-flex [&_dt]:min-w-0 [&_dt]:items-center [&_dt]:gap-1 [&_dt]:text-[0.8125rem] [&_dt]:text-ink-soft [&_dd]:m-0 [&_dd]:text-right [&_dd]:text-[0.8125rem] [&_dd]:text-ink [&_dd]:tabular-nums',
};
const TASK_ID = 'font-mono text-[0.8125rem] font-semibold';
// A task id as a text button, underlined on hover.
const TASK_ID_BUTTON = `h-auto flex-none border-0 bg-transparent p-0 text-left text-accent-text underline-offset-[3px] hover:bg-transparent hover:underline ${TASK_ID}`;
// The compact secondary button that opens a failure's detail dialog, with a 44px hit area on touch.
const DETAIL_BUTTON = 'secondary h-10 flex-none px-3 text-[0.8125rem] pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1.5';
// On narrow screens a title keeps a readable width instead of squeezing beside its id and chips.
const ROW_TITLE = 'min-w-0 flex-1 text-ink max-md:basis-32';
const FACT_ROWS = 'm-0 grid gap-[0.6rem] [&>div]:grid [&>div]:grid-cols-[8.5rem_minmax(0,1fr)] [&>div]:gap-3 max-md:[&>div]:grid-cols-1 max-md:[&>div]:gap-1 [&_dt]:text-[0.8125rem] [&_dt]:font-semibold [&_dt]:text-ink-soft [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:wrap-anywhere';
const SECTION_TITLE = 'mt-0 mb-[0.4rem]';
const META = 'col-span-full text-[0.75rem] tabular-nums';

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
const ROLE_LABEL: Record<string, string> = { dev: 'Desenvolvimento', sm: 'Scrum Master', po: 'Product Owner', test: 'Testes', sec: 'Segurança', devops: 'DevOps', env: 'Ambiente', system1: 'Decisões automáticas' };
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

const MODEL_NAME: Record<string, string> = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5', haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
const EFFORT_NAME: Record<string, string> = { low: 'baixo', medium: 'médio', high: 'alto', max: 'máximo' };
/** One line per model and effort an agent ran on; runs journaled before the effort was recorded say so. */
const modelUseLabel = (u: ModelUse) => `${MODEL_NAME[u.model] ?? u.model} · esforço ${u.effort ? (EFFORT_NAME[u.effort] ?? u.effort) : 'não registrado'} · ${steps(u.steps)}`;

function UsageList({ title, tip, rows, label, testIdPrefix, details }: { title: string; tip: string; rows: UsageRow[]; label: (key: string) => ReactNode; testIdPrefix?: string; details?: (key: string) => ReactNode }) {
  return (
    <>
      <div className="mt-[1.1rem] mb-1 flex items-center gap-1">
        <h3 className="m-0">{title}</h3>
        <InfoTip label={title} text={tip} />
      </div>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {rows.map(([key, u]) => (
          <li key={key} data-testid={testIdPrefix ? `${testIdPrefix}${key}` : undefined} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-[0.1rem] py-[0.55rem]">
            <span className="min-w-0 text-[0.875rem] font-semibold text-ink wrap-anywhere">{label(key)}</span>
            <span className="text-right text-[0.8125rem] text-ink tabular-nums">{money(u.costUsd)}</span>
            <span className={`${META} text-ink-soft`}>
              {u.inputTokens} entrada · {u.outputTokens} saída · {steps(u.steps)}
            </span>
            {details?.(key)}
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
      <span className="usage-id ml-[0.4rem] font-mono text-[0.75rem] font-normal text-ink-soft">{role}</span>
    </>
  ) : (
    role
  );

const OWNER_ICON: Record<string, IconName> = { dev: 'code', devops: 'server', test: 'check', sec: 'shield', po: 'clipboard', sm: 'list' };
const ORIGIN_LABEL: Record<string, string> = { fix: 'correção', 'deploy-fix': 'correção de deploy' };
const ORIGIN_HELP: Record<string, string> = { fix: 'Tarefa criada para corrigir um problema encontrado numa tarefa anterior.', 'deploy-fix': 'Tarefa criada para corrigir uma falha do deploy.' };
const SERVICE_HELP = 'O serviço do projeto ao qual esta tarefa pertence.';
const PHASE_HELP: Record<string, string> = {
  concluída: 'A fase terminou.',
  falhou: 'A fase falhou. Abra a fase para ver o que aconteceu.',
  'em execução': 'A fase está rodando agora.',
  interrompida: 'O processo parou no meio desta fase. Use Retomar.',
  pausada: 'A execução está pausada por limite de uso ou por login. A fase continua quando isso se resolver.',
  'com bloqueios': 'A fase terminou, mas algumas tarefas ficaram bloqueadas.',
};
const PATHS_SHOWN = 3;
const FACET_ICON = 'inline-grid h-6 cursor-help place-items-center text-ink-faint';
const FACET_ITEMS = 'flex min-h-6 min-w-0 flex-wrap items-center gap-[0.35rem]';
const PLAN_PATH = 'rounded-sm border border-line bg-surface-sunken px-[0.4rem] py-[0.05rem] text-[0.75rem] text-ink-soft wrap-anywhere';

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
      <div className={`mb-[0.9rem] ${RUN_UI.cardTitle}`}>
        <h2>
          Plano executável <InfoTip label="Plano executável" text="Como a spec foi dividida em tarefas. Cada tarefa tem um responsável, cumpre critérios de aceite (AC) e altera os arquivos listados. Sai da fase 2." />
        </h2>
        <span className="hint">
          {plan.tasks.length} {plan.tasks.length === 1 ? 'tarefa' : 'tarefas'}
        </span>
      </div>
      <dl className="m-0 mb-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-8 gap-y-3 rounded-lg border border-line bg-surface-sunken px-[0.9rem] py-[0.8rem] max-md:grid-cols-1 [&_code]:rounded-sm [&_code]:bg-surface-muted [&_code]:px-[0.35rem] [&_code]:py-[0.05rem] [&_code]:text-[0.78rem] [&_dd]:m-0 [&_dd]:text-[0.875rem] [&_dd]:text-ink [&_dd]:wrap-anywhere [&_dt]:flex [&_dt]:items-center [&_dt]:gap-[0.4rem] [&_dt]:text-[0.75rem] [&_dt]:font-semibold [&_dt]:text-ink-soft [&>div]:grid [&>div]:min-w-0 [&>div]:gap-[0.2rem]">
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
      <ul className={RUN_UI.boxList}>
        {plan.tasks.map((task) => {
          const open = expanded.has(task.id);
          const paths = open ? task.affectedPaths : task.affectedPaths.slice(0, PATHS_SHOWN);
          const hidden = task.affectedPaths.length - PATHS_SHOWN;
          const owner = ROLE_LABEL[task.owner] ?? task.owner;
          return (
            <li key={task.id} data-testid={`plan-task-${task.id}`} className="grid gap-2 px-[0.9rem] py-[0.8rem]">
              <div className="flex items-baseline gap-[0.85rem] max-md:flex-wrap">
                <span className={`min-w-[5.75rem] flex-none text-ink-soft ${TASK_ID}`}>{task.id}</span>
                <span className={`${ROW_TITLE} font-medium wrap-anywhere`}>{task.title}</span>
                <span className="inline-flex flex-none items-center gap-[0.4rem] [&_.tag]:m-0">
                  {task.service ? <Tipped text={SERVICE_HELP}><span className="tag" title="Serviço">{task.service}</span></Tipped> : null}
                  {task.origin !== 'plan' ? <Tipped text={ORIGIN_HELP[task.origin] ?? 'De onde esta tarefa veio.'}><span className="tag">{ORIGIN_LABEL[task.origin] ?? task.origin}</span></Tipped> : null}
                  <Tipped text={`Responsável pela tarefa: ${owner}.`}>
                    <span className="owner-chip" title={`Responsável pela tarefa: ${owner}`}>
                      <Icon name={OWNER_ICON[task.owner] ?? 'user'} size={14} />
                      {owner}
                    </span>
                  </Tipped>
                </span>
              </div>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-[0.6rem] gap-y-[0.4rem] pl-[6.6rem] max-md:pl-0">
                <span className={FACET_ICON} role="img" aria-label="Critérios de aceite" title="Critérios de aceite que esta tarefa cumpre">
                  <Icon name="check" size={14} />
                </span>
                <span className={FACET_ITEMS}>
                  {task.criteriaRefs.length ? task.criteriaRefs.map((ac) => <span key={ac} className="rounded-sm bg-accent-soft px-[0.45rem] py-[0.05rem] font-mono text-[0.75rem] font-semibold text-accent-ink">{ac}</span>) : <span className="hint">Sem critério direto</span>}
                </span>
                <span className={FACET_ICON} role="img" aria-label="Arquivos alterados" title="Arquivos que esta tarefa cria ou altera">
                  <Icon name="file" size={14} />
                </span>
                <span className={FACET_ITEMS}>
                  {paths.map((path) => <code key={path} className={PLAN_PATH}>{path}</code>)}
                  {hidden > 0 ? (
                    <button type="button" className="min-w-[auto] h-6 border-0 bg-transparent px-[0.45rem] text-[0.75rem] text-accent-text underline-offset-[3px] hover:bg-transparent hover:underline" aria-expanded={open} onClick={() => toggle(task.id)}>
                      {open ? 'Mostrar menos' : `+${hidden}`}
                    </button>
                  ) : null}
                </span>
                {task.dependsOn.length ? (
                  <>
                    <span className={FACET_ICON} role="img" aria-label="Depende de" title="Só começa depois que estas tarefas forem mescladas">
                      <Icon name="clock" size={14} />
                    </span>
                    <span className={FACET_ITEMS}>
                      {task.dependsOn.map((id) => <code key={id} className={PLAN_PATH}>{id}</code>)}
                    </span>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <details className="mt-[0.9rem]">
        <summary>Ver plan.json</summary>
        <pre className={RUN_UI.raw}>{JSON.stringify(plan, null, 2)}</pre>
      </details>
    </section>
  );
}

const TEST_RESULT: Record<string, { label: string; tone: string; icon: IconName; help?: string }> = {
  passed: { label: 'Passou', tone: 'good', icon: 'check', help: 'O teste rodou e passou.' },
  failed: { label: 'Falhou', tone: 'bad', icon: 'close', help: 'O teste rodou e falhou.' },
};
/** `test::[AC-001] health endpoint answers 200` reads as `health endpoint answers 200`; the full id stays in the tooltip. */
const testName = (id: string) => id.replace(/^.*?::/, '').replace(/^\[[^\]]+\]\s*/, '');

/** Acceptance-criteria coverage: each criterion with its text and the tests that prove it. */
function EvidenceCard({ criteria, rows }: { criteria: RunDetail['acceptanceCriteria']; rows: ReturnType<typeof evidence> }) {
  const covered = rows.filter((r) => r.tests.length > 0 && r.tests.every((t) => t.status === 'passed')).length;
  return (
    <section className="card" data-testid="evidence">
      <div className={`mb-[0.9rem] ${RUN_UI.cardTitle}`}>
        <h2>
          Evidências <InfoTip label="Evidências" text="Cada critério de aceite (AC) deve ter ao menos um teste automatizado passando. Aqui estão os testes ligados a cada critério, com o resultado da última rodada de cada um." />
        </h2>
        <span className="hint">
          {covered} de {rows.length} {rows.length === 1 ? 'critério coberto' : 'critérios cobertos'}
        </span>
      </div>
      <ul className={RUN_UI.boxList}>
        {rows.map((row) => {
          const criterion = criteria.find((c) => c.id === row.acId);
          const failed = row.tests.some((t) => t.status !== 'passed');
          const state = !row.tests.length ? { tone: 'neutral', icon: 'clock' as IconName, label: 'Sem teste ainda' } : failed ? { tone: 'bad', icon: 'close' as IconName, label: 'Há teste falhando' } : { tone: 'good', icon: 'check' as IconName, label: 'Coberto' };
          return (
            <li key={row.acId} data-testid={`evidence-${row.acId}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-[0.9rem] py-[0.85rem]">
              <span className={`grid size-6 flex-none place-items-center rounded-full tone-${state.tone}`} role="img" aria-label={state.label} title={state.label}>
                <Icon name={state.icon} size={14} />
              </span>
              <div className="grid min-w-0 gap-[0.4rem] [&_p]:m-0">
                <p className="flex min-h-6 items-center gap-2 [&_.tag]:m-0">
                  <span className={TASK_ID}>{row.acId}</span>
                  {criterion?.smoke ? <Tipped text="Também roda como teste rápido depois do deploy."><span className="tag" title="Também roda como teste rápido depois do deploy">smoke</span></Tipped> : null}
                </p>
                {criterion ? (
                  <p className="text-[0.875rem] leading-normal text-ink-soft wrap-anywhere [&_b]:font-semibold [&_b]:text-ink">
                    <b>Dado</b> {criterion.given} <b>quando</b> {criterion.when} <b>então</b> {criterion.then}
                  </p>
                ) : null}
                {row.tests.length ? (
                  <ul className="m-0 mt-[0.15rem] grid list-none gap-[0.4rem] p-0">
                    {row.tests.map((x) => {
                      const result = TEST_RESULT[x.status] ?? { label: x.status, tone: 'warn', icon: 'info' as IconName };
                      return (
                        <li key={x.id} title={x.id} className="flex flex-wrap items-center gap-x-[0.6rem] gap-y-1">
                          <Tipped text={result.help ?? 'O teste não rodou ou o resultado não é conhecido.'}>
                            <span className={`status-pill gap-[0.3rem] px-2 py-[0.05rem] text-[0.75rem] before:hidden tone-${result.tone}`}>
                              <Icon name={result.icon} size={12} />
                              {result.label}
                            </span>
                          </Tipped>
                          <span className="min-w-0 text-[0.875rem] text-ink wrap-anywhere">{testName(x.id)}</span>
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

const OWNER_TONE: Partial<Record<StopOwner, string>> = { Plano: 'text-warn bg-warn-soft', Você: 'text-bad bg-bad-soft' };
const OWNER_HELP: Record<StopOwner, string> = { Sistema: 'Quem precisa agir: o sistema, que resolve sozinho ou precisa de um ajuste da plataforma.', Plano: 'Quem precisa agir: o plano ou a spec precisa ser corrigido.', Você: 'Quem precisa agir: você.' };
const ownerChip = (owner: StopOwner, testId?: string) => (
  <Tipped text={OWNER_HELP[owner]}>
    <span className={`owner-chip ${OWNER_TONE[owner] ?? ''}`} data-testid={testId}>
      {owner}
    </span>
  </Tipped>
);

/** Label/value rows of a failure dialog; a null row is skipped. */
function Facts({ rows }: { rows: Array<[string, ReactNode] | null> }) {
  return (
    <dl className={FACT_ROWS}>
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

const ACTIVITY_TONE: Record<string, string> = { bad: 'text-bad', good: 'text-good' };

/** Plain-language events, oldest first, each with its time and link. */
function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <ol className="m-0 grid list-none gap-[0.4rem] p-0">
      {items.map((item, i) => (
        <li key={i} className={`grid grid-cols-[3rem_minmax(0,1fr)] gap-2 text-[0.8125rem] leading-[1.45] wrap-anywhere ${ACTIVITY_TONE[item.tone ?? ''] ?? ''}`}>
          <time dateTime={item.at} className="text-ink-soft tabular-nums">
            {hhmm(item.at)}
          </time>
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
      <div className={RUN_UI.panelHead}>
        <h2>Agora</h2>
        <InfoTip label="Agora" text={TIP.now} />
      </div>
      {running.length ? (
        <ul className="m-0 grid list-none gap-[0.6rem] p-0 text-[0.875rem] leading-[1.45]">
          {running.map((s) => (
            <li key={s.stepId} data-testid="now-step">
              <strong>{ROLE_LABEL[s.role] ?? s.role}</strong> {stepDoing(s.kind)}
              {s.taskId ? ` a tarefa ${s.taskId}` : ''}
              <span className="block text-[0.75rem] text-ink-soft tabular-nums">
                {s.model ? `${s.model} · ` : ''}há {formatDuration(now - Date.parse(s.startedAt))}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`hint ${RUN_UI.asideNote}`}>Nenhum agente trabalhando neste momento.</p>
      )}
      {last ? (
        <p className="mt-3 mb-0 border-t border-line pt-3 text-[0.8125rem] leading-[1.45]" data-testid="now-last">
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
        <p className="m-0 text-[0.875rem] text-ink-soft">{stop.what} O texto abaixo é o motivo como o orquestrador o registrou.</p>
        <pre className={RUN_UI.raw}>{stop.raw}</pre>
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
            ['Situação', <Tipped text={PHASE_HELP[label] ?? STATUS_HELP.unknown!}><span className={tone ? `status-pill tone-${tone}` : 'status-pill'}>{label}</span></Tipped>],
            ['Início', hhmm(openedPhase.startedAt)],
            openedPhase.endedAt ? ['Duração', formatDuration(Date.parse(openedPhase.endedAt) - Date.parse(openedPhase.startedAt))] : null,
            openedPhase.attempt > 1 ? ['Tentativa', `${openedPhase.attempt}ª`] : null,
            failed ? ['O que aconteceu', why.title] : null,
            failed ? ['Quem resolve', ownerChip(why.owner)] : null,
            failed ? ['Próximo passo', why.hint] : null,
          ]}
        />
        {problems.length ? (
          <section data-testid="phase-problems">
            <h3 className={SECTION_TITLE}>Problemas</h3>
            <ActivityList items={problems} />
          </section>
        ) : null}
        <section data-testid="phase-timeline">
          <h3 className={SECTION_TITLE}>O que foi feito</h3>
          {items.length ? <ActivityList items={items} /> : <p className="hint">Nenhum acontecimento registrado nesta fase ainda.</p>}
          {openedPhase.phase === 3 ? <p className="hint">O trabalho de cada tarefa fica no card Tarefas: clique numa tarefa para ver as etapas dela.</p> : null}
        </section>
        {agentSteps.length ? (
          <section>
            <h3 className={SECTION_TITLE}>Etapas dos agentes</h3>
            <StepList steps={agentSteps} loadStep={loadStep} />
          </section>
        ) : null}
        {openedPhase.reason ? (
          <section>
            <h3 className={SECTION_TITLE}>Texto técnico</h3>
            <pre className={RUN_UI.raw}>{openedPhase.reason}</pre>
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
        <section>
          <h3 className={SECTION_TITLE}>Motivo registrado</h3>
          <div>
            {text.split(/\n\s*\n/).map((paragraph, i) => (
              <p key={i} className="mt-0 mb-[0.6rem] whitespace-pre-line last:mb-0">
                {paragraph}
              </p>
            ))}
          </div>
        </section>
        {text !== openedCause.reason ? (
          <section>
            <h3 className={SECTION_TITLE}>Texto técnico</h3>
            <pre className={RUN_UI.raw}>{openedCause.reason}</pre>
          </section>
        ) : null}
      </Dialog>
    );
  }
  // Only an older server sends no repoUrl, and then a merged PR URL names the repository; null means no GitHub address is known.
  const repoUrl = detail.repoUrl === undefined ? prs.find((p) => p.url)?.url?.replace(/\/pull\/\d+.*$/, '') ?? null : detail.repoUrl;
  return (
    <main className={RUN_UI.page}>
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
      <header className={RUN_UI.head}>
        <div className="min-w-0">
          <h1 className={RUN_UI.title}>{detail.runId}</h1>
          <div className={RUN_UI.meta}>
            <Tipped text={STATUS_HELP[status] ?? STATUS_HELP.unknown!}>
              <span data-testid="status" className={`status-pill tone-${statusTone(status)}`}>
                {statusLabel(status)}
                {ended ? ' (encerrada)' : ''}
              </span>
            </Tipped>
            <span className="hint">
              {detail.projectId} / {detail.specId}
            </span>
            {until ? <span data-testid="paused-until" className="hint">pausada até {hhmm(until)}</span> : null}
            {status === 'interrupted' ? <span data-testid="interrupted-hint" className="hint">o processo não está mais rodando; use Retomar</span> : null}
          </div>
        </div>
        <div className={RUN_UI.actions}>
          {resumeAction && !detail.locked && RESUMABLE.has(status) ? (
            <ActionButton className={`primary-button ${RUN_UI.action}`} data-testid="resume" busy={resumeAction.busy} onClick={resumeAction.onResume} icon={<Icon name="play" size={16} />}>
              {resumeAction.busy ? 'Retomando…' : 'Retomar'}
            </ActionButton>
          ) : null}
          {stopAction && STOPPABLE.has(status) ? (
            <ActionButton className={`secondary ${RUN_UI.action}`} data-testid="stop" busy={stopAction.busy} onClick={stopAction.onStop} icon={<Icon name="stop" size={16} />}>
              {stopAction.busy ? 'Parando…' : 'Parar execução'}
            </ActionButton>
          ) : null}
          {detail.report ? (
            <Link className={`link-button ${RUN_UI.action}`} data-testid="validation-link" to={`/runs/${detail.runId}/validation`}>
              Validação
              <Icon name="arrow-right" size={16} />
            </Link>
          ) : null}
          {repoUrl ? (
            <a className={`primary-button ${RUN_UI.action}`} data-testid="github-link" href={repoUrl} target="_blank" rel="noreferrer">
              Abrir no GitHub
              <Icon name="external" size={16} />
            </a>
          ) : null}
        </div>
        {resumeAction?.error ? <p className="error" data-testid="resume-error">{resumeAction.error}</p> : null}
        {detail.locked ? (
          <p className="hint" data-testid="locked-notice">
            Esta execução é somente leitura porque a spec foi concluída. Para a próxima entrega, crie uma <Link to={`/projects/${detail.projectId}?novaSpec=1`}>nova spec no projeto</Link>.
          </p>
        ) : null}
        {stopAction?.error ? <p className="error" data-testid="stop-error">{stopAction.error}</p> : null}
        {totalTasks ? (
          <div className="col-span-full flex items-center gap-4 border-t border-line pt-4 max-md:flex-col max-md:items-stretch max-md:gap-2">
            <div
              className="run-progress-bar flex h-1.5 flex-1 gap-[2px] overflow-hidden rounded-full bg-surface-muted [&>.seg-active]:bg-accent [&>.seg-blocked]:bg-bad [&>.seg-merged]:bg-good [&>span]:h-full [&>span]:flex-none"
              role="progressbar"
              aria-label="Tarefas mescladas"
              aria-valuemin={0}
              aria-valuemax={totalTasks}
              aria-valuenow={doneTasks}
              aria-valuetext={`${doneTasks} de ${totalTasks} mescladas, ${tally.active} em andamento, ${tally.blocked} bloqueadas`}
            >
              {tally.merged ? <span className="seg-merged" style={{ flexBasis: `${(tally.merged / totalTasks) * 100}%` }} /> : null}
              {tally.active ? <span className="seg-active" style={{ flexBasis: `${(tally.active / totalTasks) * 100}%` }} /> : null}
              {tally.blocked ? <span className="seg-blocked" style={{ flexBasis: `${(tally.blocked / totalTasks) * 100}%` }} /> : null}
            </div>
            <p className="m-0 flex flex-wrap text-[0.8125rem] whitespace-nowrap text-ink-soft tabular-nums max-md:whitespace-normal [&_.info-tip]:ml-1 [&>span+span]:before:mx-2 [&>span+span]:before:text-ink-faint [&>span+span]:before:content-['·']">
              <span>
                <span data-testid="task-progress">
                  {doneTasks} de {totalTasks} tarefas mescladas
                </span>
                <InfoTip label="Tarefas mescladas" text={TIP.merged} />
              </span>
              {tally.active ? (
                <span data-testid="task-active" className="text-accent-text">
                  {tally.active} em andamento
                </span>
              ) : null}
              {tally.blocked ? (
                <span data-testid="task-blocked" className="text-bad">
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
      <Workspace
        columns={RUN_UI.columns}
        panels={[
          {
            id: 'tasks',
            label: 'Tarefas',
            content: (
              <div className={RUN_UI.column}>
                {stop ? (
                  <section className={RUN_UI.banner} data-testid="outcome-banner" aria-labelledby="run-outcome-title">
                    <h2 id="run-outcome-title" className={RUN_UI.bannerTitle}>
                      <Icon name="alert" size={18} />
                      {stop.what}
                    </h2>
                    <dl className={RUN_UI.bannerRows}>
                      <div>
                        <dt>Por quê</dt>
                        <dd>
                          <strong>{stop.title}</strong>
                          {stop.raw ? (
                            <button type="button" className={DETAIL_BUTTON} data-testid="outcome-detail" onClick={openDetail({ kind: 'outcome' })}>
                              Ver detalhe técnico
                              <Icon name="code" size={14} />
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
                          <div className="flex flex-wrap items-center gap-3">
                            {redeploying ? (
                              <ActionButton className="primary-button" data-testid="redeploy" busy={redeployAction.busy} onClick={redeployAction.onRedeploy} icon={<Icon name="refresh" size={16} />}>
                                {redeployAction.busy ? 'Iniciando o deploy…' : 'Tentar deploy de novo'}
                              </ActionButton>
                            ) : null}
                            {reprocessAction && !detail.locked ? (
                              <span className="inline-flex items-center gap-[0.35rem]">
                                <ActionButton className={redeploying ? 'secondary' : 'primary-button'} data-testid="reprocess" busy={reprocessAction.busy} onClick={reprocessAction.onReprocess} icon={<Icon name="refresh" size={16} />}>
                                  {reprocessAction.busy ? 'Iniciando nova run…' : 'Reprocessar'}
                                </ActionButton>
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
                {causeGroups.length ? (
                  <section className="card" data-testid="block-cause">
                    <div className={RUN_UI.panelHead}>
                      <h2>Tarefas bloqueadas</h2>
                      <InfoTip label="Tarefas bloqueadas" text={TIP.blocked} />
                    </div>
                    {!stop && stopAction && STOPPABLE.has(status) ? (
                      <p className="hint" data-testid="block-cause-live-hint">
                        A run continua com as outras tarefas. Veja o motivo em cada uma; se nenhuma vai se resolver sozinha, pare a execução para liberar o reprocessamento.
                      </p>
                    ) : null}
                    <ul className={RUN_UI.boxList}>
                      {causeGroups.map((g) => (
                        <li key={g.reason} data-testid="cause-group" className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto] items-center gap-[0.85rem] px-[0.9rem] py-[0.6rem] max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-2">
                          <span className="flex max-w-64 min-w-0 flex-wrap gap-x-3 gap-y-1">
                            {g.taskIds.map((id) => (
                              <button key={id} type="button" className={`min-w-[auto] ${TASK_ID_BUTTON}`} onClick={() => setSelected(id)}>
                                {id}
                              </button>
                            ))}
                          </span>
                          <span className="min-w-0 truncate text-ink max-md:col-span-full max-md:row-start-2 max-md:line-clamp-2 max-md:whitespace-normal max-md:wrap-anywhere">{explainStop(g.reason)?.title ?? firstSentence(explainBlockReason(g.reason))}</span>
                          <button type="button" className={`${DETAIL_BUTTON} max-md:col-start-2 max-md:row-start-1`} aria-label={`Ver detalhe do bloqueio de ${g.taskIds.join(', ')}`} onClick={openDetail({ kind: 'cause', reason: g.reason })}>
                            Ver detalhe
                            <Icon name="chevron-right" size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                <section className="card" data-testid="readme">
                  {/* The title keeps its width; the path and the button wrap below it on narrow screens. */}
                  <header className="flex-wrap gap-3">
                    <h2 className="basis-auto">README do projeto</h2>
                    <span className="font-mono text-[0.75rem] text-ink-soft">docs/README.md</span>
                    {readmeAction && !detail.locked ? (
                      <ActionButton className="secondary h-10 px-3 text-[0.8125rem]" data-testid="readme-generate" busy={readmeAction.busy} onClick={readmeAction.onGenerate} icon={<Icon name="file" size={14} />}>
                        {readmeAction.busy ? 'O sm está escrevendo…' : detail.readme ? 'Reescrever com o sm' : 'Gerar README com o sm'}
                      </ActionButton>
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
                {error ? <p className="error m-0">{error}</p> : null}
                <section className="card">
                  <h2>Tarefas</h2>
                  {groups.length === 0 ? <p className="hint">Nenhuma tarefa planejada ainda.</p> : null}
                  {groups.map(([s, ids], i) => (
                    <div key={s} data-testid={`group-${s}`}>
                      {/* Tasks: a fixed id column so every title starts on the same guide. */}
                      <h3 className={`mb-2 flex items-center gap-2 ${i ? 'mt-5' : 'mt-1'}`}>
                        {statusLabel(s)} <span className="min-w-5 rounded-full bg-surface-muted px-[0.35rem] text-center text-[0.6875rem] tracking-normal text-ink-soft tabular-nums">{ids.length}</span>
                      </h3>
                      <ul className={RUN_UI.boxList}>
                        {ids.map((id) => {
                          const tk = state.tasks.get(id)!;
                          return (
                            <li key={id} className="flex flex-wrap items-baseline gap-[0.85rem] px-[0.9rem] py-[0.65rem] hover:bg-surface-sunken">
                              <button className={`min-w-[5.75rem] ${TASK_ID_BUTTON}`} data-testid={`task-${id}`} onClick={() => setSelected(id)}>
                                {id}
                              </button>
                              <span className="min-w-0 flex-[1_1_16rem] leading-[1.45] text-ink">{tk.def.title}</span>
                              {tk.def.service ? <Tipped text={SERVICE_HELP}><span className="tag" title="Serviço">{tk.def.service}</span></Tipped> : null}
                              <span className="ml-auto inline-flex items-center gap-[0.4rem] text-[0.8125rem] whitespace-nowrap text-ink-soft max-md:ml-0 max-md:whitespace-normal [&_.tag]:m-0">
                                {tk.attempts > 0 ? `${tk.attempts} ${tk.attempts === 1 ? 'tentativa' : 'tentativas'}` : null}
                                {tk.replanned ? <Tipped text="O plano desta tarefa foi refeito durante a execução."><span className="tag">replanejada</span></Tipped> : null}
                                {tk.def.origin && tk.def.origin !== 'plan' ? <Tipped text={ORIGIN_HELP[tk.def.origin] ?? 'De onde esta tarefa veio.'}><span className={`tag tag-${tk.def.origin}`}>{tk.def.origin}</span></Tipped> : null}
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
            ),
          },
          {
            id: 'phases',
            label: 'Fases e consumo',
            content: (
              <aside className={RUN_UI.aside}>
                {status === 'running' || status === 'draining' || status.startsWith('paused') ? <NowCard events={unique} /> : null}
                <section className="card">
                  <div className={RUN_UI.panelHead}>
                    <h2>Fases</h2>
                    <InfoTip label="Fases" text={TIP.phases} />
                  </div>
                  {phaseList.length ? (
                    <ol className="m-0 grid list-none divide-y divide-line p-0">
                      {phaseList.map((p) => {
                        const [label, tone] = phaseState(p, status, blockedTasks);
                        const problems = activity.get(p.phase)?.items.filter((i) => i.tone === 'bad').length ?? 0;
                        return (
                          <li key={p.phase} data-testid="phase" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-[0.35rem] py-[0.6rem] first:pt-0 last:pb-0">
                            {/* The phase name opens its detail: a text button, underlined on hover. */}
                            <button type="button" className="phase-name h-auto min-w-0 border-0 bg-transparent p-0 text-left text-[0.875rem] leading-[1.4] font-semibold text-ink tabular-nums hover:bg-transparent hover:text-accent-text hover:underline" aria-label={`Ver o que aconteceu em ${phaseTitle(p.phase)}`} onClick={openDetail({ kind: 'phase', phase: p.phase })}>
                              {phaseTitle(p.phase)}
                            </button>{' '}
                            <Tipped text={PHASE_HELP[label] ?? STATUS_HELP.unknown!}><span className={tone ? `status-pill tone-${tone}` : 'status-pill'}>{label}</span></Tipped>
                            {p.attempt > 1 ? <span className={`${META} text-ink-soft`}>{p.attempt}ª tentativa</span> : null}
                            {problems && p.result !== 'failed' ? (
                              <span className={`${META} text-warn`} data-testid="phase-problems-count">
                                {problems === 1 ? '1 problema registrado' : `${problems} problemas registrados`}
                              </span>
                            ) : null}
                            {p.result === 'failed' ? (
                              <div className="col-span-full grid min-w-0 justify-items-start gap-2">
                                <p className="m-0 text-[0.8125rem] leading-[1.45] text-ink">
                                  <strong>O que fazer:</strong> {explainPhase(p).hint}
                                </p>
                                <button type="button" className={DETAIL_BUTTON} aria-label={`Ver detalhe da falha em ${phaseTitle(p.phase)}`} onClick={openDetail({ kind: 'phase', phase: p.phase })}>
                                  Ver detalhe
                                  <Icon name="chevron-right" size={14} />
                                </button>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className={`hint ${RUN_UI.asideNote}`}>Nenhuma fase iniciada ainda.</p>
                  )}
                </section>
                {prs.length ? (
                  <section className="card">
                    <h2>Pull requests mesclados</h2>
                    <ul className="m-0 flex list-none flex-wrap gap-[0.6rem] p-0">
                      {prs.map((p) => (
                        <li key={p.taskId} className="flex items-center gap-2 rounded-md border border-line px-[0.6rem] py-[0.3rem]">
                          <span className="font-mono text-[0.8125rem] text-ink-soft">{p.taskId}</span>
                          {safeHttpUrl(p.url) ? (
                            <a href={safeHttpUrl(p.url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[0.35rem] font-semibold text-accent-text no-underline hover:underline">
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
                  <dl className={RUN_UI.totals} data-testid="tokens-total">
                    <div>
                      <dt>
                        Custo estimado
                        <InfoTip label="Custo estimado" text={TIP.cost} />
                      </dt>
                      <dd className="font-[650]">{money(t.total.costUsd)}</dd>
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
                  {Object.keys(t.byRole).length ? (
                    <UsageList
                      title="Por agente"
                      tip={TIP.byRole}
                      rows={Object.entries(t.byRole)}
                      label={roleName}
                      testIdPrefix="tokens-"
                      details={(role) => (t.modelsByRole[role] ?? []).map((u) => (
                        <span key={`${u.model}|${u.effort ?? ''}`} className={`${META} block text-ink-soft`} data-testid={`models-${role}`}>
                          {modelUseLabel(u)}
                        </span>
                      ))}
                    />
                  ) : null}
                  {Object.keys(t.byPhase).length ? <UsageList title="Por fase" tip={TIP.byPhase} rows={Object.entries(t.byPhase)} label={(key) => PHASE_LABEL[key] ?? key} /> : null}
                </section>
              </aside>
            ),
          },
        ]}
      />
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
      .then((r) => navigate(startedPath(detail.projectId, r)))
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
