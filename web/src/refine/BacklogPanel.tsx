import { isStarted } from '@server/refine/coverage';
import type { BacklogView } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';

const SIZE = { S: 'pequena', M: 'média', L: 'grande' } as const;
const HELP = 'Os agentes quebram os cinco documentos em specs organizadas em épicos e priorizadas de P0 (base de tudo) a P3 (depois). Gasta uma avaliação. Para mudar prioridade ou cortes, escreva no briefing.md e reavalie. Com o esboço certo, Detalhar specs gera a spec (PO) e o pré-plano com tarefas (SM) de cada item; depois, cada avaliação refaz só o que os documentos mudaram. O início da execução a partir do backlog chega no próximo passo.';
const DETAIL_HELP = 'Gera a spec (objetivos, critérios de aceite) e o pré-plano (módulos, tarefas, riscos) de cada item, três itens por chamada de agente dentro de cada épico. A estimativa conta essas chamadas e as revisões do Front, do PO e do SM.';

/** Spec and pre-plan calls (three items of one epic per call) plus the Front, PO and SM reviews. */
function estimatedCalls(backlog: BacklogView): number {
  const perEpic = new Map<string, number>();
  for (const i of backlog.items) perEpic.set(i.epic, (perEpic.get(i.epic) ?? 0) + 1);
  const batches = [...perEpic.values()].reduce((n, count) => n + Math.ceil(count / 3), 0);
  return batches * 2 + 3;
}

/** Where a detailed item stands: delivered or running as main has it, spec and current pre-plan, a failed attempt, or still being derived. */
function itemStatus(backlog: BacklogView, key: string): 'entregue' | 'em execução' | 'planejada' | 'em refinamento' | 'erro' {
  const spec = backlog.specs?.[key];
  const pre = backlog.preplans?.[key];
  if (spec?.spec && isStarted(spec.spec.status)) return spec.spec.status === 'done' ? 'entregue' : 'em execução';
  if (spec && !spec.spec) return 'erro';
  if (spec?.spec && pre && !pre.preplan) return 'erro';
  if (spec?.spec && pre?.preplan && pre.specRev === spec.rev) return 'planejada';
  return 'em refinamento';
}
/** What the agents are doing to the backlog while an evaluation runs. */
function processingText(backlog: BacklogView): string {
  if (backlog.items.length === 0) return 'Montando a lista de specs a partir dos documentos.';
  if (!backlog.detail) return 'Atualizando a lista de specs.';
  const planned = backlog.items.filter((i) => itemStatus(backlog, i.key) !== 'em refinamento').length;
  return `Gerando a spec e o pré-plano de cada item: ${planned} de ${backlog.items.length} prontos.`;
}
/** A small backlog chip and its tones, shared with the program panel. */
export const bkChip = 'flex-none rounded-full px-2 py-[0.1rem] text-[0.6875rem] font-bold';
export const bkTone = {
  P0: 'bg-accent-soft text-accent-ink',
  P1: 'bg-good-soft text-good',
  P2: 'bg-warn-soft text-warn',
  P3: 'bg-surface-muted text-ink-soft',
  planned: 'bg-good-soft text-good',
  refining: 'bg-surface-muted text-ink-soft',
  error: 'bg-bad-soft text-bad',
} as const;
export const bkMeta = 'flex-none text-[0.75rem] text-ink-faint';
const STATUS_TONE = { entregue: bkTone.planned, 'em execução': bkTone.planned, planejada: bkTone.planned, 'em refinamento': bkTone.refining, erro: bkTone.error } as const;

