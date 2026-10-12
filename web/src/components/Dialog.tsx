import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icons.js';

/**
 * A modal for reading long detail without leaving the page. It closes with the X, Escape or a click on the backdrop;
 * focus moves to the X when it opens and goes back to `returnFocus` (else whatever had focus) when it closes.
 */
export function Dialog({ title, onClose, returnFocus, children }: { title: string; onClose: () => void; returnFocus?: HTMLElement | null; children: ReactNode }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const opener = useRef(returnFocus ?? null);
  // A drag that starts inside the dialog (selecting text) and ends on the backdrop must not close it.
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const back = opener.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      // The page behind is covered, so Tab cycles inside the dialog.
      const items = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
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
        if (pressedBackdrop.current && e.target === e.currentTarget) close.current();
      }}
    >
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button ref={closeButton} type="button" className="dialog-close w-auto gap-1.5 px-2.5 text-[0.8125rem]" onClick={() => close.current()}>
            Fechar
            <Icon name="close" size={16} />
          </button>
        </div>
        {/* Focusable so the keyboard can scroll a long body. */}
        <div className="dialog-body" tabIndex={0}>
          {children}
        </div>
      </div>
    </div>
  );
}
