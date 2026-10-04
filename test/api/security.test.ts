import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedHost, startApi, type Route } from '../../server/api/server.js';
import { isPrivateAddress, parseAllowedHosts, refuseCloneHost } from '../../server/api/security.js';

const routes: Route[] = [
  { method: 'GET', path: '/api/ping', handler: async ({ json }) => json(200, { ok: true }) },
  { method: 'POST', path: '/api/ping', handler: async ({ body, json }) => json(200, { got: await body() }) },
  {
    method: 'GET',
    path: '/api/stream',
    handler: async ({ sse }) => {
      const w = sse();
      w.send('hello', {});
    },
  },
];
let api: { port: number; close(): Promise<void> } | null = null;
let tmp = '';
afterEach(async () => {
  await api?.close();
  api = null;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = '';
});
const url = (p: string) => `http://127.0.0.1:${api!.port}${p}`;
const JSON_CT = { 'content-type': 'application/json' };

/** Raw request, so headers such as Host and Origin can be set freely. */
function raw(port: number, headers: Record<string, string>, method = 'GET', pathName = '/api/ping', body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('CSRF and framing (audit H2)', () => {
  it('rejects a state-changing request that is not application/json', async () => {
    api = await startApi({ routes, host: '127.0.0.1' }, 0);
    const form = await fetch(url('/api/ping'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"a":1}' });
    expect(form.status).toBe(415);
    expect((await fetch(url('/api/ping'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status).toBe(415);
    expect((await fetch(url('/api/ping'), { method: 'POST' })).status).toBe(415);
    const ok = await fetch(url('/api/ping'), { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"a":1}' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ got: { a: 1 } });
    expect((await fetch(url('/api/ping'))).status).toBe(200);
  });

  it('refuses a cross-site browser request without a bearer, by Sec-Fetch-Site or by Origin', async () => {
    api = await startApi({ routes, host: '127.0.0.1' }, 0);
    const host = `127.0.0.1:${api.port}`;
    const post = (extra: Record<string, string>) => raw(api!.port, { host, ...JSON_CT, ...extra }, 'POST', '/api/ping', '{}');
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ origin: 'null' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await post({ origin: `http://${host}` })).status).toBe(200);
    expect((await post({})).status).toBe(200);
    expect((await raw(api.port, { host, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('lets a bearer-authenticated request through regardless of Origin (a page cannot attach the bearer)', async () => {
    api = await startApi({ routes, token: 's3cret', host: '127.0.0.1' }, 0);
    const host = `127.0.0.1:${api.port}`;
    const r = await raw(api.port, { host, authorization: 'Bearer s3cret', origin: 'https://other.example', ...JSON_CT }, 'POST', '/api/ping', '{}');
    expect(r.status).toBe(200);
  });

  it('sends frame, nosniff, referrer and CSP headers on API, 404 and static responses (audit L3)', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-sec-'));
    await fs.mkdir(path.join(tmp, 'dist'));
    await fs.writeFile(path.join(tmp, 'dist', 'index.html'), '<!doctype html>');
    api = await startApi({ routes, host: '127.0.0.1', staticDir: path.join(tmp, 'dist') }, 0);
    for (const p of ['/api/ping', '/api/missing', '/', '/index.html']) {
      const r = await fetch(url(p));
      expect(r.headers.get('x-frame-options'), p).toBe('DENY');
      expect(r.headers.get('x-content-type-options'), p).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), p).toBe('no-referrer');
      expect(r.headers.get('content-security-policy'), p).toMatch(/frame-ancestors 'none'/);
      expect(r.headers.get('content-security-policy'), p).toMatch(/default-src 'self'/);
    }
    const sse = await fetch(url('/api/stream'));
    expect(sse.headers.get('x-frame-options')).toBe('DENY');
    await sse.body?.cancel();
  });
});

describe('static serving (audit L2)', () => {
  it('does not serve a sibling directory that shares the prefix', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-sec-'));
    await fs.mkdir(path.join(tmp, 'dist'));
    await fs.mkdir(path.join(tmp, 'dist-secrets'));
    await fs.writeFile(path.join(tmp, 'dist', 'index.html'), 'app');
    await fs.writeFile(path.join(tmp, 'dist-secrets', 'x.js'), 'SECRET');
    api = await startApi({ routes, host: '127.0.0.1', staticDir: path.join(tmp, 'dist') }, 0);
    const r = await raw(api.port, { host: `127.0.0.1:${api.port}` }, 'GET', '/..%2Fdist-secrets/x.js');
    expect(r.text).not.toContain('SECRET');
    expect(await (await fetch(url('/'))).text()).toBe('app');
  });
});

describe('allowed hosts (plan 15)', () => {
  it('accepts configured Service names beside loopback and nothing else', async () => {
    expect(isAllowedHost('teams-ai.ns.svc:8787')).toBe(false);
    expect(isAllowedHost('teams-ai.ns.svc:8787', ['teams-ai.ns.svc'])).toBe(true);
    expect(isAllowedHost('Teams-AI.ns.svc', ['teams-ai.ns.svc'])).toBe(true);
    expect(isAllowedHost('teams.example:8443', ['teams.example:8443'])).toBe(true);
    expect(isAllowedHost('evil.example', ['teams-ai.ns.svc'])).toBe(false);
    expect(isAllowedHost('localhost:1', ['teams-ai.ns.svc'])).toBe(true);
    expect(parseAllowedHosts(' a.svc , B.example:80,,')).toEqual(['a.svc', 'b.example:80']);
    expect(parseAllowedHosts(undefined)).toEqual([]);
  });

  it('serves a Host given in the option or in TEAMS_AI_ALLOWED_HOSTS', async () => {
    api = await startApi({ routes, host: '127.0.0.1' }, 0);
    expect((await raw(api.port, { host: 'teams-ai.ns.svc' })).status).toBe(403);
    await api.close();
    api = await startApi({ routes, host: '127.0.0.1', allowedHosts: ['teams-ai.ns.svc'] }, 0);
    expect((await raw(api.port, { host: 'teams-ai.ns.svc:8787' })).status).toBe(200);
    expect((await raw(api.port, { host: 'other.svc' })).status).toBe(403);
    await api.close();
    process.env.TEAMS_AI_ALLOWED_HOSTS = 'a.svc, teams-ai.ns.svc';
    try {
      api = await startApi({ routes, host: '127.0.0.1' }, 0);
      expect((await raw(api.port, { host: 'teams-ai.ns.svc' })).status).toBe(200);
      expect((await raw(api.port, { host: 'b.svc' })).status).toBe(403);
    } finally {
      delete process.env.TEAMS_AI_ALLOWED_HOSTS;
    }
  });

  it('keeps token protection for a non-loopback Host', async () => {
    api = await startApi({ routes, token: 's3cret', host: '127.0.0.1', allowedHosts: ['teams-ai.ns.svc'] }, 0);
    expect((await raw(api.port, { host: 'teams-ai.ns.svc' })).status).toBe(401);
    expect((await raw(api.port, { host: 'teams-ai.ns.svc', authorization: 'Bearer s3cret' })).status).toBe(200);
  });
});

describe('SSE limits (audit M5)', () => {
  it('caps concurrent streams in total and frees a slot when one closes', async () => {
    api = await startApi({ routes, host: '127.0.0.1', maxSse: { total: 2, perAddress: 10 } }, 0);
    const a = await fetch(url('/api/stream'));
    const b = await fetch(url('/api/stream'));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const c = await fetch(url('/api/stream'));
    expect(c.status).toBe(503);
    await a.body?.cancel();
    let d = c;
    for (let i = 0; i < 50 && d.status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 20));
      d = await fetch(url('/api/stream'));
    }
    expect(d.status).toBe(200);
    await b.body?.cancel();
    await d.body?.cancel();
  });

  it('caps streams per remote address', async () => {
    api = await startApi({ routes, host: '127.0.0.1', maxSse: { total: 100, perAddress: 1 } }, 0);
    const a = await fetch(url('/api/stream'));
    expect(a.status).toBe(200);
    expect((await fetch(url('/api/stream'))).status).toBe(503);
    await a.body?.cancel();
  });
});

describe('clone host policy (audit M1)', () => {
  const never = async () => {
    throw new Error('no dns');
  };
  it('classifies private, loopback and link-local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '[::1]']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['140.82.112.3', '8.8.8.8', '172.32.0.1', '2606:50c0:8000::154']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('applies the allowlist first, then the private checks', async () => {
    expect(await refuseCloneHost('github.com', ['github.com'], async () => ['140.82.112.3'])).toBeNull();
    expect(await refuseCloneHost('GitHub.com', ['github.com'], never)).toBeNull();
    expect(await refuseCloneHost('example.com', ['github.com'], never)).toMatch(/lista permitida/);
    expect(await refuseCloneHost('127.0.0.1', ['127.0.0.1'], never)).toMatch(/interno/);
    expect(await refuseCloneHost('[::1]', ['::1'], never)).toMatch(/interno/);
    expect(await refuseCloneHost('localhost', ['localhost'], never)).toMatch(/interno/);
    expect(await refuseCloneHost('git.team.svc.cluster.local', ['git.team.svc.cluster.local'], never)).toMatch(/interno/);
    expect(await refuseCloneHost('github.com', ['github.com'], async () => ['140.82.112.3', '10.0.0.9'])).toMatch(/interno/);
  });
});
