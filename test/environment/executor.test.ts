import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvironmentVariable } from '../../server/agents/outputs.js';
import { applyRecipes, mintValues, type MintRecipe } from '../../server/environment/executor.js';

const dir = () => mkdtemp(path.join(os.tmpdir(), 'teams-ai-env-'));
const base = { scope: 'both' as const, reason: 'lido no compose' };
const fixed = (n: number) => Buffer.alloc(n, 0xab);

describe('applyRecipes', () => {
  it('creates a random credential once, shaped as asked, in a 0600 file', async () => {
    const secretsDir = await dir();
    const vars: EnvironmentVariable[] = [{ ...base, name: 'PLATFORM_ADMIN_TOKEN', strategy: 'random', minLength: 40 }];
    const r = await applyRecipes(vars, { secretsDir, held: {}, serviceEnv: async () => null });
    expect(r.values.PLATFORM_ADMIN_TOKEN).toHaveLength(40);
    expect(r.applied).toEqual([{ name: 'PLATFORM_ADMIN_TOKEN', scope: 'both', strategy: 'random', outcome: 'created' }]);
    expect((await readFile(path.join(secretsDir, 'PLATFORM_ADMIN_TOKEN'), 'utf8')).trim()).toBe(r.values.PLATFORM_ADMIN_TOKEN);
    expect((await stat(path.join(secretsDir, 'PLATFORM_ADMIN_TOKEN'))).mode & 0o777).toBe(0o600);
  });

  it('keeps a value that already exists, whatever the recipe says', async () => {
    const secretsDir = await dir();
    const r = await applyRecipes([{ ...base, name: 'LLM_API_KEY', strategy: 'fake', prefix: 'sk-local-' }], { secretsDir, held: { LLM_API_KEY: 'the-real-one' }, serviceEnv: async () => null });
    expect(r.values.LLM_API_KEY).toBe('the-real-one');
    expect(r.applied[0]!.outcome).toBe('kept');
    await expect(stat(path.join(secretsDir, 'LLM_API_KEY'))).rejects.toThrow();
  });

  it('makes a fake third-party key with the prefix and at least the length asked', async () => {
    const r = await applyRecipes([{ ...base, name: 'HEALTH_PLAN_API_TOKEN', strategy: 'fake', prefix: 'hp_live_', minLength: 24 }], { secretsDir: await dir(), held: {}, serviceEnv: async () => null, random: fixed });
    expect(r.values.HEALTH_PLAN_API_TOKEN).toBe(`hp_live_${'ab'.repeat(12)}`);
  });

  it('copies the value a deployed service runs with, and falls back to a random one when it is not there', async () => {
    const asked: string[] = [];
    const serviceEnv = async (service: string, variable: string) => (asked.push(`${service}:${variable}`), service === 'identity-service' ? 'running-value' : null);
    const vars: EnvironmentVariable[] = [
      { ...base, name: 'PLATFORM_ADMIN_TOKEN', strategy: 'from-service', service: 'identity-service', variable: 'PLATFORM_ADMIN_TOKEN' },
      { ...base, name: 'OTHER_TOKEN', strategy: 'from-service', service: 'audit-service', variable: 'OTHER_TOKEN' },
    ];
    const r = await applyRecipes(vars, { secretsDir: await dir(), held: {}, serviceEnv });
    expect(r.values.PLATFORM_ADMIN_TOKEN).toBe('running-value');
    expect(r.values.OTHER_TOKEN).toHaveLength(32);
    expect(r.applied.map((a) => a.outcome)).toEqual(['created', 'fallback']);
    expect(asked).toEqual(['identity-service:PLATFORM_ADMIN_TOKEN', 'audit-service:OTHER_TOKEN']);
  });

  it('copies only the variable of the same name, never another variable of a service relabelled', async () => {
    const asked: string[] = [];
    const vars: EnvironmentVariable[] = [{ ...base, name: 'IDENTITY_TOKEN', strategy: 'from-service', service: 'identity-service', variable: 'OPENROUTER_API_KEY' }];
    const r = await applyRecipes(vars, { secretsDir: await dir(), held: {}, serviceEnv: async (s, v) => (asked.push(`${s}:${v}`), 'would-leak') });
    expect(asked).toEqual([]);
    expect(r.values.IDENTITY_TOKEN).not.toBe('would-leak');
    expect(r.applied[0]!.outcome).toBe('fallback');
  });

  it('defers a mint recipe to after the deploy and lists a variable once', async () => {
    const mint: EnvironmentVariable = { ...base, scope: 'suites', name: 'E2E_AUTHORIZATION', strategy: 'mint', service: 'identity-service', request: { method: 'POST', path: '/v1/sessions' }, extract: { from: 'json', path: 'token' } };
    const r = await applyRecipes([mint, mint, { ...base, name: 'A_KEY', strategy: 'random' }, { ...base, name: 'A_KEY', strategy: 'random' }], { secretsDir: await dir(), held: {}, serviceEnv: async () => null });
    expect(r.mints).toEqual([mint]);
    expect(r.applied.map((a) => `${a.name}:${a.outcome}`)).toEqual(['E2E_AUTHORIZATION:deferred', 'A_KEY:created']);
  });
});

