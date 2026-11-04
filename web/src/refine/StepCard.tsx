import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';

const TILE = {
  accent: 'text-[color:var(--tile-accent-ink)] [background:var(--tile-accent)]',
  violet: 'text-[color:var(--tile-violet-ink)] [background:var(--tile-violet)]',
  good: 'text-[color:var(--tile-good-ink)] [background:var(--tile-good)]',
} as const;

/** One block of a step: a one-line header (icon tile, title with help, who fills it, state chip) that opens its content. The card in focus starts open and ringed. */
export function StepCard({ id, icon, tone = 'accent', title, info, owner, chip, open = false, focus = false, children }: { id: string; icon: IconName; tone?: keyof typeof TILE; title: string; info: string; owner?: string; chip?: { label: string; tone?: string }; open?: boolean; focus?: boolean; children: ReactNode }) {
  return (
    <details data-testid={`step-card-${id}`} data-focus={focus || undefined} open={open} className={`group card min-w-0 p-0 ${focus ? 'border-accent-line shadow-pop' : ''}`}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span data-testid={`step-card-tile-${id}`} aria-hidden="true" className={`grid flex-[0_0_2.5rem] place-items-center rounded-tile shadow-tile ${focus ? 'size-11' : 'size-10'} ${TILE[tone]}`}><Icon name={icon} size={20} /></span>
        <div className="min-w-0 flex-1">
          <h3 data-testid={`step-card-title-${id}`} className="m-0 flex items-center gap-1 text-[1.0625rem] font-semibold tracking-[-0.01em] text-ink">{title}<InfoTip text={info} /></h3>
          {owner && <p data-testid={`step-card-owner-${id}`} className="m-0 text-[0.8125rem] text-ink-soft">{owner}</p>}
        </div>
        {chip && <span data-testid={`step-card-chip-${id}`} className={`status-dot ${chip.tone ?? ''}`}>{chip.label}</span>}
        <span aria-hidden="true" className="flex-none text-ink-soft transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
      </summary>
      <div className="grid gap-4 px-4 pb-4">{children}</div>
    </details>
  );
}
