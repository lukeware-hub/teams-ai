import { HttpError, type Route } from './server.js';
import { activateLicense, authorizeLicense, LicenseError } from '../license/client.js';
import { readMachine } from '../license/machine.js';
import { clearLicenseCode, readLicenseCode, writeLicenseCode } from '../license/vault.js';

export interface LicenseDeps {
  home?: string;
  serviceUrl: string;
  fetch?: typeof fetch;
}

export function licenseRoutes(deps: LicenseDeps): Route[] {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  return [
    {
      method: 'GET',
      path: '/api/license',
      handler: async ({ json }) => {
        const code = await readLicenseCode(deps.home);
        if (!code) {
          json(200, { state: 'missing' });
          return;
        }
        const view = await authorizeLicense(deps.serviceUrl, code, (await readMachine(deps.home)).fingerprint, fetchImpl);
        if (view.state === 'missing') await clearLicenseCode(deps.home);
        json(200, view);
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
          const code = await activateLicense(deps.serviceUrl, key, await readMachine(deps.home), fetchImpl);
          await writeLicenseCode(code, deps.home);
        } catch (err) {
          if (err instanceof LicenseError) throw new HttpError(err.status, err.message);
          throw err;
        }
        json(200, { state: 'authorized' });
      },
    },
  ];
}
