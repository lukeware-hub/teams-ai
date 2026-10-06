import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icons.js';

/**
 * A compact confirmation for a destructive action. Focus starts on Cancel (the safe answer), Escape and a click on the
 * backdrop cancel, Tab cycles inside, and focus returns to whatever opened it.
 */
export function ConfirmDialog({ title, subject, confirmLabel, onConfirm, onCancel, children }: { title: string; subject?: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; children: ReactNode }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel.current();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      const inside = box.current.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      back?.focus();
    };
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) cancel.current();
      }}
    >
      <div ref={box} className="confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="confirm-icon" aria-hidden="true">
          <Icon name="trash" size={22} />
        </span>
        <h2 id={titleId}>{title}</h2>
        {subject ? <code className="confirm-subject">{subject}</code> : null}
        <p>{children as ReactNode}</p>
        <div className="confirm-actions">
          <button ref={cancelButton} type="button" className="confirm-cancel" data-testid="delete-cancel" onClick={() => cancel.current()}>
            Cancelar
          </button>
          <button type="button" className="confirm-danger" data-testid="delete-confirm" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
