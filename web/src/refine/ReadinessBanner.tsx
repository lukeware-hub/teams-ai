import type { DocFile } from '@server/refine/draft';
import { jevVerdict, percentOf, READY_PERCENT, type JevVerdict, type Readiness } from '@server/refine/readiness';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';
import { DOC_LABEL } from './doc-labels.js';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

const TONE: Record<Tone, string> = {
  good: 'border-good-line bg-good-soft text-good',
  warn: 'border-warn-line bg-warn-soft text-warn',
  bad: 'border-bad-line bg-bad-soft text-bad',
  neutral: 'border-line bg-surface-sunken text-ink-soft',
};

const VIEW: Record<JevVerdict, { tone: Tone; title: string; detail: string }> = {
  none: { tone: 'neutral', title: 'Sem nota do Jev', detail: 'Clique em Avaliar com o Jev para a nota dos cinco documentos.' },
  skipped: { tone: 'neutral', title: 'Projeto confidencial', detail: 'O Jev não lê os documentos deste projeto, então não há nota.' },
  unavailable: { tone: 'bad', title: 'O Jev não respondeu', detail: 'Confira a chave do OpenRouter e clique em Avaliar com o Jev.' },
  outdated: { tone: 'warn', title: 'Os documentos mudaram depois da nota', detail: 'Clique em Avaliar com o Jev para medir de novo.' },
  below: { tone: 'warn', title: 'Ainda não está pronto para desenvolver', detail: `Mínimo ${READY_PERCENT}%. Melhore os documentos e avalie de novo.` },
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
    <section className={`flex flex-col gap-3 rounded-lg border px-4 py-3 ${TONE[view.tone]}`} aria-label="Nota do Jev" data-testid="readiness-banner">
      <div className="flex flex-wrap items-center gap-3">
        <Icon name={verdict === 'ready' ? 'check' : 'info'} size={18} />
        <b className="text-[0.9375rem]">{view.title}</b>
        {percent !== null && <span className="ml-auto text-[0.8125rem] font-semibold tabular-nums" data-testid="readiness-score">Nota do Jev {percent}%</span>}
      </div>
      <p className="m-0 text-[0.8125rem] leading-[1.45]">{view.detail}</p>
      {docs && (
        <ul className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-1 p-0 text-[0.8125rem] sm:grid-cols-5" data-testid="readiness-docs">
          {(Object.keys(DOC_LABEL) as DocFile[]).map((file) => (
            <li key={file} className="flex justify-between gap-2">
              <span>{DOC_LABEL[file]}</span>
              <b className="tabular-nums">{percentOf(docs[file].score)}%</b>
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
        {verdict === 'ready' && (
          <ActionButton data-testid="readiness-start" className="primary" busy={startState.busy} disabled={!canStart} onClick={onStart} icon={<Icon name="play" size={16} />}>
            {startState.label}
          </ActionButton>
        )}
      </div>
    </section>
  );
}
