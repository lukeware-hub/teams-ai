import { COST_PERIODS, type CostPeriod, type CostShare } from '@server/usage/cost-types.js';
import { Icon, type IconName } from '../../components/Icons.js';
import { InfoTip, Tipped } from '../../components/InfoTip.js';
import { plural, responsiveCell, responsiveTable, sectionHeading, sectionTitle, stat, statLabel, statValue } from '../project-shared.js';
import { money, percent } from './format.js';
import { HELP, PERIOD_LABEL } from './labels.js';

export interface Option {
  value: string;
  label: string;
}

export const tableWrap = `@container ${responsiveTable} -mx-1 overflow-x-auto`;
export const table = 'mt-3 w-full text-[0.8125rem]';
export const headRow = 'text-left text-ink-soft';
export const numCell = `${responsiveCell} text-right tabular-nums`;

/** Panel heading: a tile with the panel's glyph, the title, and its explanation beside it. */
export function PanelTitle({ icon, title, help }: { icon: IconName; title: string; help?: string }) {
  return (
    <div className={sectionTitle}>
      <span className="grid size-6 flex-none place-items-center rounded-sm bg-accent-soft text-accent-ink">
        <Icon name={icon} size={14} />
      </span>
      <h2 className={sectionHeading}>{title}</h2>
      {help ? <InfoTip label={title} text={help} /> : null}
    </div>
  );
}

/** One figure of the stat strip: its label and explanation, the value, and a line beneath it. */
export function Indicator({ id, label, help, value, detail }: { id: string; label: string; help?: string; value: string; detail: string }) {
  return (
    <div data-testid={`costs-indicator-${id}`} className={`${stat} border-line bg-surface shadow-card`}>
      <span className={`${statLabel} inline-flex items-center gap-1`}>
        {label}
        {help ? <InfoTip label={label} text={help} /> : null}
      </span>
      <strong className={`${statValue} text-ink`}>{value}</strong>
      <span className="text-[0.8125rem] text-ink-soft">{detail}</span>
    </div>
  );
}

/** The period choice: one button per period, the chosen one pressed. */
export function PeriodChips({ value, onChange }: { value: CostPeriod; onChange: (next: CostPeriod) => void }) {
  return (
    <div role="group" aria-label="Período" data-testid="costs-periods" className="flex flex-wrap gap-2">
      {COST_PERIODS.map((period) => (
        <button
          key={period}
          type="button"
          data-testid={`costs-period-${period}`}
          aria-pressed={value === period}
          className="min-w-[auto] px-3.5 text-[0.8125rem] text-ink-soft max-md:min-h-11 hover:text-ink aria-[pressed=true]:border-accent-line aria-[pressed=true]:bg-accent-soft aria-[pressed=true]:text-accent-ink"
          onClick={() => onChange(period)}
        >
          {PERIOD_LABEL[period]}
        </button>
      ))}
    </div>
  );
}

/** A flat accent bar for a share of a whole, with the percent written beside it. */
export function ShareBar({ share }: { share: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden="true" className="relative h-1.5 w-32 max-w-full overflow-hidden rounded-pill bg-surface-muted">
        <span
          className="absolute inset-0 origin-left rounded-pill bg-accent transition-transform duration-[var(--duration-slow)] ease-[var(--ease-out)]"
          style={{ transform: `scaleX(${Math.min(1, Math.max(0, share))})` }}
        />
      </span>
      <span className="text-[0.8125rem] text-ink-soft tabular-nums">{percent(share)}</span>
    </span>
  );
}

export interface ShareRow {
  id: string;
  label: string;
  costUsd: number;
  share: number;
  tip?: string;
}

/** A breakdown row; the escalation row explains itself beside its label. */
export function shareRow(share: CostShare, label: string, id = share.key): ShareRow {
  return { id, label, costUsd: share.costUsd, share: share.share, tip: share.key === 'escalonamento' ? HELP.escalation : undefined };
}

/** A breakdown as rows: the name and the money, then the share bar. */
export function ShareList({ title, rows }: { title?: string; rows: ShareRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="grid gap-1">
      {title ? <h3 className="m-0 text-[0.8125rem] font-semibold text-ink-soft">{title}</h3> : null}
      <ul className="m-0 grid list-none p-0">
        {rows.map((row) => (
          <li key={row.id} className="grid gap-1 border-b border-line py-2 last:border-b-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[0.875rem]">
              <span className="inline-flex min-w-0 items-center gap-1 text-ink wrap-anywhere">
                {row.label}
                {row.tip ? <InfoTip label={row.label} text={row.tip} /> : null}
              </span>
              <span className="tabular-nums text-ink">{money(row.costUsd)}</span>
            </div>
            <ShareBar share={row.share} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** When the figures were last read; nothing shows before the first good read. */
export function UpdatedAt({ at }: { at?: Date }) {
  if (!at) return null;
  return <p data-testid="costs-updated-at" className="m-0 text-[0.8125rem] text-ink-soft tabular-nums">Atualizado às {clock.format(at)}</p>;
}

export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" data-testid="costs-refresh" className="secondary max-md:min-h-11" onClick={onClick}>
      Atualizar
      <Icon name="refresh" size={16} />
    </button>
  );
}

/** The read failed: the last value stays on screen under this line. */
export function ErrorBlock({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" data-testid="costs-error" className="error flex flex-wrap items-center justify-between gap-3">
      <span>Não foi possível ler os custos. Tente de novo.</span>
      <button type="button" className="secondary max-md:min-h-11" onClick={onRetry}>
        Tentar de novo
      </button>
    </div>
  );
}

/** Journals that could not be read; the chip shows only when there are some. */
export function UnreadChip({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Tipped text={HELP.unread}>
      <span data-testid="costs-unread" className="status-chip tone-warn">
        <Icon name="alert" size={14} />
        {plural(count, 'registro não lido', 'registros não lidos')}
      </span>
    </Tipped>
  );
}
