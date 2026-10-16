import type { ReactNode } from 'react';
import { Icon } from './Icons.js';
import { OnboardingStepper } from './OnboardingStepper.js';

export function OnboardingShell({
  title,
  subtitle,
  step,
  total,
  canAdvance,
  onBack,
  onNext,
  showNext,
  children,
}: {
  title: string;
  subtitle: string;
  step: number;
  total: number;
  canAdvance: boolean;
  onBack: () => void;
  onNext: () => void;
  showNext: boolean;
  children: ReactNode;
}) {
  return (
    <main className="@container mx-auto w-full max-w-[1120px] min-w-0 gap-6 pt-9 pb-12 *:min-w-0 max-[720px]:pt-6">
      <header className="mb-6 min-w-0">
        <h1 className="m-0 text-[2.5rem] leading-[1.08] font-bold tracking-[-0.03em] text-ink @max-2xl:text-[1.875rem]">{title}</h1>
        <p className="mx-0 mt-[0.65rem] mb-0 max-w-[60ch] text-[0.9375rem] leading-[1.55] text-ink-soft">{subtitle}</p>
      </header>
      <section className="onboarding-shell edge-lit overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="onboarding-shell-stepper border-b border-line px-6 py-5 @max-2xl:px-4">
          <OnboardingStepper step={step} total={total} />
        </div>
        <div key={step} className="step-in onboarding-shell-body min-w-0 px-6 py-6 @max-2xl:px-4 @max-2xl:py-5">
          {children}
        </div>
        <nav className="onboarding-shell-nav flex items-center justify-between gap-4 border-t border-line px-6 py-4 @max-2xl:sticky @max-2xl:bottom-0 @max-2xl:bg-surface @max-2xl:px-4 @max-2xl:backdrop-blur-md" aria-label="Navegação da configuração">
          <button type="button" className="secondary h-10 border-line-strong text-ink enabled:hover:bg-surface-sunken @max-2xl:flex-1" onClick={onBack} disabled={step === 0}>
            <Icon name="arrow-left" size={16} />
            Voltar
          </button>
          {showNext ? (
            <button type="button" className="primary-button h-10 @max-2xl:flex-1" onClick={onNext} disabled={!canAdvance}>
              Continuar
              <Icon name="arrow-right" size={16} />
            </button>
          ) : null}
        </nav>
      </section>
    </main>
  );
}
