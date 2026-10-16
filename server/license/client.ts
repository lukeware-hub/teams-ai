import { createHash } from 'node:crypto';

export function hashLicenseKey(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex');
}

export type LicenseView =
  | { state: 'missing' }
  | { state: 'authorized' }
  | { state: 'revoked'; contactEmail: string; contactPhone: string }
  | { state: 'unavailable' };

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

export async function activateLicense(serviceUrl: string, key: string, fetchImpl: typeof fetch): Promise<string> {
  if (!serviceUrl.trim()) throw new LicenseError(503, 'Não foi possível contatar o serviço de licenças.');
  let res: Response;
  try {
    res = await post(fetchImpl, endpoint(serviceUrl, '/api/v1/activate'), { keyHash: hashLicenseKey(key) });
  } catch {
    throw new LicenseError(503, 'Não foi possível contatar o serviço de licenças.');
  }
  if (res.status === 404) throw new LicenseError(400, 'Chave de licença inválida.');
  if (res.status === 409) throw new LicenseError(409, 'Esta licença já foi registrada.');
  if (res.status === 403) throw new LicenseError(403, 'Esta licença está desativada.');
  if (!res.ok) throw new LicenseError(503, 'Não foi possível contatar o serviço de licenças.');
  const body = (await res.json().catch(() => ({}))) as { codeHash?: unknown };
  if (typeof body.codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.codeHash)) throw new LicenseError(502, 'Resposta inválida do serviço de licenças.');
  return body.codeHash;
}

export async function authorizeLicense(serviceUrl: string, code: string, fetchImpl: typeof fetch): Promise<LicenseView> {
  if (!serviceUrl.trim()) return { state: 'unavailable' };
  try {
    const res = await post(fetchImpl, endpoint(serviceUrl, '/api/v1/authorize'), { codeHash: code });
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json().catch(() => ({}))) as { authorized?: boolean; contactEmail?: string; contactPhone?: string };
    if (body.authorized) return { state: 'authorized' };
    return { state: 'revoked', contactEmail: body.contactEmail ?? '', contactPhone: body.contactPhone ?? '' };
  } catch {
    return { state: 'unavailable' };
  }
}
