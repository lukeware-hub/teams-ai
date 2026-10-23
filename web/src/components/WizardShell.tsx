import type { ReactNode } from 'react';
import { Icon } from './Icons.js';

interface Props {
  stepper: ReactNode;
  /** Changes with the step, so the new screen enters with the step-in motion. */
  stepKey: string;
  /** One line of facts above the footer actions. */
  meta?: string;
  back: { onClick: () => void; disabled: boolean; reason?: string };
  actions: ReactNode;
  children: ReactNode;
}

/** One panel, one screen per step: the stepper on top, the screen, and Voltar on the left with the step's actions on the right. */
export function WizardShell({ stepper, stepKey, meta, back, actions, children }: Props) {
  return (
    <section className="@container edge-lit mx-auto w-full max-w-[1120px] min-w-0 overflow-hidden rounded-2xl border border-line bg-surface shadow-card" data-testid="wizard">
      <div className="border-b border-line px-6 py-5 @max-2xl:px-4">{stepper}</div>
      <div key={stepKey} className="step-in min-w-0 px-6 py-6 @max-2xl:px-4 @max-2xl:py-5">{children}</div>
      <footer className="border-t border-line px-6 py-4 @max-2xl:px-4">
        {meta && <p className="m-0 mb-3 text-[0.75rem] tabular-nums text-ink-soft" aria-live="polite" data-testid="wizard-meta">{meta}</p>}
        <nav className="grid grid-cols-1 gap-3 @3xl:flex @3xl:flex-wrap @3xl:items-center @3xl:justify-between" aria-label="Navegação das etapas">
          <button type="button" data-testid="wizard-back" className="secondary h-10 w-full border-line-strong text-ink enabled:hover:bg-surface-sunken @3xl:w-auto" onClick={back.onClick} disabled={back.disabled} title={back.disabled ? back.reason : undefined}>
            <Icon name="arrow-left" size={16} />
            Voltar
          </button>
          <div className="grid grid-cols-1 gap-3 *:w-full @3xl:flex @3xl:flex-wrap @3xl:items-center @3xl:*:w-auto">{actions}</div>
        </nav>
      </footer>
    </section>
  );
}
