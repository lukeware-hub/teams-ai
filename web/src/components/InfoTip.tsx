import { useState, type ReactNode } from 'react';
import { Icon } from './Icons.js';

/**
 * A small "i" beside a label that explains it on hover or keyboard focus. The explanation is the button's
 * accessible name, and the bubble only exists while shown, so it never leaks into the surrounding text.
 */
export function InfoTip({ text, label }: { text: string; label?: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    // Keep the 17rem bubble's center far enough from the viewport edges for it to fit.
    setAt({ x: Math.min(Math.max(r.left + r.width / 2, 144), window.innerWidth - 144), y: r.top });
  };
  return (
    <button
      type="button"
      className="info-tip"
      aria-label={label ? `${label}: ${text}` : text}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setAt(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setAt(null)}
      onKeyDown={(e) => e.key === 'Escape' && setAt(null)}
    >
      <Icon name="info" size={14} />
      {at ? (
        <span className="info-tip-bubble" role="tooltip" aria-hidden="true" style={{ left: at.x, top: at.y }}>
          {text}
        </span>
      ) : null}
    </button>
  );
}

/** A flag with its explanation beside it. */
export function Tipped({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 justify-self-start">
      {children}
      <InfoTip text={text} />
    </span>
  );
}
