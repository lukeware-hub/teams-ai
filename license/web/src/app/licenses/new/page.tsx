'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Frame, ValidityChoice } from '@/components/Frame';
import { api, toRFC3339, type License } from '@/lib/api';

export default function NewLicensePage() {
  const [mode, setMode] = useState<'none' | 'date' | 'days'>('none');
  const [date, setDate] = useState('');
  const [days, setDays] = useState('30');
  const [created, setCreated] = useState<License | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const body: { expiresAt?: string; validForDays?: number } = {};
    if (mode === 'date') body.expiresAt = toRFC3339(date);
    if (mode === 'days') body.validForDays = Number(days);
    try {
      setCreated(await api<License>('/api/admin/licenses', { method: 'POST', body: JSON.stringify(body) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Nova licença">
      {created ? (
        <section className="card grid gap-3">
          <h2 className="m-0 text-lg">Licença criada</h2>
          <p className="m-0 text-[var(--ink-soft)]">A chave pode ser consultada de novo na página da licença.</p>
          <div className="flex items-center gap-3">
            <p className="key m-0 min-w-0 flex-1 rounded-[var(--control-radius)] bg-[var(--surface-sunken)] p-3">{created.key}</p>
            <button
              type="button"
              className="btn btn-secondary shrink-0"
              onClick={() => {
                const key = created.key;
                if (!key) return;
                const write = navigator.clipboard.writeText(key).catch(() => {
                  const field = document.createElement('textarea');
                  field.value = key;
                  document.body.append(field);
                  field.select();
                  const ok = document.execCommand('copy');
                  field.remove();
                  if (!ok) throw new Error('copy failed');
                });
                void write.then(() => setCopied(true));
              }}
            >
              {copied ? 'Copiada' : 'Copiar'}
            </button>
          </div>
          <Link className="btn btn-primary w-fit" href={`/licenses/view/?id=${created.id}`}>Abrir licença</Link>
        </section>
      ) : (
        <form
          className="card grid max-w-xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <ValidityChoice mode={mode} date={date} days={days} onMode={setMode} onDate={setDate} onDays={setDays} />
          {error ? <p className="error">{error}</p> : null}
          <button type="submit" className="btn btn-primary w-fit" disabled={busy}>{busy ? 'Gerando…' : 'Gerar chave'}</button>
        </form>
      )}
    </Frame>
  );
}
