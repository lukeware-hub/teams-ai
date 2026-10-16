import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { licenseRoutes } from '../../server/api/license-routes.js';
import { startApi } from '../../server/api/server.js';
import { licenseCodeFile, writeLicenseCode } from '../../server/license/vault.js';

const KEY = 'license-key-value';
const CODE = 'ab'.repeat(32);

let home = '';
let api: { port: number; close(): Promise<void> };
let service: http.Server;
let serviceUrl = '';
let authorize: { authorized: boolean } | { authorized: false; contactEmail: string; contactPhone: string } = { authorized: true };
const seen: unknown[] = [];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-license-'));
  await fs.mkdir(path.join(home, '.teams-ai', 'secrets'), { recursive: true });
  await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), '{}\n');
  seen.length = 0;
  authorize = { authorized: true };
  service = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown);
      const body = req.url === '/api/v1/activate' ? { codeHash: CODE } : authorize;
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
  api = await startApi({ routes: licenseRoutes({ home, serviceUrl }) }, 0);
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
    expect(seen[0]).toEqual({ keyHash: createHash('sha256').update(KEY).digest('hex') });
    expect(JSON.stringify(seen)).not.toContain(KEY);
    const codeFile = licenseCodeFile(home);
    expect((await fs.readFile(codeFile, 'utf8')).trim()).toBe(CODE);
    if (process.platform !== 'win32') {
      expect((await fs.stat(codeFile)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(codeFile))).mode & 0o777).toBe(0o700);
    }
    expect(await fs.readFile(path.join(home, '.teams-ai', 'config.json'), 'utf8')).toBe('{}\n');
    expect(await fs.readdir(path.join(home, '.teams-ai', 'secrets'))).toEqual([]);
    expect((await post(`${base()}/api/license/activate`, { key: KEY })).status).toBe(409);
    expect((await (await fetch(`${base()}/api/license`)).json())).toEqual({ state: 'authorized' });
  });

  it('reports a revoked license with the Lukeware contacts', async () => {
    authorize = { authorized: false, contactEmail: 'admin@lukeware.com', contactPhone: '+55 11 0000-0000' };
    await writeLicenseCode(CODE, home);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'revoked', contactEmail: 'admin@lukeware.com', contactPhone: '+55 11 0000-0000' });
  });

  it('reports unavailable when the license service does not answer', async () => {
    await api.close();
    await writeLicenseCode(CODE, home);
    api = await startApi({ routes: licenseRoutes({ home, serviceUrl: 'http://127.0.0.1:1' }) }, 0);
    expect(await (await fetch(`${base()}/api/license`)).json()).toEqual({ state: 'unavailable' });
  });
});
