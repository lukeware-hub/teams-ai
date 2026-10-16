import type { KeyObject } from 'node:crypto';
import { SESSION_PATH } from './auth.js';
import { readMachine } from '../license/machine.js';
import { verifyLicenseToken } from '../license/token.js';
import { readLicenseToken } from '../license/vault.js';

const OPEN = new Set(['/api/license', '/api/license/activate', '/api/license/sync', SESSION_PATH]);

export interface LicenseGuard {
  allowed(path: string): boolean;
  reload(): Promise<void>;
}

export async function licenseGuard(deps: { home?: string; publicKey?: KeyObject } = {}): Promise<LicenseGuard> {
  const { fingerprint } = await readMachine(deps.home);
  let token: string | null = null;
  const reload = async () => {
    token = await readLicenseToken(deps.home);
  };
  await reload();
  return {
    allowed: (path) => !path.startsWith('/api/') || OPEN.has(path) || (token !== null && verifyLicenseToken(token, fingerprint, Date.now(), deps.publicKey)),
    reload,
  };
}
