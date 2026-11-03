import { Icon } from './Icons.js';

export const ONBOARDING_STEP_LABELS = ['Conectar GitHub', 'Token', 'Organização', 'Claude', 'OpenRouter', 'Pronto'] as const;

export function OnboardingStepper({ step, total }: { step: number; total: number }) {
  return (
    <ol data-testid="onboarding-stepper" className="onboarding-stepper" aria-label={`Etapa ${step + 1} de ${total}`}>
      {ONBOARDING_STEP_LABELS.slice(0, total).map((label, index) => {
        const state = index < step ? 'done' : index === step ? 'active' : 'todo';
        return (
          <li data-testid={`onboarding-stepper-item-${label.toLowerCase().split(' ').join('-')}`} key={label} className={`onboarding-stepper-item is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <span data-testid={`onboarding-stepper-node-${label.toLowerCase().split(' ').join('-')}`} className="onboarding-stepper-node" aria-hidden="true">{state === 'done' ? <Icon name="check" size={14} /> : index + 1}</span>
            <span data-testid={`onboarding-stepper-label-${label.toLowerCase().split(' ').join('-')}`} className="onboarding-stepper-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
