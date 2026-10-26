import { isStarted } from '@server/refine/coverage';
import type { BacklogView } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';

const SIZE = { S: 'pequena', M: 'média', L: 'grande' } as const;
const HELP = 'Os agentes quebram os cinco documentos em specs organizadas em épicos e priorizadas de P0 (base de tudo) a P3 (depois). Cada avaliação gera a spec (PO) e o pré-plano com tarefas (SM) de cada item e refaz só o que os documentos mudaram. Para mudar prioridade ou cortes, escreva no briefing.md e avalie de novo.';

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
export function processingText(backlog: BacklogView): string {
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
  error: 'bg-warn-soft text-warn',
} as const;
export const bkMeta = 'flex-none text-[0.75rem] text-ink-faint';
const STATUS_TONE = { entregue: bkTone.planned, 'em execução': bkTone.planned, planejada: bkTone.planned, 'em refinamento': bkTone.refining, erro: bkTone.error } as const;

/** The documents broken into prioritized specs, the way the agents organized them; the human reads and steers through the docs. */
export function BacklogPanel({ backlog, evaluating, locked, onEnable, mandatory = false }: { backlog: BacklogView | null | undefined; evaluating: boolean; locked: boolean; onEnable?: () => unknown; mandatory?: boolean }) {
  if (!backlog?.enabled) {
    if (mandatory) return <p className="m-0 text-[0.8125rem] text-ink-soft" data-testid="backlog-mandatory">O backlog aparece aqui quando os documentos estiverem prontos: a mesma avaliação o monta e detalha.</p>;
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
      {backlog.items.length === 0 && !evaluating && <p className="text-[0.8125rem] text-ink-soft">{mandatory ? 'O esboço do backlog aparece aqui quando os documentos ficarem prontos.' :'O backlog aparece depois da próxima avaliação. Clique em Avaliar.'}</p>}
      {epics.map((epic) => (
        <details key={epic.key} className="group grid gap-[0.4rem]" data-testid={`epic-${epic.key}`}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[0.8125rem] text-ink-soft [&::-webkit-details-marker]:hidden">
            <span className="flex-none transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
            <span className="min-w-0 flex-1 font-semibold wrap-anywhere">{epic.title}</span>
            <span className="count-pill">{epic.items.length}</span>
          </summary>
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
                    {[...(backlog.specs?.[i.key]?.issues ?? []), ...(backlog.preplans?.[i.key]?.issues ?? [])].map((issue, n) => <p key={n} className="text-warn">Problema: {issue}</p>)}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </details>
      ))}
    </div>
  );
}
