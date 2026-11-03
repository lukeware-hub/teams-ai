import type { ReactNode } from 'react';

/** Spinner for a screen whose content has no fixed shape while it loads; screen readers announce it as a status. */
export function Loading() {
  return (
    <p data-testid="loading" className="loading" role="status">
      <span data-testid="loading-spinner" className="loading-spinner" aria-hidden="true" />
      Carregando…
    </p>
  );
}

/** Wraps placeholders built from the screen's own layout, so the real content replaces them without a jump. */
export function Skeleton({ children }: { children: ReactNode }) {
  return (
    <div data-testid="skeleton" className="skeleton" role="status">
      <span data-testid="skeleton-label" className="sr-only">Carregando…</span>
      {children}
    </div>
  );
}

/** One gray bar standing in for a line of text or a control. */
export function Bone({ size }: { size?: 'short' | 'half' | 'tiny' | 'control' | 'action' }) {
  return <span data-testid="bone" className={size ? `bone is-${size}` : 'bone'} />;
}
