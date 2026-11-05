import type { ReactNode } from 'react';
import type { RequestImpact } from '../api.js';
import { Icon } from '../components/Icons.js';
import { plural } from '../pages/project-shared.js';
import { StepCard } from './StepCard.js';
import { type ReadyCheck, type ReplanRow } from './request.js';

/** The owner's own words, kept whole, and the section of the project briefing they sit under. */
export function RequestCard({ text, heading, interpreted, concluded = false, understood }: { text: string; heading: string; interpreted: boolean; concluded?: boolean; understood?: { requirements: number; rules: number } | null }) {
  const chip = concluded ? { label: 'Concluído', tone: 'ok' } : interpreted ? { label: 'Interpretado', tone: 'ok' } : { label: 'Em análise' };
  return (
    <StepCard id="request" icon="file" tone="accent" title="Seu pedido" info="O texto que você escreveu. Ele fica no briefing do projeto, na seção do pedido, e os agentes o seguem palavra por palavra." owner="Escrito por você" chip={chip} open>
      <p data-testid="request-text" className="m-0 whitespace-pre-wrap rounded-lg bg-surface-sunken px-3 py-2.5 text-[0.9375rem] leading-[1.55] text-ink">{text}</p>
      <p className="m-0 mt-2 text-[0.8125rem] text-ink-soft">salvo em briefing.md › {heading}</p>
      {understood && <p data-testid="request-understood" className="m-0 mt-2 text-[0.9375rem] font-medium text-ink">Entendido: {plural(understood.requirements, 'requisito', 'requisitos')} · {plural(understood.rules, 'regra de negócio', 'regras de negócio')}</p>}
    </StepCard>
  );
}

/** One count of the impact card, in the singular or the plural its number needs; opening it lists what the count stands for. */
function CountGroup({ id, one, many, items }: { id: string; one: string; many: string; items: string[] }) {
  return (
    <details data-testid={`impact-group-${id}`} className="min-w-0">
      <summary className="count-pill cursor-pointer select-none">{items.length} {items.length === 1 ? one : many}</summary>
      {items.length > 0 && <ul className="m-0 mt-2 grid list-none gap-1 p-0 text-[0.8125rem] text-ink-soft">{items.map((item) => <li key={item}>{item}</li>)}</ul>}
    </details>
  );
}

/** What an action on an affected spec means to the owner, in plain words. */
const ACTION_LABEL: Record<RequestImpact['affected'][number]['action'], string> = { adjust: 'ajuste proposto', review: 'revisar', none: 'sem ação' };

/** What the request does to the backlog it follows, as the SM measured it; an impact that did not close says why. */
export function ImpactCard({ impact, issues, addedKeys, accepted = [] }: { impact: RequestImpact | null; issues: string[]; addedKeys: string[]; accepted?: Array<{ file: string; heading: string }> }) {
  const body: ReactNode = impact === null ? (
    issues.length > 0 ? <p role="alert" data-testid="impact-issues" className="m-0 text-[0.875rem] text-warn">O impacto não fechou: {issues.join('; ')}</p> : <p className="m-0 text-[0.875rem] text-ink-soft">O SM ainda está medindo o impacto do pedido.</p>
  ) : (
    <div className="grid gap-3">
      <p className="m-0 text-[0.9375rem] leading-[1.55] text-ink">{impact.summary}</p>
      <div data-testid="impact-counts" className="flex flex-wrap gap-2">
        <CountGroup id="novas" one="spec nova" many="specs novas" items={addedKeys} />
        <CountGroup id="afetadas" one="afetada" many="afetadas" items={impact.affected.filter((a) => a.kind === 'spec').map((a) => `${a.ref}: ${a.effect} (${a.action})`)} />
        <CountGroup id="documentos" one="documento" many="documentos" items={impact.affected.filter((a) => a.kind === 'doc').map((a) => `${a.ref}: ${a.effect}`)} />
        <CountGroup id="riscos" one="risco" many="riscos" items={impact.risks.map((r) => `${r.severity}: ${r.text}. ${r.mitigation}`)} />
      </div>
      <ul data-testid="impact-affects" className="m-0 grid list-none gap-1 p-0 text-[0.8125rem] text-ink-soft">
        {impact.affected.filter((a) => a.kind === 'spec').map((a) => <li key={`spec-${a.ref}`}>Afeta: {a.ref} → {ACTION_LABEL[a.action]}. {a.effect}</li>)}
      </ul>
      {impact.conflicts.length > 0 && <ul data-testid="impact-conflicts" className="m-0 grid list-none gap-1 p-0 text-[0.8125rem] text-ink-soft">{impact.conflicts.map((c) => <li key={`${c.a}-${c.b}`}>Conflito: {c.a} ↔ {c.b} ({c.reason}) → {c.resolution}</li>)}</ul>}
      <p data-testid="impact-architecture" className="m-0 text-[0.8125rem] text-ink-soft">Arquitetura: {impact.affected.some((a) => a.kind === 'architecture' || a.kind === 'decision') ? 'com mudança' : 'sem mudança'} · Duplicidade: {impact.duplicates.length > 0 ? 'ver abaixo' : 'nenhuma'}</p>
      {impact.duplicates.length > 0 && <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem] text-ink-soft">{impact.duplicates.map((d) => <li key={d.newKey}>{d.newKey} repete {d.existing}: {d.verdict === 'reuse' ? 'aproveita a existente' : 'é distinta'}. {d.reason}</li>)}</ul>}
      <p data-testid="impact-accepted" className="m-0 text-[0.8125rem] text-ink-soft">Documentos atualizados pelo time: {accepted.length > 0 ? accepted.map((a) => `${a.file} › ${a.heading}`).join('; ') : 'nenhum'}</p>
    </div>
  );
  return (
    <StepCard id="impact" icon="alert" tone="violet" title="Impacto" info="O que o pedido toca no backlog que ele segue. O SM confere cada referência antes de mostrar; o que não fecha aparece aqui, em palavras." owner="Analisado pelo SM" chip={impact ? { label: 'Atual', tone: 'ok' } : { label: 'Medindo' }} open>
      {body}
    </StepCard>
  );
}

