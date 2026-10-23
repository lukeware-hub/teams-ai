import { afterEach, describe, expect, it } from 'vitest';
import { startApi } from '../../server/api/server.js';
import { OwnerError } from '../../server/core/owner-error.js';

describe('an error a route throws', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /** Serves one POST route whose handler throws `error`; returns the URL of that route. */
  async function serve(error: Error): Promise<string> {
    const api = await startApi({ routes: [{ method: 'POST', path: '/api/probe', handler: async () => { throw error; } }], log: () => undefined }, 0);
    close = api.close;
    return `http://127.0.0.1:${api.port}/api/probe`;
  }

  const post = (url: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  it('shows an owner error with its Portuguese message, as a 500', async () => {
    const res = await post(await serve(new OwnerError('A sugestão de nome não devolveu o resultado em formato válido. Tente de novo.', 'bad json')));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'A sugestão de nome não devolveu o resultado em formato válido. Tente de novo.' });
  });

  it('hides any other error behind "internal error"', async () => {
    const res = await post(await serve(new Error('disk full at /home/node/secret')));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});
