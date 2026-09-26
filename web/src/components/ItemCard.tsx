import type { ReactNode } from 'react';
import type { Item } from '../api.js';

function friendlyDetail(detail: string) {
  const normalized = detail.trim().toLowerCase();
  if (normalized === 'not logged in') return 'Ainda não conectado';
  if (normalized === 'gh is not logged in') return 'GitHub CLI ainda não conectado';
  if (normalized === 'github owner not set') return 'Escolha uma organização do GitHub';
  if (normalized === 'github_token not set') return 'Token do GitHub ainda não informado';
  if (normalized === 'openrouter_api_key not set') return 'Chave do OpenRouter ainda não informada';
  if (normalized === 'unknown account (team)') return 'Conta Claude conectada (equipe)';
  return detail;
}

export function ItemCard({ title, item, children }: { title: string; item: Item | null; children?: ReactNode }) {
  const status = item === null ? 'checking' : item.ok ? 'ok' : 'todo';
  const statusLabel = status === 'checking' ? 'Verificando' : status === 'ok' ? 'Concluído' : 'Pendente';
  return (
    <section className={`card card-${status} onboarding-card`} data-testid={`card-${title}`}>
      <header className="onboarding-card-header">
        <span className="dot" aria-label={status === 'checking' ? 'verificando' : status === 'ok' ? 'concluído' : 'pendente'} />
        <h2>{title}</h2>
        <span className="status-chip">{statusLabel}</span>
        {item?.secret?.set ? <code className="hint">…{item.secret.hint}</code> : null}
      </header>
      <p className="detail onboarding-detail">{item === null ? 'Verificando…' : friendlyDetail(item.detail)}</p>
      {children}
    </section>
  );
}
