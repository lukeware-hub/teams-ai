import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { licenseGuard } from '../../server/api/license-guard.js';
import { licenseRoutes } from '../../server/api/license-routes.js';
import { startApi } from '../../server/api/server.js';
import { readMachine } from '../../server/license/machine.js';
import { verifyLicenseToken } from '../../server/license/token.js';
import { licenseCodeFile, licenseTokenFile, writeLicenseCode, writeLicenseToken } from '../../server/license/vault.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const KEY = 'license-key-value';
const CODE = 'ab'.repeat(32);
const FOREIGN = 'payload.signature';

function signed(fingerprint: string): string {
  const body = Buffer.from(JSON.stringify({ lid: 'lic', fp: fingerprint, exp: null })).toString('base64url');
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}

let home = '';
let api: { port: number; close(): Promise<void> };
let service: http.Server;
let serviceUrl = '';
let authorize: { authorized: boolean; reason?: string; contactEmail?: string; contactPhone?: string } = { authorized: true };
let foreign = false;
let boundElsewhere = false;
let changes = 0;
const seen: unknown[] = [];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-license-'));
  await fs.mkdir(path.join(home, '.teams-ai', 'secrets'), { recursive: true });
  await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), '{}\n');
  seen.length = 0;
  changes = 0;
  foreign = false;
  boundElsewhere = false;
  authorize = { authorized: true };
  service = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { fingerprint?: string; machine?: { fingerprint?: string } };
      seen.push(parsed);
      const fingerprint = foreign ? 'f'.repeat(64) : parsed.machine?.fingerprint ?? parsed.fingerprint ?? '';
      if (req.url === '/api/v1/activate' && boundElsewhere) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'license is bound to another machine' }));
        return;
      }
      const body = req.url === '/api/v1/activate' ? { codeHash: CODE, token: signed(fingerprint) } : authorize.authorized ? { ...authorize, token: signed(fingerprint) } : authorize;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  serviceUrl = await new Promise<string>((resolve) => {
    service.listen(0, '127.0.0.1', () => {
      const address = service.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
    });
  });
  api = await startApi({ routes: licenseRoutes({ home, serviceUrl, publicKey, onChange: async () => void changes++ }) }, 0);
});

