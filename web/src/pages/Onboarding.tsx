import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Item, type ItemName, type Status } from '../api.js';
import { Icon } from '../components/Icons.js';
import { Loading } from '../components/Loading.js';
import { LoginCard } from '../components/LoginCard.js';
import { OwnerCard } from '../components/OwnerCard.js';
import { SecretCard } from '../components/SecretCard.js';

const STEP_ITEMS: readonly ItemName[] = ['ghLogin', 'githubOwner', 'githubToken', 'claude', 'openrouterKey'];

export function Onboarding({ compact = false }: { compact?: boolean }) {
  const totalSteps = 6;
  const focusOpenrouter = useSearchParams()[0].get('item') === 'openrouter'; // deep link from the refine page
  const [step, setStep] = useState(focusOpenrouter ? STEP_ITEMS.indexOf('openrouterKey') : 0);
  const [status, setStatus] = useState<Status | null>(null);
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [organizationOwner, setOrganizationOwner] = useState<string | null>(null);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const refresh = useCallback(() => void api.status().then(setStatus), []);
  useEffect(refresh, [refresh]);
  const item = (n: ItemName): Item | null => status?.items[n] ?? null;
  const patch = (n: ItemName) => (it: Item) => setStatus((s) => (s ? { ...s, items: { ...s.items, [n]: it }, allOk: Object.values({ ...s.items, [n]: it }).every((v) => v.ok) } : s));
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
    if (status?.allOk && !focusOpenrouter) setStep(totalSteps - 1);
  }, [status?.allOk, focusOpenrouter]);
  const currentName = STEP_ITEMS[step];
  const canAdvance = currentName !== undefined && item(currentName)?.ok === true;
  const next = () => {
    if (step < totalSteps - 1 && canAdvance) setStep((current) => current + 1);
  };
  const stepContent = () => {
    switch (step) {
      case 0: return <LoginCard cli="gh" title="Login do GitHub CLI" item={item('ghLogin')} onDone={refresh} />;
      case 1: return <OwnerCard organizations={organizations} initialOwner={organizationOwner} loading={organizationsLoading} loadError={organizationsError} item={item('githubOwner')} onSaved={patch('githubOwner')} />;
      case 2: return <SecretCard name="GITHUB_TOKEN" title="Token do GitHub" item={item('githubToken')} onSaved={patch('githubToken')} />;
      case 3: return <LoginCard cli="claude" title="Login do Claude" item={item('claude')} onDone={refresh} />;
      case 4: return <SecretCard name="OPENROUTER_API_KEY" title="Chave do OpenRouter (Jev)" item={item('openrouterKey')} onSaved={patch('openrouterKey')} />;
      default: return (
        // Completion screen: the flow's one gradient object.
        <section className="edge-lit grid grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)] items-center justify-items-start gap-x-10 gap-y-3 rounded-2xl border border-good-line bg-surface p-10 shadow-card @max-2xl:grid-cols-[minmax(0,1fr)] @max-2xl:rounded-xl @max-2xl:p-6" aria-labelledby="welcome-title">
          <span className="grid size-14 place-items-center rounded-tile bg-good-soft text-good" aria-hidden="true"><Icon name="check" size={28} /></span>
          <p className="m-0 inline-flex items-center gap-1.5 rounded-full bg-good-soft px-[0.65rem] py-[0.2rem] text-[0.8125rem] font-semibold text-good before:size-[0.45rem] before:rounded-full before:bg-current before:content-['']">Configuração concluída</p>
          <h2 id="welcome-title" className="mx-0 mt-1 mb-0 text-[1.75rem] leading-[1.2] tracking-[-0.025em]">Tudo pronto para começar</h2>
          <p className="m-0 max-w-[60ch] text-[0.9375rem] leading-[1.55] text-ink-soft">O Teams AI está conectado às suas ferramentas e pronto para ajudar a organizar projetos, executar tarefas e acompanhar o trabalho da equipe.</p>
          <Link className="primary-button mt-3 min-h-11 border-transparent px-5 [background:var(--gradient-primary)] [box-shadow:var(--shadow-primary)] hover:border-transparent hover:[background:var(--gradient-primary-hover)] @max-2xl:w-full" to="/projects">Ir para projetos<Icon name="arrow-right" size={16} /></Link>
          <div className="col-start-2 row-[1/span_5] w-full @max-2xl:hidden" aria-hidden="true"><img className="block max-h-72 w-full rounded-lg object-contain [background:var(--art-plate)] [mix-blend-mode:var(--art-blend)]" src="/onboarding-complete.png" alt="" /></div>
        </section>
      );
    }
  };
  return (
    <main className={`@container mx-auto w-full max-w-[1120px] min-w-0 gap-6 pt-9 pb-12 *:min-w-0 max-[720px]:pt-6 ${compact ? 'compact' : ''}`}>
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-8 border-b border-line pb-6 *:min-w-0 @max-2xl:grid-cols-[minmax(0,1fr)] @max-2xl:gap-5">
        <div>
          <h1 className="m-0 text-[2.5rem] leading-[1.08] font-bold tracking-[-0.03em] text-ink @max-2xl:text-[1.875rem]">{compact ? 'Status do ambiente' : 'Configure este ambiente'}</h1>
          <p className="mx-0 mt-[0.65rem] mb-0 max-w-[60ch] text-[0.9375rem] leading-[1.55] text-ink-soft">Conecte as ferramentas que o Teams AI precisa para trabalhar neste computador.</p>
        </div>
        <div className="edge-lit w-80 max-w-full rounded-xl border border-line bg-surface px-[1.15rem] py-4 shadow-card @max-2xl:w-full" aria-label={`Etapa ${step + 1} de ${totalSteps}`}>
          <div className="flex items-baseline justify-between gap-4 text-[0.8125rem] font-semibold text-ink-soft">
            <span>Progresso</span>
            <strong className="text-[1.125rem] text-ink tabular-nums">{step + 1}/{totalSteps}</strong>
          </div>
          <div className="mt-[0.65rem] mb-2 h-1.5 overflow-hidden rounded-full bg-surface-muted"><span className="block size-full origin-left rounded-[inherit] transition-transform duration-[var(--duration-slow)] ease-[var(--ease-out)] [background:var(--gradient-primary)] motion-reduce:transition-none" style={{ transform: `scaleX(${(step + 1) / totalSteps})` }} /></div>
          <small className="text-[0.8125rem] text-ink-soft">{step === totalSteps - 1 ? 'Configuração concluída' : 'Complete esta etapa para continuar'}</small>
        </div>
      </header>
      <div className="grid gap-[0.85rem]">{status ? stepContent() : <Loading />}</div>
      {/* On narrow frames the navigation sticks to the bottom over a glass band. */}
      <nav className="flex items-center justify-between gap-4 border-t border-line pt-5 @max-2xl:sticky @max-2xl:bottom-0 @max-2xl:-mx-[clamp(1rem,3vw,2rem)] @max-2xl:bg-surface @max-2xl:px-[clamp(1rem,3vw,2rem)] @max-2xl:py-3 @max-2xl:backdrop-blur-md" aria-label="Navegação da configuração">
        <button type="button" className="secondary h-11 min-w-32 border-line-strong text-ink enabled:hover:bg-surface-sunken @max-2xl:flex-1" onClick={() => setStep((current) => current - 1)} disabled={step === 0}><Icon name="arrow-left" size={16} />Voltar</button>
        {step < totalSteps - 1 ? <button type="button" className="primary-button h-11 min-w-32 @max-2xl:flex-1" onClick={next} disabled={!canAdvance}>Próximo<Icon name="arrow-right" size={16} /></button> : null}
      </nav>
    </main>
  );
}
