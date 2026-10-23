import { useState } from 'react';
import type { ReshapeRow } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';

/** The newest reshape still applied, as a notice at the top of the page: Desfazer puts the document back, Fechar hides the notice. */
export function ReshapeNotice({ reshapes, onUndo, docName }: { reshapes: ReshapeRow[]; onUndo: (reshapeId: string) => unknown; docName: (file: string) => string }) {
  const [closed, setClosed] = useState<string | null>(null);
  const reshape = [...reshapes].reverse().find((r) => r.status === 'applied');
  if (!reshape || reshape.reshapeId === closed) return null;
  return (
    <div role="status" data-testid="reshape-notice" className="flex flex-wrap items-center gap-3 rounded-lg border border-accent-line bg-accent-soft p-[0.85rem] text-[0.8125rem] leading-[1.45] text-ink">
      <span className="min-w-0 basis-full min-[640px]:flex-1 min-[640px]:basis-0">Reorganizei <b>{docName(reshape.file)}</b> no modelo do documento.</span>
      <ActionButton className="secondary flex-1 min-[640px]:flex-none" data-testid="undo-reshape" onClick={() => onUndo(reshape.reshapeId)}>Desfazer</ActionButton>
      <ActionButton className="secondary flex-1 min-[640px]:flex-none" data-testid="close-reshape-notice" onClick={() => setClosed(reshape.reshapeId)}>Fechar</ActionButton>
    </div>
  );
}
