import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export const LICENSE_PUBLIC_KEY = createPublicKey({ key: Buffer.from('MCowBQYDK2VwAyEAxK6aNcSv1PSpoFR9VWVTEkUMIZ5d84KUusFtSXq2i44=', 'base64'), format: 'der', type: 'spki' });

export function verifyLicenseToken(token: string, fingerprint: string, now = Date.now(), key: KeyObject = LICENSE_PUBLIC_KEY): boolean {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return false;
  try {
    if (!verify(null, Buffer.from(body), key, Buffer.from(sig, 'base64url'))) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { fp?: unknown; exp?: unknown };
    return payload.fp === fingerprint && (payload.exp === null || (typeof payload.exp === 'number' && payload.exp * 1000 > now));
  } catch {
    return false;
  }
}
