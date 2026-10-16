'use client';

import { useEffect, useState } from 'react';
import { Frame } from '@/components/Frame';
import { api, type Settings } from '@/lib/api';

export default function SettingsPage() {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    api<Settings>('/api/admin/settings')
      .then((body) => {
        setEmail(body.contactEmail);
        setPhone(body.contactPhone);
      })
      .catch((err: Error) => setError(err.message));
  }, []);
  const save = async () => {
    setError(null);
    setNotice(null);
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ contactEmail: email, contactPhone: phone }) });
      setNotice('Contatos salvos.');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Frame title="Contatos">
      <form
        className="card grid max-w-xl gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="m-0 text-[var(--ink-soft)]">Estes dados aparecem para quem teve o acesso desativado.</p>
        <label className="field">E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field">Telefone<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        {notice ? <p className="m-0 text-[var(--good)]">{notice}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" className="btn btn-primary w-fit">Salvar</button>
      </form>
    </Frame>
  );
}
