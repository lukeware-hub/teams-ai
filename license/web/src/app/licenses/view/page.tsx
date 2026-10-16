'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Frame, ValidityChoice } from '@/components/Frame';
import { api, statusClass, STATUS_LABEL, toRFC3339, when, type License, type Machine } from '@/lib/api';

function MachineInfo({ machine }: { machine: Machine }) {
  const rows: [string, string][] = [
    ['Computador', machine.hostname],
    ['Usuário', machine.user],
    ['Sistema', machine.os],
    ['Processador', machine.cpus ? `${machine.cpu} (${machine.cpus} núcleos)` : machine.cpu],
    ['Memória', machine.memoryBytes ? `${(machine.memoryBytes / 1024 ** 3).toFixed(1)} GB` : ''],
    ['IP de origem', machine.remoteIp],
    ['IPs da rede', (machine.addresses ?? []).join(', ')],
    ['Endereços MAC', (machine.macs ?? []).join(', ')],
  ];
  return (
    <div className="grid gap-3 border-t border-[var(--line)] pt-4">
      <h2 className="m-0 text-sm font-semibold text-[var(--ink-soft)]">Máquina registrada</h2>
      <label className="field">Identificador da máquina<input className="key" readOnly value={machine.fingerprint || '—'} /></label>
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[var(--ink-soft)]">{label}</dt>
            <dd className="m-0 break-words">{value || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Detail() {
  const id = useSearchParams().get('id') ?? '';
  const router = useRouter();
  const [license, setLicense] = useState<License | null>(null);
  const [mode, setMode] = useState<'none' | 'date' | 'days'>('none');
  const [date, setDate] = useState('');
  const [days, setDays] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
  const remove = async () => {
    setError(null);
    setNotice(null);
    setDeleting(true);
    try {
      await api(`/api/admin/licenses/${id}`, { method: 'DELETE' });
      router.replace('/licenses/');
    } catch (err) {
      setDeleting(false);
      setError((err as Error).message);
    }
  };
  return (
    <Frame title="Licença">
      {!id ? <p className="error">Licença não informada.</p> : null}
      {license ? (
        <section className="card mx-auto grid w-full max-w-xl gap-5">
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
          {license.machine ? <MachineInfo machine={license.machine} /> : null}
          <div className="grid gap-3 border-t border-[var(--line)] pt-4">
            {confirmDelete ? (
              <>
                <p className="m-0 text-sm text-[var(--ink-soft)]">Excluir esta licença? Ela deixa de existir e o Teams AI pede uma chave nova.</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={deleting}>Excluir</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancelar</button>
                </div>
              </>
            ) : (
              <button type="button" className="btn btn-danger w-fit" onClick={() => setConfirmDelete(true)}>Excluir licença</button>
            )}
          </div>
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
