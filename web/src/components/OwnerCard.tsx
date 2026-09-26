import { useEffect, useState } from 'react';
import { api, type Item } from '../api.js';
import { ItemCard } from './ItemCard.js';

export function OwnerCard({ organizations, initialOwner, loading, loadError, item, onSaved }: { organizations: string[]; initialOwner: string | null; loading: boolean; loadError: string | null; item: Item | null; onSaved: (item: Item) => void }) {
  const [owner, setOwner] = useState(initialOwner ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setOwner(initialOwner ?? ''), [initialOwner]);
  const save = async () => {
    setError(null);
    try {
      onSaved((await api.owner(owner)).item);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <ItemCard title="GitHub organization" item={item}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <select aria-label="GitHub organization" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={loading || organizations.length === 0}>
          <option value="">{loading ? 'Loading organizations…' : organizations.length === 0 ? 'No organizations found' : 'Select an organization'}</option>
          {organizations.map((organization) => <option key={organization} value={organization}>{organization}</option>)}
        </select>
        <button type="submit" disabled={loading || owner.trim() === ''}>
          Salvar e verificar
        </button>
      </form>
      {loadError ? <p className="error">{loadError}</p> : null}
      {!loading && !loadError && organizations.length === 0 ? <p className="error">No organization was found for this GitHub account.</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
