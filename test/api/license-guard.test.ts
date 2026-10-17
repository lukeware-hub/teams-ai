import { generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { licenseGuard } from '../../server/api/license-guard.js';
import { startApi } from '../../server/api/server.js';
import { readMachine } from '../../server/license/machine.js';
import { writeLicenseToken } from '../../server/license/vault.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

function token(payload: unknown, key = privateKey): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(null, Buffer.from(body), key).toString('base64url')}`;
}

let home = '';
let fingerprint = '';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-guard-'));
  fingerprint = (await readMachine(home)).fingerprint;
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const guardWith = async (value: string | null) => {
  if (value) await writeLicenseToken(value, home);
  return licenseGuard({ home, publicKey });
};

describe('license guard', () => {
  it('allows an API request with a valid token', async () => {
    expect((await guardWith(token({ lid: 'a', fp: fingerprint, exp: null }))).allowed('/api/runs')).toBe(true);
    expect((await guardWith(token({ lid: 'a', fp: fingerprint, exp: Math.floor(Date.now() / 1000) + 60 }))).allowed('/api/runs')).toBe(true);
  });

  it('refuses a missing, forged, foreign or expired token', async () => {
    expect((await guardWith(null)).allowed('/api/runs')).toBe(false);
    expect((await guardWith(token({ lid: 'a', fp: fingerprint, exp: null }, other.privateKey))).allowed('/api/runs')).toBe(false);
    expect((await guardWith(token({ lid: 'a', fp: 'f'.repeat(64), exp: null }))).allowed('/api/runs')).toBe(false);
    expect((await guardWith(token({ lid: 'a', fp: fingerprint, exp: Math.floor(Date.now() / 1000) - 1 }))).allowed('/api/runs')).toBe(false);
  });

  it('keeps the license routes, the session and static files open', async () => {
    const guard = await guardWith(null);
    for (const open of ['/api/license', '/api/license/activate', '/api/license/sync', '/','/assets/app.js']) expect(guard.allowed(open)).toBe(true);
  });

  it('picks up a new token on reload', async () => {
    const guard = await guardWith(null);
    await writeLicenseToken(token({ lid: 'a', fp: fingerprint, exp: null }), home);
    await guard.reload();
    expect(guard.allowed('/api/runs')).toBe(true);
  });

  it('answers 403 and logs a denied request', async () => {
    const lines: string[] = [];
    const api = await startApi({ routes: [{ method: 'GET', path: '/api/runs', handler: async ({ json }) => json(200, {}) }], guard: await guardWith(null), log: (line) => lines.push(line) }, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/runs`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'license required' });
      expect(lines).toContain('license denied GET /api/runs');
    } finally {
      await api.close();
    }
  });
});
