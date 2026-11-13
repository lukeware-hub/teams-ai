import { createHash, randomBytes } from 'node:crypto';
import type { EnvironmentVariable } from '../agents/outputs.js';
import type { PlatformService } from '../contracts/project.js';
import type { PlatformRequest } from '../deploy/target.js';

export type IssuerRecipe = Extract<EnvironmentVariable, { strategy: 'oidc-issuer' }>;
export type TokenRecipe = Extract<EnvironmentVariable, { strategy: 'oidc-token' }>;

/** The name every service of the project reaches Keycloak by, on the shared network. */
export const KEYCLOAK_NAME = 'platform-keycloak';
const ORIGIN = `http://${KEYCLOAK_NAME}:8080`;
const ADMIN = 'admin';
/** The platform's own admin password: a reserved name, so no recipe can take it. */
export const KEYCLOAK_PASSWORD = 'TEAMS_AI_KEYCLOAK_PASSWORD';

/** The issuer URL a service checks a token against; Keycloak writes the same text in `iss`. */
export const issuerUrl = (realm: string) => `${ORIGIN}/realms/${realm}`;

export type PlatformHttp = (req: PlatformRequest) => Promise<{ status: number; body: string }>;

/** Keycloak in dev mode on the shared network; a fixed hostname keeps `iss` the same whoever asks for the token. */
export function keycloakContainer(adminPassword: string): PlatformService {
  return {
    name: KEYCLOAK_NAME,
    image: 'quay.io/keycloak/keycloak:26.0.7',
    command: ['start-dev'],
    environment: { KC_BOOTSTRAP_ADMIN_USERNAME: ADMIN, KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword, KC_HOSTNAME: ORIGIN, KC_HEALTH_ENABLED: 'true' },
    // The image has no curl: bash opens the management port itself.
    healthcheck: ['CMD-SHELL', `exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q '"UP"' <&3`],
  };
}

