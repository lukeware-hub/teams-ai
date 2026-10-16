'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, saveToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ token: string }>('/api/admin/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      saveToken(body.token);
      router.replace('/licenses/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <form
        className="card grid w-full max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <p className="m-0 text-xs font-semibold tracking-[0.08em] text-[var(--ink-soft)] uppercase">Lukeware</p>
          <h1 className="m-0 text-[1.75rem] tracking-[-0.03em]">Entrar</h1>
          <p className="m-0 mt-2 text-[var(--ink-soft)]">Acesso administrativo das licenças do Teams AI.</p>
        </div>
        <label className="field">E-mail<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field">Senha<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </main>
  );
}
