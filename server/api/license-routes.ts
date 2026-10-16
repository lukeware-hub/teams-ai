import type { KeyObject } from 'node:crypto';
import { HttpError, type Route } from './server.js';
import { activateLicense, authorizeLicense, LicenseError, type LicenseView } from '../license/client.js';
import { readMachine } from '../license/machine.js';
import { verifyLicenseToken } from '../license/token.js';
import { clearLicenseCode, clearLicenseToken, readLicenseCode, readLicenseToken, writeLicenseCode, writeLicenseToken } from '../license/vault.js';

export interface LicenseDeps {
  home?: string;
  serviceUrl: string;
  fetch?: typeof fetch;
  onChange?: () => Promise<void>;
  publicKey?: KeyObject;
}

export function licenseRoutes(deps: LicenseDeps): Route[] {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const changed = deps.onChange ?? (async () => undefined);
  const accepted = (token: string, fingerprint: string) => verifyLicenseToken(token, fingerprint, Date.now(), deps.publicKey);
  const confirm = async (): Promise<LicenseView> => {
    const fingerprint = (await readMachine(deps.home)).fingerprint;
    const code = await readLicenseCode(deps.home);
    if (!code) {
      if (await readLicenseToken(deps.home)) {
        await clearLicenseToken(deps.home);
        await changed();
      }
      return { state: 'missing' };
    }
    const { view, token } = await authorizeLicense(deps.serviceUrl, code, fingerprint, fetchImpl);
    if (view.state === 'unavailable') {
      const current = await readLicenseToken(deps.home);
      if (current && accepted(current, fingerprint)) return { state: 'authorized' };
      return view;
    }
    if (view.state === 'missing') await clearLicenseCode(deps.home);
    if (view.state === 'authorized') {
      if (!token || !accepted(token, fingerprint)) {
        await clearLicenseToken(deps.home);
        await changed();
        return { state: 'unavailable' };
      }
      await writeLicenseToken(token, deps.home);
    } else await clearLicenseToken(deps.home);
    await changed();
    return view;
  };
  return [
    {
      method: 'GET',
      path: '/api/license',
      handler: async ({ json }) => {
        const fingerprint = (await readMachine(deps.home)).fingerprint;
        const current = await readLicenseToken(deps.home);
        if (current && accepted(current, fingerprint)) {
          json(200, { state: 'authorized' });
          return;
        }
        json(200, await confirm());
      },
    },
    {
      method: 'POST',
      path: '/api/license/sync',
      handler: async ({ json }) => {
        json(200, await confirm());
      },
    },
    {
      method: 'POST',
      path: '/api/license/activate',
      handler: async ({ body, json }) => {
        const input = await body();
        const key = typeof input === 'object' && input !== null && 'key' in input && typeof input.key === 'string' ? input.key.trim() : '';
        if (!key) throw new HttpError(400, 'Informe a chave de licença.');
        if (await readLicenseCode(deps.home)) throw new HttpError(409, 'Este computador já tem uma licença.');
        try {
          const machine = await readMachine(deps.home);
          const { code, token } = await activateLicense(deps.serviceUrl, key, machine, fetchImpl);
          if (!accepted(token, machine.fingerprint)) throw new LicenseError(502, 'Resposta inválida do serviço de licenças.');
          await writeLicenseCode(code, deps.home);
          await writeLicenseToken(token, deps.home);
        } catch (err) {
          if (err instanceof LicenseError) throw new HttpError(err.status, err.message);
          throw err;
        }
        await changed();
        json(200, { state: 'authorized' });
      },
    },
  ];
}