/** The user id a token carries in `sub`: the one the recipe gives, else a UUID fixed by realm and username. */
export function subjectOf(t: TokenRecipe): string {
  if (t.subject) return t.subject;
  const h = createHash('sha256').update(`${t.realm}/${t.username}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const clientId = (t: TokenRecipe) => `e2e-${t.username}`;
const accessClaim = (config: Record<string, string>) => ({ ...config, 'access.token.claim': 'true', 'id.token.claim': 'false', 'userinfo.token.claim': 'false' });

function client(t: TokenRecipe) {
  return {
    clientId: clientId(t),
    publicClient: true,
    directAccessGrantsEnabled: true,
    standardFlowEnabled: false,
    protocol: 'openid-connect',
    protocolMappers: [
      { name: 'audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: accessClaim({ 'included.custom.audience': t.audience }) },
      { name: 'roles', protocol: 'openid-connect', protocolMapper: 'oidc-usermodel-realm-role-mapper', config: accessClaim({ 'claim.name': 'roles', multivalued: 'true', 'jsonType.label': 'String' }) },
      ...Object.entries(t.claims ?? {}).map(([name, value]) => ({ name: `claim-${name}`, protocol: 'openid-connect', protocolMapper: 'oidc-hardcoded-claim-mapper', config: accessClaim({ 'claim.name': name, 'claim.value': value, 'jsonType.label': 'String' }) })),
    ],
  };
}

const keyProvider = (name: string, providerId: string, config: Record<string, string[]> = {}) => ({ name, providerId, config: { priority: ['100'], ...config } });

/** A token is signed in the realm of the project's one issuer: the issuer URL a service checks and the realm a token comes from can never differ. */
export function aligned(recipes: readonly EnvironmentVariable[]): EnvironmentVariable[] {
  const realms = [...new Set(recipes.filter((v): v is IssuerRecipe => v.strategy === 'oidc-issuer').map((i) => i.realm))];
  return realms.length === 1 ? recipes.map((v) => (v.strategy === 'oidc-token' ? { ...v, realm: realms[0]! } : v)) : [...recipes];
}

/** One realm per name the recipes use: its roles, a user and a client per token, and both RSA and P-256 keys so either algorithm signs. */
export function realmsFrom(recipes: readonly EnvironmentVariable[], passwords: Readonly<Record<string, string>>): Array<Record<string, unknown>> {
  const issuers = recipes.filter((v): v is IssuerRecipe => v.strategy === 'oidc-issuer');
  const tokens = recipes.filter((v): v is TokenRecipe => v.strategy === 'oidc-token');
  const names = [...new Set([...issuers.map((i) => i.realm), ...tokens.map((t) => t.realm)])];
  return names.map((realm) => {
    const own = tokens.filter((t) => t.realm === realm);
    return {
      realm,
      enabled: true,
      accessTokenLifespan: 3600,
      defaultSignatureAlgorithm: issuers.find((i) => i.realm === realm)?.algorithm ?? 'RS256',
      roles: { realm: [...new Set(own.flatMap((t) => t.roles))].map((name) => ({ name })) },
      users: own.map((t) => ({
        id: subjectOf(t),
        username: t.username,
        enabled: true,
        emailVerified: true,
        email: `${t.username}@e2e.test`,
        firstName: t.username,
        lastName: 'e2e',
        credentials: [{ type: 'password', value: passwords[t.name], temporary: false }],
        realmRoles: t.roles,
      })),
      clients: own.map(client),
      components: {
        'org.keycloak.keys.KeyProvider': [
          keyProvider('rsa', 'rsa-generated'),
          keyProvider('hmac', 'hmac-generated', { algorithm: ['HS512'] }),
          keyProvider('aes', 'aes-generated'),
          keyProvider('ecdsa', 'ecdsa-generated', { ecdsaEllipticCurveKey: ['P-256'] }),
        ],
      },
    };
  });
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const ATTEMPTS = 3;
const PAUSE_MS = 5000;

/** Retries a call that threw or answered 5xx, since a starting Keycloak refuses calls for a while. */
function retrying(http: PlatformHttp, wait: (ms: number) => Promise<void>): PlatformHttp {
  return async (req) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await http(req);
        if (res.status < 500 || attempt === ATTEMPTS) return res;
      } catch (error) {
        if (attempt === ATTEMPTS) throw error;
      }
      await wait(PAUSE_MS);
    }
  };
}

async function call(http: PlatformHttp, req: PlatformRequest, ok: (status: number) => boolean = (s) => s >= 200 && s < 300): Promise<{ status: number; body: string }> {
  const res = await http(req);
  if (!ok(res.status)) throw new Error(`keycloak ${req.method} ${new URL(req.url).pathname} answered ${res.status}: ${res.body.slice(0, 300)}`);
  return res;
}

async function accessToken(http: PlatformHttp, realm: string, fields: Record<string, string>): Promise<string> {
  const res = await call(http, { method: 'POST', url: `${issuerUrl(realm)}/protocol/openid-connect/token`, headers: FORM, body: form({ grant_type: 'password', ...fields }) });
  const token = (JSON.parse(res.body) as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || token === '') throw new Error(`keycloak gave no access token for realm ${realm}`);
  return token;
}

/**
 * Creates each realm the recipes name (an existing one keeps its keys, so a running service's cached key set still holds,
 * and gets its roles, users and clients overwritten), then asks a fresh access token for every token recipe.
 */
export async function issueTokens(all: readonly EnvironmentVariable[], deps: { http: PlatformHttp; adminPassword: string; random?: (bytes: number) => Buffer; wait?: (ms: number) => Promise<void> }): Promise<Record<string, string>> {
  const http = retrying(deps.http, deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
  const recipes = aligned(all);
  const tokens = recipes.filter((v): v is TokenRecipe => v.strategy === 'oidc-token');
  const random = deps.random ?? randomBytes;
  const passwords = Object.fromEntries(tokens.map((t) => [t.name, random(24).toString('base64url')]));
  const admin = await accessToken(http, 'master', { client_id: 'admin-cli', username: ADMIN, password: deps.adminPassword });
  const auth = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
  for (const realm of realmsFrom(recipes, passwords)) {
    const at = `${ORIGIN}/admin/realms/${String(realm.realm)}`;
    const found = await call(http, { method: 'GET', url: at, headers: auth }, (s) => s === 200 || s === 404);
    if (found.status === 404) {
      await call(http, { method: 'POST', url: `${ORIGIN}/admin/realms`, headers: auth, body: JSON.stringify(realm) });
      continue;
    }
    const { roles, users, clients, components: _keys, ...settings } = realm;
    await call(http, { method: 'PUT', url: at, headers: auth, body: JSON.stringify(settings) });
    await call(http, { method: 'POST', url: `${at}/partialImport`, headers: auth, body: JSON.stringify({ ifResourceExists: 'OVERWRITE', roles, users, clients }) });
  }
  const values: Record<string, string> = {};
  for (const t of tokens) {
    const token = await accessToken(http, t.realm, { client_id: clientId(t), username: t.username, password: passwords[t.name]!, scope: 'openid' });
    values[t.name] = (t.template ?? '{value}').replace('{value}', token);
  }
  return values;
}
