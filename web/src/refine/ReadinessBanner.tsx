import type { DocFile } from '@server/refine/draft';
import { GOAL_SHARE, jevVerdict, percentOf, READY_PERCENT, SCORE_CHECKS, type JevVerdict, type Readiness, type ScoreCheck } from '@server/refine/readiness';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';
import { DOC_LABEL } from './doc-labels.js';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

const CHECK_LABEL: Record<ScoreCheck, string> = { complete: 'completo', concrete: 'concreto', consistent: 'consistente', scoped: 'escopo' };

const CHIP: Record<Tone, string> = {
  good: 'border-good-line bg-good-soft text-good',
  warn: 'border-warn-line bg-warn-soft text-warn',
  bad: 'border-bad-line bg-bad-soft text-bad',
  neutral: 'border-line bg-surface-muted text-ink-soft',
};

const VIEW: Record<JevVerdict, { tone: Tone; title: string; detail: string }> = {
  none: { tone: 'neutral', title: 'Sem nota do Jev', detail: 'Clique em Avaliar com o Jev para a nota dos cinco documentos.' },
  skipped: { tone: 'neutral', title: 'Projeto confidencial', detail: 'O Jev não lê os documentos deste projeto, então não há nota.' },
  unavailable: { tone: 'bad', title: 'O Jev não respondeu', detail: 'Confira a chave do OpenRouter e clique em Avaliar com o Jev.' },
  outdated: { tone: 'warn', title: 'Os documentos mudaram depois da nota', detail: 'Clique em Avaliar com o Jev para medir de novo.' },
  below: { tone: 'warn', title: 'Ainda não está pronto para desenvolver', detail: `Mínimo recomendado ${READY_PERCENT}%. Você pode iniciar mesmo assim, ou melhorar os documentos e reavaliar.` },
  ready: { tone: 'good', title: 'Pronto para desenvolver', detail: `Nota acima do mínimo de ${READY_PERCENT}%.` },
};

interface Props {
  readiness: Readiness | undefined;
  canStart: boolean;
  startState: { label: string; busy: boolean };
  onScore: () => unknown;
  onStart: () => unknown;
}

/** The Jev's verdict on the documents: the score, the five documents, and the one step to take now. */
export function ReadinessBanner({ readiness, canStart, startState, onScore, onStart }: Props) {
  const verdict = jevVerdict(readiness);
  const view = VIEW[verdict];
  const scoredNow = verdict === 'ready' || verdict === 'below';
  const percent = scoredNow && readiness?.average != null ? percentOf(readiness.average) : null;
  const docs = scoredNow ? readiness?.docs ?? null : null;
  return (
    <section className="flex flex-col gap-4 rounded-tile border border-line bg-surface p-5 shadow-card" aria-label="Nota do Jev" data-testid="readiness-banner">
      <div className="flex flex-wrap items-start gap-3.5">
        <span className={`grid size-12 shrink-0 place-items-center rounded-tile border ${CHIP[view.tone]}`}>
          <Icon name={verdict === 'ready' ? 'check' : 'info'} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[0.75rem] font-semibold tracking-[0.07em] text-ink-soft">Avaliação dos documentos</p>
          <h2 className="m-0 mt-0.5 text-[1.125rem] font-semibold leading-[1.3] tracking-[-0.01em] text-ink">{view.title}</h2>
        </div>
        {percent !== null && (
          <span className={`inline-flex h-7 items-center rounded-md border px-2.5 text-[0.8125rem] font-semibold tabular-nums ${CHIP[view.tone]}`} data-testid="readiness-score">
            Nota do Jev {percent}%
          </span>
        )}
      </div>
      <p className="m-0 text-[0.9375rem] leading-[1.55] text-ink-soft">{view.detail}</p>
      {docs && (
        <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-5" data-testid="readiness-docs">
          {(Object.keys(DOC_LABEL) as DocFile[]).flatMap((file) => (docs[file] ? [{ file, doc: docs[file] }] : [])).map(({ file, doc }) => (
            <li key={file} className="flex flex-col gap-1 rounded-[var(--radius-lg)] bg-surface-sunken px-3 py-2.5">
              <span className="text-[0.8125rem] text-ink-soft">{DOC_LABEL[file]}</span>
              <b className="text-[0.9375rem] font-semibold tabular-nums text-ink">{percentOf(doc.score)}%</b>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[0.75rem] tabular-nums" data-testid={`readiness-checks-${file}`}>
                {SCORE_CHECKS.map((id: ScoreCheck) => (
                  <li key={id} className={doc.checks[id] < GOAL_SHARE ? 'font-semibold text-warn' : 'text-ink-soft'}>
                    {CHECK_LABEL[id]} {percentOf(doc.checks[id])}%
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {verdict !== 'skipped' && verdict !== 'ready' && (
          <ActionButton className="secondary" disabled={verdict === 'below'} onClick={onScore} icon={<Icon name="check" size={16} />}>
            Avaliar com o Jev
          </ActionButton>
        )}
        {(verdict === 'ready' || verdict === 'below') && (
          <ActionButton data-testid="readiness-start" className="primary" busy={startState.busy} disabled={!canStart} onClick={onStart} icon={<Icon name="play" size={16} />}>
            {startState.label}
          </ActionButton>
        )}
      </div>
    </section>
  );
}
