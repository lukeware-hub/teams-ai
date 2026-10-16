import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Item, type ItemName, type Status } from '../api.js';
import { Icon } from '../components/Icons.js';
import { LicenseCard } from '../components/LicenseCard.js';
import { Loading } from '../components/Loading.js';
import { LoginCard } from '../components/LoginCard.js';
import { OnboardingShell } from '../components/OnboardingShell.js';
import { OwnerCard } from '../components/OwnerCard.js';
import { SecretCard } from '../components/SecretCard.js';

const STEP_ITEMS: readonly ItemName[] = ['ghLogin', 'githubToken', 'githubOwner', 'claude', 'openrouterKey'];
const DONE_CLASS = 'primary-button mt-3 min-h-10 border-transparent px-5 [background:var(--gradient-primary)] [box-shadow:var(--shadow-primary)] hover:border-transparent hover:[background:var(--gradient-primary-hover)] @max-2xl:w-full';

export function Onboarding({ includeLicense = false, onLicensed, onLeave }: { includeLicense?: boolean; onLicensed?: () => void; onLeave?: () => void } = {}) {
  const focusOpenrouter = useSearchParams()[0].get('item') === 'openrouter';
  const offset = includeLicense ? 1 : 0;
  const total = 6 + offset;
  const [licensed, setLicensed] = useState(false);
  const [step, setStep] = useState(focusOpenrouter && !includeLicense ? STEP_ITEMS.indexOf('openrouterKey') : 0);
  const [status, setStatus] = useState<Status | null>(null);
  const [sawIncomplete, setSawIncomplete] = useState(false);
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [organizationOwner, setOrganizationOwner] = useState<string | null>(null);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const refresh = useCallback(() => void api.status().then(setStatus), []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (status && !status.allOk) setSawIncomplete(true);
  }, [status]);
  const item = (n: ItemName): Item | null => status?.items[n] ?? null;
  const advance = useCallback(() => {
    setStep((current) => (current < total - 1 ? current + 1 : current));
  }, [total]);
  const patch = (n: ItemName) => (it: Item) => {
    setStatus((s) => (s ? { ...s, items: { ...s.items, [n]: it }, allOk: Object.values({ ...s.items, [n]: it }).every((v) => v.ok) } : s));
    if (it.ok) advance();
  };
  const onLoginDone = useCallback(() => {
    void api.status().then((s) => {
      setStatus(s);
      const name = STEP_ITEMS[step - offset];
      if (name && s.items[name]?.ok) advance();
    });
  }, [advance, offset, step]);
  const githubLoggedIn = status?.items.ghLogin.ok === true;
  useEffect(() => {
    if (!githubLoggedIn) {
      setOrganizations([]);
      setOrganizationOwner(null);
      setOrganizationsError(null);
      return;
    }
    let active = true;
    setOrganizationsLoading(true);
    setOrganizationsError(null);
    void api.organizations().then((result) => {
      if (!active) return;
      setOrganizations(result.organizations);
      setOrganizationOwner(result.owner);
    }).catch(() => {
      if (active) setOrganizationsError('Não foi possível carregar suas organizações do GitHub.');
    }).finally(() => {
      if (active) setOrganizationsLoading(false);
    });
    return () => { active = false; };
  }, [githubLoggedIn]);
  useEffect(() => {
    if (includeLicense && !licensed) return;
    if (status?.allOk && !focusOpenrouter) setStep(total - 1);
  }, [focusOpenrouter, includeLicense, licensed, status?.allOk, total]);
  const onLicenseStep = includeLicense && step === 0;
  const currentName = onLicenseStep ? undefined : STEP_ITEMS[step - offset];
  const canAdvance = onLicenseStep ? licensed : currentName !== undefined && item(currentName)?.ok === true;
  const next = () => {
    if (step < total - 1 && canAdvance) advance();
  };
  const stepContent = () => {
    if (onLicenseStep) return <LicenseCard onSaved={() => { setLicensed(true); onLicensed?.(); refresh(); advance(); }} />;
    switch (step - offset) {
      case 0: return <LoginCard cli="gh" title="Login do GitHub CLI" item={item('ghLogin')} onDone={onLoginDone} />;
      case 1: return <SecretCard name="GITHUB_TOKEN" title="Token do GitHub" item={item('githubToken')} onSaved={patch('githubToken')} />;
      case 2: return <OwnerCard organizations={organizations} initialOwner={organizationOwner} loading={organizationsLoading} loadError={organizationsError} item={item('githubOwner')} onSaved={patch('githubOwner')} />;
      case 3: return <LoginCard cli="claude" title="Login do Claude" item={item('claude')} onDone={onLoginDone} />;
      case 4: return <SecretCard name="OPENROUTER_API_KEY" title="Chave do OpenRouter (Jev)" item={item('openrouterKey')} onSaved={patch('openrouterKey')} />;
      default: return (
        <section className="grid grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)] items-center justify-items-start gap-x-10 gap-y-3 @max-2xl:grid-cols-[minmax(0,1fr)]" aria-labelledby="welcome-title">
          <span className="relative grid size-14 place-items-center rounded-tile bg-good-soft text-good" aria-hidden="true"><Icon name="check" size={28} />{sawIncomplete ? <span className="confetti"><i /><i /><i /><i /><i /></span> : null}</span>
          <p className="m-0 inline-flex items-center gap-1.5 rounded-full bg-good-soft px-[0.65rem] py-[0.2rem] text-[0.8125rem] font-semibold text-good before:size-[0.45rem] before:rounded-full before:bg-current before:content-['']">Configuração concluída</p>
          <h2 id="welcome-title" className="mx-0 mt-1 mb-0 text-[1.75rem] leading-[1.2] tracking-[-0.025em]">Tudo pronto para começar</h2>
          <p className="m-0 max-w-[60ch] text-[0.9375rem] leading-[1.55] text-ink-soft">O Teams AI está conectado às suas ferramentas e pronto para ajudar a organizar projetos, executar tarefas e acompanhar o trabalho da equipe. Para começar, abra Projetos e use Nova spec ou Novo projeto.</p>
          {onLeave ? <button type="button" className={DONE_CLASS} onClick={onLeave}>Ir para projetos<Icon name="arrow-right" size={16} /></button> : <Link className={DONE_CLASS} to="/projects">Ir para projetos<Icon name="arrow-right" size={16} /></Link>}
          <div className="onboarding-panel col-start-2 row-[1/span_5] w-full @max-2xl:hidden" aria-hidden="true">
            <img className="onboarding-panel-art" src="/onboarding-complete.png" alt="" />
          </div>
        </section>
      );
    }
  };
  return (
    <OnboardingShell
      title="Configure este ambiente"
      subtitle="Conecte as ferramentas que o Teams AI precisa para trabalhar neste computador."
      step={step}
      total={total}
      canAdvance={canAdvance}
      onBack={() => setStep((current) => current - 1)}
      onNext={next}
      showNext={step < total - 1}
    >
      {status || onLicenseStep ? stepContent() : <Loading />}
    </OnboardingShell>
  );
}
