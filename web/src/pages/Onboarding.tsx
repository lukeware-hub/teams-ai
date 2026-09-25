import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Item, type ItemName, type Status } from '../api.js';
import { LoginCard } from '../components/LoginCard.js';
import { OwnerCard } from '../components/OwnerCard.js';
import { SecretCard } from '../components/SecretCard.js';

export function Onboarding({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = useCallback(() => void api.status().then(setStatus), []);
  useEffect(refresh, [refresh]);
  const item = (n: ItemName): Item | null => status?.items[n] ?? null;
  const patch = (n: ItemName) => (it: Item) => setStatus((s) => (s ? { ...s, items: { ...s.items, [n]: it }, allOk: Object.entries({ ...s.items, [n]: it }).every(([, v]) => v.ok) } : s));
  return (
    <main className={compact ? 'compact' : ''}>
      <h1>{compact ? 'Status do ambiente' : 'Configure este ambiente'}</h1>
      <LoginCard cli="claude" title="Login do Claude" item={item('claude')} onDone={refresh} />
      <OwnerCard item={item('githubOwner')} onSaved={patch('githubOwner')} />
      <LoginCard cli="gh" title="Login do GitHub CLI" item={item('ghLogin')} onDone={refresh} />
      <SecretCard name="GITHUB_TOKEN" title="Token do GitHub" item={item('githubToken')} onSaved={patch('githubToken')} />
      <SecretCard name="OPENROUTER_API_KEY" title="Chave do OpenRouter (Jev)" item={item('openrouterKey')} onSaved={patch('openrouterKey')} />
      {status?.allOk ? (
        <p className="all-ok">
          Tudo configurado. <Link to="/projects">Ir para projetos</Link>
        </p>
      ) : null}
    </main>
  );
}
