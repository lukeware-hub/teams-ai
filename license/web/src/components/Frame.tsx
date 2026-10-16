'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearToken, readToken } from '@/lib/api';

export function Frame({ title, children }: { title: string; children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!readToken()) router.replace('/login/');
    else setReady(true);
  }, [router]);
  if (!ready) return null;
  return (
    <div className="mx-auto grid min-h-dvh w-full max-w-5xl content-start gap-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="m-0 text-xs font-semibold tracking-[0.08em] text-[var(--ink-soft)] uppercase">Lukeware</p>
          <h1 className="m-0 text-[1.75rem] tracking-[-0.03em]">{title}</h1>
        </div>
        <nav className="flex flex-wrap items-center gap-3 text-sm">
          <Link href="/licenses/">Licenças</Link>
          <Link href="/licenses/new/">Nova licença</Link>
          <Link href="/settings/">Contatos</Link>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              clearToken();
              router.replace('/login/');
            }}
          >
            Sair
          </button>
        </nav>
      </header>
      {children}
    </div>
  );
}

export function ValidityChoice({
  mode,
  date,
  days,
  onMode,
  onDate,
  onDays,
}: {
  mode: 'none' | 'date' | 'days';
  date: string;
  days: string;
  onMode: (mode: 'none' | 'date' | 'days') => void;
  onDate: (value: string) => void;
  onDays: (value: string) => void;
}) {
  return (
    <fieldset className="m-0 grid gap-3 border-0 p-0">
      <legend className="mb-1 text-sm font-semibold text-[var(--ink-soft)]">Validade automática</legend>
      <label className="flex items-center gap-2"><input type="radio" name="validity" checked={mode === 'none'} onChange={() => onMode('none')} /> Sem desativação automática</label>
      <label className="flex items-center gap-2"><input type="radio" name="validity" checked={mode === 'date'} onChange={() => onMode('date')} /> Data</label>
      {mode === 'date' ? <label className="field">Data e hora<input type="datetime-local" value={date} onChange={(e) => onDate(e.target.value)} required /></label> : null}
      <label className="flex items-center gap-2"><input type="radio" name="validity" checked={mode === 'days'} onChange={() => onMode('days')} /> Período a partir da ativação</label>
      {mode === 'days' ? <label className="field">Dias<input type="number" min={1} value={days} onChange={(e) => onDays(e.target.value)} required /></label> : null}
    </fieldset>
  );
}
