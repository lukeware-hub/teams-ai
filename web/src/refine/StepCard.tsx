import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icons.js';
import { InfoTip } from '../components/InfoTip.js';

const TILE = {
  accent: 'text-[color:var(--tile-accent-ink)] [background:var(--tile-accent)]',
  violet: 'text-[color:var(--tile-violet-ink)] [background:var(--tile-violet)]',
  good: 'text-[color:var(--tile-good-ink)] [background:var(--tile-good)]',
} as const;

/** One block of a step: an icon tile, a title with its help, who fills it, a state chip and the content. */
export function StepCard({ id, icon, tone = 'accent', title, info, owner, chip, children }: { id: string; icon: IconName; tone?: keyof typeof TILE; title: string; info: string; owner?: string; chip?: { label: string; tone?: string }; children: ReactNode }) {
  return (
    <section data-testid={`step-card-${id}`} aria-labelledby={`step-card-title-${id}`} className="card grid min-w-0 content-start gap-4">
      <header className="m-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-0 p-0">
        <div className="flex min-w-0 items-center gap-3">
          <span data-testid={`step-card-tile-${id}`} aria-hidden="true" className={`grid size-11 flex-[0_0_2.75rem] place-items-center rounded-tile shadow-tile ${TILE[tone]}`}><Icon name={icon} size={22} /></span>
          <div className="min-w-0">
            <h3 id={`step-card-title-${id}`} data-testid={`step-card-title-${id}`} className="m-0 flex items-center gap-1 text-[1.0625rem] font-semibold tracking-[-0.01em] text-ink">{title}<InfoTip text={info} /></h3>
            {owner && <p data-testid={`step-card-owner-${id}`} className="m-0 text-[0.8125rem] text-ink-soft">{owner}</p>}
          </div>
        </div>
        {chip && <span data-testid={`step-card-chip-${id}`} className={`status-dot ${chip.tone ?? ''}`}>{chip.label}</span>}
      </header>
      {children}
    </section>
  );
}
