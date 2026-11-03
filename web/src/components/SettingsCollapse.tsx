import { useState, type ReactNode, type SyntheticEvent } from 'react';
import type { Item } from '../api.js';
import { Icon } from './Icons.js';

export function SettingsCollapse({ title, item, meta, children }: { title: string; item?: Item | null; meta?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const status = item === undefined || item === null ? null : item.ok ? 'ok' : 'todo';
  const statusLabel = status === 'ok' ? 'Concluído' : status === 'todo' ? 'Pendente' : item === null ? 'Verificando' : null;
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(e.currentTarget.open);
  };
  return (
    <details data-testid="settings-collapse" className={`settings-collapse${status ? ` card-${status}` : item === null ? ' card-checking' : ''}`} onToggle={onToggle}>
      <summary data-testid="settings-collapse-summary" className="settings-collapse-summary">
        <Icon name="chevron-right" size={16} />
        <span data-testid="settings-collapse-title" className="settings-collapse-title">{title}</span>
        {statusLabel !== null ? (
          <span data-testid="settings-collapse-status" className={`status-chip${status === 'todo' ? ' tone-warn' : ''}`}>
            {status === 'todo' ? <Icon name="clock" size={12} /> : null}
            {statusLabel}
          </span>
        ) : meta ? (
          <span data-testid="settings-collapse-meta" className="settings-collapse-meta">{meta}</span>
        ) : null}
      </summary>
      {open ? <div data-testid="settings-collapse-body" className="settings-collapse-body">{children}</div> : null}
    </details>
  );
}
