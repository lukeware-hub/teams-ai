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
    <ItemCard title={title} item={item} variant="login" subtitle={name === 'GITHUB_TOKEN' ? 'Informe um token para validar o acesso aos seus repositórios.' : 'Informe a chave para habilitar os recursos de IA.'} icon={name === 'GITHUB_TOKEN' ? 'github' : 'user'}>
      <form
        className="secret-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="secret-field">
          <span>{item?.secret?.set ? 'Substituir token salvo' : 'Cole o token de acesso'}</span>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Cole o valor aqui…" autoComplete="off" />
        </label>
        <button type="submit" className="primary-button" disabled={busy || value.trim() === ''}>
          {busy ? 'Verificando…' : 'Salvar e verificar'}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
