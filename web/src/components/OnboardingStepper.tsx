import { Icon } from './Icons.js';

export const ONBOARDING_STEP_LABELS = ['Conectar GitHub', 'Token', 'Organização', 'Claude', 'OpenRouter', 'Pronto'] as const;

export function OnboardingStepper({ step, total }: { step: number; total: number }) {
  return (
    <ol className="onboarding-stepper" aria-label={`Etapa ${step + 1} de ${total}`}>
      {ONBOARDING_STEP_LABELS.slice(0, total).map((label, index) => {
        const state = index < step ? 'done' : index === step ? 'active' : 'todo';
        return (
          <li key={label} className={`onboarding-stepper-item is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <span className="onboarding-stepper-node" aria-hidden="true">{state === 'done' ? <Icon name="check" size={14} /> : index + 1}</span>
            <span className="onboarding-stepper-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