/** The documents broken into prioritized specs, the way the agents organized them; the human reads and steers through the docs. */
export function BacklogPanel({ backlog, evaluating, locked, ready = false, onEnable, onDetail }: { backlog: BacklogView | null | undefined; evaluating: boolean; locked: boolean; ready?: boolean; onEnable?: () => unknown; onDetail?: () => unknown }) {
  if (!backlog?.enabled) {
    if (!onEnable) return null;
    return (
      <div className="my-4 grid gap-3 rounded-lg border border-line bg-surface-sunken p-4" data-testid="backlog-off">
        <h4 className="m-0 flex items-center gap-2"><Icon name="list" size={20} />Backlog<InfoTip text={HELP} /></h4>
        <p className="text-[0.8125rem] text-ink-soft">Quebre os documentos em specs organizadas e priorizadas, em vez de uma spec só.</p>
        <ActionButton className="secondary" data-testid="enable-backlog" disabled={locked} onClick={onEnable} icon={<Icon name="list" size={16} />}>Quebrar em backlog</ActionButton>
      </div>
    );
  }
  const titles = new Map(backlog.items.map((i) => [i.key, i.title]));
  const epics = backlog.epics.map((e) => ({ ...e, items: backlog.items.filter((i) => i.epic === e.key).sort((a, b) => a.rank - b.rank) })).filter((e) => e.items.length > 0);
  return (
    <div className="my-4 grid gap-3" data-testid="backlog-on">
      <h4 className="m-0 flex items-center gap-2"><Icon name="list" size={20} />Backlog{backlog.items.length > 0 ? ` · ${backlog.items.length} specs em ${epics.length} épicos` : ''}<InfoTip text={HELP} /></h4>
      {evaluating && (
        <p className="m-0 flex items-center gap-2 rounded-lg border border-accent-line bg-accent-soft px-3 py-2 text-[0.8125rem] text-ink" role="status" aria-live="polite" data-testid="backlog-processing">
          <span className="button-spinner" aria-hidden="true" />
          <span><b>Processando o backlog.</b> {processingText(backlog)}</span>
        </p>
      )}
      {backlog.items.length === 0 && !evaluating && <p className="text-[0.8125rem] text-ink-soft">O backlog aparece depois da próxima avaliação. Clique em Avaliar.</p>}
      {backlog.items.length > 0 && !backlog.detail && onDetail && (
        <p className="m-0 flex items-center gap-2">
          <ActionButton className="secondary" data-testid="detail-specs" disabled={!ready || locked} onClick={onDetail} icon={<Icon name="file" size={16} />}>Detalhar specs (~{estimatedCalls(backlog)} chamadas)</ActionButton>
          <InfoTip text={DETAIL_HELP} />
        </p>
      )}
      {epics.map((epic) => (
        <section key={epic.key} className="grid gap-[0.4rem]" data-testid={`epic-${epic.key}`}>
          <h5 className="m-0 flex items-center justify-between gap-2 text-[0.8125rem] text-ink-soft"><span>{epic.title}</span><span className="count-pill">{epic.items.length}</span></h5>
          <ol className="m-0 grid list-none gap-[0.4rem] p-0">
            {epic.items.map((i) => (
              <li key={i.key} className="rounded-md border border-line bg-surface" data-testid={`item-${i.key}`}>
                <details>
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-[0.65rem] py-2 [&::-webkit-details-marker]:hidden">
                    <span className={`${bkChip} ${bkTone[i.priority]}`}>{i.priority}</span>
                    <b className="min-w-[10rem] flex-[1_1_10rem] font-semibold wrap-anywhere">{i.title}</b>
                    {backlog.detail && <span className={`${bkChip} ${STATUS_TONE[itemStatus(backlog, i.key)]}`}>{itemStatus(backlog, i.key)}</span>}
                    <span className={bkMeta}>#{i.rank} · {SIZE[i.size]}</span>
                  </summary>
                  <div className="grid gap-[0.35rem] px-[0.65rem] pb-[0.65rem] text-[0.8125rem] text-ink-soft [&_p]:m-0">
                    <p>{i.scope}</p>
                    <p>Por quê: {i.rationale}</p>
                    {i.dependsOn.length > 0 && <p>Depende de: {i.dependsOn.map((d) => titles.get(d) ?? d).join(', ')}</p>}
                    <p>Origem: {i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}</p>
                    {[...(backlog.specs?.[i.key]?.issues ?? []), ...(backlog.preplans?.[i.key]?.issues ?? [])].map((issue, n) => <p key={n} className="text-bad">Problema: {issue}</p>)}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
