import { useEffect, useMemo, useState } from 'react';
import { runPath } from '../routes.js';
import { Link } from 'react-router-dom';
import { refineApi, runApi, type ProgramView, type ProgramViewItem, type RefineState } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { SortHeader, TableFilters, Pagination, useLocalTable } from '../components/DataTable.js';
import { Icon } from '../components/Icons.js';
import { InfoTip, Tipped } from '../components/InfoTip.js';
import { RunStoppedActions } from '../components/RunStoppedActions.js';
import type { TableSpec } from '@server/api/paging.js';
import { canStart, type StartInput } from '@server/refine/state';
import { explainStop, phaseTitle } from '../run/selectors.js';
import { action, panel, plural, responsiveCell, responsiveHead, responsiveRow, responsiveTable, sectionHeading, sectionTitle } from '../pages/project-shared.js';
import { visibleInterval } from '../visibleInterval.js';
import { money } from '../pages/costs/format.js';

const HELP = 'Depois do início, os agentes executam o backlog inteiro sozinhos, na ordem de prioridade e de dependência, até duas specs ao mesmo tempo quando elas não mexem no mesmo código: planejam, implementam, testam e publicam cada spec. Quando uma spec fica pronta para validação, a próxima segue sem esperar; só você a valida e conclui. Uma spec que falha é isolada e só bloqueia as que dependem dela; as demais seguem. Executar agora passa uma spec à frente da fila. O custo de cada spec soma todas as suas execuções, inclusive tentativas, conclusão e deploy.';

const ITEM_HELP = {
  pending: 'Na fila: a spec espera a vez, por prioridade e por dependência de outras specs.',
  running: 'Os agentes estão executando esta spec agora.',
  completing: 'A spec foi entregue e está sendo concluída.',
  delivered: 'A run entregou a spec e o código já está na main. A próxima spec segue sem esperar; esta só fica concluída quando você valida e conclui.',
  waiting: 'A spec espera um tempo depois de uma falha de ambiente e começa de novo sozinha.',
  done: 'A spec foi entregue e concluída.',
  partial: 'O código da spec já está na main, mas uma etapa depois dele falhou (como o deploy). Veja o motivo abaixo.',
  failed: 'A execução desta spec falhou. Veja o motivo abaixo.',
  blocked: 'A spec não pôde seguir. Veja o motivo abaixo.',
  interrupted: 'O processo parou antes do fim. Abra a run para retomar.',
} as const;
const OWNER_HELP: Record<string, string> = { Sistema: 'Quem precisa agir: o sistema, que resolve sozinho ou precisa de um ajuste da plataforma.', Plano: 'Quem precisa agir: o plano ou a spec precisa ser corrigido.', Você: 'Quem precisa agir: você.' };
const LABEL = { pending: 'na fila', running: 'em execução', completing: 'concluindo', delivered: 'aguarda sua validação', waiting: 'aguardando', done: 'concluída', partial: 'concluída parcialmente', failed: 'falhou', blocked: 'bloqueada', interrupted: 'interrompida' } as const;
// Same pills as the hub's spec rows; a live spec's dot pulses.
const PILL = {
  pending: 'status-pill',
  running: 'status-pill tone-neutral motion-safe:before:animate-pulse',
  completing: 'status-pill tone-neutral motion-safe:before:animate-pulse',
  delivered: 'status-pill tone-warn',
  waiting: 'status-pill tone-warn',
  done: 'status-pill tone-good',
  partial: 'status-pill tone-warn',
  failed: 'status-pill tone-bad',
  blocked: 'status-pill tone-bad',
  interrupted: 'status-pill tone-warn',
} as const;
// A live row carries the faint accent ground: cell by cell on a wide screen, on the whole card on a phone.
const LIVE = '@min-[44rem]:[&>td]:bg-accent-soft/40 @max-[44rem]:bg-accent-soft/40';

// The list reads top-down: what runs, then what waits on a person or a retry, then what failed, then what is done; each status by rank.
const STATUS_ORDER = ['running', 'completing', 'interrupted', 'delivered', 'waiting', 'pending', 'failed', 'blocked', 'partial', 'done'];
const statusRank = (i: ProgramViewItem) => STATUS_ORDER.indexOf(shownStatus(i));

