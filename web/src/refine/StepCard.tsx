import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';

const TILE = {
  accent: 'text-[color:var(--tile-accent-ink)] [background:var(--tile-accent)]',
  violet: 'text-[color:var(--tile-violet-ink)] [background:var(--tile-violet)]',
  good: 'text-[color:var(--tile-good-ink)] [background:var(--tile-good)]',
} as const;

/**
 * One block of a step: a one-line header (icon tile, title with help, state chip) that opens its content; who fills it is in the help.
 * The card in focus starts open and ringed; `grouped` drops the card frame, for a row inside a shared card.
 */
export function StepCard({ id, icon, tone = 'accent', title, info, owner, chip, open = false, focus = false, grouped = false, children }: { id: string; icon: IconName; tone?: keyof typeof TILE; title: string; info: string; owner?: string; chip?: { label: string; tone?: string }; open?: boolean; focus?: boolean; grouped?: boolean; children: ReactNode }) {
  const frame = grouped ? '' : `card ${focus ? 'border-accent-line shadow-pop' : ''}`;
  return (
    <details data-testid={`step-card-${id}`} data-focus={focus || undefined} open={open} className={`group min-w-0 p-0 ${frame}`}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span data-testid={`step-card-tile-${id}`} aria-hidden="true" className={`grid size-9 flex-none place-items-center rounded-tile ${TILE[tone]}`}><Icon name={icon} size={18} /></span>
        <h3 data-testid={`step-card-title-${id}`} className="m-0 flex flex-1 items-center gap-1 text-[1rem] font-semibold tracking-[-0.01em] normal-case text-ink">{title}<InfoTip text={owner ? `${info} ${owner}.` : info} /></h3>
        {chip && <span data-testid={`step-card-chip-${id}`} className={`status-dot ${chip.tone ?? ''}`}>{chip.label}</span>}
        <span aria-hidden="true" className="flex-none text-ink-soft transition-transform duration-[140ms] ease-out group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
      </summary>
      <div className="grid gap-4 px-4 pb-4">{children}</div>
    </details>
  );
}
