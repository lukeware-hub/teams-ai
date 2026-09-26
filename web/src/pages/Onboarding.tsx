import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Item, type ItemName, type Status } from '../api.js';
import { LoginCard } from '../components/LoginCard.js';
import { OwnerCard } from '../components/OwnerCard.js';
import { SecretCard } from '../components/SecretCard.js';

export function Onboarding({ compact = false }: { compact?: boolean }) {
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
  const githubOwnerReady = status?.items.githubOwner.ok === true;
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
    }).catch((e: Error) => {
      if (active) setOrganizationsError(e.message);
    }).finally(() => {
      if (active) setOrganizationsLoading(false);
    });
    return () => { active = false; };
  }, [githubLoggedIn]);
  return (
    <main className={compact ? 'compact' : ''}>
      <h1>{compact ? 'Status do ambiente' : 'Configure este ambiente'}</h1>
      <LoginCard cli="gh" title="Login do GitHub CLI" item={item('ghLogin')} onDone={refresh} />
      {githubLoggedIn ? <OwnerCard organizations={organizations} initialOwner={organizationOwner} loading={organizationsLoading} loadError={organizationsError} item={item('githubOwner')} onSaved={patch('githubOwner')} /> : null}
      {githubOwnerReady ? <SecretCard name="GITHUB_TOKEN" title="Token do GitHub" item={item('githubToken')} onSaved={patch('githubToken')} /> : null}
      <LoginCard cli="claude" title="Login do Claude" item={item('claude')} onDone={refresh} />
      <SecretCard name="OPENROUTER_API_KEY" title="Chave do OpenRouter (Jev)" item={item('openrouterKey')} onSaved={patch('openrouterKey')} />
      {status?.allOk ? (
        <p className="all-ok">
          Tudo configurado. <Link to="/projects">Ir para projetos</Link>
        </p>
      ) : null}
    </main>
  );
}
