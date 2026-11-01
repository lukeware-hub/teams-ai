import type { DocFile } from '@server/refine/draft';
import { percentOf } from '@server/refine/readiness';
import { DOC_LABEL } from './doc-labels.js';
import type { StageView } from './stage-view.js';

const STATE_LABEL = { done: 'feita', current: 'atual', todo: 'pendente' } as const;

interface Props {
  views: StageView[];
  shown: DocFile;
}

/** The five stages of a new project's documents, in order: where the owner is, each score, and what is outdated. */
/** The steps only show where the owner is: they do not open a document, Continuar and Voltar move between them. */
export function StageSteps({ views, shown }: Props) {
  return (
    <ol className="m-0 mb-4 grid list-none grid-cols-2 gap-2 p-0" aria-label="Etapas dos documentos">
      {views.map((view, index) => (
        <li key={view.doc} className="flex flex-col gap-1">
          <span id={`stage-state-${view.doc}`} className="text-[0.75rem] text-ink-soft">{index + 1} · {STATE_LABEL[view.state]}</span>
          <div
            data-testid={`stage-${view.doc}`}
            data-state={view.state}
            aria-describedby={`stage-state-${view.doc}`}
            aria-current={view.doc === shown ? 'step' : undefined}
            className="flex w-full flex-col gap-1 rounded-[var(--radius-lg)] border border-line bg-surface-sunken px-3 py-2 text-left"
          >
            <b className="text-[0.875rem] font-semibold text-ink">{DOC_LABEL[view.doc]}</b>
            {view.score !== null && <span className="text-[0.8125rem] tabular-nums text-ink-soft">{percentOf(view.score)}%</span>}
            {view.outdated && <span className="text-[0.75rem] text-warn">desatualizado</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
