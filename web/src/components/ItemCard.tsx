import type { ReactNode } from 'react';
import type { Item } from '../api.js';

export function ItemCard({ title, item, children }: { title: string; item: Item | null; children?: ReactNode }) {
  const status = item === null ? 'checking' : item.ok ? 'ok' : 'todo';
  return (
    <section className={`card card-${status}`} data-testid={`card-${title}`}>
      <header>
        <span className="dot" aria-label={status} />
        <h2>{title}</h2>
        {item?.secret?.set ? <code className="hint">…{item.secret.hint}</code> : null}
      </header>
      <p className="detail">{item === null ? 'Checking…' : item.detail}</p>
      {children}
    </section>
  );
}