/** The state a row shows: a run whose process is gone reads as interrupted, whatever the ledger says. */
const shownStatus = (i: ProgramViewItem) => (i.interrupted ? 'interrupted' : i.status);

/** Why an item failed or waits: what happened, who has to act and what to do, with the orchestrator's own words one click away. */
export function ItemReason({ status, reason }: { status: ProgramViewItem['status']; reason: string }) {
  const bad = status === 'failed' || status === 'blocked';
  const tone = bad || status === 'partial' ? 'text-warn' : 'text-ink-soft';
  const why = bad || status === 'partial' ? explainStop(reason) : null;
  if (!why) return <p className={`m-0 text-[0.8125rem] wrap-anywhere ${tone}`} data-testid="item-reason-plain">{reason}</p>;
  return (
    <div className="flex flex-col gap-1" data-testid="item-reason">
      <p className={`m-0 text-[0.8125rem] font-medium ${tone}`} data-testid="item-reason-title">{why.title} <Tipped text={OWNER_HELP[why.owner] ?? 'Quem precisa agir para resolver.'}><span className="status-pill tone-neutral" data-testid="item-reason-owner">{why.owner}</span></Tipped></p>
      <p className="hint m-0" data-testid="item-reason-hint">{why.hint}</p>
      <details data-testid="item-reason-details">
        <summary className="cursor-pointer text-[0.75rem] text-ink-soft" data-testid="item-reason-summary">Detalhe técnico</summary>
        <pre className="m-0 max-h-48 overflow-auto text-[0.75rem] whitespace-pre-wrap wrap-anywhere" data-testid="item-reason-pre">{reason}</pre>
      </details>
    </div>
  );
}

/** The start is never locked by a check or the Jev: only a running evaluation or a missing spec or backlog keeps it shut. */
export function canStartRun(st: StartInput, busy: boolean): boolean {
  return !busy && canStart(st);
}

/** The program that runs the backlog: every spec with where it stands, the run to follow and why one failed or waits. */
const fmtCost = money;

/** `repo#7`: services keep their own repositories, so a number alone would name several pull requests. */
export const prLabel = (pr: { number: number; url: string }): string => `${/github\.com\/[^/]+\/([^/]+)\/pull\//.exec(pr.url)?.[1] ?? 'PR'}#${pr.number}`;

/** The time of day as HH:MM. */
export const hhmm = (d: Date) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Why a run waits, and until when the Claude quota lets it go on. */
export function pauseText(pause: NonNullable<ProgramViewItem['pause']>): string {
  if (pause.reason === 'auth') return 'Pausada: o login do Claude precisa ser refeito.';
  const until = pause.until ? new Date(pause.until) : null;
  return until && !Number.isNaN(until.getTime()) ? `Pausada pela cota do Claude até ${hhmm(until)}.` : 'Pausada pela cota do Claude.';
}

/** Polls a started backlog's program every 5 seconds, with the phase of each run in progress, until it finishes. */
export function useProgram(projectId: string, specId: string, enabled: boolean) {
  const [program, setProgram] = useState<ProgramView | null>(null);
  const [phases, setPhases] = useState<Record<string, number>>({});
  const live = enabled && program?.status !== 'finished';
  useEffect(() => {
    if (!live) return;
    const poll = () => refineApi.program(projectId, specId).then(async (r) => {
      setProgram(r.program);
      const runIds = (r.program?.items ?? []).flatMap((i) => (i.status === 'running' && i.runId ? [i.runId] : []));
      setPhases(Object.fromEntries(await Promise.all(runIds.map(async (id) => [id, (await runApi.run(id)).phase] as const))));
    }).catch(() => undefined);
    void poll();
    return visibleInterval(() => void poll(), 5_000);
  }, [live, projectId, specId]);
  return { program, phases, setProgram };
}

