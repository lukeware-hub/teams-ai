import { Icon } from '../components/Icons.js';
import type { Stage, StageState } from './stages.js';

const ITEM: Record<StageState, string> = {
  done: 'border-good-line bg-good-soft text-good',
  active: 'border-accent-line bg-accent-soft',
  todo: 'border-line bg-surface-sunken text-ink-soft',
};

const NODE: Record<StageState, string> = {
  done: 'border-good-line text-good',
  active: 'border-accent-line text-accent-text',
  todo: 'border-line text-ink-faint',
};

/** The steps of a new project's refinement above the columns: where the work stands and what comes next. */
export function StageBar({ stages }: { stages: Stage[] }) {
  return (
    <ol className="m-0 flex min-w-0 list-none flex-wrap gap-2 p-0" aria-label="Etapas do refinamento">
      {stages.map((stage, index) => (
        <li
          key={stage.key}
          className={`flex min-w-0 flex-1 basis-56 items-center gap-3 rounded-lg border px-3 py-2.5 ${ITEM[stage.state]}`}
          aria-current={stage.state === 'active' ? 'step' : undefined}
          data-testid={`stage-${stage.key}`}
        >
          <span className={`grid size-7 flex-none place-items-center rounded-full border text-[0.75rem] font-bold tabular-nums ${NODE[stage.state]}`} aria-hidden="true">
            {stage.state === 'done' ? <Icon name="check" size={14} /> : index + 1}
          </span>
          <span className="grid min-w-0 gap-0.5">
            <b className="text-[0.875rem] font-semibold text-ink">{stage.label}</b>
            <small className="text-[0.8125rem] text-ink-soft">{stage.note}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}
