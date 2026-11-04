import type { ReactNode } from 'react';
import type { BlockExplanation } from '../run/selectors.js';
import { Icon } from './Icons.js';

export const RAW_TEXT = 'm-0 rounded-md border border-line bg-surface-sunken px-[0.9rem] py-3 text-[0.78rem] leading-normal whitespace-pre-wrap text-ink wrap-anywhere';
export const SECTION_TITLE = 'mt-0 mb-[0.4rem]';
const FACT_ROWS = 'm-0 grid gap-[0.6rem] [&>div]:grid [&>div]:grid-cols-[8.5rem_minmax(0,1fr)] [&>div]:gap-3 max-md:[&>div]:grid-cols-1 max-md:[&>div]:gap-1 [&_dt]:text-[0.8125rem] [&_dt]:font-semibold [&_dt]:text-ink-soft [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:wrap-anywhere';

/** Label/value rows of a failure dialog; a null row is skipped. */
export function Facts({ rows }: { rows: Array<[string, ReactNode] | null> }) {
  return (
    <dl data-testid="facts" className={FACT_ROWS}>
      {rows
        .filter((row): row is [string, ReactNode] => row !== null)
        .map(([term, value]) => (
          <div key={term} data-testid={`facts-row-${term}`}>
            <dt data-testid={`facts-term-${term}`}>{term}</dt>
            <dd data-testid={`facts-value-${term}`}>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** The problem and the solution of a blocked task in plain words; the orchestrator's own text stays folded away. */
export function BlockReason({ block }: { block: BlockExplanation }) {
  const count = block.findings.length;
  return (
    <div data-testid="block-reason" className="grid gap-5">
      {block.problem.length || count ? (
        <section data-testid="block-reason-problem">
          <h3 data-testid="block-reason-problem-title" className={SECTION_TITLE}>O problema</h3>
          {block.problem.map((text, i) => (
            <p key={i} data-testid={`block-reason-problem-${i}`} className="m-0 mb-2">
              {text}
            </p>
          ))}
          {count ? (
            <>
              <p data-testid="block-reason-findings-count" className="m-0 mb-2">A revisão apontou {count === 1 ? '1 ponto' : `${count} pontos`} para corrigir:</p>
              <ol data-testid="block-reason-findings" className="m-0 grid list-decimal gap-3 pl-5">
                {block.findings.map((f, i) => (
                  <li key={i} data-testid={`block-reason-finding-${f.where}`}>
                    <span data-testid={`block-reason-finding-row-${f.where}`} className="flex flex-wrap items-center gap-2">
                      <span data-testid={`block-reason-finding-where-${f.where}`} className="font-mono text-[0.8125rem] wrap-anywhere">{f.where}</span>
                      <span data-testid={`block-reason-finding-severity-${f.where}`} className="rounded-pill bg-surface-muted px-2 py-0.5 text-[0.75rem] text-ink-soft">{f.severity}</span>
                    </span>
                    <span data-testid={`block-reason-finding-problem-${f.where}`} className="mt-1 block">{f.problem}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </section>
      ) : null}
      <section data-testid="block-reason-solution" className="flex items-start gap-[0.6rem] rounded-lg border border-accent-line bg-accent-soft p-[0.85rem] text-ink [&_svg]:flex-none [&_svg]:text-accent-text">
        <Icon name="lightbulb" size={20} />
        <div data-testid="block-reason-solution-body" className="grid min-w-0 gap-2">
          <h3 data-testid="block-reason-solution-title" className="m-0 text-[0.9375rem] font-semibold text-accent-text">Solução</h3>
          {count ? (
            <ol data-testid="block-reason-solution-steps" className="m-0 grid list-decimal gap-2 pl-5">
              {block.findings.map((f, i) => (
                <li key={i} data-testid={`block-reason-solution-step-${f.where}`}>{f.fix ?? 'Veja o detalhe técnico.'}</li>
              ))}
            </ol>
          ) : null}
          <p data-testid="block-reason-next" className="m-0">{block.next}</p>
        </div>
      </section>
      <details data-testid="block-reason-raw">
        <summary data-testid="block-reason-raw-summary" className="cursor-pointer text-[0.8125rem] font-semibold text-accent-text">Ver detalhe técnico</summary>
        <pre data-testid="block-reason-raw-text" className={`mt-2 ${RAW_TEXT}`}>{block.raw}</pre>
      </details>
    </div>
  );
}