/** The backlog's item titles by key, read once from the refinement snapshot. */
export function useBacklogTitles(projectId: string, specId: string) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    refineApi.snapshot(projectId, specId).then((s) => setTitles(Object.fromEntries((s.state.backlog?.items ?? []).map((i) => [i.key, i.title])))).catch(() => undefined);
  }, [projectId, specId]);
  return titles;
}

/** A stopped run keeps its item running in the ledger: only the run's own process says it is gone. */
const isInterrupted = (program: ProgramView) => {
  const now = program.items.filter((i) => i.status === 'running' || i.status === 'completing');
  return program.status !== 'finished' && now.length > 0 && now.every((i) => i.interrupted);
};

/** The specs whose run delivered them and that wait for the owner to validate them. */
const awaitingOwner = (program: ProgramView) => program.items.filter((i) => i.status === 'delivered').length;

/** Only validations are left: nothing runs, is queued or waits, so the backlog waits for the owner. */
const onlyValidationsLeft = (program: ProgramView) => awaitingOwner(program) > 0 && !program.items.some((i) => i.status === 'running' || i.status === 'completing' || i.status === 'pending' || i.status === 'waiting');

/** `1 aguarda sua validação` or `2 aguardam sua validação`. */
const awaitingText = (n: number) => plural(n, 'aguarda sua validação', 'aguardam sua validação');

/** "2 em execução · 35 bloqueadas": the specs that are neither done nor waiting in line, so the headline count is not read alone. */
function statusCounts(items: ReadonlyArray<{ status: string }>): string {
  const count = (status: string) => items.filter((i) => i.status === status).length;
  const parts: Array<[number, string, string]> = [[count('running'), 'em execução', 'em execução'], [count('blocked'), 'bloqueada', 'bloqueadas'], [count('failed'), 'falhou', 'falharam'], [count('partial'), 'parcial', 'parciais']];
  return parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(' · ');
}

