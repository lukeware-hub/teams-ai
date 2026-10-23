import type { ReactNode } from 'react';
import { percentOf, SCORE_CHECKS, type DocScore, type ScoreCheck } from '@server/refine/readiness';

export const CHECK_LABEL: Record<ScoreCheck, string> = { complete: 'completo', concrete: 'concreto', consistent: 'consistente', scoped: 'escopo' };

/** The four checks of one document in one line: information only, with no colour and no threshold. */
export function ScoreChecks({ doc }: { doc: DocScore }) {
  return <p className="m-0 text-[0.8125rem] tabular-nums text-ink-soft">{SCORE_CHECKS.map((id) => `${CHECK_LABEL[id]} ${percentOf(doc.checks[id])}%`).join(' · ')}</p>;
}

/** The Jev score of one document, as a single inset. */
export function DocScoreInset({ label, doc, children }: { label: string; doc: DocScore | undefined; children?: ReactNode }) {
  return (
    <div className="grid gap-1.5 rounded-lg bg-surface-sunken px-3 py-2.5" aria-live="polite" data-testid="doc-score">
      <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.8125rem] text-ink-soft">
        <span>Nota do Jev · {label}</span>
        {doc && <b className="text-[0.9375rem] font-semibold tabular-nums text-ink" data-testid="doc-score-percent">{percentOf(doc.score)}%</b>}
      </p>
      {doc && <ScoreChecks doc={doc} />}
      {children}
    </div>
  );
}
