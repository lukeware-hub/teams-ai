import { useState } from 'react';
import { api, type Item } from '../api.js';
import { ItemCard } from './ItemCard.js';

export function SecretCard({ name, title, item, onSaved }: { name: 'GITHUB_TOKEN' | 'OPENROUTER_API_KEY'; title: string; item: Item | null; onSaved: (item: Item) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.secret(name, value);
      setValue('');
      onSaved(r.item);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ItemCard title={title} item={item}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={item?.secret?.set ? 'Replace the stored value' : 'Paste the value'} autoComplete="off" />
        <button type="submit" disabled={busy || value.trim() === ''}>
          {busy ? 'Checking…' : 'Save and verify'}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
