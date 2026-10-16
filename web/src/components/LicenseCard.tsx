import { useState } from 'react';
import { api } from '../api.js';
import { LICENSE } from '../onboarding/stepCopy.js';
import { ActionButton } from './ActionButton.js';
import { Icon } from './Icons.js';
import { ItemCard } from './ItemCard.js';

export function LicenseCard({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.activateLicense(value);
      setValue('');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ItemCard title="Licença do Teams AI" item={{ ok: false, detail: 'Informe a chave de licença' }} variant="login" subtitle="A chave libera este computador e não fica salva nele." info="A Lukeware fornece a chave. O Teams AI envia só a conferência dela e guarda um código próprio no cofre deste computador." benefits={LICENSE.benefits} panel={LICENSE.panel}>
      <form
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-end gap-[0.7rem] @max-[40rem]:grid-cols-[minmax(0,1fr)]"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="grid min-w-0 gap-[0.38rem] text-[0.8125rem] font-semibold text-ink-soft">
          <span>Cole a chave de licença</span>
          <input className="w-full min-w-0" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Cole a chave aqui…" autoComplete="off" spellCheck={false} />
        </label>
        <ActionButton type="submit" className="primary-button @max-[40rem]:w-full" busy={busy} disabled={value.trim() === ''} icon={<Icon name="check" size={16} />}>
          {busy ? 'Verificando…' : 'Ativar'}
        </ActionButton>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
