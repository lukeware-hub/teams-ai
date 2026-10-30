import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { refineApi, runApi, type ProgramView, type ProgramViewItem, type RefineState } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';
import { InfoTip, Tipped } from '../components/InfoTip.js';
import { canStart, type StartInput } from '@server/refine/state';
import { explainStop, phaseTitle } from '../run/selectors.js';
import { action, panel, sectionHeading, sectionTitle } from '../pages/project-shared.js';

const HELP = 'Depois do início, os agentes executam o backlog inteiro sozinhos, na ordem de prioridade e de dependência, até duas specs ao mesmo tempo quando elas não mexem no mesmo código: planejam, implementam, testam, publicam e marcam cada spec como concluída. Uma spec que falha é isolada e só bloqueia as que dependem dela; as demais seguem. Executar agora passa uma spec à frente da fila.';

const ITEM_HELP = {
  pending: 'Na fila: a spec espera a vez, por prioridade e por dependência de outras specs.',
  running: 'Os agentes estão executando esta spec agora.',
  completing: 'A spec foi entregue e está sendo concluída.',
  waiting: 'A spec espera um tempo depois de uma falha de ambiente e começa de novo sozinha.',
  done: 'A spec foi entregue e concluída.',
  partial: 'O código da spec já está na main, mas uma etapa depois dele falhou (como o deploy). Veja o motivo abaixo.',
  failed: 'A execução desta spec falhou. Veja o motivo abaixo.',
  blocked: 'A spec não pôde seguir. Veja o motivo abaixo.',
  interrupted: 'O processo parou antes do fim. Abra a run para retomar.',
} as const;
const OWNER_HELP: Record<string, string> = { Sistema: 'Quem precisa agir: o sistema, que resolve sozinho ou precisa de um ajuste da plataforma.', Plano: 'Quem precisa agir: o plano ou a spec precisa ser corrigido.', Você: 'Quem precisa agir: você.' };
const LABEL = { pending: 'na fila', running: 'em execução', completing: 'concluindo', waiting: 'aguardando', done: 'concluída', partial: 'concluída parcialmente', failed: 'falhou', blocked: 'bloqueada', interrupted: 'interrompida' } as const;
// Same pills as the hub's spec rows; a live spec's dot pulses.
const PILL = {
  pending: 'status-pill',
  running: 'status-pill tone-neutral motion-safe:before:animate-pulse',
  completing: 'status-pill tone-neutral motion-safe:before:animate-pulse',
  waiting: 'status-pill tone-warn',
  done: 'status-pill tone-good',
  partial: 'status-pill tone-warn',
  failed: 'status-pill tone-bad',
  blocked: 'status-pill tone-bad',
  interrupted: 'status-pill tone-warn',
} as const;
// Rank, spec, status, cost and action share fixed columns so every row lines up; below lg status, cost and action wrap under the title.
const ROW = 'grid grid-cols-[2.5rem_minmax(0,1fr)_8rem_5.5rem_9rem] items-center gap-x-4 gap-y-2 border-b border-line px-3 py-[0.9rem] last:border-b-0 max-lg:grid-cols-[2rem_minmax(0,1fr)]';

/** The state a row shows: a run whose process is gone reads as interrupted, whatever the ledger says. */
const shownStatus = (i: ProgramViewItem) => (i.interrupted ? 'interrupted' : i.status);

/** Why an item failed or waits: what happened, who has to act and what to do, with the orchestrator's own words one click away. */
export function ItemReason({ status, reason }: { status: ProgramViewItem['status']; reason: string }) {
  const bad = status === 'failed' || status === 'blocked';
  const tone = bad || status === 'partial' ? 'text-warn' : 'text-ink-soft';
  const why = bad || status === 'partial' ? explainStop(reason) : null;
  if (!why) return <p className={`m-0 text-[0.8125rem] wrap-anywhere ${tone}`}>{reason}</p>;
  return (
    <div className="flex flex-col gap-1" data-testid="item-reason">
      <p className={`m-0 text-[0.8125rem] font-medium ${tone}`}>{why.title} <Tipped text={OWNER_HELP[why.owner] ?? 'Quem precisa agir para resolver.'}><span className="status-pill tone-neutral">{why.owner}</span></Tipped></p>
      <p className="hint m-0">{why.hint}</p>
      <details>
        <summary className="cursor-pointer text-[0.75rem] text-ink-soft">Detalhe técnico</summary>
        <pre className="m-0 max-h-48 overflow-auto text-[0.75rem] whitespace-pre-wrap wrap-anywhere">{reason}</pre>
      </details>
    </div>
  );
}