/** The banner of a started backlog: a spinner while it runs, the progress, and each spec running now with its phase. */
export function ProgramStatus({ program, titles, phases, link }: { program: ProgramView | null; titles: Record<string, string>; phases: Record<string, number>; link?: string }) {
  const done = program?.items.filter((i) => i.status === 'done').length ?? 0;
  const total = program?.items.length ?? 0;
  const running = program?.status !== 'finished';
  const now = program?.items.filter((i) => i.status === 'running' || i.status === 'completing') ?? [];
  const interrupted = program !== null && isInterrupted(program);
  const waiting = program !== null && onlyValidationsLeft(program);
  const awaiting = program ? awaitingOwner(program) : 0;
  return (
    <div className="card grid gap-4 px-6 py-5 max-md:p-4" role="status" data-testid="program-status-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3" data-testid="program-status-header">
        <div className="flex items-center gap-3" data-testid="program-status-title-row">
          {interrupted ? <span className="grid size-5 flex-none place-items-center text-warn" aria-hidden="true" data-testid="program-status-icon-interrupted"><Icon name="alert" size={18} /></span> : waiting ? <span className="grid size-5 flex-none place-items-center text-warn" aria-hidden="true" data-testid="program-status-icon-waiting"><Icon name="clock" size={18} /></span> : running ?<span className="loading-spinner flex-none" aria-hidden="true" data-testid="program-status-spinner" /> : <span className="grid size-5 flex-none place-items-center text-good" aria-hidden="true" data-testid="program-status-icon-done"><Icon name="check" size={18} /></span>}
          <b className="text-[1rem] text-ink" data-testid="program-status-label">{!program ? 'Preparando a execução do backlog…' : `${interrupted ? 'Backlog interrompido' : waiting ? 'Aguardando sua validação' : running ? 'Executando o backlog' : 'Backlog executado'} · ${done} de ${total} concluída${total === 1 ? '' : 's'}${awaiting > 0 ? ` · ${awaitingText(awaiting)}` : ''}`}</b>
        </div>
        {link && <Link to={link} className="link-button shrink-0">Acompanhar no projeto<Icon name="arrow-right" size={16} /></Link>}
      </div>
      {program && <progress data-testid="program-status-progress" className="h-2 w-full appearance-none overflow-hidden rounded-full border-0 bg-surface-muted [&::-moz-progress-bar]:bg-good-live [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-good-live" max={total} value={done} />}
      {now.length > 0 && (
        <div className="grid gap-2 text-[0.875rem] text-ink-soft [&_p]:m-0" data-testid="program-status-now">
          {now.map((i) => {
            const runId = i.interrupted?.runId ?? i.runId;
            return (
              <p key={i.specId} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`program-status-now-${i.key}`}>
                <span className={i.interrupted ? 'size-2 flex-none rounded-full bg-warn' : 'size-2 flex-none rounded-full bg-accent-text motion-safe:animate-pulse'} aria-hidden="true" data-testid={`program-status-dot-${i.key}`} />
                <span data-testid={`program-status-text-${i.key}`}>{i.interrupted ? 'Interrompida: ' : 'Agora: '}<b className="font-semibold text-ink" data-testid={`program-status-item-${i.key}`}>{titles[i.key] ?? i.key}</b>{i.runId && phases[i.runId] !== undefined && ` · ${phaseTitle(phases[i.runId]!)}`}{i.pause && ` · ${pauseText(i.pause)}`}</span>
                {runId && <>· <Link to={runPath(runId)}>Acompanhar a run</Link></>}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Every spec of the backlog in run order: its rank, title and run, where it stands, what it cost and what can be done. */
export function ProgramPanel({ program, titles, phases = {}, unanswered = 0, onPrioritize, onStoppedRun }: { program: ProgramView; titles: Record<string, string>; phases?: Record<string, number>; unanswered?: number; onPrioritize?: (specId: string) => unknown; /** What the owner can do with a run that stopped on its own; the row offers nothing without it. */ onStoppedRun?: { resume: (runId: string) => unknown; restart: (runId: string) => unknown; cancel: (runId: string) => unknown } }) {
  const done = program.items.filter((i) => i.status === 'done').length;
  const total = program.items.length;
  const totalCost = program.items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
  const interrupted = isInterrupted(program);
  const running = program.status !== 'finished';
  const waiting = onlyValidationsLeft(program);
  const awaiting = awaitingOwner(program);
  const ordered = useMemo(() => [...program.items].sort((a, b) => statusRank(a) - statusRank(b) || a.rank - b.rank), [program.items]);
  const spec = useMemo<TableSpec<ProgramViewItem>>(() => ({
    sorts: { rank: (i) => i.rank, spec: (i) => titles[i.key] ?? i.key, status: statusRank, cost: (i) => i.costUsd },
    text: (i) => [titles[i.key] ?? i.key, i.key, i.runId ?? ''],
    facet: shownStatus,
  }), [titles]);
  /** What the owner can do with a row, each with its own key. */
  const rowActions = (i: ProgramViewItem) => [
    onStoppedRun && i.status === 'running' && i.runId && (i.pause?.reason === 'auth' || i.interrupted) && <RunStoppedActions key="stopped" runId={i.interrupted?.runId ?? i.runId} latest onResume={onStoppedRun.resume} onRestart={onStoppedRun.restart} onCancel={onStoppedRun.cancel} />,
    i.status === 'pending' && (i.priority ? <Tipped key="priority" text="Esta spec foi escolhida para executar antes das outras da fila."><span className="status-chip tone-neutral" data-testid={`program-panel-priority-${i.key}`}>prioritária</span></Tipped> : onPrioritize && <ActionButton key="run" className={action.secondary} onClick={() => onPrioritize(i.specId)} icon={<Icon name="play" size={14} />}>Executar agora</ActionButton>),
    (i.status === 'failed' || i.status === 'partial') && onPrioritize && <ActionButton key="retry" className={action.secondary} onClick={() => onPrioritize(i.specId)} icon={<Icon name="refresh" size={14} />}>Tentar de novo</ActionButton>,
  ].filter(Boolean);
  const view = useLocalTable(ordered, spec, (status) => LABEL[status as keyof typeof LABEL] ?? status);
  return (
    <section className={`${panel} gap-4`} data-testid="program-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2" data-testid="program-panel-header">
        <div className={sectionTitle} data-testid="program-panel-title-row">
          <span className="grid size-6 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink" aria-hidden="true" data-testid="program-panel-icon"><Icon name="list" size={14} /></span>
          <h2 className={`${sectionHeading} ml-1`} data-testid="program-panel-title">Specs do backlog</h2>
          <InfoTip label="Execução do backlog" text={HELP} />
        </div>
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-ink-soft tabular-nums" role="status" data-testid="program-panel-summary">
          {interrupted ? <span className="grid size-4 flex-none place-items-center text-warn" aria-hidden="true" data-testid="program-panel-icon-interrupted"><Icon name="alert" size={16} /></span> : waiting ? <span className="grid size-4 flex-none place-items-center text-warn" aria-hidden="true" data-testid="program-panel-icon-waiting"><Icon name="clock" size={16} /></span> : running ? <span className="loading-spinner flex-none" aria-hidden="true" data-testid="program-panel-spinner" /> : null}
          <span data-testid="program-panel-progress"><b className="font-semibold text-ink">{interrupted ? 'Backlog interrompido' : waiting ? 'Aguardando sua validação' : running ? 'Executando o backlog' : 'Backlog executado'}</b> · {done} de {total} concluída{total === 1 ? '' : 's'}</span>
          {statusCounts(program.items) && <span data-testid="program-panel-counts">{statusCounts(program.items)}</span>}
          {awaiting > 0 && <span data-testid="program-panel-awaiting">{awaitingText(awaiting)}</span>}
          {totalCost > 0 && <span className="whitespace-nowrap" data-testid="program-total-cost">{fmtCost(totalCost)}</span>}
          {unanswered > 0 && <Tipped text="Um modelo foi consultado e falhou, ou falta a chave do Jev. Verifique o Jev e a chave do modelo."><span className="status-chip tone-warn" data-testid="program-panel-unanswered">{unanswered} {unanswered === 1 ? 'consulta sem resposta' : 'consultas sem resposta'}</span></Tipped>}
        </p>
      </div>
      <progress data-testid="program-panel-progress-bar" className="h-2 w-full appearance-none overflow-hidden rounded-full border-0 bg-surface-muted [&::-moz-progress-bar]:bg-good-live [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-good-live" max={total} value={done} />
      {program.status === 'finished' && <p className="hint m-0" data-testid="program-panel-finished">Programa encerrado{program.items.some((i) => i.status === 'failed' || i.status === 'blocked') ? ': há specs que falharam ou ficaram bloqueadas.' : program.items.some((i) => i.status === 'partial') ? ': há specs concluídas parcialmente.' : '.'}</p>}
      <TableFilters view={view} subject="specs" placeholder="Filtrar por spec ou run" facetName="Status" />
      <div data-testid="program-panel-table-wrap" className="@container relative -mx-[0.6rem] @max-[44rem]:mx-0 min-w-0 overflow-x-auto @min-[44rem]:[&_td]:py-3 [&_td]:align-middle">
        <table data-testid="program-panel-table" className={`m-0 ${responsiveTable} @min-[60rem]:min-w-[60rem] table-fixed`}>
          <colgroup><col className="w-[6%]" /><col className="w-[44%]" /><col className="w-[18%]" /><col className="w-[18%]" /><col className="w-[14%]" /></colgroup>
          <thead className={responsiveHead}>
            <tr>
              <SortHeader view={view} column="rank">#</SortHeader>
              <SortHeader view={view} column="spec">Spec</SortHeader>
              <SortHeader view={view} column="status">Status</SortHeader>
              <th scope="col"><span className="sr-only">Ação</span></th>
              <SortHeader view={view} column="cost" className="num">Custo</SortHeader>
            </tr>
          </thead>
          <tbody className="@max-[44rem]:block">
            {view.rows.length === 0 ? <tr data-testid="program-panel-empty"><td colSpan={5} className="text-ink-soft">Nenhuma spec corresponde ao filtro.</td></tr> : null}
            {view.rows.map((i) => {
              const actions = rowActions(i);
              return (
              <tr key={i.specId} className={`${i.status === 'running' || i.status === 'completing' ? LIVE : ''} ${responsiveRow} @max-[44rem]:grid-cols-[auto_1fr_auto] @max-[44rem]:gap-x-3 @max-[44rem]:gap-y-2`} data-testid={`program-item-${i.key}`}>
                <td className={`font-mono text-[0.8125rem] text-ink-soft tabular-nums ${responsiveCell} @max-[44rem]:before:hidden`} data-testid={`program-panel-rank-${i.key}`}>#{i.rank}</td>
                <td className={`${responsiveCell} @max-[44rem]:col-span-3 @max-[44rem]:row-start-2 @max-[44rem]:before:hidden`}>
                  <div className="grid min-w-0 gap-1 text-left hyphens-auto" data-testid={`program-panel-body-${i.key}`}>
                    <b className="font-semibold text-ink wrap-anywhere" data-testid={`program-panel-name-${i.key}`}>{titles[i.key] ?? i.key}</b>
                    {i.runId && <Link to={runPath(i.runId)} className="w-fit max-w-full truncate font-mono text-[0.75rem] no-underline hover:underline">{i.runId}</Link>}
                    {i.status === 'running' && i.runId && phases[i.runId] !== undefined && <span className="text-[0.8125rem] text-ink-soft" data-testid={`program-panel-phase-${i.key}`}>{phaseTitle(phases[i.runId]!)}</span>}
                    {i.pause && <p className="m-0 text-[0.8125rem] text-ink-soft" data-testid={`program-item-pause-${i.key}`}>{pauseText(i.pause)}</p>}
                    {i.status === 'waiting' && i.retryAt && <p className="m-0 text-[0.8125rem] text-ink-soft" data-testid={`program-panel-retry-${i.key}`}>tenta de novo às {hhmm(new Date(i.retryAt))}</p>}
                    {i.prs && i.prs.length > 0 && (
                      <details className="text-[0.8125rem]" data-testid={`program-item-prs-${i.key}`}>
                        <summary className="w-fit cursor-pointer text-ink-soft" data-testid={`program-panel-prs-summary-${i.key}`}>{i.prs.length} {i.prs.length === 1 ? 'pull request' : 'pull requests'}</summary>
                        <p className="m-0 mt-1 flex flex-wrap gap-x-3 gap-y-1" data-testid={`program-panel-prs-list-${i.key}`}>
                          {i.prs.map((pr) => <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer" className="font-mono" data-testid={`program-panel-pr-${pr.url}`}>{prLabel(pr)}</a>)}
                        </p>
                      </details>
                    )}
                    {i.reason && <ItemReason status={i.status} reason={i.reason} />}
                  </div>
                </td>
                <td className={`${responsiveCell} @max-[44rem]:col-start-2 @max-[44rem]:col-span-2 @max-[44rem]:row-start-1 @max-[44rem]:items-end! @max-[44rem]:before:hidden`}>
                  <Tipped text={ITEM_HELP[shownStatus(i)]}><span className={PILL[shownStatus(i)]} data-testid={`program-panel-status-${i.key}`}>{LABEL[shownStatus(i)]}</span></Tipped>
                </td>
                <td className={`${responsiveCell} @max-[44rem]:col-span-2 @max-[44rem]:row-start-3 ${actions.length > 0 ? '' : '@max-[44rem]:hidden!'}`} data-testid={`program-panel-action-${i.key}`}>
                  <span className="flex flex-wrap gap-2">{actions}</span>
                </td>
                <td className={`num text-[0.8125rem] text-ink-soft ${responsiveCell} @max-[44rem]:col-start-3 @max-[44rem]:row-start-3 @max-[44rem]:items-end! @max-[44rem]:before:hidden`} data-testid={`program-panel-cost-${i.key}`}>
                  {i.costUsd != null ? <span className="whitespace-nowrap" data-testid={`program-item-cost-${i.key}`}>{fmtCost(i.costUsd)}</span> : <span className="text-ink-faint" aria-hidden="true" data-testid={`program-panel-cost-empty-${i.key}`}>—</span>}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination view={view} />
    </section>
  );
}
