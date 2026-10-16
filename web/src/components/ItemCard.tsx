import type { ReactNode } from 'react';
import type { Item } from '../api.js';
import { Icon, type IconName } from './Icons.js';
import { InfoTip, Tipped } from './InfoTip.js';

export type Benefit = { icon: IconName; title: string; text: string };
export type StepPanel = { headline: string; support: string };

function friendlyDetail(detail: string) {
  const normalized = detail.trim().toLowerCase();
  if (normalized === 'not logged in') return 'Ainda não conectado';
  if (normalized === 'gh is not logged in') return 'GitHub CLI ainda não conectado';
  if (normalized.startsWith('you are not logged into any github hosts')) return 'GitHub ainda não está conectado';
  if (normalized === 'github owner not set') return 'Escolha uma organização do GitHub';
  if (normalized === 'github_token not set') return 'Token do GitHub ainda não informado';
  if (normalized === 'openrouter_api_key not set') return 'Chave do OpenRouter ainda não informada';
  if (normalized === 'unknown account (team)') return 'Conta Claude conectada (equipe)';
  const owner = /^(.+) \((Organization|User)\)$/.exec(detail.trim());
  if (owner) return `${owner[1]} (${owner[2] === 'Organization' ? 'organização' : 'conta pessoal'})`;
  const token = /^(.+) · scopes: (.+)$/.exec(detail.trim());
  if (token) return `${token[1]} · permissões: ${token[2] === 'none' ? 'não informadas' : token[2]}`;
  return detail;
}

export function ItemCard({
  title,
  item,
  children,
  variant = 'default',
  subtitle,
  info,
  icon,
  illustration,
  benefits,
  panel,
}: {
  title: string;
  item: Item | null;
  children?: ReactNode;
  variant?: 'default' | 'login';
  subtitle?: string;
  info?: string;
  icon?: IconName;
  illustration?: string;
  benefits?: readonly Benefit[];
  panel?: StepPanel;
}) {
  const status = item === null ? 'checking' : item.ok ? 'ok' : 'todo';
  const statusLabel = status === 'checking' ? 'Verificando' : status === 'ok' ? 'Concluído' : 'Pendente';
  const statusHelp = status === 'checking' ? 'A plataforma está verificando esta conexão.' : status === 'ok' ? 'A conexão está configurada e funcionando.' : 'Falta configurar esta conexão.';
  const login = variant === 'login';
  const body = (
    <>
      {benefits && benefits.length > 0 ? (
        <ul className="onboarding-benefits">
          {benefits.map((benefit) => (
            <li key={benefit.title} className="onboarding-benefit">
              <span className="onboarding-benefit-icon" aria-hidden="true"><Icon name={benefit.icon} size={18} /></span>
              <div className="min-w-0">
                <strong className="onboarding-benefit-title">{benefit.title}</strong>
                <p className="onboarding-benefit-text">{benefit.text}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <p className={`detail mx-0 mt-0 leading-[1.45] wrap-anywhere ${login ? 'mb-[1.15rem] flex items-center gap-[0.85rem] border-b border-line pb-4 text-[1rem]' : 'mb-[1.1rem] text-[0.9375rem]'}`}>
        {login ? <span className="inline-grid size-10 flex-none place-items-center rounded-full bg-accent-soft text-accent-text"><Icon name="user" size={22} /></span> : null}
        <span className={login ? 'font-[650] text-ink' : undefined}>{item === null ? 'Verificando…' : friendlyDetail(item.detail)}</span>
      </p>
      {children}
    </>
  );
  return (
    <section className={`${login ? 'onboarding-step' : 'card'} card-${status} @container [&_.error]:mx-0 [&_.error]:mt-[0.8rem] [&_.error]:mb-0 ${login ? 'overflow-hidden [&_:is(.link-button,.primary-button,.secondary)]:h-11 [&_:is(.link-button,.primary-button,.secondary)]:px-4' : 'pt-5'}${illustration ? ' has-illustration' : ''}`} data-testid={`card-${title}`}>
      <header className={login ? 'onboarding-step-header mb-[1.15rem] @max-[40rem]:grid @max-[40rem]:grid-cols-[auto_minmax(0,1fr)] @max-[40rem]:gap-x-3 @max-[40rem]:gap-y-2' : '@max-[40rem]:flex-wrap @max-[40rem]:items-start'}>
        {icon ? <span className={`inline-grid size-14 flex-none place-items-center rounded-tile border ${icon === 'github' ? 'border-line bg-surface-muted text-ink' : 'border-brand-claude-line bg-brand-claude-soft text-brand-claude'}${login ? ' @max-[40rem]:row-[1/span_2]' : ''}`}><Icon name={icon} size={login ? 38 : 24} /></span> : <span className={`dot flex-none ${status === 'ok' ? '[box-shadow:0_0_0_4px_var(--good-soft)]' : '[box-shadow:0_0_0_4px_var(--surface-muted)]'}`} aria-label={status === 'checking' ? 'verificando' : status === 'ok' ? 'concluído' : 'pendente'} />}
        <div className={`min-w-0 flex-1 ${login ? '@max-[40rem]:col-start-2' : ''}`}>
          <div className="flex min-w-0 items-center gap-[0.4rem]">
            <h2 className={`flex-none ${login ? 'text-[1.25rem] tracking-[-0.02em]' : 'tracking-[-0.015em]'}`}>{title}</h2>
            {info ? <InfoTip text={info} /> : null}
          </div>
          {subtitle ? <p className="mx-0 mt-[0.3rem] mb-0 text-[0.9375rem] leading-[1.4] text-ink-soft">{subtitle}</p> : null}
        </div>
        <span className={`ml-auto ${login ? '@max-[40rem]:col-start-2 @max-[40rem]:ml-0 @max-[40rem]:justify-self-start' : ''}`}>
          <Tipped text={statusHelp}>
            <span className={`status-chip${status === 'todo' ? ' tone-warn' : ''}`}>
              {status === 'todo' ? <Icon name="clock" size={12} /> : null}
              {statusLabel}
            </span>
          </Tipped>
        </span>
        {variant !== 'login' && item?.secret?.set ? <code className="hint flex-none text-[0.75rem]">…{item.secret.hint}</code> : null}
      </header>
      {illustration || panel ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(16rem,0.48fr)] items-stretch gap-5 @max-[40rem]:grid-cols-[minmax(0,1fr)]">
          <div className="@container min-w-0">{body}</div>
          <aside className="onboarding-panel @max-[40rem]:hidden" aria-hidden={!panel}>
            {panel ? (
              <>
                <h3 className="onboarding-panel-headline">{panel.headline}</h3>
                <p className="onboarding-panel-support">{panel.support}</p>
              </>
            ) : null}
            {illustration ? <img className="onboarding-panel-art" src={illustration} alt="" /> : null}
          </aside>
        </div>
      ) : body}
    </section>
  );
}
