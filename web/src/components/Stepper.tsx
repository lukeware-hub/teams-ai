import { Icon } from './Icons.js';

export interface StepperStep {
  key: string;
  label: string;
  state: 'done' | 'active' | 'todo';
  /** A short flag under the label, such as that the document changed after its review. */
  marker?: string;
  /** What the step waits for, in few words, such as an open item count or the owner's decision. */
  badge?: string;
}

interface Props {
  steps: readonly StepperStep[];
  ariaLabel: string;
  onSelect?: (key: string) => void;
}

/** Numbered steps in the look of the onboarding; a step opens on click when `onSelect` is given. */
export function Stepper({ steps, ariaLabel, onSelect }: Props) {
  // On a phone the flags do not fit under their labels, so the flagged steps are named in a line below the steps.
  const flagged = steps.filter((step) => step.marker);
  const flags = [...new Set(flagged.map((step) => step.marker))].join(' · ');
  const at = steps.findIndex((step) => step.state === 'active');
  return (
    <>
      {at >= 0 && <p data-testid="stepper-position" className="m-0 hidden text-[0.8125rem] font-semibold text-ink-soft max-[720px]:block">Etapa {at + 1} de {steps.length} · {steps[at]!.label}</p>}
      <ol data-testid="stepper" className="onboarding-stepper" aria-label={ariaLabel}>
        {steps.map((step, index) => {
          const body = (
            <>
              <span data-testid={`stepper-node-${step.key}`} className="onboarding-stepper-node" aria-hidden="true">{step.state === 'done' ? <Icon name="check" size={14} /> : index + 1}</span>
              <span data-testid={`stepper-label-${step.key}`} className="onboarding-stepper-label">{step.label}</span>
              {step.marker && <span data-testid={`stepper-marker-${step.key}`} className="text-[0.6875rem] font-semibold text-warn max-[720px]:sr-only">{step.marker}</span>}
              {step.badge && <span data-testid={`stepper-badge-${step.key}`} className="text-[0.6875rem] font-semibold text-ink-soft max-[720px]:sr-only">{step.badge}</span>}
            </>
          );
          return (
            <li data-testid={`stepper-item-${step.key}`} key={step.key} className={`onboarding-stepper-item is-${step.state}`} aria-current={step.state === 'active' ? 'step' : undefined}>
              {onSelect ? (
                <button
                  type="button"
                  data-testid={`step-${step.key}`}
                  aria-label={[step.label, step.marker, step.badge].filter(Boolean).join(', ')}
                  className="grid h-auto min-h-11 w-full min-w-0 justify-items-center gap-[0.45rem] rounded-md border-0 bg-transparent p-0 shadow-none"
                  onClick={() => onSelect(step.key)}
                >
                  {body}
                </button>
              ) : body}
            </li>
          );
        })}
      </ol>
      {flagged.length > 0 && <p data-testid="stepper-flags" className="m-0 hidden text-[0.8125rem] font-semibold text-warn max-[720px]:block">{flagged.map((step) => step.label).join(', ')}: {flags}.</p>}
    </>
  );
}
