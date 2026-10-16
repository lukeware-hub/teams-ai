import { createHash } from 'node:crypto';
import type { Machine } from './machine.js';

export function hashLicenseKey(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex');
}

export type LicenseView =
  | { state: 'missing' }
  | { state: 'authorized' }
  | { state: 'revoked'; contactEmail: string; contactPhone: string }
  | { state: 'unavailable' }
  | { state: 'other-machine' };

export class LicenseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

async function post(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
}

export async function activateLicense(serviceUrl: string, key: string, machine: Machine, fetchImpl: typeof fetch): Promise<{ code: string; token: string }> {
  if (!serviceUrl.trim()) throw new LicenseError(503, 'Não foi possível contatar o serviço de licenças.');
  let res: Response;
  try {
    res = await post(fetchImpl, endpoint(serviceUrl, '/api/v1/activate'), { keyHash: hashLicenseKey(key), machine });
  } catch {
    throw new LicenseError(503, 'Não foi possível contatar o serviço de licenças.');
  }
  if (res.status === 404) throw new LicenseError(400, 'Chave de licença inválida.');
  if (res.status === 409) {
    const denied = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (denied.error === 'license is bound to another machine') throw new LicenseError(409, 'Esta chave já está em uso em outro computador.');
    throw new LicenseError(409, 'Esta licença já foi registrada.');
  }
  if (res.status === 403) throw new LicenseError(403, 'Esta licença está desativada.');
  if (!res.ok) throw new LicenseError(503, 'Não foi possível contatar o serviço de licenças.');
  const body = (await res.json().catch(() => ({}))) as { codeHash?: unknown; token?: unknown };
  if (typeof body.codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.codeHash) || typeof body.token !== 'string') throw new LicenseError(502, 'Resposta inválida do serviço de licenças.');
  return { code: body.codeHash, token: body.token };
}

export async function authorizeLicense(serviceUrl: string, code: string, fingerprint: string, fetchImpl: typeof fetch): Promise<{ view: LicenseView; token?: string }> {
  if (!serviceUrl.trim()) return { view: { state: 'unavailable' } };
  try {
    const res = await post(fetchImpl, endpoint(serviceUrl, '/api/v1/authorize'), { codeHash: code, fingerprint });
    if (!res.ok) return { view: { state: 'unavailable' } };
    const body = (await res.json().catch(() => ({}))) as { authorized?: boolean; token?: string; reason?: string; contactEmail?: string; contactPhone?: string };
    if (body.authorized) return { view: { state: 'authorized' }, token: body.token };
    if (body.reason === 'unknown') return { view: { state: 'missing' } };
    if (body.reason === 'machine') return { view: { state: 'other-machine' } };
    return { view: { state: 'revoked', contactEmail: body.contactEmail ?? '', contactPhone: body.contactPhone ?? '' } };
  } catch {
    return { view: { state: 'unavailable' } };
  }
}
