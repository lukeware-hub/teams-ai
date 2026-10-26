import type { MoveRow } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';

/** The newest move still applied, as a notice at the top of the page: Desfazer puts both documents back, Fechar hides the notice for good. */
export function MoveNotice({ moves, onUndo, onClose, docName }: { moves: MoveRow[]; onUndo: (moveId: string) => unknown; onClose: (moveId: string) => unknown; docName: (file: string) => string }) {
  const move = [...moves].reverse().find((m) => m.status === 'applied');
  if (!move || move.closed) return null;
  return (
    <div role="status" data-testid="move-notice" className="flex flex-wrap items-center gap-3 rounded-lg border border-accent-line bg-accent-soft p-[0.85rem] text-[0.8125rem] leading-[1.45] text-ink">
      <span className="min-w-0 basis-full min-[640px]:flex-1 min-[640px]:basis-0">Movi um trecho de <b>{docName(move.from)}</b> para <b>{docName(move.to)}</b>. <span className="text-ink-soft">{move.reason}</span></span>
      <ActionButton className="secondary flex-1 min-[640px]:flex-none" data-testid="undo-move" onClick={() => onUndo(move.moveId)}>Desfazer</ActionButton>
      <ActionButton className="secondary flex-1 min-[640px]:flex-none" data-testid="close-move-notice" onClick={() => onClose(move.moveId)}>Fechar</ActionButton>
    </div>
  );
}
