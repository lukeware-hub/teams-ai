import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Item, type ItemName, type Status } from '../api.js';
import { LoginCard } from '../components/LoginCard.js';
import { OwnerCard } from '../components/OwnerCard.js';
import { SecretCard } from '../components/SecretCard.js';

export function Onboarding({ compact = false }: { compact?: boolean }) {
  const totalSteps = 6;
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [organizationOwner, setOrganizationOwner] = useState<string | null>(null);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const refresh = useCallback(() => void api.status().then(setStatus), []);
  useEffect(refresh, [refresh]);
  const item = (n: ItemName): Item | null => status?.items[n] ?? null;
  const patch = (n: ItemName) => (it: Item) => setStatus((s) => (s ? { ...s, items: { ...s.items, [n]: it }, allOk: Object.entries({ ...s.items, [n]: it }).every(([, v]) => v.ok) } : s));
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
    if (status?.allOk) setStep(totalSteps - 1);
  }, [status?.allOk]);
  const currentItem = [item('ghLogin'), item('githubOwner'), item('githubToken'), item('claude'), item('openrouterKey')][step];
  const next = () => {
    if (step < totalSteps - 1 && currentItem?.ok) setStep((current) => current + 1);
  };
  const stepContent = () => {
    switch (step) {
      case 0: return <LoginCard cli="gh" title="Login do GitHub CLI" item={item('ghLogin')} onDone={refresh} />;
      case 1: return <OwnerCard organizations={organizations} initialOwner={organizationOwner} loading={organizationsLoading} loadError={organizationsError} item={item('githubOwner')} onSaved={patch('githubOwner')} />;
      case 2: return <SecretCard name="GITHUB_TOKEN" title="Token do GitHub" item={item('githubToken')} onSaved={patch('githubToken')} />;
      case 3: return <LoginCard cli="claude" title="Login do Claude" item={item('claude')} onDone={refresh} />;
      case 4: return <SecretCard name="OPENROUTER_API_KEY" title="Chave do OpenRouter (Jev)" item={item('openrouterKey')} onSaved={patch('openrouterKey')} />;
      default: return (
        <section className="welcome-card" aria-labelledby="welcome-title">
          <span className="welcome-icon" aria-hidden="true">✓</span>
          <p className="setup-kicker">Configuração concluída</p>
          <h2 id="welcome-title">Tudo pronto para começar</h2>
          <p>O Teams AI está conectado às suas ferramentas e pronto para ajudar a organizar projetos, executar tarefas e acompanhar o trabalho da equipe.</p>
          <Link className="primary-button" to="/projects">Ir para projetos</Link>
          <div className="welcome-visual" aria-hidden="true"><img className="welcome-art" src="/onboarding-complete.png" alt="" /></div>
        </section>
      );
    }
  };
  return (
    <main className={`onboarding-shell${compact ? ' compact' : ''}`}>
      <header className="setup-hero">
        <div>
          <h1>{compact ? 'Status do ambiente' : 'Configure este ambiente'}</h1>
          <p className="setup-intro">Conecte as ferramentas que o Teams AI precisa para trabalhar neste computador.</p>
        </div>
        <div className="setup-progress" aria-label={`Etapa ${step + 1} de ${totalSteps}`}>
          <div className="progress-meta">
            <span>Progresso</span>
            <strong>{step + 1}/{totalSteps}</strong>
          </div>
          <div className="progress-track"><span style={{ transform: `scaleX(${(step + 1) / totalSteps})` }} /></div>
          <small>{step === totalSteps - 1 ? 'Configuração concluída' : 'Complete esta etapa para continuar'}</small>
        </div>
      </header>
      <div className="setup-grid">{stepContent()}</div>
      <nav className="onboarding-navigation" aria-label="Navegação da configuração">
        <button type="button" className="secondary" onClick={() => setStep((current) => current - 1)} disabled={step === 0}>Voltar</button>
        {step < totalSteps - 1 ? <button type="button" className="primary-button" onClick={next} disabled={!currentItem?.ok}>Próximo</button> : null}
      </nav>
    </main>
  );
}
