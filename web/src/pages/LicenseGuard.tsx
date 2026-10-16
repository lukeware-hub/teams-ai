import { useEffect, useState, type ReactNode } from 'react';
import { api, type LicenseView } from '../api.js';
import { LicenseCard } from '../components/LicenseCard.js';
import { Loading } from '../components/Loading.js';
import { Onboarding } from './Onboarding.js';

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
  return (
    <main className="mx-auto w-full max-w-xl">
      <section className="card grid gap-3">
        <h1>Acesso desativado</h1>
        <p className="m-0 text-ink-soft">Seu acesso foi desativado. Entre em contato com a administração da Lukeware por e-mail ou telefone para solicitar a reativação.</p>
        {email ? <a href={`mailto:${email}`}>{email}</a> : null}
        {phone ? <a href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a> : null}
      </section>
    </main>
  );
}

export function LicenseUnavailable({ onRetry, onRegister }: { onRetry: () => void; onRegister: () => void }) {
  return (
    <main className="mx-auto w-full max-w-xl">
      <section className="card grid gap-3">
        <h1>Licença indisponível</h1>
        <p className="m-0 text-ink-soft">Não foi possível confirmar sua licença. O Teams AI volta a funcionar quando o serviço de licenças responder.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="primary-button w-fit" onClick={onRetry}>Tentar de novo</button>
          <button type="button" className="primary-button w-fit" onClick={onRegister}>Registrar licença</button>
        </div>
      </section>
    </main>
  );
}
