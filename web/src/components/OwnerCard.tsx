import { useEffect, useState } from 'react';
import { api, type Item } from '../api.js';
import { Icon } from './Icons.js';
import { ItemCard } from './ItemCard.js';

export function OwnerCard({ organizations, initialOwner, loading, loadError, item, onSaved }: { organizations: string[]; initialOwner: string | null; loading: boolean; loadError: string | null; item: Item | null; onSaved: (item: Item) => void }) {
  const [owner, setOwner] = useState(initialOwner ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setOwner(initialOwner ?? ''), [initialOwner]);
  const save = async () => {
    setError(null);
    try {
      onSaved((await api.owner(owner)).item);
    } catch {
      setError('Não foi possível salvar a organização. Tente novamente.');
    }
  };
  return (
    <ItemCard title="Organização do GitHub" item={item} variant="login" subtitle="Escolha onde o Teams AI deve trabalhar." info="Organização do GitHub onde o Teams AI cria e atualiza os repositórios dos seus projetos." icon="github" illustration="/onboarding-github-organization.png">
      <form
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-end gap-[0.7rem] max-md:grid-cols-1"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <select className="w-full min-w-0" aria-label="Organização do GitHub" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={loading || organizations.length === 0}>
          <option value="">{loading ? 'Carregando organizações…' : organizations.length === 0 ? 'Nenhuma organização encontrada' : 'Selecione uma organização'}</option>
          {organizations.map((organization) => <option key={organization} value={organization}>{organization}</option>)}
        </select>
        <button type="submit" className="primary-button max-md:w-full" disabled={loading || owner.trim() === ''}>
          Salvar e verificar
          <Icon name="check" size={16} />
        </button>
      </form>
      {loadError ? <p className="error">{loadError}</p> : null}
      {!loading && !loadError && organizations.length === 0 ? <p className="error">Nenhuma organização foi encontrada para esta conta do GitHub.</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
