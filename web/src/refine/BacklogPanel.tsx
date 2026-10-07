import type { BacklogView } from '../api.js';
import { Icon } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';
import './backlog.css';

const SIZE = { S: 'pequena', M: 'média', L: 'grande' } as const;
const HELP = 'Os agentes quebram os cinco documentos em specs organizadas em épicos e priorizadas de P0 (base de tudo) a P3 (depois). Gasta uma avaliação. Para mudar prioridade ou cortes, escreva no briefing.md e reavalie. Com o esboço certo, Detalhar specs gera a spec (PO) e o pré-plano com tarefas (SM) de cada item; depois, cada avaliação refaz só o que os documentos mudaram. O início da execução a partir do backlog chega no próximo passo.';
const DETAIL_HELP = 'Gera a spec (objetivos, critérios de aceite) e o pré-plano (módulos, tarefas, riscos) de cada item, três itens por chamada de agente dentro de cada épico. A estimativa conta essas chamadas e a revisão do PO e do SM.';

/** Spec and pre-plan calls (three items of one epic per call) plus the PO and SM reviews. */
function estimatedCalls(backlog: BacklogView): number {
  const perEpic = new Map<string, number>();
  for (const i of backlog.items) perEpic.set(i.epic, (perEpic.get(i.epic) ?? 0) + 1);
  const batches = [...perEpic.values()].reduce((n, count) => n + Math.ceil(count / 3), 0);
  return batches * 2 + 2;
}

/** Where a detailed item stands: spec and current pre-plan, a failed attempt, or still being derived. */
function itemStatus(backlog: BacklogView, key: string): 'planejada' | 'em refinamento' | 'erro' {
  const spec = backlog.specs?.[key];
  const pre = backlog.preplans?.[key];
  if (spec && !spec.spec) return 'erro';
  if (spec?.spec && pre && !pre.preplan) return 'erro';
  if (spec?.spec && pre?.preplan && pre.specRev === spec.rev) return 'planejada';
  return 'em refinamento';
}
const STATUS_CLASS = { planejada: 'bk-planned', 'em refinamento': 'bk-refining', erro: 'bk-error' } as const;

/** The documents broken into prioritized specs, the way the agents organized them; the human reads and steers through the docs. */
export function BacklogPanel({ backlog, evaluating, locked, ready = false, onEnable, onDetail }: { backlog: BacklogView | null | undefined; evaluating: boolean; locked: boolean; ready?: boolean; onEnable?: () => void; onDetail?: () => void }) {
  if (!backlog?.enabled) {
    if (!onEnable) return null;
    return (
      <div className="backlog-panel card-inner" data-testid="backlog-off">
        <h4><Icon name="list" size={20} />Backlog<InfoTip text={HELP} /></h4>
        <p className="muted">Quebre os documentos em specs organizadas e priorizadas, em vez de uma spec só.</p>
        <button type="button" className="secondary" data-testid="enable-backlog" disabled={locked} onClick={onEnable}>Quebrar em backlog</button>
      </div>
    );
  }
  const titles = new Map(backlog.items.map((i) => [i.key, i.title]));
  const epics = backlog.epics.map((e) => ({ ...e, items: backlog.items.filter((i) => i.epic === e.key).sort((a, b) => a.rank - b.rank) })).filter((e) => e.items.length > 0);
  return (
    <div className="backlog-panel" data-testid="backlog-on">
      <h4><Icon name="list" size={20} />Backlog{backlog.items.length > 0 ? ` · ${backlog.items.length} specs em ${epics.length} épicos` : ''}<InfoTip text={HELP} /></h4>
      {backlog.items.length === 0 && <p className="muted">{evaluating ? 'Montando o backlog…' : 'O backlog aparece depois da próxima avaliação. Clique em Avaliar.'}</p>}
      {backlog.items.length > 0 && !backlog.detail && onDetail && (
        <p className="backlog-detail">
          <button type="button" className="secondary" data-testid="detail-specs" disabled={!ready || locked} onClick={onDetail}>Detalhar specs (~{estimatedCalls(backlog)} chamadas)</button>
          <InfoTip text={DETAIL_HELP} />
        </p>
      )}
      {epics.map((epic) => (
        <section key={epic.key} className="backlog-epic" data-testid={`epic-${epic.key}`}>
          <h5><span>{epic.title}</span><span className="count-pill">{epic.items.length}</span></h5>
          <ol className="backlog-items">
            {epic.items.map((i) => (
              <li key={i.key} className="backlog-item" data-testid={`item-${i.key}`}>
                <details>
                  <summary>
                    <span className={`bk-chip bk-${i.priority.toLowerCase()}`}>{i.priority}</span>
                    <b>{i.title}</b>
                    {backlog.detail && <span className={`bk-chip ${STATUS_CLASS[itemStatus(backlog, i.key)]}`}>{itemStatus(backlog, i.key)}</span>}
                    <span className="bk-meta">#{i.rank} · {SIZE[i.size]}</span>
                  </summary>
                  <div className="bk-body">
                    <p>{i.scope}</p>
                    <p>Por quê: {i.rationale}</p>
                    {i.dependsOn.length > 0 && <p>Depende de: {i.dependsOn.map((d) => titles.get(d) ?? d).join(', ')}</p>}
                    <p>Origem: {i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}</p>
                    {[...(backlog.specs?.[i.key]?.issues ?? []), ...(backlog.preplans?.[i.key]?.issues ?? [])].map((issue) => <p key={issue} className="bk-issue">Problema: {issue}</p>)}
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