describe('mintValues', () => {
  const recipe = (over: Partial<MintRecipe> = {}): MintRecipe => ({
    name: 'E2E_AUTHORIZATION', scope: 'suites', reason: 'sessão do ator', strategy: 'mint', service: 'identity-service',
    request: { method: 'POST', path: '/v1/sessions', headers: { authorization: 'Bearer ${PLATFORM_ADMIN_TOKEN}', 'content-type': 'application/json' }, body: '{"actor":"doctor"}' },
    extract: { from: 'json', path: 'session.token' }, template: 'Bearer {value}', ...over,
  });
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

  it('calls the deployed service with the admin token in the header and takes the value out of the answer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: URL, init: RequestInit) => (calls.push({ url: String(url), init }), json({ session: { token: 'abc123' } }))) as unknown as typeof globalThis.fetch;
    const r = await mintValues([recipe()], { urls: { 'identity-service': 'http://identity-service:20092' }, secrets: { PLATFORM_ADMIN_TOKEN: 'admin-secret' }, fetch });
    expect(r).toEqual({ values: { E2E_AUTHORIZATION: 'Bearer abc123' }, failed: [] });
    expect(calls[0]!.url).toBe('http://identity-service:20092/v1/sessions');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer admin-secret' });
    expect(calls[0]!.init.body).toBe('{"actor":"doctor"}');
  });

  it('takes the value from a response header, and lets a later recipe use an earlier value', async () => {
    const fetch = (async (_u: URL, init: RequestInit) => (init.method === 'GET' ? new Response('', { headers: { 'x-session': 'hdr-1' } }) : json({ token: 'tok' }))) as unknown as typeof globalThis.fetch;
    const first = recipe({ name: 'TENANT_TOKEN', request: { method: 'POST', path: '/t' }, extract: { from: 'json', path: 'token' }, template: undefined });
    const second = recipe({ name: 'ACTOR_SESSION', request: { method: 'GET', path: '/s', headers: { authorization: '${TENANT_TOKEN}' } }, extract: { from: 'header', path: 'x-session' }, template: undefined });
    const r = await mintValues([first, second], { urls: { 'identity-service': 'http://identity-service:1' }, secrets: {}, fetch });
    expect(r.values).toEqual({ TENANT_TOKEN: 'tok', ACTOR_SESSION: 'hdr-1' });
  });

  it('refuses a service the project does not run, a path that leaves it, and a variable that does not exist', async () => {
    const never = (async () => { throw new Error('must not be called'); }) as unknown as typeof globalThis.fetch;
    const urls = { 'identity-service': 'http://identity-service:1' };
    const r = await mintValues([recipe({ service: 'unknown-service' }), recipe({ name: 'B_ONE', request: { method: 'GET', path: '//evil.example/x' } }), recipe({ name: 'C_TWO' })], { urls, secrets: {}, fetch: never });
    expect(r.values).toEqual({});
    expect(r.failed.map((f) => f.reason)).toEqual(['service unknown-service is not deployed', 'path //evil.example/x leaves the service', '${PLATFORM_ADMIN_TOKEN} does not exist']);
  });

  it('never follows a redirect, and takes a secret outside the ones it was given as missing', async () => {
    const seen: RequestInit[] = [];
    const fetch = (async (_u: URL, init: RequestInit) => (seen.push(init), new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } }))) as unknown as typeof globalThis.fetch;
    const urls = { 'identity-service': 'http://identity-service:1' };
    const r = await mintValues([recipe()], { urls, secrets: { PLATFORM_ADMIN_TOKEN: 'a' }, fetch });
    expect(seen[0]!.redirect).toBe('manual');
    expect(r.failed[0]!.reason).toContain('answered 302');
    const stolen = await mintValues([recipe({ request: { method: 'GET', path: '/x', headers: { authorization: 'Bearer ${GITHUB_TOKEN}' } } })], { urls, secrets: { PLATFORM_ADMIN_TOKEN: 'a' }, fetch });
    expect(stolen.failed[0]!.reason).toBe('${GITHUB_TOKEN} does not exist');
  });

  it('reports a failed call and never repeats a secret in the reason', async () => {
    const fetch = (async () => new Response('no', { status: 403 })) as unknown as typeof globalThis.fetch;
    const r = await mintValues([recipe({ request: { method: 'GET', path: '/x?token=admin-secret' } })], { urls: { 'identity-service': 'http://identity-service:1' }, secrets: { PLATFORM_ADMIN_TOKEN: 'admin-secret' }, fetch });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.reason).toContain('answered 403');
    expect(r.failed[0]!.reason).not.toContain('admin-secret');
  });
});
