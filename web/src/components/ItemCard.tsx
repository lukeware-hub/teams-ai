import type { ReactNode } from 'react';
import type { Item } from '../api.js';
import { Icon, type IconName } from './Icons.js';
import { InfoTip } from './InfoTip.js';

function friendlyDetail(detail: string) {
  const normalized = detail.trim().toLowerCase();
  if (normalized === 'not logged in') return 'Ainda não conectado';
  if (normalized === 'gh is not logged in') return 'GitHub CLI ainda não conectado';
  if (normalized.startsWith('you are not logged into any github hosts')) return 'GitHub ainda não está conectado';
  if (normalized === 'github owner not set') return 'Escolha uma organização do GitHub';
  if (normalized === 'github_token not set') return 'Token do GitHub ainda não informado';
  if (normalized === 'openrouter_api_key not set') return 'Chave do OpenRouter ainda não informada';
  if (normalized === 'unknown account (team)') return 'Conta Claude conectada (equipe)';
  // The owner check reports "login (Organization|User)" and the token check "login · scopes: …".
  const owner = /^(.+) \((Organization|User)\)$/.exec(detail.trim());
  if (owner) return `${owner[1]} (${owner[2] === 'Organization' ? 'organização' : 'conta pessoal'})`;
  const token = /^(.+) · scopes: (.+)$/.exec(detail.trim());
  if (token) return `${token[1]} · permissões: ${token[2] === 'none' ? 'não informadas' : token[2]}`;
  return detail;
}

export function ItemCard({ title, item, children, variant = 'default', subtitle, info, icon, illustration }: { title: string; item: Item | null; children?: ReactNode; variant?: 'default' | 'login'; subtitle?: string; info?: string; icon?: IconName; illustration?: string }) {
  const status = item === null ? 'checking' : item.ok ? 'ok' : 'todo';
  const statusLabel = status === 'checking' ? 'Verificando' : status === 'ok' ? 'Concluído' : 'Pendente';
  return (
    <section className={`card card-${status} onboarding-card${variant === 'login' ? ' auth-login-card' : ''}${illustration ? ' has-illustration' : ''}`} data-testid={`card-${title}`}>
      <header className="onboarding-card-header">
        {icon ? <span className={`card-icon card-icon-${icon}`}><Icon name={icon} size={variant === 'login' ? 38 : 24} /></span> : <span className="dot" aria-label={status === 'checking' ? 'verificando' : status === 'ok' ? 'concluído' : 'pendente'} />}
        <div className="card-title-block">
          <div className="card-title-row">
            <h2>{title}</h2>
            {info ? <InfoTip text={info} /> : null}
          </div>
          {subtitle ? <p className="card-subtitle">{subtitle}</p> : null}
        </div>
        <span className="status-chip">{statusLabel}</span>
        {variant !== 'login' && item?.secret?.set ? <code className="hint">…{item.secret.hint}</code> : null}
      </header>
      <p className="detail onboarding-detail">
        {variant === 'login' ? <span className="detail-icon"><Icon name="user" size={22} /></span> : null}
        <span>{item === null ? 'Verificando…' : friendlyDetail(item.detail)}</span>
      </p>
      {illustration ? <div className="card-body-with-illustration"><div className="card-body-content">{children}</div><img className="card-illustration" src={illustration} alt="" /></div> : children}
    </section>
  );
}
