import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';

/** What the owner does with what a review left: apply the suggested adjustments, or go on without them; a new review only when asked. */
export function ReviewDecision({ id, suggestions, questions, locked, onApply, onProceed, onReview }: {
  id: string;
  suggestions: number;
  questions: number;
  locked: boolean;
  onApply?(): unknown;
  onProceed(): unknown;
  onReview?(): unknown;
}) {
  const note = questions > 0 ? 'Seguir sem alterações: o PO responde as perguntas abertas com a opção recomendada e registra a premissa no documento.' : 'Seguir sem alterações: as sugestões ficam registradas e o documento não muda.';
  return (
    <div data-testid={`review-decision-${id}`} className="grid gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {suggestions > 0 && onApply && (
          <ActionButton data-testid={`review-apply-${id}`} className="primary h-10" disabled={locked} onClick={() => onApply()} icon={<Icon name="check" size={16} />}>
            Aplicar os ajustes sugeridos ({suggestions})
          </ActionButton>
        )}
        <ActionButton data-testid={`review-proceed-${id}`} className="secondary h-10" disabled={locked} onClick={() => onProceed()} icon={<Icon name="arrow-right" size={16} />}>
          Seguir sem alterações
        </ActionButton>
        {onReview && (
          <ActionButton data-testid={`review-again-${id}`} className="secondary ml-auto h-10" disabled={locked} onClick={() => onReview()} icon={<Icon name="refresh" size={16} />}>
            Revisar de novo
          </ActionButton>
        )}
      </div>
      <p data-testid={`review-decision-note-${id}`} className="m-0 text-[0.8125rem] leading-normal text-ink-soft">{note}</p>
    </div>
  );
}
