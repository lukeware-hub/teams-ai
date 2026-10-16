'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearToken, readToken } from '@/lib/api';

const LINKS = [
  { href: '/licenses/', label: 'Licenças', active: (path: string) => path.startsWith('/licenses') && !path.startsWith('/licenses/new') },
  { href: '/licenses/new/', label: 'Nova licença', active: (path: string) => path.startsWith('/licenses/new') },
  { href: '/settings/', label: 'Contatos', active: (path: string) => path.startsWith('/settings') },
];

export function Frame({ title, children }: { title: string; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!readToken()) router.replace('/login/');
    else setReady(true);
  }, [router]);
  if (!ready) return null;
  return (
    <div className="min-h-dvh">
      <header className="topbar">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3">
          <Link href="/licenses/" className="flex items-center gap-3 no-underline">
            <img src="/lukeware-lockup-dark.png" alt="Lukeware" width={103} height={28} className="h-7 w-auto" />
            <span className="border-l border-[var(--line-strong)] pl-3 text-sm font-semibold text-[var(--ink-soft)]">Licenças</span>
          </Link>
          <nav aria-label="Navegação principal" className="flex flex-wrap items-center gap-1">
            {LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="nav-link" aria-current={link.active(path) ? 'page' : undefined}>
                {link.label}
              </Link>
            ))}
            <span className="mx-2 h-5 w-px bg-[var(--line-strong)]" aria-hidden="true" />
            <button
              type="button"
              className="nav-link"
              onClick={() => {
                clearToken();
                router.replace('/login/');
              }}
            >
              Sair
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-5xl content-start gap-6 px-4 py-8">
        <h1 className="m-0 text-[1.75rem] tracking-[-0.03em]">{title}</h1>
        {children}
      </main>
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
