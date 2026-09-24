import { useState } from 'react';
import { api, type Item } from '../api.js';
import { ItemCard } from './ItemCard.js';

export function OwnerCard({ item, onSaved }: { item: Item | null; onSaved: (item: Item) => void }) {
  const [owner, setOwner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      onSaved((await api.owner(owner)).item);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <ItemCard title="GitHub owner" item={item}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="user or organization" />
        <button type="submit" disabled={owner.trim() === ''}>
          Save and verify
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