/** The start is never locked by a check or the Jev: only a running evaluation or a missing spec or backlog keeps it shut. */
export function canStartRun(st: StartInput, busy: boolean): boolean {
  return !busy && canStart(st);
}

/** The program that runs the backlog: every spec with where it stands, the run to follow and why one failed or waits. */
const fmtCost = (v: number) => `US$ ${v.toFixed(2)}`;

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
    const timer = setInterval(() => void poll(), 5_000);
    return () => clearInterval(timer);
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

/** A running backlog's status card with the way to its execution screen; nothing when the spec has no backlog or it finished. */
export function BacklogBanner({ projectId, specId }: { projectId: string; specId: string }) {
  const { program, phases } = useProgram(projectId, specId, true);
  const titles = useBacklogTitles(projectId, specId);
  if (!program || program.status === 'finished') return null;
  return <ProgramStatus program={program} titles={titles} phases={phases} link={`/refine/${projectId}/${specId}/program`} />;
}

/** The banner of a started backlog: a spinner while it runs, the progress, and each spec running now with its phase. */
export function ProgramStatus({ program, titles, phases, link }: { program: ProgramView | null; titles: Record<string, string>; phases: Record<string, number>; link?: string }) {
  const done = program?.items.filter((i) => i.status === 'done').length ?? 0;
  const total = program?.items.length ?? 0;
  const running = program?.status !== 'finished';
  const now = program?.items.filter((i) => i.status === 'running' || i.status === 'completing') ?? [];
  // A stopped run keeps its item running in the ledger: only the run's own process says it is gone.
  const interrupted = running && now.length > 0 && now.every((i) => i.interrupted);
  return (
    <div className="card grid gap-4 px-6 py-5 max-md:p-4" role="status">
      <div className="flex items-center gap-3">
        {interrupted ? <span className="grid size-5 flex-none place-items-center text-warn" aria-hidden="true"><Icon name="alert" size={18} /></span> : running ? <span className="loading-spinner flex-none" aria-hidden="true" /> : <span className="grid size-5 flex-none place-items-center text-good" aria-hidden="true"><Icon name="check" size={18} /></span>}
        <b className="text-[1rem] text-ink">{!program ? 'Preparando a execução do backlog…' : `${interrupted ? 'Backlog interrompido' : running ? 'Executando o backlog' : 'Backlog executado'} · ${done} de ${total} concluída${total === 1 ? '' : 's'}`}</b>
      </div>
      {program && <progress className="h-2 w-full appearance-none overflow-hidden rounded-full border-0 bg-surface-muted [&::-moz-progress-bar]:bg-good-live [&::-webkit-progress-bar]:bg-surface-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-good-live" max={total} value={done} />}
      {(now.length > 0 || link) && (
        <div className="grid gap-2 text-[0.875rem] text-ink-soft [&_p]:m-0">
          {now.map((i) => {
            const runId = i.interrupted?.runId ?? i.runId;
            return (
              <p key={i.specId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={i.interrupted ? 'size-2 flex-none rounded-full bg-warn' : 'size-2 flex-none rounded-full bg-accent-text motion-safe:animate-pulse'} aria-hidden="true" />
                <span>{i.interrupted ? 'Interrompida: ' : 'Agora: '}<b className="font-semibold text-ink">{titles[i.key] ?? i.key}</b>{i.runId && phases[i.runId] !== undefined && ` · ${phaseTitle(phases[i.runId]!)}`}{i.pause && ` · ${pauseText(i.pause)}`}</span>
                {runId && <>· <Link to={`/runs/${runId}`}>Acompanhar a run</Link></>}
              </p>
            );
          })}
          {link && <p className="mt-1"><Link to={link} className="link-button">Abrir a execução do backlog<Icon name="arrow-right" size={16} /></Link></p>}
        </div>
      )}
    </div>
  );
}

/** Every spec of the backlog in run order: its rank, title and run, where it stands, what it cost and what can be done. */
export function ProgramPanel({ program, titles, onPrioritize }: { program: ProgramView; titles: Record<string, string>; onPrioritize?: (specId: string) => unknown }) {
  const done = program.items.filter((i) => i.status === 'done').length;
  const totalCost = program.items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
  return (
    <section className={`${panel} gap-4`} data-testid="program-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className={sectionTitle}>
          <span className="grid size-6 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink" aria-hidden="true"><Icon name="list" size={14} /></span>
          <h2 className={`${sectionHeading} ml-1`}>Specs do backlog</h2>
          <InfoTip label="Execução do backlog" text={HELP} />
        </div>
        <p className="m-0 text-[0.8125rem] text-ink-soft tabular-nums">
          <span>{done} de {program.items.length} concluída{program.items.length === 1 ? '' : 's'}</span>
          {totalCost > 0 && <span data-testid="program-total-cost"> · {fmtCost(totalCost)}</span>}
        </p>
      </div>
      {program.status === 'finished' && <p className="hint m-0">Programa encerrado{program.items.some((i) => i.status === 'failed' || i.status === 'blocked') ? ': há specs que falharam ou ficaram bloqueadas.' : program.items.some((i) => i.status === 'partial') ? ': há specs concluídas parcialmente.' : '.'}</p>}
      <ol className="-mx-3 my-0 list-none p-0">
        {[...program.items].sort((a, b) => a.rank - b.rank).map((i) => (
          <li key={i.specId} className={`${ROW} ${i.status === 'running' || i.status === 'completing' ? 'bg-accent-soft/40' : 'hover:bg-surface-sunken'}`} data-testid={`program-item-${i.key}`}>
            <span className="font-mono text-[0.8125rem] text-ink-faint tabular-nums">#{i.rank}</span>
            <div className="grid min-w-0 gap-1">
              <b className="font-semibold text-ink wrap-anywhere">{titles[i.key] ?? i.key}</b>
              {i.runId && <Link to={`/runs/${i.runId}`} className="w-fit max-w-full truncate font-mono text-[0.75rem] no-underline hover:underline">{i.runId}</Link>}
              {i.pause && <p className="m-0 text-[0.8125rem] text-ink-soft" data-testid={`program-item-pause-${i.key}`}>{pauseText(i.pause)}</p>}
              {i.status === 'waiting' && i.retryAt && <p className="m-0 text-[0.8125rem] text-ink-soft">tenta de novo às {hhmm(new Date(i.retryAt))}</p>}
              {i.prs && i.prs.length > 0 && (
                <details className="text-[0.8125rem]" data-testid={`program-item-prs-${i.key}`}>
                  <summary className="w-fit cursor-pointer text-ink-soft">{i.prs.length} {i.prs.length === 1 ? 'pull request' : 'pull requests'}</summary>
                  <p className="m-0 mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {i.prs.map((pr) => <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer" className="font-mono">{prLabel(pr)}</a>)}
                  </p>
                </details>
              )}
              {i.reason && <ItemReason status={i.status} reason={i.reason} />}
            </div>
            <div className="flex flex-wrap items-center gap-3 max-lg:col-start-2 lg:contents">
              <Tipped text={ITEM_HELP[shownStatus(i)]}><span className={PILL[shownStatus(i)]}>{LABEL[shownStatus(i)]}</span></Tipped>
              <span className="text-right text-[0.8125rem] text-ink-soft tabular-nums lg:justify-self-end">
                {i.costUsd != null ? <span data-testid={`program-item-cost-${i.key}`}>{fmtCost(i.costUsd)}</span> : <span className="text-ink-faint" aria-hidden="true">—</span>}
              </span>
              <span className="flex lg:justify-self-end">
                {i.status === 'pending' && (i.priority ? <Tipped text="Esta spec foi escolhida para executar antes das outras da fila."><span className="status-chip tone-neutral">prioritária</span></Tipped> : onPrioritize && <ActionButton className={action.secondary} onClick={() => onPrioritize(i.specId)} icon={<Icon name="play" size={14} />}>Executar agora</ActionButton>)}
                {i.status === 'failed' && onPrioritize && <ActionButton className={action.secondary} onClick={() => onPrioritize(i.specId)} icon={<Icon name="refresh" size={14} />}>Tentar de novo</ActionButton>}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
