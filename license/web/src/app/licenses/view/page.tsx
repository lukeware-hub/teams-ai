'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Frame, ValidityChoice } from '@/components/Frame';
import { api, statusClass, STATUS_LABEL, toRFC3339, when, type License } from '@/lib/api';

function Detail() {
  const id = useSearchParams().get('id') ?? '';
  const [license, setLicense] = useState<License | null>(null);
  const [mode, setMode] = useState<'none' | 'date' | 'days'>('none');
  const [date, setDate] = useState('');
  const [days, setDays] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => {
    if (!id) return;
    api<License>(`/api/admin/licenses/${id}`)
      .then((body) => {
        setLicense(body);
        if (body.validForDays && !body.activatedAt) {
          setMode('days');
          setDays(String(body.validForDays));
        } else if (body.expiresAt) {
          setMode('date');
          setDate(body.expiresAt.slice(0, 16));
        } else setMode('none');
      })
      .catch((err: Error) => setError(err.message));
  };
  useEffect(load, [id]);
  const patch = async (body: Record<string, unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await api(`/api/admin/licenses/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setNotice(done);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const saveValidity = () => {
    if (mode === 'date' && !date) {
      setError('Informe a data.');
      return;
    }
    if (mode === 'days' && Number(days) < 1) {
      setError('Informe o período.');
      return;
    }
    if (mode === 'none') return patch({ clearExpiry: true }, 'Validade removida.');
    if (mode === 'date') return patch({ expiresAt: toRFC3339(date) }, 'Validade atualizada.');
    return patch({ validForDays: Number(days) }, 'Período atualizado.');
  };
  return (
    <Frame title="Licença">
      {!id ? <p className="error">Licença não informada.</p> : null}
      {license ? (
        <section className="card grid max-w-3xl gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className={statusClass(license.status)}>{STATUS_LABEL[license.status]}</span>
            <span className="text-sm text-[var(--ink-soft)]">Criada em {when(license.createdAt)}</span>
            <span className="text-sm text-[var(--ink-soft)]">Ativada em {when(license.activatedAt)}</span>
          </div>
          <label className="field">Chave<input className="key" readOnly value={license.key ?? ''} /></label>
          <ValidityChoice mode={mode} date={date} days={days} onMode={setMode} onDate={setDate} onDays={setDays} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => void saveValidity()}>Salvar validade</button>
            <button type="button" className="btn btn-primary" onClick={() => void patch({ status: 'active' }, 'Licença habilitada.')} disabled={license.status === 'active' || license.status === 'pending'}>Habilitar</button>
            <button type="button" className="btn btn-secondary" onClick={() => void patch({ status: 'disabled' }, 'Licença desabilitada.')} disabled={license.status === 'disabled'}>Desabilitar</button>
          </div>
          {notice ? <p className="m-0 text-[var(--good)]">{notice}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </section>
      ) : null}
    </Frame>
  );
}

export default function LicenseViewPage() {
  return (
    <Suspense>
      <Detail />
    </Suspense>
  );
}