/** Columns of the replan table on a wide screen; on a phone each row stacks into one block. */
const REPLAN_COLUMNS = 'sm:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,8rem)_4rem_minmax(0,1.4fr)]';

/** The backlog as the request leaves it: what is new, what moved, what stays, and what already started. */
export function ReplanCard({ rows }: { rows: ReplanRow[] }) {
  const changed = rows.filter((r) => r.change !== 'mantida' && r.change !== 'sem mudança').length;
  return (
    <StepCard id="replan" icon="list" tone="accent" title="Replanejamento" info="O backlog depois do pedido: o que é novo, o que sobe ou desce e o que já começou, que fica como está." owner="Montado pelo PO" chip={{ label: `${changed} ${changed === 1 ? 'mudou' : 'mudaram'}` }} open>
      <ol data-testid="replan-rows" className="m-0 grid list-none gap-2 p-0">
        <li aria-hidden="true" className={`hidden gap-x-3 text-[0.75rem] uppercase tracking-[0.06em] text-ink-soft sm:grid ${REPLAN_COLUMNS}`}><span>antes</span><span>spec</span><span>estado</span><span>novo #</span><span>mudança</span></li>
        {rows.map((r) => (
          <li key={r.key} data-testid={`replan-row-${r.key}`} className={`grid gap-x-3 gap-y-1 border-b border-line pb-2 text-[0.875rem] max-sm:grid-cols-[1.5rem_minmax(0,1fr)] sm:items-baseline ${REPLAN_COLUMNS}`}>
            <span className="tabular-nums text-ink-soft max-sm:hidden">{r.oldRank ?? '—'}</span>
            <span className="min-w-0 break-words font-semibold text-ink max-sm:order-2">{r.key}</span>
            <span className="min-w-0 break-words text-ink-soft max-sm:hidden">{r.state}</span>
            <span className="tabular-nums text-ink max-sm:order-1">{r.newRank}</span>
            <span className="flex min-w-0 items-center gap-1.5 break-words text-ink-soft max-sm:hidden">{r.change.includes('mantida') && <Icon name="lock" size={13} />}{r.change}</span>
            <span className="col-start-2 min-w-0 break-words text-ink-soft max-sm:order-3 sm:hidden">{r.state} · {r.change}</span>
          </li>
        ))}
      </ol>
    </StepCard>
  );
}

/** The trail of the request as one line: the specs it made, their plans and their task lists. */
export function TraceStrip({ trail }: { trail: string }) {
  return <p data-testid="request-trail" className="m-0 text-[0.8125rem] text-ink-soft">Trilha: {trail}</p>;
}

/** The bar that closes the request: the checks it passed, its trail, and the owner's one action. */
export function ReadyBar({ checks, trail, action }: { checks: ReadyCheck[]; trail: string; action: ReactNode }) {
  return (
    <section data-testid="request-ready" aria-labelledby="request-ready-title" className="card grid gap-3 p-4">
      <h3 id="request-ready-title" className="m-0 text-[1rem] font-semibold text-ink">Pronto</h3>
      <ul data-testid="request-checks" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.875rem] text-ink">
        {checks.map((c) => (
          <li key={c.id} data-testid={`request-check-${c.id}`} className="flex items-center gap-1.5">
            <Icon name={c.ok ? 'check' : 'clock'} size={14} />
            {c.ok ? c.label : `falta: ${c.label}`}
          </li>
        ))}
      </ul>
      <TraceStrip trail={trail} />
      <div className="flex justify-end">{action}</div>
    </section>
  );
}