afterEach(async () => {
  await api.close();
  await new Promise<void>((resolve) => service.close(() => resolve()));
  await fs.rm(home, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${api.port}`;
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('license routes', () => {
  it('stores only the code hash in the vault and never the license key', async () => {
    expect((await (await fetch(`${base()}/api/license`)).json())).toEqual({ state: 'missing' });
    const activated = await post(`${base()}/api/license/activate`, { key: KEY });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({ state: 'authorized' });
    expect(seen[0]).toMatchObject({ keyHash: createHash('sha256').update(KEY).digest('hex'), machine: { fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), hostname: expect.any(String) } });
    expect(JSON.stringify(seen)).not.toContain(KEY);
    const codeFile = licenseCodeFile(home);
    expect((await fs.readFile(codeFile, 'utf8')).trim()).toBe(CODE);
    expect(verifyLicenseToken((await fs.readFile(licenseTokenFile(home), 'utf8')).trim(), (await readMachine(home)).fingerprint, Date.now(), publicKey)).toBe(true);
    expect(changes).toBe(1);
    if (process.platform !== 'win32') {
      expect((await fs.stat(codeFile)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(codeFile))).mode & 0o777).toBe(0o700);
    }
    expect(await fs.readFile(path.join(home, '.teams-ai', 'config.json'), 'utf8')).toBe('{}\n');
    expect(await fs.readdir(path.join(home, '.teams-ai', 'secrets'))).toEqual([]);
    expect((await post(`${base()}/api/license/activate`, { key: KEY })).status).toBe(409);
    expect((await (await fetch(`${base()}/api/license`)).json())).toEqual({ state: 'authorized' });
  });

  it('asks for a new key when the license no longer exists', async () => {
    authorize = { authorized: false, reason: 'unknown', contactEmail: 'admin@lukeware.com', contactPhone: '+55 11 0000-0000' };
    await writeLicenseCode(CODE, home);
    await writeLicenseToken(FOREIGN, home);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'missing' });
    await expect(fs.readFile(licenseCodeFile(home), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(licenseTokenFile(home), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await post(`${base()}/api/license/activate`, { key: 'replacement-key' })).status).toBe(200);
  });

  it('refuses a license bound to another computer and keeps the local code', async () => {
    authorize = { authorized: false, reason: 'machine' };
    await writeLicenseCode(CODE, home);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'other-machine' });
    expect((await fs.readFile(licenseCodeFile(home), 'utf8')).trim()).toBe(CODE);
  });

  it('reports a revoked license with the Lukeware contacts', async () => {
    authorize = { authorized: false, contactEmail: 'admin@lukeware.com', contactPhone: '+55 11 0000-0000' };
    await writeLicenseCode(CODE, home);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'revoked', contactEmail: 'admin@lukeware.com', contactPhone: '+55 11 0000-0000' });
  });

  it('reports unavailable when the license service does not answer', async () => {
    await api.close();
    await writeLicenseCode(CODE, home);
    await writeLicenseToken(FOREIGN, home);
    api = await startApi({ routes: licenseRoutes({ home, serviceUrl: 'http://127.0.0.1:1', publicKey }) }, 0);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'unavailable' });
    expect((await fs.readFile(licenseTokenFile(home), 'utf8')).trim()).toBe(FOREIGN);
  });

  it('saves the token of an authorized license activated before tokens existed', async () => {
    await writeLicenseCode(CODE, home);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'authorized' });
    expect(verifyLicenseToken((await fs.readFile(licenseTokenFile(home), 'utf8')).trim(), (await readMachine(home)).fingerprint, Date.now(), publicKey)).toBe(true);
    expect(changes).toBe(1);
  });

  it('reports authorized from the same token the guard accepts, without calling the license service', async () => {
    await api.close();
    const fingerprint = (await readMachine(home)).fingerprint;
    await writeLicenseToken(signed(fingerprint), home);
    const guard = await licenseGuard({ home, publicKey });
    api = await startApi({
      guard,
      routes: [
        ...licenseRoutes({ home, serviceUrl, publicKey }),
        { method: 'GET', path: '/api/runs', handler: async ({ json }) => json(200, { ok: true }) },
      ],
    }, 0);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'authorized' });
    expect(seen).toEqual([]);
    expect((await fetch(`${base()}/api/runs`)).status).toBe(200);
  });

  it('refuses a key already bound to another computer', async () => {
    boundElsewhere = true;
    const denied = await post(`${base()}/api/license/activate`, { key: KEY });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: 'Esta chave já está em uso em outro computador.' });
    await expect(fs.readFile(licenseCodeFile(home), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drops a deleted license on sync and blocks the next request', async () => {
    await api.close();
    const fingerprint = (await readMachine(home)).fingerprint;
    await writeLicenseCode(CODE, home);
    await writeLicenseToken(signed(fingerprint), home);
    authorize = { authorized: false, reason: 'unknown' };
    const guard = await licenseGuard({ home, publicKey });
    api = await startApi({
      guard,
      routes: [
        ...licenseRoutes({ home, serviceUrl, publicKey, onChange: guard.reload }),
        { method: 'GET', path: '/api/runs', handler: async ({ json }) => json(200, { ok: true }) },
      ],
    }, 0);
    expect(await (await post(`${base()}/api/license/sync`, {})).json()).toEqual({ state: 'missing' });
    await expect(fs.readFile(licenseCodeFile(home), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(licenseTokenFile(home), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fetch(`${base()}/api/runs`)).status).toBe(403);
  });

  it('opens again when sync finds the license enabled', async () => {
    await api.close();
    await writeLicenseCode(CODE, home);
    const guard = await licenseGuard({ home, publicKey });
    api = await startApi({
      guard,
      routes: [
        ...licenseRoutes({ home, serviceUrl, publicKey, onChange: guard.reload }),
        { method: 'GET', path: '/api/runs', handler: async ({ json }) => json(200, { ok: true }) },
      ],
    }, 0);
    expect((await fetch(`${base()}/api/runs`)).status).toBe(403);
    expect(await (await post(`${base()}/api/license/sync`, {})).json()).toEqual({ state: 'authorized' });
    expect(verifyLicenseToken((await fs.readFile(licenseTokenFile(home), 'utf8')).trim(), (await readMachine(home)).fingerprint, Date.now(), publicKey)).toBe(true);
    expect((await fetch(`${base()}/api/runs`)).status).toBe(200);
  });

  it('keeps a valid token when sync cannot reach the license service', async () => {
    await api.close();
    const fingerprint = (await readMachine(home)).fingerprint;
    await writeLicenseCode(CODE, home);
    await writeLicenseToken(signed(fingerprint), home);
    const guard = await licenseGuard({ home, publicKey });
    api = await startApi({
      guard,
      routes: [
        ...licenseRoutes({ home, serviceUrl: 'http://127.0.0.1:1', publicKey, onChange: guard.reload }),
        { method: 'GET', path: '/api/runs', handler: async ({ json }) => json(200, { ok: true }) },
      ],
    }, 0);
    expect(await (await post(`${base()}/api/license/sync`, {})).json()).toEqual({ state: 'authorized' });
    expect((await fs.readFile(licenseTokenFile(home), 'utf8')).trim()).toBe(signed(fingerprint));
    expect((await fetch(`${base()}/api/runs`)).status).toBe(200);
  });

  it('rejects a token the guard would reject and keeps the screen unlicensed', async () => {
    foreign = true;
    expect((await post(`${base()}/api/license/activate`, { key: KEY })).status).toBe(502);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'missing' });
    await expect(fs.readFile(licenseTokenFile(home), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
