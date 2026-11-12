import type { ReactNode } from 'react';
import type { GraphView } from '../../api.js';
import { sectionHeading } from '../project-shared.js';
import { ageOf, armRows, graphHealth, MIN_ARM_SPECS, MIN_ARM_STEPS, relationsLine, usefulLine, type ArmRow, type Verdict } from './health-rules.js';

const PILL: Record<Verdict, { label: string; tone: string }> = {
  ok: { label: 'Funcionando', tone: 'tone-good' },
  degraded: { label: 'Degradado', tone: 'tone-warn' },
  nodata: { label: 'Sem dados', tone: 'tone-neutral' },
};

const money = (usd: number): string => `US$ ${usd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const percent = (change: number | null): string => (change === null ? '—' : `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(Math.round(change))}%`);
const FEW = 'Poucos passos ou poucas specs: ainda não conclui.';
const kindLabel = (kind: string): string => ({ dev: 'desenvolvimento', review: 'revisão', security: 'segurança', test: 'testes' })[kind] ?? kind;

function Measure({ label, value, testId, wide }: { label: string; value: string; testId: string; wide?: boolean }) {
  return (
    <div className={`grid content-start gap-0.5 ${wide ? 'col-span-2' : ''}`}>
      <dt className="text-[0.75rem] text-ink-soft">{label}</dt>
      <dd data-testid={testId} className="m-0 text-[0.9375rem] leading-[1.45] text-ink [font-variant-numeric:tabular-nums]">{value}</dd>
    </div>
  );
}

/** What one step of an arm cost and read, with the group size; the two groups side by side, graph first. */
const pair = (a: string, b: string): string => `${a} · ${b}`;

/** Whether the graph helps: a one-line status that opens into the reason, four measures, the experiment of the steps that had the graph against the ones that did not, and the extra lines it is given. */
export function GraphHealth({ view, now, children }: { view: GraphView; now: number; children?: ReactNode }) {
  const health = graphHealth(view, now);
  const pill = PILL[health.verdict];
  const rows = armRows(view.usage.effect?.arms);
  const updatedAt = view.status?.updatedAt ?? null;
  return (
    <details data-testid="graph-health" className="card group grid gap-4 px-5 py-1.5 open:pb-5 max-md:px-4">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 [&::-webkit-details-marker]:hidden">
        <h2 id="graph-health-title" className={sectionHeading}>Saúde do grafo</h2>
        <span data-testid="graph-health-verdict" className={`status-pill ${pill.tone}`}>{pill.label}</span>
        <span data-testid="graph-health-summary" className="min-w-0 text-[0.8125rem] text-ink-soft">{`${updatedAt === null ? 'sem data' : ageOf(updatedAt, now)} · ${usefulLine(view)}`}</span>
        <span className="link-button ml-auto inline-flex items-center justify-center text-[0.8125rem] group-open:hidden">Ver saúde do grafo</span>
        <span className="link-button ml-auto hidden items-center justify-center text-[0.8125rem] group-open:inline-flex">Ocultar saúde do grafo</span>
      </summary>
      <p data-testid="graph-health-reason" className="m-0 max-w-[65ch] text-[0.875rem] leading-[1.5] text-ink-soft">{health.reason}</p>
      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
        <Measure testId="graph-health-age" label="Idade" value={updatedAt === null ? '—' : ageOf(updatedAt, now)} />
        <Measure testId="graph-health-communities" label="Comunidades" value={String(view.communities)} />
        <Measure testId="graph-health-useful" label="Consultas úteis" value={usefulLine(view)} />
        <Measure testId="graph-health-relations" label="Ligações entre specs" value={relationsLine(view.relations)} wide />
      </dl>
      <div className="grid gap-2">
        <h3 className={sectionHeading}>Com grafo × sem grafo</h3>
        {rows.length === 0 ? (
          <p data-testid="graph-health-experiment-empty" className="m-0 text-[0.875rem] text-ink-soft">O experimento acumula conforme as rodadas terminam.</p>
        ) : (
          <>
            <table data-testid="graph-health-experiment" className="mt-0 hidden md:table">
              <thead>
                <tr><th scope="col">Passo</th><th scope="col">Custo por passo</th><th scope="col">Variação</th><th scope="col">Leituras por passo</th><th scope="col">Variação</th><th scope="col">Passos e specs</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.kind} data-testid={`graph-health-row-${row.kind}`}>
                    <th scope="row" className="border-b border-line text-[0.875rem] font-semibold normal-case tracking-normal text-ink">{kindLabel(row.kind)}</th>
                    <ArmCells row={row} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ul data-testid="graph-health-experiment-list" className="m-0 grid list-none gap-3 p-0 md:hidden">
              {rows.map((row) => (
                <li key={row.kind} className="grid gap-0.5 border-b border-line pb-3">
                  <span className="text-[0.875rem] font-semibold text-ink">{kindLabel(row.kind)}</span>
                  <span className="text-[0.8125rem] text-ink-soft">{`Custo por passo: ${pair(money(row.graph.cost), money(row.control.cost))} (${percent(row.costChange)})`}</span>
                  <span className="text-[0.8125rem] text-ink-soft">{`Leituras por passo: ${pair(number(row.graph.reads), number(row.control.reads))} (${percent(row.readsChange)})`}</span>
                  <span className="text-[0.8125rem] text-ink-soft">{`Passos: ${pair(String(row.graph.steps), String(row.control.steps))} · Specs: ${pair(String(row.specs.graph), String(row.specs.control))}${row.conclusive ? '' : `. ${FEW}`}`}</span>
                </li>
              ))}
            </ul>
            <p className="m-0 text-[0.8125rem] text-ink-soft">{`Cada par mostra o grupo com grafo, depois o grupo sem grafo. A variação negativa quer dizer que o grafo gastou menos. Só conclui com ${MIN_ARM_STEPS} passos e ${MIN_ARM_SPECS} specs diferentes em cada grupo.`}</p>
          </>
        )}
      </div>
      {children}
    </details>
  );
}

function ArmCells({ row }: { row: ArmRow }) {
  return (
    <>
      <td>{pair(money(row.graph.cost), money(row.control.cost))}</td>
      <td className="text-ink-soft">{percent(row.costChange)}</td>
      <td>{pair(number(row.graph.reads), number(row.control.reads))}</td>
      <td className="text-ink-soft">{percent(row.readsChange)}</td>
      <td>
        {pair(String(row.graph.steps), String(row.control.steps))}
        <span className="block text-[0.75rem] text-ink-soft">{`${pair(String(row.specs.graph), String(row.specs.control))} specs`}</span>
        {row.conclusive ? null : <span className="block text-[0.75rem] text-ink-soft">{FEW}</span>}
      </td>
    </>
  );
}
