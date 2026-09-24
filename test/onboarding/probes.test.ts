import { describe, expect, it } from 'vitest';
import { claudeStatus, ghOwner, ghStatus, ghToken, openrouterKey } from '../../server/onboarding/probes.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const KEY = 'sk-or-v1-' + 'ab'.repeat(32);
const TOKEN = 'ghp_' + 'c'.repeat(36);
const noFetch = (async () => { throw new Error('no network'); }) as typeof fetch;

describe('probes', () => {
  it('claude: loggedIn true → ok with email and plan; false or bad json → red', async () => {
    const good = new FakeExec().onArgs('claude', ['auth', 'status'], () => ({ stdout: JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' }) }));
    expect(await claudeStatus({ exec: good.exec, fetch: noFetch })).toEqual({ ok: true, detail: 'a@b.c (max)' });
    expect(good.calls[0]!.args).toEqual(['auth', 'status', '--json']);
    const out = new FakeExec().onArgs('claude', ['auth', 'status'], () => ({ stdout: JSON.stringify({ loggedIn: false }) }));
    expect((await claudeStatus({ exec: out.exec, fetch: noFetch })).ok).toBe(false);
    const missing = new FakeExec().on((s) => s.bin === 'claude', () => ({ exitCode: 127, stderr: 'claude: not found' }));
    expect(await claudeStatus({ exec: missing.exec, fetch: noFetch })).toMatchObject({ ok: false, detail: expect.stringContaining('not found') });
  });

  it('gh: parses the logged-in account from auth status', async () => {
    const good = new FakeExec().onArgs('gh', ['auth', 'status'], () => ({ stderr: 'github.com\n  ✓ Logged in to github.com account lukeware70X7 (/home/u/.config/gh/hosts.yml)\n' }));
    expect(await ghStatus({ exec: good.exec, fetch: noFetch })).toEqual({ ok: true, detail: 'lukeware70X7' });
    const bad = new FakeExec().onArgs('gh', ['auth', 'status'], () => ({ exitCode: 1, stderr: 'You are not logged into any GitHub hosts.' }));
    expect(await ghStatus({ exec: bad.exec, fetch: noFetch })).toMatchObject({ ok: false, detail: expect.stringContaining('not logged') });
  });

  it('owner: tries users/<owner> then orgs/<owner>, with GH_TOKEN only when given', async () => {
    const org = new FakeExec()
      .onArgs('gh', ['api', 'users/labsitio'], () => ({ exitCode: 1, stderr: 'Not Found (HTTP 404)' }))
      .onArgs('gh', ['api', 'orgs/labsitio'], () => ({ stdout: JSON.stringify({ login: 'labsitio', type: 'Organization' }) }));
    expect(await ghOwner({ exec: org.exec, fetch: noFetch }, 'labsitio', TOKEN)).toEqual({ ok: true, detail: 'labsitio (Organization)' });
    expect(org.calls.every((c) => c.env?.GH_TOKEN === TOKEN)).toBe(true);
    const user = new FakeExec().onArgs('gh', ['api', 'users/diego'], () => ({ stdout: JSON.stringify({ login: 'diego', type: 'User' }) }));
    expect(await ghOwner({ exec: user.exec, fetch: noFetch }, 'diego', null)).toEqual({ ok: true, detail: 'diego (User)' });
    expect(user.calls[0]!.env?.GH_TOKEN).toBeUndefined();
  });

  it('token: reports the login and scopes, passes the token only through GH_TOKEN, redacts it from errors', async () => {
    const good = new FakeExec().onArgs('gh', ['api', 'user'], () => ({ stdout: `HTTP/2.0 200 OK\nX-Oauth-Scopes: repo, read:org\n\n${JSON.stringify({ login: 'diego-dm-morais' })}` }));
    expect(await ghToken({ exec: good.exec, fetch: noFetch }, TOKEN)).toEqual({ ok: true, detail: 'diego-dm-morais · scopes: repo, read:org' });
    expect(good.calls[0]!.env).toMatchObject({ GH_TOKEN: TOKEN });
    expect(good.calls[0]!.args).not.toContain(TOKEN);
    const bad = new FakeExec().onArgs('gh', ['api', 'user'], () => ({ exitCode: 1, stderr: `HTTP 401: Bad credentials for ${TOKEN}` }));
    const r = await ghToken({ exec: bad.exec, fetch: noFetch }, TOKEN);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
    expect(r.detail).not.toContain(TOKEN);
  });

  it('openrouter: one noul through Jev; ok reports model and cost, a 401 is red without the key', async () => {
    const ok = (async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13-20260917', answers: { probe: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 40, output_tokens: 2, cost: 0.0000017 } }), { status: 200 })) as typeof fetch;
    expect(await openrouterKey({ exec: new FakeExec().exec, fetch: ok }, KEY)).toEqual({ ok: true, detail: 'typesafe/jev-1.13-20260917 · $0.0000017' });
    const unauthorized = (async () => new Response(`invalid key ${KEY}`, { status: 401 })) as typeof fetch;
    const r = await openrouterKey({ exec: new FakeExec().exec, fetch: unauthorized }, KEY);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
    expect(r.detail).not.toContain(KEY);
  });
});
