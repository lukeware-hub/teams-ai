import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackHost, tokenEquals } from '../../server/api/auth.js';
import { startApi, type Route } from '../../server/api/server.js';

const routes: Route[] = [
  { method: 'GET', path: '/api/ping', handler: async ({ json }) => json(200, { ok: true }) },
  { method: 'POST', path: '/api/ping', handler: async ({ json }) => json(200, { ok: true }) },
];
let api: { port: number; close(): Promise<void> } | null = null;
afterEach(async () => {
  await api?.close();
  api = null;
});
const url = (p: string) => `http://127.0.0.1:${api!.port}${p}`;

describe('api bearer auth', () => {
  it('compares tokens', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true);
    expect(tokenEquals('abc', 'abd')).toBe(false);
    expect(tokenEquals('', 'abc')).toBe(false);
    expect(isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
  it('rejects /api without a valid bearer and accepts the right one', async () => {
    api = await startApi({ routes, token: 's3cret', host: '127.0.0.1' }, 0);
    const none = await fetch(url('/api/ping'));
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'unauthorized' });
    expect((await fetch(url('/api/ping'), { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await fetch(url('/api/ping'), { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200);
  });
  it('trades the bearer for a cookie that authorizes GET only', async () => {
    api = await startApi({ routes, token: 's3cret', host: '127.0.0.1' }, 0);
    expect((await fetch(url('/api/auth/session'), { method: 'POST' })).status).toBe(401);
    const s = await fetch(url('/api/auth/session'), { method: 'POST', headers: { authorization: 'Bearer s3cret' } });
    expect(s.status).toBe(204);
    const setCookie = s.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    expect((await fetch(url('/api/ping'), { headers: { cookie } })).status).toBe(200);
    expect((await fetch(url('/api/ping'), { method: 'POST', headers: { cookie } })).status).toBe(401);
  });
  it('refuses to start on a non-loopback host without a token', async () => {
    await expect(startApi({ routes, token: '', host: '0.0.0.0' }, 0)).rejects.toThrow(/TEAMS_AI_UI_TOKEN/);
  });
  it('opts out on loopback without a token, with a warning', async () => {
    const lines: string[] = [];
    const saved = process.env.TEAMS_AI_UI_TOKEN;
    delete process.env.TEAMS_AI_UI_TOKEN;
    try {
      api = await startApi({ routes, host: '127.0.0.1', log: (l) => lines.push(l) }, 0);
    } finally {
      if (saved !== undefined) process.env.TEAMS_AI_UI_TOKEN = saved;
    }
    expect((await fetch(url('/api/ping'))).status).toBe(200);
    expect(lines.some((l) => /unauthenticated/.test(l))).toBe(true);
  });
});
