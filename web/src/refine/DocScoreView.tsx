import type { ReactNode } from 'react';
import { DOUBT_BELOW, percentOf, SCORE_CHECKS, type DocScore, type ScoreCheck, type ScoreDoubt } from '@server/refine/readiness';

export const CHECK_LABEL: Record<ScoreCheck, string> = { complete: 'completo', concrete: 'concreto', consistent: 'consistente' };

/** Each check as the question the Jev answers, in plain words. */
const CHECK_QUESTION: Record<ScoreCheck, string> = {
  complete: 'Tem tudo o que deveria ter?',
  concrete: 'Dá para conferir o que diz?',
  consistent: 'Está livre de contradições?',
};

const title = (heading: string): string => heading.replace(/^#+\s*/, '');

/** Where one doubt sits: its part of the document and the headings that bound it. */
function placeOf({ part }: ScoreDoubt): string {
  if (!part) return 'no documento';
  const from = part.from ? ` · de ${title(part.from)}` : '';
  const to = part.to ? ` até ${title(part.to)}` : part.index === part.of ? ' até o fim' : '';
  return `parte ${part.index} de ${part.of}${from}${to}`;
}

/** The places the Jev doubts for one check, or one line when every part is doubted. */
function DoubtPlaces({ doubts }: { doubts: ScoreDoubt[] }) {
  const of = doubts[0]?.part?.of;
  const lines = of !== undefined && doubts.length === of
    ? [`Em todas as ${of} partes (a pior: ${percentOf(Math.min(...doubts.map((d) => d.value)))}%)`]
    : doubts.filter((d) => d.part).map((d) => `${placeOf(d)} — ${percentOf(d.value)}%`);
  if (lines.length === 0) return null;
  return (
    <ul className="m-0 grid list-none gap-1 p-0 text-[0.75rem] leading-[1.4] text-ink-soft" data-testid="doc-score-doubts">
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}

/** One question with its value, a neutral bar and the places the Jev doubts. */
function ScoreQuestion({ id, doc }: { id: ScoreCheck; doc: DocScore }) {
  const value = doc.checks[id];
  const percent = percentOf(value);
  return (
    <li className="grid gap-1.5" data-testid={`doc-score-question-${id}`}>
      <p className="m-0 flex items-baseline justify-between gap-3 text-[0.8125rem] text-ink">
        <span>{CHECK_QUESTION[id]}</span>
        <b className="font-semibold tabular-nums">{percent}%</b>
      </p>
      <div className="flex items-center gap-3">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        </span>
        {value < DOUBT_BELOW && <span className="text-[0.75rem] font-medium text-ink-soft" data-testid="doc-score-doubted">em dúvida</span>}
      </div>
      <DoubtPlaces doubts={(doc.doubts ?? []).filter((d) => d.check === id)} />
    </li>
  );
}

/** The four checks of one document in one line: information only, with no colour and no threshold. */
export function ScoreChecks({ doc }: { doc: DocScore }) {
  return <p className="m-0 text-[0.8125rem] tabular-nums text-ink-soft" data-testid="doc-score-checks">{SCORE_CHECKS.map((id) => `${CHECK_LABEL[id]} ${percentOf(doc.checks[id])}%`).join(' · ')}</p>;
}

/** The Jev score of one document, as a single inset. */
export function DocScoreInset({ label, doc, children }: { label: string; doc: DocScore | undefined; children?: ReactNode }) {
  return (
    <div className="grid gap-3 rounded-lg bg-surface-sunken px-3 py-3" aria-live="polite" data-testid="doc-score">
      <div className="grid gap-1">
        <p className="m-0 flex items-baseline justify-between gap-3 text-[0.8125rem] text-ink-soft" data-testid="doc-score-heading">
          <span data-testid="doc-score-label">Nota do Jev · {label}</span>
          {doc && <b className="text-[1.125rem] font-semibold tabular-nums text-ink" data-testid="doc-score-percent">{percentOf(doc.score)}%</b>}
        </p>
        {doc && <p className="m-0 text-[0.75rem] leading-[1.4] text-ink-soft">Média das {SCORE_CHECKS.length} perguntas. Cada valor é a chance de o Jev responder “sim”.</p>}
      </div>
      {doc && (
        <ul className="m-0 grid list-none gap-3 p-0" data-testid="doc-score-questions">
          {SCORE_CHECKS.map((id) => <ScoreQuestion key={id} id={id} doc={doc} />)}
        </ul>
      )}
      {doc && (
        <details className="text-[0.75rem] leading-[1.45] text-ink-soft" data-testid="doc-score-how">
          <summary className="cursor-pointer text-[0.8125rem] text-ink">Como a nota é calculada</summary>
          <p className="mt-1.5 mb-0">Um documento longo é lido em partes de até 32 mil caracteres. “Tem tudo” é julgado uma vez, pelo sumário de títulos do documento inteiro. “Dá para conferir” é a média das partes, pesada pelo tamanho. Contradições valem a pior parte. Abaixo de 60%, a pergunta fica em dúvida.</p>
        </details>
      )}
      {children}
    </div>
  );
}
