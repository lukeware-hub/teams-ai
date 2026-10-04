import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeSecret } from '../../server/core/secrets.js';
import { setGithubOwner } from '../../server/onboarding/config-store.js';
import { computeStatus, hint } from '../../server/onboarding/status.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const KEY = 'sk-or-v1-' + 'ab'.repeat(32);
const TOKEN = 'ghp_' + 'c'.repeat(36);
let home = '';
afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
  home = '';
});

describe('status', () => {
  it('hint never shows any character of the value', () => {
    expect(hint(KEY)).toBe('****');
    expect(hint('ab')).toBe('****');
  });

  it('is all red on a fresh host and never carries a secret value', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    const exec = new FakeExec().on(() => true, () => ({ exitCode: 1, stderr: 'not configured' }));
    const s = await computeStatus({ exec: exec.exec, fetch: (async () => new Response('', { status: 500 })) as typeof fetch, home, secretsDir: path.join(home, 'secrets') });
    expect(s.allOk).toBe(false);
    expect(Object.values(s.items).every((i) => i.ok === false)).toBe(true);
    expect(s.items.githubToken.secret).toEqual({ set: false, hint: '' });
    expect(s.items.githubOwner.detail).toContain('not set');
  });

  it('keeps the other items when one probe throws instead of answering', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    const red = new FakeExec().on(() => true, () => ({ exitCode: 1, stderr: 'not configured' }));
    const exec: typeof red.exec = (spec) => {
      if (spec.bin === 'claude') throw new Error('spawn claude EACCES'); // synchronous throw, not a rejected promise
      return red.exec(spec);
    };
    const s = await computeStatus({ exec, fetch: (async () => new Response('', { status: 500 })) as typeof fetch, home, secretsDir: path.join(home, 'secrets') });
    expect(s.items.claude).toEqual({ ok: false, detail: 'spawn claude EACCES' });
    expect(Object.keys(s.items)).toHaveLength(5);
    expect(s.items.githubOwner.detail).toContain('not set');
  });

  it('turns green when every probe answers and exposes hints, not values', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    const secretsDir = path.join(home, 'secrets');
    await writeSecret(secretsDir, 'GITHUB_TOKEN', TOKEN);
    await writeSecret(secretsDir, 'OPENROUTER_API_KEY', KEY);
    await setGithubOwner('diego-dm-morais', home);
    const exec = new FakeExec()
      .onArgs('claude', ['auth', 'status'], () => ({ stdout: JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' }) }))
      .onArgs('gh', ['auth', 'status'], () => ({ stderr: '✓ Logged in to github.com account lukeware70X7' }))
      .onArgs('gh', ['api', 'users/diego-dm-morais'], () => ({ stdout: JSON.stringify({ login: 'diego-dm-morais', type: 'User' }) }))
      .onArgs('gh', ['api', 'user'], () => ({ stdout: `HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n${JSON.stringify({ login: 'diego-dm-morais' })}` }));
    const okFetch = (async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { probe: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0.000001 } }), { status: 200 })) as typeof fetch;
    const s = await computeStatus({ exec: exec.exec, fetch: okFetch, home, secretsDir });
    expect(s.allOk).toBe(true);
    expect(s.items.githubToken.secret).toEqual({ set: true, hint: '****' });
    expect(s.items.openrouterKey.secret).toEqual({ set: true, hint: '****' });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
});
