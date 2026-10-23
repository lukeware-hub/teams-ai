import type { ReactNode } from 'react';
import { percentOf, SCORE_CHECKS, type DocScore, type ScoreCheck } from '@server/refine/readiness';
import { InfoTip } from '../components/InfoTip.js';

export const CHECK_LABEL: Record<ScoreCheck, string> = { complete: 'completo', concrete: 'concreto', consistent: 'consistente', scoped: 'escopo' };

/** What the score and each check mean, in plain words, for the info icon beside the score. */
const SCORE_HELP = 'A nota do Jev é a média das quatro checagens. Quanto maior o número, mais o Jev acha que o documento atende a cada checagem. completo: o documento tem todas as partes que deve ter. concreto: a maior parte do texto é fácil de conferir, com valores, nomes e limites exatos, sem termos vagos. consistente: nenhuma frase contradiz outra. escopo: o documento traz só o que é dele, sem conteúdo de outro documento.';

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
        <InfoTip label="Nota do Jev" text={SCORE_HELP} />
        {doc && <b className="text-[0.9375rem] font-semibold tabular-nums text-ink" data-testid="doc-score-percent">{percentOf(doc.score)}%</b>}
      </p>
      {doc && <ScoreChecks doc={doc} />}
      {children}
    </div>
  );
}
