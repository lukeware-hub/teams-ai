import { useEffect, useMemo, useRef, useState } from 'react';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { projectPath, refinePath, runPath } from '../routes.js';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { criterionSentence } from '../criterion.js';
import { runApi, type AcceptanceCriterion, type GapCause, type GapDecision, type GapItem, type GapsReport, type Report, type RunDetail, type ServiceStatus } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Pagination, SortHeader, TableFilters, usePagedTable } from '../components/DataTable.js';
import { Icon } from '../components/Icons.js';
import { InfoTip, Tipped } from '../components/InfoTip.js';
import { Loading } from '../components/Loading.js';
import { money } from './costs/format.js';
import { responsiveCell, responsiveHead, responsiveRow, responsiveTable } from './project-shared.js';
import { explainBlockReason, ownHint, rootBlockers, stopBefore, stopSummary } from '../run/selectors.js';
import { PUBLISHED_PORTS, serviceLinks } from '@server/deploy/service-links';
import { RUN_UI } from './Run.js';
import { STATUS_HELP } from './project-shared.js';
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
const RESULT: Record<string, { label: string; tone: string; help: string }> = {
  passed: { label: 'Passou', tone: 'tone-good', help: 'O teste rodou e confirmou o critério.' },
  failed: { label: 'Falhou', tone: 'tone-bad', help: 'O teste rodou e o critério não foi cumprido.' },
  blocked: { label: 'Bloqueado', tone: 'tone-bad', help: 'Não foi possível testar: uma tarefa ligada ao critério ficou bloqueada.' },
  missing: { label: 'Sem teste', tone: 'tone-warn', help: 'Não há teste que comprove este critério.' },
  'not-applicable': { label: 'Não se aplica', tone: '', help: 'Este critério não pede este tipo de teste.' },
};
function ResultChip({ status }: { status: string }) {
  const r = RESULT[status];
  return (
    <Tipped text={r?.help ?? 'Resultado informado pelo teste.'}>
      <span data-testid={`validation-result-${status}`} className={`status-chip ${r?.tone ?? ''}`}>{r?.label ?? status}</span>
    </Tipped>
  );
}
const CRITERION_HELP = 'Critério de aceite: uma condição que o serviço publicado precisa cumprir para a spec ser aceita.';
const RESULT_HELP = 'Passou: o teste confirmou o critério. Falhou: o teste rodou e não confirmou. Bloqueado: uma tarefa ligada ao critério ficou bloqueada. Sem teste: não há teste que o comprove.'
const resultLabel = (status: string) => RESULT[status]?.label ?? status;
type Smoke = NonNullable<Report['service']>['smoke'][number];
type Evidence = Report['evidence'][number];
function SmokeTable({ runId }: { runId: string }) {
  const view = usePagedTable(`${runId}/smoke`, (req) => runApi.validationTable<Smoke>(runId, 'smoke', req), resultLabel);
  return (
    <>
      <TableFilters view={view} subject="testes rápidos" placeholder="Filtrar por critério, serviço ou teste" facetName="Resultado" />
      <div data-testid="validation-smoke-table-wrap" className="@container overflow-x-auto">
        <table data-testid="validation-smoke-table" className={`${TABLE} ${responsiveTable} @min-[32rem]:min-w-[32rem] table-fixed`}>
          <colgroup data-testid="validation-smoke-colgroup"><col data-testid="validation-smoke-col-criterion" className="w-[15rem]" /><col data-testid="validation-smoke-col-test" /><col data-testid="validation-smoke-col-result" className="w-[9rem]" /></colgroup>
          <thead data-testid="validation-smoke-head" className={responsiveHead}>
            <tr data-testid="validation-smoke-head-row">
              <SortHeader view={view} column="criterion" tip={<InfoTip text={`${CRITERION_HELP} Entre parênteses, o serviço que o testa.`} />}>Critério</SortHeader>
              <SortHeader view={view} column="test" tip={<InfoTip text="Smoke test: teste automático curto, rodado no serviço publicado, que confirma o essencial de cada critério." />}>Teste rápido</SortHeader>
              <SortHeader view={view} column="result" className={CENTER} tip={<InfoTip text={RESULT_HELP} />}>Resultado</SortHeader>
            </tr>
          </thead>
          <tbody data-testid="validation-smoke-body" className="@max-[44rem]:block">
            {view.rows.length === 0 ? <tr data-testid="validation-smoke-empty-row"><td data-testid="validation-smoke-empty-cell" colSpan={3} className="text-ink-soft">Nenhum teste corresponde ao filtro.</td></tr> : null}
            {view.rows.map((s) => (
              <tr key={`${s.service ?? ''}-${s.acId}`} data-testid={`smoke-${s.service ? `${s.service}-` : ''}${s.acId}`} className={`result-${s.status} ${responsiveRow}`}>
                <td data-testid={`smoke-${s.service ? `${s.service}-` : ''}${s.acId}-criterion`} className={`${TD_ID} ${responsiveCell}`} data-label="Critério">{s.acId}{s.service ? ` (${s.service})` : ''}</td>
                <td data-testid={`smoke-${s.service ? `${s.service}-` : ''}${s.acId}-test`} className={`${TD_MONO} ${responsiveCell}`} data-label="Teste rápido">{s.testId ?? '—'}</td>
                <td data-testid={`smoke-${s.service ? `${s.service}-` : ''}${s.acId}-result`} className={`${CENTER} ${responsiveCell}`} data-label="Resultado"><ResultChip status={s.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination view={view} />
    </>
  );
}
function EvidenceTable({ runId }: { runId: string }) {
  const view = usePagedTable(`${runId}/evidence`, (req) => runApi.validationTable<Evidence>(runId, 'evidence', req), resultLabel);
  return (
    <>
      <TableFilters view={view} subject="evidências" placeholder="Filtrar por critério, tarefa ou teste" facetName="Resultado" />
      <div data-testid="validation-evidence-table-wrap" className="@container overflow-x-auto">
        <table data-testid="validation-evidence-table" className={`${TABLE} ${responsiveTable} @min-[44rem]:min-w-[44rem] table-fixed`}>
          <colgroup data-testid="validation-evidence-colgroup"><col data-testid="validation-evidence-col-criterion" className="w-[7rem]" /><col data-testid="validation-evidence-col-tasks" className="w-[12rem]" /><col data-testid="validation-evidence-col-tests" /><col data-testid="validation-evidence-col-e2e" className="w-[9rem]" /><col data-testid="validation-evidence-col-result" className="w-[9rem]" /></colgroup>
          <thead data-testid="validation-evidence-table-head" className={responsiveHead}>
            <tr data-testid="validation-evidence-table-head-row">
              <SortHeader view={view} column="criterion" tip={<InfoTip text={CRITERION_HELP} />}>Critério</SortHeader>
              <SortHeader view={view} column="tasks" tip={<InfoTip text="As tarefas dos agentes que implementaram o critério." />}>Tarefas</SortHeader>
              <SortHeader view={view} column="tests" tip={<InfoTip text="Os testes automáticos que comprovam o critério." />}>Testes</SortHeader>
              <SortHeader view={view} column="e2e" className={CENTER} tip={<InfoTip text="Teste ponta a ponta: simula uma pessoa usando o serviço publicado, do início ao fim do fluxo." />}>Teste E2E</SortHeader>
              <SortHeader view={view} column="result" className={CENTER} tip={<InfoTip text={RESULT_HELP} />}>Resultado</SortHeader>
            </tr>
          </thead>
          <tbody data-testid="validation-evidence-body" className="@max-[44rem]:block">
            {view.rows.length === 0 ? <tr data-testid="validation-evidence-empty-row"><td data-testid="validation-evidence-empty-cell" colSpan={5} className="text-ink-soft">Nenhuma evidência corresponde ao filtro.</td></tr> : null}
            {view.rows.map((r) => (
              <tr key={r.criterion} data-testid={`evidence-${r.criterion}`} className={`result-${r.status} ${responsiveRow}`}>
                <td data-testid={`evidence-${r.criterion}-criterion`} className={`${TD_ID} ${responsiveCell}`} data-label="Critério">{r.criterion}</td>
                <td data-testid={`evidence-${r.criterion}-tasks`} className={`${TD_MONO} ${responsiveCell}`} data-label="Tarefas"><CellList items={r.tasks} /></td>
                <td data-testid={`evidence-${r.criterion}-tests`} className={`${TD_MONO} ${responsiveCell}`} data-label="Testes"><CellList items={r.tests} /></td>
                <td className={`${CENTER} ${responsiveCell}`} data-label="Teste E2E" data-testid={`e2e-${r.criterion}`} title={r.e2eReason}>{r.e2e ? <ResultChip status={r.e2e} /> : '—'}{r.e2eReason ? ` (${r.e2eReason})` : ''}</td>
                <td data-testid={`evidence-${r.criterion}-result`} className={`${CENTER} ${responsiveCell}`} data-label="Resultado"><ResultChip status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination view={view} />
    </>
  );
}
// Ids stay on one line and long test names break between words, so a narrow screen scrolls the table instead of wrapping letter by letter.
const TABLE = 'mt-0 wrap-break-word [&_td]:align-middle';
const TD_ID = 'font-mono text-[0.8125rem] font-semibold text-accent-text';
const TD_MONO = 'font-mono text-[0.78rem] text-left text-ink-soft [hyphens:manual] wrap-anywhere';
// Every cell is centred vertically; result columns are centred horizontally too.
const CENTER = 'text-center';
/** One item per line, so long lists of tasks and tests stay readable. */
function CellList({ items }: { items: string[] }) {
  if (items.length === 0) return <>—</>;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {items.map((item) => <li key={item} className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-line [&:not(:first-child)]:pt-1.5">{item}</li>)}
    </ul>
  );
}
// Assumptions, blocked tasks and security findings: plain bordered rows.
const FINDINGS = `${RUN_UI.boxList} [&>li]:px-[0.9rem] [&>li]:py-[0.7rem] [&>li]:text-[0.875rem] [&>li]:leading-normal`;
// Commands, URLs and JSON the agents quoted between backticks.
const CODE = '[&_code]:rounded-sm [&_code]:bg-surface-muted [&_code]:px-[0.35rem] [&_code]:py-[0.05rem] [&_code]:text-[0.8125rem] [&_code]:text-ink [&_code]:wrap-anywhere';
const SEVERITY: Record<string, { label: string; tone: string; help: string }> = {
  critical: { label: 'Gravidade crítica', tone: 'tone-bad', help: 'Falha de segurança grave: corrija antes de aceitar o serviço.' },
  high: { label: 'Gravidade alta', tone: 'tone-bad', help: 'Falha de segurança importante: corrija antes de aceitar o serviço.' },
  medium: { label: 'Gravidade média', tone: 'tone-warn', help: 'Falha de segurança moderada: vale corrigir em breve.' },
  low: { label: 'Gravidade baixa', tone: '', help: 'Falha de segurança leve, com pouco risco.' },
};
/** Agent text marks commands, URLs and JSON with backticks: show them as code instead of loose quote marks. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((p, i) => (i % 2 ? <code key={i} data-testid={`validation-code-${p}`}>{p}</code> : p))}</>;
}
/** A service's state: still checking, answering or not. */
function StatePill({ checking, online, testId }: { checking: boolean; online: boolean; testId?: string }) {
  const help = checking ? 'A plataforma está perguntando ao serviço se ele responde.' : online ? 'O serviço respondeu à verificação e está no ar.' : 'O serviço não respondeu à verificação.';
  return (
    <Tipped text={help}>
      <span data-testid={testId} className={`status-pill tone-${checking ? 'neutral' : online ? 'good' : 'bad'}`}>{checking ? 'Verificando' : online ? 'No ar' : 'Fora do ar'}</span>
    </Tipped>
  );
}
const openLink = (href: string, testId: string, text: string, primary: boolean, label?: string) => (
  <a className={`${primary ? 'primary-button' : 'link-button'} ${RUN_UI.action}`} data-testid={testId} href={href} target="_blank" rel="noreferrer" aria-label={label}>
    {text}
    <Icon name="external" size={16} />
  </a>
);
const recheckButton = (checking: boolean, onRecheck: () => void) => (
  <ActionButton className="link-button ml-auto min-h-10 px-[0.65rem] text-[0.8125rem]" data-testid="recheck-service" onClick={onRecheck} busy={checking} icon={<Icon name="refresh" size={14} />}>
    Verificar de novo
  </ActionButton>
);
const startButton = (starting: boolean, canStart: boolean, onStart: () => unknown, [idle, busy]: readonly [string, string]) => (
  <ActionButton className="primary-button" data-testid="start-service" busy={starting} disabled={!canStart} onClick={onStart} icon={<Icon name="play" size={16} />}>
    {starting ? busy : idle}
  </ActionButton>
);
// Service status and the buttons that open or start it.
const SERVICE = {
  controls: 'mb-[0.9rem] grid gap-3',
  status: 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
  actions: 'flex flex-wrap gap-2 empty:hidden [&>*]:flex-auto',
};
interface ControlProps { status: ServiceStatus | null; starting: boolean; canStart: boolean; onStart: () => unknown }

/** Is the service up, where to open it, and a button to bring it up when it is not. */
function ServiceControls({ service, status, starting, canStart, onStart }: { service: NonNullable<Report['service']> } & ControlProps) {
  const links = serviceLinks(service, window.location.hostname);
  const checking = status === null;
  const online = status?.online === true;
  return (
    <div data-testid="validation-service-controls" className={SERVICE.controls}>
      <div data-testid="validation-service-status" className={SERVICE.status}>
        <StatePill checking={checking} online={online} testId="service-online" />
      </div>
      <div data-testid="validation-service-actions" className={SERVICE.actions}>
        {online && links.appUrl && (status?.ui === true || service.kind === 'front') ? openLink(links.appUrl, 'open-app', 'Abrir aplicação', true) : null}
        {online && links.docsUrl && status?.docs === true ? openLink(links.docsUrl, 'open-docs', 'Abrir Swagger', false) : null}
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


/** A mobile run's build: the file the owner downloads and installs. No service runs, so there is no port and no status. */
function ArtifactDownload({ runId, artifact }: { runId: string; artifact: string }) {
  return (
    <div data-testid="validation-artifact-controls" className={SERVICE.controls}>
      <a data-testid="download-artifact" className="primary" href={runApi.artifactUrl(runId)} download={artifact}>Baixar {artifact}</a>
    </div>
  );
}

/** A services run: one line per service with its state and its link, then one recheck and one start for them all. */
function ServiceList({ services, status, starting, canStart, onStart }: { services: NonNullable<Report['services']> } & ControlProps) {
  const checking = status === null;
  const entryOf = (service: string) => status?.services?.find((s) => s.service === service);
  const onlineOf = (service: string) => entryOf(service)?.online === true;
  return (
    <div data-testid="validation-service-list" className={SERVICE.controls}>
      <ul data-testid="validation-service-list-items" className="m-0 grid list-none gap-2 p-0">
        {services.map((s) => {
          const links = serviceLinks(s, window.location.hostname);
          return (
            <li key={s.service} data-testid={`service-${s.service}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface-sunken px-4 py-3 [&>a:first-of-type]:md:ml-auto">
              <strong data-testid={`validation-service-name-${s.service}`}>{s.service}</strong>
              <StatePill checking={checking} online={onlineOf(s.service)} />
              {onlineOf(s.service) && links.appUrl && (entryOf(s.service)?.ui === true || s.kind === 'front') ? openLink(links.appUrl, `open-app-${s.service}`, 'Abrir aplicação', false, `Abrir aplicação (${s.service})`) : null}
              {onlineOf(s.service) && links.docsUrl && entryOf(s.service)?.docs === true ? openLink(links.docsUrl, `open-${s.service}`, 'Abrir Swagger', false, `Abrir Swagger (${s.service})`) : null}
              {!links.appUrl ? <span data-testid={`validation-service-port-${s.service}`} className="hint">porta fora da faixa publicada ({PUBLISHED_PORTS.from} a {PUBLISHED_PORTS.to})</span> : null}
            </li>
          );
        })}
      </ul>
      <div data-testid="validation-service-list-actions" className={SERVICE.actions}>
        {!checking && services.some((s) => !onlineOf(s.service)) ? startButton(starting, canStart, onStart, ['Subir serviços', 'Subindo os serviços…']) : null}
      </div>
    </div>
  );
}
const criterionText = (c: AcceptanceCriterion) => {
  const sentence = criterionSentence(c);
  return sentence[0]!.toUpperCase() + sentence.slice(1);
};
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
  onStartService?: () => unknown;
  onRecheckService?: () => void;
  /** The run completing the spec, while it goes. */
  completing?: string | null;
}

/** The cause the run recorded for an open doc section, in words the owner reads. */
function gapCauseLabel(cause: GapCause | null, autonomous: boolean): { title: string; hint: string } | null {
  if (!cause) return null;
  switch (cause.kind) {
    case 'no-task':
      return { title: 'Nenhuma tarefa cobre este trecho', hint: 'O plano não criou tarefa para ele. Relate o problema para que entre numa nova entrega.' };
    case 'blocked':
      return { title: `Tarefa bloqueada: ${cause.roots.map((r) => r.taskId).join(', ')}`, hint: cause.roots.map((r) => explainBlockReason(r.reason)).join(' ') };
    case 'tests-failing':
      return { title: `Teste falhou: ${cause.acIds.join(', ')}`, hint: ownHint('O código existe, mas o teste do critério não passou. Use Reprocessar na execução.', autonomous) };
    case 'run-stopped':
      return { title: `A execução terminou como “${statusLabel(cause.result)}”`, hint: ownHint('O trecho não chegou a ser verificado. Use Reprocessar na execução.', autonomous) };
    case 'not-built':
      return { title: 'O código não cobre este trecho', hint: 'As tarefas foram concluídas e os testes passaram, mas o código não faz tudo o que o documento pede. Relate o problema.' };
  }
}

function GapRow({ gap, decision, locked, canReport, onPrefill, onAccept, autonomous }: { gap: GapItem; decision: GapDecision | undefined; locked: boolean; canReport: boolean; onPrefill: (text: string) => void; onAccept: (gap: GapItem, note: string) => unknown; autonomous: boolean }) {
  const [note, setNote] = useState('');
  const why = gapCauseLabel(gap.cause, autonomous);
  return (
    <li data-testid="gap-row" className="flex flex-col gap-1.5">
      <strong data-testid={`validation-gap-title-${gap.doc}-${gap.heading}`} className="text-[0.875rem]">{gap.doc} › {gap.heading}</strong>
      <span data-testid={`validation-gap-missing-${gap.doc}-${gap.heading}`} className="text-[0.875rem]"><Rich text={gap.missing} /></span>
      {gap.evidence.length ? <span data-testid={`validation-gap-evidence-${gap.doc}-${gap.heading}`} className="hint">Encontrado em {gap.evidence.join(', ')}</span> : null}
      {why ? <span data-testid={`validation-gap-cause-${gap.doc}-${gap.heading}`} className="hint"><strong data-testid={`validation-gap-cause-title-${gap.doc}-${gap.heading}`}>{why.title}.</strong> {why.hint}</span> : null}
      {decision ? <span data-testid="gap-accepted" className="hint">Aceito fora de escopo: {decision.note}</span> : null}
      {!decision && !locked ? (
        <form data-testid={`validation-gap-form-${gap.doc}-${gap.heading}`} className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void onAccept(gap, note.trim()); }}>
          <input className="min-w-0 flex-1 px-[0.8rem] py-[0.5rem] text-[0.875rem]" aria-label="Motivo para aceitar o trecho" data-testid="gap-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Por que fica de fora?" />
          <ActionButton type="submit" className="secondary" data-testid="gap-accept" disabled={note.trim() === ''} icon={<Icon name="check" size={16} />}>Aceitar como fora de escopo</ActionButton>
        </form>
      ) : null}
      {canReport ? <ActionButton className="secondary self-start" data-testid="gap-prefill" onClick={() => onPrefill(`${gap.doc} › ${gap.heading}: ${gap.missing}`)} icon={<Icon name="alert" size={16} />}>Preencher o relato</ActionButton> : null}
    </li>
  );
}

const gapKey = (g: { doc: string; heading: string }) => `${g.doc} › ${g.heading}`;

function GapsCard({ gaps, decisions, locked, canReport, onPrefill, onAccept, autonomous }: { gaps: GapsReport; decisions: GapDecision[]; locked: boolean; canReport: boolean; onPrefill: (text: string) => void; onAccept: (gap: GapItem, note: string) => unknown; autonomous: boolean }) {
  // The open list and the decision lookup change only with the gaps and decisions, not with each row's typing.
  const open = useMemo(() => ('items' in gaps ? gaps.items.filter((g) => g.status !== 'delivered') : []), [gaps]);
  // One lookup per gap instead of a scan of every decision; the first decision of a gap wins.
  const decisionOf = useMemo(() => {
    const byGap = new Map<string, GapDecision>();
    for (const d of decisions) byGap.set(gapKey(d), byGap.get(gapKey(d)) ?? d);
    return byGap;
  }, [decisions]);
  return (
    <section className="card" data-testid="gaps">
      <div data-testid="validation-gaps-head" className={RUN_UI.panelHead}>
        <h2 data-testid="validation-gaps-title">Cobertura dos documentos</h2>
        <InfoTip text="Cada trecho dos documentos desta spec, conferido contra o código na main. Aceitar um trecho só registra a decisão: a entrega não muda." />
      </div>
      {'unavailable' in gaps ? (
        <p data-testid="gaps-unavailable" className="hint m-0">Não foi possível conferir: {gaps.unavailable}</p>
      ) : (
        <>
          <p data-testid="gaps-count" className="hint m-0 mb-2">{gaps.items.length - open.length} de {gaps.items.length} trechos entregues</p>
          {open.length ? (
            <ul className={FINDINGS} data-testid="gaps-open">
              {open.map((gap) => (
                <GapRow key={gapKey(gap)} gap={gap} decision={decisionOf.get(gapKey(gap))} locked={locked} canReport={canReport} onPrefill={onPrefill} onAccept={onAccept} autonomous={autonomous} />
              ))}
            </ul>
          ) : <p data-testid="validation-gaps-empty" className="hint m-0">Nenhum trecho em aberto.</p>}
        </>
      )}
    </section>
  );
}

export function ValidationView({ detail, specStatus, actionError = null, serviceStatus = null, startingService = false, onStartService = () => undefined, onRecheckService = () => undefined, completing = null, onReport, onComplete, onAcceptGap = () => undefined }: { detail: RunDetail; specStatus: string; actionError?: string | null; onReport: (text: string) => unknown; onComplete: () => unknown; onAcceptGap?: (gap: { doc: string; heading: string; note: string }) => unknown } & ServiceProps) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => readChecks(detail.runId));
  const [text, setText] = useState('');
  const report: Report | null = detail.report;
  const toggle = (id: string) => {
    const next = { ...checks, [id]: !checks[id] };
    setChecks(next);
    writeChecks(detail.runId, next);
  };
  // The same explanation the Run page gives a run that stopped, so the cause is at the top here too.
  const finished = detail.finished;
  const reportBlocked = report?.blocked;
  // Kept stable so the causes and the stop summary below are not rebuilt on every checkbox click.
  const blocked = useMemo(() => (finished?.blocked ?? reportBlocked ?? []) as Array<{ taskId: string; reason: string }>, [finished?.blocked, reportBlocked]);
  // A run that ended with blocked tasks (its RUN_FINISHED) is not delivered: the owner validates only a run whose every task merged.
  const endedBlocked = (detail.finished?.blocked ?? []) as Array<{ taskId: string; reason: string }>;
  const enabled = specStatus === 'awaiting-validation' && report?.result === 'awaiting-validation' && !completing && endedBlocked.length === 0;
  const specState = specStatus ? ` e a especificação está “${statusLabel(specStatus)}”` : '';
  const blockedNote = endedBlocked.length > 0 ? `${endedBlocked.length === 1 ? 'Há 1 tarefa bloqueada' : `Há ${endedBlocked.length} tarefas bloqueadas`}: a entrega não está pronta para validar. Envie a run de volta para o agente corrigir, na página da run.` : null;
  const note = enabled ? null : blockedNote ?? (specStatus === 'done' ? 'Esta especificação já foi concluída.' : report ? `Ações indisponíveis: a execução terminou como “${statusLabel(report.result)}”${specState}.` : 'As ações ficam disponíveis quando a execução gerar o relatório.');
  const script = report?.exploratoryScript;
  // The step ids depend only on the script, so ticking a box does not rebuild them.
  const steps = useMemo(() => script?.flatMap((b) => b.steps.map((_, i) => `${b.acId}-${i}`)) ?? [], [script]);
  const stepsDone = useMemo(() => steps.filter((id) => checks[id]).length, [steps, checks]);
  const causes = useMemo(() => rootBlockers(blocked), [blocked]);
  const lastFailure = report?.deploy.lastFailure ?? null;
  const stop = useMemo(() => stopSummary({ status: detail.status, reason: typeof finished?.reason === 'string' ? finished.reason : null, causes, deployFailure: lastFailure }), [detail.status, finished?.reason, causes, lastFailure]);
  const before = useMemo(() => (stop ? stopBefore(detail.status, blocked) : null), [stop, detail.status, blocked]);
  // One lookup per script block instead of a scan of every criterion.
  const criterionOf = useMemo(() => {
    const byId = new Map<string, AcceptanceCriterion>();
    for (const c of detail.acceptanceCriteria) byId.set(c.id, byId.get(c.id) ?? c);
    return byId;
  }, [detail.acceptanceCriteria]);
  const raw = stop && !causes.some((c) => c.reason === stop.raw) ? stop.raw : '';
  return (
    <main data-testid="validation-main" className={`${RUN_UI.page} ${CODE}`}>
      <Breadcrumb testId="validation-breadcrumb" trail={[{ label: detail.projectId, to: projectPath(detail.projectId), testId: 'validation-breadcrumb-project' }, { label: detail.specId, testId: 'validation-breadcrumb-spec' }, { label: detail.runId, to: runPath(detail.runId), testId: 'validation-breadcrumb-run' }, { label: 'Validação', testId: 'validation-breadcrumb-current' }]} />
      <header data-testid="validation-header" className={RUN_UI.head}>
        <div data-testid="validation-header-title" className="min-w-0">
          <h1 data-testid="validation-title" className={RUN_UI.title}>Validação</h1>
          <div data-testid="validation-meta" className={RUN_UI.meta}>
            <Tipped text={STATUS_HELP[report && specStatus ? specStatus : detail.status] ?? STATUS_HELP.unknown!}>
              <span data-testid="validation-status" className={`status-pill tone-${enabled ? 'neutral' : specStatus === 'done' ? 'good' : 'warn'}`}>{statusLabel(report && specStatus ? specStatus : detail.status)}</span>
            </Tipped>
            <span data-testid="validation-run-ids" className="hint">
              {detail.runId} / {detail.specId}
            </span>
          </div>
          <p data-testid="validation-subtitle" className="mt-3 mb-0 max-w-[60ch] text-[0.875rem] text-ink-soft">Confira o serviço publicado e siga o roteiro de teste. Depois, conclua a especificação ou relate um problema.</p>
        </div>
      </header>
      <Workspace
        columns={RUN_UI.columns}
        panels={[
          {
            id: 'checks',
            label: 'Serviço e roteiro',
            content: (
              <div data-testid="validation-checks-column" className={RUN_UI.column}>
                {stop ? (
                  <section className={RUN_UI.banner} data-testid="validation-stop" aria-labelledby="validation-stop-title">
                    <h2 id="validation-stop-title" data-testid="validation-stop-heading" className={RUN_UI.bannerTitle}>
                      <Icon name="alert" size={18} />
                      {stop.what}
                    </h2>
                    <dl data-testid="validation-stop-rows" className={RUN_UI.bannerRows}>
                      <div data-testid="validation-stop-why">
                        <dt data-testid="validation-stop-why-term">Por quê</dt>
                        <dd data-testid="validation-stop-why-detail"><strong data-testid="validation-stop-why-strong">{stop.title}</strong></dd>
                      </div>
                      {before ? (
                        <div data-testid="validation-stop-before">
                          <dt data-testid="validation-stop-before-term">Antes disso</dt>
                          <dd data-testid="validation-stop-before-detail">{before}</dd>
                        </div>
                      ) : null}
                      {causes.map((c) => (
                        <div key={c.taskId} data-testid={`stop-cause-${c.taskId}`}>
                          <dt data-testid={`validation-stop-cause-term-${c.taskId}`}>{c.taskId}</dt>
                          <dd data-testid={`validation-stop-cause-detail-${c.taskId}`}><p data-testid={`validation-stop-cause-text-${c.taskId}`}><Rich text={explainBlockReason(c.reason)} /></p></dd>
                        </div>
                      ))}
                      {raw ? (
                        <div data-testid="validation-stop-raw">
                          <dt data-testid="validation-stop-raw-term">Detalhe técnico</dt>
                          <dd data-testid="validation-stop-raw-detail"><pre data-testid="validation-stop-raw-text" className={RUN_UI.raw}>{raw}</pre></dd>
                        </div>
                      ) : null}
                      <div data-testid="validation-stop-next">
                        <dt data-testid="validation-stop-next-term">Próximo passo</dt>
                        <dd data-testid="validation-stop-next-detail">{stop.hint}</dd>
                      </div>
                    </dl>
                  </section>
                ) : null}
                {!report ? <p data-testid="validation-no-report" className="hint m-0">Ainda não há relatório: a execução está na fase {detail.phase} ({statusLabel(detail.status)}).</p> : null}
                {report ? (
                  <>
                    <section data-testid="validation-service-card" className="card">
                      <div data-testid="validation-service-head" className={RUN_UI.panelHead}>
                        <h2 data-testid="validation-service-title">{report.services ? 'Serviços publicados' : report.service?.kind === 'mobile' ? 'Aplicativo gerado' : 'Serviço publicado'}</h2>
                        {report.service && report.service.kind !== 'mobile' ? recheckButton(serviceStatus === null, onRecheckService) : null}
                      </div>
                      {report.service ? (
                        <>
                          {report.services ? (
                            <ServiceList services={report.services} status={serviceStatus} starting={startingService} canStart={specStatus === 'awaiting-validation'} onStart={onStartService} />
                          ) : report.service.kind === 'mobile' ? (
                            <ArtifactDownload runId={report.runId} artifact={report.service.artifact ?? ''} />
                          ) : (
                            <ServiceControls service={report.service} status={serviceStatus} starting={startingService} canStart={specStatus === 'awaiting-validation'} onStart={onStartService} />
                          )}
                          <SmokeTable runId={detail.runId} />
                        </>
                      ) : (
                        <p data-testid="deploy-failure" className="error">
                          {deployFailure(report.deploy)}
                        </p>
                      )}
                    </section>
                    <section data-testid="validation-script-card" className="card">
                      <div data-testid="validation-script-head" className={`mb-[0.85rem] ${RUN_UI.cardTitle}`}>
                        <div data-testid="validation-script-head-row" className={RUN_UI.headRow}>
                          <h2 data-testid="validation-script-title">Roteiro de teste manual</h2>
                          <InfoTip text="Passos sugeridos para você conferir cada critério de aceite no serviço publicado. As marcações ficam salvas só neste navegador." />
                        </div>
                        {steps.length ? <span data-testid="validation-script-count" className="hint text-left">{stepsDone} de {steps.length} {steps.length === 1 ? 'passo conferido' : 'passos conferidos'}</span> : null}
                      </div>
                      {report.exploratoryScript.length === 0 ? <p data-testid="validation-script-empty" className="hint">Nenhum passo sugerido.</p> : null}
                      {report.exploratoryScript.map((block) => {
                        const criterion = criterionOf.get(block.acId);
                        return (
                          <div data-testid={`validation-script-block-${block.acId}`} key={block.acId}>
                            {/* Manual script: one bordered list per criterion, a real checkbox on every row. */}
                            <h3 data-testid={`validation-script-block-title-${block.acId}`} className={`mb-1 font-mono text-[0.8125rem] tracking-normal text-accent-text normal-case mt-5`}>{block.acId}</h3>
                            {criterion ? <p data-testid={`validation-script-block-criterion-${block.acId}`} className="hint mt-0 mb-[0.6rem] leading-normal max-sm:text-left">{criterionText(criterion)}</p> : null}
                            <ul data-testid={`validation-script-steps-${block.acId}`} className={RUN_UI.boxList}>
                              {block.steps.map((s, i) => {
                                const id = `${block.acId}-${i}`;
                                return (
                                  <li data-testid={`validation-script-step-${id}`} key={id}>
                                    <label data-testid={`validation-script-step-label-${id}`} className="flex cursor-pointer items-center gap-3 px-[0.9rem] py-[0.7rem] leading-normal text-ink hover:bg-surface-sunken">
                                      <input type="checkbox" className="m-0 size-[1.05rem] min-w-0 flex-none cursor-pointer p-0" data-testid={`step-${id}`} checked={Boolean(checks[id])} onChange={() => toggle(id)} />
                                      <span data-testid={`validation-script-step-text-${id}`} className={`min-w-0 text-[0.875rem] wrap-anywhere max-sm:text-left ${checks[id] ? 'text-ink-soft' : ''}`}><Rich text={s} /></span>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        );
                      })}
                    </section>
                    <section data-testid="validation-evidence-card" className="card">
                      <div data-testid="validation-evidence-card-head" className={`mb-[0.85rem] ${RUN_UI.cardTitle}`}>
                        <div data-testid="validation-evidence-card-head-row" className={RUN_UI.headRow}>
                          <h2 data-testid="validation-evidence-card-title">Evidências por critério</h2>
                          <InfoTip text="Para cada critério de aceite: as tarefas que o implementaram e os testes automáticos que comprovam que ele funciona." />
                        </div>
                      </div>
                      <EvidenceTable runId={detail.runId} />
                    </section>
                    {report.gaps ? (
                      <GapsCard gaps={report.gaps} decisions={detail.gapDecisions ?? []} locked={detail.locked ?? false} canReport={enabled} onPrefill={setText} autonomous={detail.agentsDecide === true} onAccept={(gap, note) => onAcceptGap({ doc: gap.doc, heading: gap.heading, note })} />
                    ) : null}
                    {report.securityFindings?.length ? (
                      <section data-testid="validation-security-card" className="card">
                        <div data-testid="validation-security-head" className={RUN_UI.panelHead}>
                          <h2 data-testid="validation-security-title">Segurança</h2>
                        </div>
                        <ul className={FINDINGS} data-testid="security-findings">
                          {report.securityFindings.map((f, i) => (
                            <li key={i} data-testid={`security-${i}`}>
                              <Tipped text={SEVERITY[f.severity]?.help ?? 'Gravidade informada pelo agente de segurança.'}><span data-testid={`validation-security-severity-${f.file}-${f.line ?? 'none'}`} className={`status-chip ${SEVERITY[f.severity]?.tone ?? ''}`}>{SEVERITY[f.severity]?.label ?? f.severity}</span></Tipped>{' '}
                              {f.taskId ? `${f.taskId} · ` : ''}{f.file}{f.line === null ? '' : `:${f.line}`} · {f.category}: {f.problem} <span data-testid={`validation-security-fix-${f.file}-${f.line ?? 'none'}`} className="hint">Correção sugerida: {f.fix}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    <section data-testid="validation-assumptions-card" className="card">
                      <div data-testid="validation-assumptions-head" className={RUN_UI.panelHead}>
                        <h2 data-testid="validation-assumptions-title">Suposições dos agentes</h2>
                        <InfoTip text="Decisões que os agentes tomaram sozinhos quando a especificação não deixava claro. Se alguma estiver errada, relate um problema." />
                      </div>
                      <ul className={FINDINGS} data-testid="assumptions">{report.assumptions.length ? report.assumptions.map((a, i) => <li key={i} data-testid={`validation-assumption-${i}`}><Rich text={a} /></li>) : <li data-testid="validation-assumption-empty" className="hint">Nenhuma suposição registrada.</li>}</ul>
                    </section>
                    <section data-testid="validation-blocked-card" className="card">
                      <div data-testid="validation-blocked-head" className={RUN_UI.panelHead}>
                        <h2 data-testid="validation-blocked-title">Tarefas bloqueadas</h2>
                        <InfoTip text="Tarefas que os agentes não conseguiram concluir, com o motivo. Os critérios ligados a elas aparecem como bloqueados nas evidências." />
                      </div>
                      <ul data-testid="validation-blocked-list" className={FINDINGS}>{report.blocked.length ? report.blocked.map((b) => <li key={b.taskId} data-testid={`blocked-${b.taskId}`}><strong data-testid={`validation-blocked-id-${b.taskId}`} className="font-mono text-[0.8125rem] text-accent-text">{b.taskId}</strong>: <Rich text={b.reason} /></li>) : <li data-testid="validation-blocked-empty" className="hint">Nenhuma tarefa bloqueada.</li>}</ul>
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
              <aside data-testid="validation-decision-aside" className={RUN_UI.aside}>
                <section data-testid="validation-decision-card" className="card">
                  <div data-testid="validation-decision-head" className={RUN_UI.panelHead}>
                    <h2 data-testid="validation-decision-title">Sua decisão</h2>
                    <InfoTip text="Concluir finaliza a entrega e marca a especificação como concluída. Relatar problema reabre o refinamento com o seu relato, para os agentes corrigirem." />
                  </div>
                  {completing ? <p data-testid="completing-note" className={`hint ${RUN_UI.asideNote}`}>Concluindo a especificação. Acompanhe em <Link to={runPath(completing)}>{completing}</Link>.</p> : note ? <p data-testid="actions-note" className={`hint ${RUN_UI.asideNote}`}>{note}</p> : null}
                  {actionError ? <p data-testid="action-error" className={`error ${RUN_UI.asideNote}`}>{actionError}</p> : null}
                  <textarea className="m-0 mt-1 mb-[0.9rem] w-full resize-y px-[0.8rem] py-[0.65rem] text-[0.875rem] leading-normal disabled:cursor-not-allowed disabled:bg-surface-muted" data-testid="problem-text" aria-label="Descrição do problema" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="O que deu errado? O refinamento será reaberto com este relato." disabled={!enabled} />
                  <div data-testid="validation-decision-actions" className="grid gap-2 [&_button]:w-full">
                    <ActionButton className="primary-button" data-testid="complete-spec" busy={!!completing} disabled={!enabled} onClick={onComplete} icon={<Icon name="check" size={16} />}>
                      {completing ? 'Concluindo…' : 'Concluir especificação'}
                    </ActionButton>
                    <ActionButton className="secondary" data-testid="report-problem" disabled={!enabled || text.trim() === ''} onClick={() => onReport(text.trim())} icon={<Icon name="alert" size={16} />}>
                      Relatar problema
                    </ActionButton>
                  </div>
                </section>
                {report ? (
                  <section data-testid="validation-summary-card" className="card">
                    <div data-testid="validation-summary-head" className={RUN_UI.panelHead}>
                      <h2 data-testid="validation-summary-title">Resumo</h2>
                    </div>
                    <p data-testid="validation-summary-text" className="mt-0 mb-[0.9rem] max-h-64 overflow-auto text-[0.875rem] leading-[1.55] text-ink [text-wrap:pretty] max-sm:text-left"><Rich text={report.summary} /></p>
                    <dl data-testid="validation-totals" className={RUN_UI.totals}>
                      <div data-testid="validation-totals-cost">
                        <dt data-testid="validation-totals-cost-term">Custo estimado <InfoTip text="Estimativa em dólares das chamadas aos modelos de IA nesta execução, calculada pelos preços de API." /></dt>
                        <dd data-testid="validation-totals-cost-value" className="font-[650]">{money(report.tokens.total.costUsd)}</dd>
                      </div>
                      <div data-testid="validation-totals-tokens">
                        <dt data-testid="validation-totals-tokens-term">Tokens <InfoTip text="Volume de texto processado pelos modelos de IA: entrada é o que eles leram, saída é o que escreveram. O custo cresce com os tokens." /></dt>
                        <dd data-testid="validation-totals-tokens-value">{report.tokens.total.inputTokens} de entrada, {report.tokens.total.outputTokens} de saída</dd>
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
  return runId ? <ValidationRun key={runId} runId={runId} /> : <main data-testid="validation-page-loading"><Loading /></main>;
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
    if (inFlight.current) return Promise.resolve();
    inFlight.current = true;
    setActionError(null);
    return call().catch((e: Error) => setActionError(e.message)).finally(() => { inFlight.current = false; });
  };
  const load = async () => {
    const d = await runApi.run(runId);
    setDetail(d);
    if (isLive(d.status)) setDeployRun(runId); // a deploy run opened from an import: follow it until the service answers
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
          if (run.status === 'done') await load().catch(() => undefined);
        })
        .catch(() => undefined); // transient: the next tick asks again
    }, 4000);
    return () => clearInterval(timer);
  }, [deployRun]);
  if (error) return <main data-testid="validation-run-error"><p data-testid="validation-run-error-text" className="error">{error}</p></main>;
  if (!detail) return <main data-testid="validation-run-loading"><Loading /></main>;
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
        guarded(() => runApi.reportProblem(detail.projectId, detail.specId, text).then(() => navigate(refinePath(detail.projectId, detail.specId))))
      }
      onComplete={() => guarded(() => runApi.complete(detail.projectId, detail.specId).then((started) => setCompletion(started.runId)))}
      onAcceptGap={(gap) => guarded(() => runApi.acceptGap(detail.runId, gap).then(() => load()))}
    />
  );
}
