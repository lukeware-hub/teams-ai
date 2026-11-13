import { describe, expect, it } from 'vitest';
import type { EnvironmentVariable } from '../../server/agents/outputs.js';
import { issueTokens, issuerUrl, keycloakContainer, realmsFrom, subjectOf, type PlatformHttp, type TokenRecipe } from '../../server/environment/keycloak.js';

const base = { scope: 'suites' as const, reason: 'lido no e2e' };
const maker: TokenRecipe = { ...base, name: 'E2E_MAKER_TOKEN', strategy: 'oidc-token', realm: 'kayron', audience: 'policy-registry-api', username: 'maker', roles: ['GOV-POL'], claims: { tenant_id: '11111111-1111-4111-8111-111111111111' }, template: 'Bearer {value}' };
const checker: TokenRecipe = { ...maker, name: 'E2E_CHECKER_TOKEN', username: 'checker', subject: '22222222-2222-4222-8222-222222222222', template: undefined };
const issuer: EnvironmentVariable = { ...base, name: 'OIDC_ISSUER_URL', strategy: 'oidc-issuer', realm: 'kayron', algorithm: 'ES256' };

function fakeKeycloak(realmExists: boolean) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const http: PlatformHttp = async (req) => {
    const path = new URL(req.url).pathname;
    calls.push({ method: req.method, path, ...(req.body === undefined ? {} : { body: req.body }) });
    if (path.endsWith('/protocol/openid-connect/token')) return { status: 200, body: JSON.stringify({ access_token: `jwt-of-${new URLSearchParams(req.body).get('username')}` }) };
    if (req.method === 'GET') return { status: realmExists ? 200 : 404, body: '' };
    return { status: 201, body: '' };
  };
  return { http, calls };
}

describe('keycloak container', () => {
  it('uses a fixed hostname so the issuer text is the same wherever a token is asked', () => {
    const c = keycloakContainer('pw');
    expect(c.name).toBe('platform-keycloak');
    expect(c.environment).toMatchObject({ KC_HOSTNAME: 'http://platform-keycloak:8080', KC_BOOTSTRAP_ADMIN_PASSWORD: 'pw' });
    expect(issuerUrl('kayron')).toBe('http://platform-keycloak:8080/realms/kayron');
  });
});

describe('realmsFrom', () => {
  const [realm] = realmsFrom([issuer, maker, checker], { E2E_MAKER_TOKEN: 'p1', E2E_CHECKER_TOKEN: 'p2' }) as Array<Record<string, any>>;

  it('makes one realm that signs with ES256, with the roles, a fixed user id per actor and a client per actor', () => {
    expect(realm.realm).toBe('kayron');
    expect(realm.defaultSignatureAlgorithm).toBe('ES256');
    expect(realm.roles.realm).toEqual([{ name: 'GOV-POL' }]);
    expect(realm.users.map((u: any) => u.id)).toEqual([subjectOf(maker), '22222222-2222-4222-8222-222222222222']);
    expect(subjectOf(maker)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(realm.clients.map((c: any) => c.clientId)).toEqual(['e2e-maker', 'e2e-checker']);
    expect(realm.components['org.keycloak.keys.KeyProvider'].map((k: any) => k.providerId)).toContain('ecdsa-generated');
  });

  it('puts the audience, the roles claim and the fixed claims in the access token', () => {
    const mappers = realm.clients[0].protocolMappers as Array<{ protocolMapper: string; config: Record<string, string> }>;
    expect(mappers.find((m) => m.protocolMapper === 'oidc-audience-mapper')!.config['included.custom.audience']).toBe('policy-registry-api');
    expect(mappers.find((m) => m.protocolMapper === 'oidc-usermodel-realm-role-mapper')!.config['claim.name']).toBe('roles');
    expect(mappers.find((m) => m.config['claim.name'] === 'tenant_id')!.config['claim.value']).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('issueTokens', () => {
  const deps = (http: PlatformHttp) => ({ http, adminPassword: 'admin-pw', random: (n: number) => Buffer.alloc(n, 1), wait: async () => {} });

  it('creates a missing realm and asks one token per recipe, wrapped in its template', async () => {
    const { http, calls } = fakeKeycloak(false);
    const values = await issueTokens([issuer, maker, checker], deps(http));
    expect(values).toEqual({ E2E_MAKER_TOKEN: 'Bearer jwt-of-maker', E2E_CHECKER_TOKEN: 'jwt-of-checker' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /realms/master/protocol/openid-connect/token',
      'GET /admin/realms/kayron',
      'POST /admin/realms',
      'POST /realms/kayron/protocol/openid-connect/token',
      'POST /realms/kayron/protocol/openid-connect/token',
    ]);
  });

  it('keeps the keys of a realm that exists and overwrites its users, roles and clients', async () => {
    const { http, calls } = fakeKeycloak(true);
    await issueTokens([issuer, maker], deps(http));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(put.body!)).not.toHaveProperty('components');
    expect(JSON.parse(calls.find((c) => c.path.endsWith('/partialImport'))!.body!)).toMatchObject({ ifResourceExists: 'OVERWRITE' });
  });

  it('fails with Keycloak\'s own answer when a call is refused', async () => {
    await expect(issueTokens([issuer, maker], deps(async () => ({ status: 401, body: 'bad credentials' })))).rejects.toThrow('answered 401: bad credentials');
  });

  it('does not retry a refused call', async () => {
    let count = 0;
    await expect(issueTokens([issuer, maker], deps(async () => { count++; return { status: 401, body: 'no' }; }))).rejects.toThrow('401');
    expect(count).toBe(1);
  });

  it('retries a call that answered 5xx or threw, until it works', async () => {
    const { http } = fakeKeycloak(false);
    let first = 0;
    const flaky: PlatformHttp = async (req) => {
      if (first++ === 0) return { status: 503, body: '' };
      if (first === 2) throw new Error('connection refused');
      return http(req);
    };
    const values = await issueTokens([issuer, maker], deps(flaky));
    expect(values).toEqual({ E2E_MAKER_TOKEN: 'Bearer jwt-of-maker' });
  });

  it('gives up after three 5xx answers', async () => {
    let count = 0;
    await expect(issueTokens([issuer, maker], deps(async () => { count++; return { status: 503, body: 'starting' }; }))).rejects.toThrow('answered 503');
    expect(count).toBe(3);
  });
});

describe('one realm for the issuer and its tokens', () => {
  it('signs a token in the realm of the issuer even when the recipe names another one', async () => {
    const other: TokenRecipe = { ...maker, realm: 'policy-registry' };
    const paths: string[] = [];
    const http: PlatformHttp = async (req) => {
      const path = new URL(req.url).pathname;
      paths.push(path);
      if (path.endsWith('/protocol/openid-connect/token')) return { status: 200, body: JSON.stringify({ access_token: 'jwt' }) };
      return { status: req.method === 'GET' ? 404 : 201, body: '' };
    };
    await issueTokens([issuer, other], { http, adminPassword: 'pw', random: (n) => Buffer.alloc(n, 1) });
    expect(paths).toContain('/realms/kayron/protocol/openid-connect/token');
    expect(paths.some((p) => p.includes('policy-registry'))).toBe(false);
  });
});
