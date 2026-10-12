import { type ReactNode, useId, useState } from 'react';

export type WorkspacePanel = { id: string; label: string; content: ReactNode };

// Side by side from the lg breakpoint, each panel scrolling on its own; below it, one panel at a time behind tabs.
// Hidden panels stay mounted, so switching tabs never loses typed text or scroll position.
export function Workspace({ panels, columns }: { panels: WorkspacePanel[]; columns: string }) {
  const [active, setActive] = useState(panels[0]?.id);
  const base = useId();
  return (
    <div className="flex min-h-0 flex-col gap-3 lg:flex-1">
      <div role="tablist" aria-label="Painéis" className="flex gap-1 rounded-tile border border-line bg-surface-sunken p-1 lg:hidden">
        {panels.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`${base}-tab-${p.id}`}
            aria-controls={`${base}-panel-${p.id}`}
            aria-selected={active === p.id}
            onClick={() => setActive(p.id)}
            className="h-9 min-w-0 flex-1 truncate rounded-md border-transparent bg-transparent px-2 text-ink-soft aria-selected:border-line-strong aria-selected:bg-surface aria-selected:text-ink aria-selected:shadow-button"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className={`grid min-h-0 gap-4 lg:flex-1 ${columns}`}>
        {panels.map((p) => (
          <section
            key={p.id}
            role="tabpanel"
            id={`${base}-panel-${p.id}`}
            aria-labelledby={`${base}-tab-${p.id}`}
            className={`min-h-0 min-w-0 lg:-m-1 lg:block lg:overflow-y-auto lg:p-1 ${active === p.id ? '' : 'max-lg:hidden'}`}
          >
            {p.content}
          </section>
        ))}
      </div>
    </div>
  );
}
