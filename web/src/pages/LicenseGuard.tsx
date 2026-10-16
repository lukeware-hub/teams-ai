import { useEffect, useState, type ReactNode } from 'react';
import { api, type LicenseView } from '../api.js';
import { useHideRail } from '../components/AppShell.js';
import { Icon } from '../components/Icons.js';
import { LicenseCard } from '../components/LicenseCard.js';
import { Loading } from '../components/Loading.js';
import { Onboarding } from './Onboarding.js';

const contactLink = 'rounded-sm text-ink-soft no-underline underline-offset-2 transition-colors hover:text-accent-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
const LICENSE_CHECK_MS = 20_000;

export function LicenseGuard({ children }: { children: ReactNode }) {
  const [view, setView] = useState<LicenseView | null>(null);
  const [session, setSession] = useState(false);
  const [register, setRegister] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setView(null);
    void api.license().then((next) => { if (live) setView(next); }).catch(() => { if (live) setView({ state: 'unavailable' }); });
    return () => { live = false; };
  }, [attempt]);
  useEffect(() => {
    if (view?.state !== 'authorized') return;
    let live = true;
    const refresh = () => {
      void api.license().then((next) => { if (live) setView(next); }).catch(() => { if (live) setView({ state: 'unavailable' }); });
    };
    const timer = window.setInterval(refresh, LICENSE_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [view?.state]);
  if (view === null) return <main><Loading /></main>;
  if (view.state === 'unavailable' && register) {
    return (
      <main className="mx-auto grid w-full max-w-xl gap-3">
        <LicenseCard onSaved={() => { setView({ state: 'authorized' }); setRegister(false); }} />
        <button type="button" className="primary-button w-fit" onClick={() => setRegister(false)}>Voltar</button>
      </main>
    );
  }
  if (view.state === 'unavailable') return <LicenseUnavailable onRetry={() => setAttempt((current) => current + 1)} onRegister={() => setRegister(true)} />;
  if (view.state === 'revoked') return <LicenseRevoked email={view.contactEmail} phone={view.contactPhone} />;
  if (view.state === 'missing' || session) {
    return <Onboarding includeLicense onLicensed={() => { setView({ state: 'authorized' }); setSession(true); }} onLeave={() => setSession(false)} />;
  }
  return children;
}

export function LicenseRevoked({ email, phone }: { email: string; phone: string }) {
  useHideRail();
  return (
    <main className="min-h-full place-content-center">
      <section className="card grid w-full max-w-md justify-items-center gap-3 justify-self-center text-center">
        <span className="confirm-icon mb-0" aria-hidden="true">
          <Icon name="lock" size={22} />
        </span>
        <h1 className="m-0 text-[1.125rem] leading-[1.3] font-[650] tracking-[-0.01em] text-balance text-ink">Acesso desativado</h1>
        <p className="m-0 max-w-[42ch] text-[0.875rem] leading-[1.55] text-balance text-ink-soft">Seu acesso foi desativado. Entre em contato com a administração da Lukeware por e-mail ou telefone para solicitar a reativação.</p>
        {email || phone ? (
          <div className="grid gap-1">
            {email ? <a className={contactLink} href={`mailto:${email}`}>{email}</a> : null}
            {phone ? <a className={contactLink} href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a> : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function LicenseUnavailable({ onRetry, onRegister }: { onRetry: () => void; onRegister: () => void }) {
  useHideRail();
  return (
    <main className="min-h-full place-content-center">
      <section className="card grid w-full max-w-md justify-self-center gap-3">
        <h1>Licença indisponível</h1>
        <p className="m-0 text-ink-soft">Não foi possível confirmar sua licença. O Teams AI volta a funcionar quando o serviço de licenças responder.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" className="primary-button w-full" onClick={onRetry}>Tentar de novo</button>
          <button type="button" className="secondary w-full" onClick={onRegister}>Registrar licença</button>
        </div>
      </section>
    </main>
  );
}
