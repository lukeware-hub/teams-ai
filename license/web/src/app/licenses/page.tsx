'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Frame } from '@/components/Frame';
import { api, statusClass, STATUS_LABEL, when, type License } from '@/lib/api';

export default function LicensesPage() {
  const [licenses, setLicenses] = useState<License[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ licenses: License[] }>('/api/admin/licenses')
      .then((body) => setLicenses(body.licenses))
      .catch((err: Error) => setError(err.message));
  }, []);
  return (
    <Frame title="Licenças">
      <section className="card grid gap-4">
        {error ? <p className="error">{error}</p> : null}
        {licenses === null && !error ? <p className="m-0 text-[var(--ink-soft)]">Carregando…</p> : null}
        {licenses?.length === 0 ? <p className="m-0 text-[var(--ink-soft)]">Nenhuma licença criada.</p> : null}
        {licenses && licenses.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="text-xs tracking-[0.06em] text-[var(--ink-soft)] uppercase">
                  <th className="px-2 py-2 font-semibold">Estado</th>
                  <th className="px-2 py-2 font-semibold">Criada</th>
                  <th className="px-2 py-2 font-semibold">Validade</th>
                  <th className="px-2 py-2 font-semibold">Ativação</th>
                </tr>
              </thead>
              <tbody>
                {licenses.map((license) => (
                  <tr key={license.id} className="border-t border-[var(--line)]">
                    <td className="px-2 py-3"><Link href={`/licenses/view/?id=${license.id}`} className={statusClass(license.status)}>{STATUS_LABEL[license.status]}</Link></td>
                    <td className="px-2 py-3">{when(license.createdAt)}</td>
                    <td className="px-2 py-3">{license.expiresAt ? when(license.expiresAt) : license.validForDays ? `${license.validForDays} dias após a ativação` : '—'}</td>
                    <td className="px-2 py-3">{when(license.activatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </Frame>
  );
}
