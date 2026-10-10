import type { ReactNode } from 'react';

/** Spinner for a screen whose content has no fixed shape while it loads; screen readers announce it as a status. */
export function Loading() {
  return (
    <p className="loading" role="status">
      <span className="loading-spinner" aria-hidden="true" />
      Carregando…
    </p>
  );
}

/** Wraps placeholders built from the screen's own layout, so the real content replaces them without a jump. */
export function Skeleton({ children }: { children: ReactNode }) {
  return (
    <div className="skeleton" role="status">
      <span className="sr-only">Carregando…</span>
      {children}
    </div>
  );
}

/** One gray bar standing in for a line of text or a control. */
export function Bone({ size }: { size?: 'short' | 'half' | 'tiny' | 'control' | 'action' }) {
  return <span className={size ? `bone is-${size}` : 'bone'} />;
}
