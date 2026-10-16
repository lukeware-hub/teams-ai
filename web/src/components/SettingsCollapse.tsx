import { useState, type ReactNode, type SyntheticEvent } from 'react';
import type { Item } from '../api.js';
import { Icon } from './Icons.js';

export function SettingsCollapse({ title, item, children }: { title: string; item: Item | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const status = item === null ? 'checking' : item.ok ? 'ok' : 'todo';
  const statusLabel = status === 'checking' ? 'Verificando' : status === 'ok' ? 'Concluído' : 'Pendente';
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(e.currentTarget.open);
  };
  return (
    <details className={`settings-collapse card-${status}`} onToggle={onToggle}>
      <summary className="settings-collapse-summary">
        <Icon name="chevron-right" size={16} />
        <span className="settings-collapse-title">{title}</span>
        <span className={`status-chip${status === 'todo' ? ' tone-warn' : ''}`}>
          {status === 'todo' ? <Icon name="clock" size={12} /> : null}
          {statusLabel}
        </span>
      </summary>
      {open ? <div className="settings-collapse-body">{children}</div> : null}
    </details>
  );
}
