import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEYCLOAK_PASSWORD } from '../../server/environment/keycloak.js';
import { mintProjectToken, tokenChoices } from '../../server/grpc/token.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const issuer = { name: 'OIDC_ISSUER_URL', strategy: 'oidc-issuer', realm: 'kayron-hub' };
const token = (name: string, username: string) => ({ name, strategy: 'oidc-token', realm: 'kayron-hub', audience: 'policy-registry-api', username, roles: ['maker'] });

const dirs: string[] = [];
const project = async (manifests: Record<string, unknown>, password?: string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-test-'));
  dirs.push(root);
  const manifestDir = path.join(root, 'environment');
  const secretsDir = path.join(root, 'secrets');
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.mkdir(secretsDir, { recursive: true });
  for (const [spec, variables] of Object.entries(manifests)) await fs.writeFile(path.join(manifestDir, `${spec}.json`), JSON.stringify({ specId: spec, variables }));
  if (password !== undefined) await fs.writeFile(path.join(secretsDir, KEYCLOAK_PASSWORD), `${password}\n`);
  return { manifestDir, secretsDir };
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('tokenChoices', () => {
  it('lists the token recipes of every spec once, by name, with the identity and nothing else', async () => {
    const d = await project({ one: [issuer, token('E2E_MAKER_TOKEN', 'maker'), { name: 'X', strategy: 'derive' }], two: [issuer, token('E2E_MAKER_TOKEN', 'maker'), token('E2E_CHECKER_TOKEN', 'checker')] });
    expect(await tokenChoices(d.manifestDir)).toEqual([
      { name: 'E2E_MAKER_TOKEN', username: 'maker' },
      { name: 'E2E_CHECKER_TOKEN', username: 'checker' },
    ]);
  });

  it('lists nothing for a project with no environment folder or an unreadable manifest', async () => {
    expect(await tokenChoices(path.join(os.tmpdir(), 'no-such-folder-for-tokens'))).toEqual([]);
    const d = await project({});
    await fs.writeFile(path.join(d.manifestDir, 'broken.json'), 'not json');
    expect(await tokenChoices(d.manifestDir)).toEqual([]);
  });
});

describe('mintProjectToken', () => {
  it('asks the identity provider for the recipes with the administrator password from the secrets folder, and returns the named token', async () => {
    const d = await project({ one: [issuer, token('E2E_MAKER_TOKEN', 'maker'), token('E2E_CHECKER_TOKEN', 'checker')] }, 'admin-secret');
    const seen: Array<{ names: string[]; adminPassword: string }> = [];
    const issue = (async (recipes: Array<{ name: string }>, deps: { adminPassword: string }) => {
      seen.push({ names: recipes.map((r) => r.name), adminPassword: deps.adminPassword });
      return { E2E_MAKER_TOKEN: 'maker.jwt', E2E_CHECKER_TOKEN: 'checker.jwt' };
    }) as never;
    expect(await mintProjectToken(new FakeExec().exec, 'kayron-hub', d, 'E2E_CHECKER_TOKEN', issue)).toBe('checker.jwt');
    expect(seen).toEqual([{ names: ['OIDC_ISSUER_URL', 'E2E_MAKER_TOKEN', 'E2E_CHECKER_TOKEN'], adminPassword: 'admin-secret' }]);
  });

  it('refuses a name that is not a token recipe, and says to deploy again when the project has no identity provider password', async () => {
    const d = await project({ one: [issuer, token('E2E_MAKER_TOKEN', 'maker')] });
    const issue = (async () => ({})) as never;
    await expect(mintProjectToken(new FakeExec().exec, 'kayron-hub', d, 'OIDC_ISSUER_URL', issue)).rejects.toThrow(/no token recipe named OIDC_ISSUER_URL/);
    await expect(mintProjectToken(new FakeExec().exec, 'kayron-hub', d, 'E2E_MAKER_TOKEN', issue)).rejects.toThrow(/deploy the project again/);
  });

  it('says when the identity provider issued nothing for the name', async () => {
    const d = await project({ one: [issuer, token('E2E_MAKER_TOKEN', 'maker')] }, 'p');
    await expect(mintProjectToken(new FakeExec().exec, 'kayron-hub', d, 'E2E_MAKER_TOKEN', (async () => ({})) as never)).rejects.toThrow(/issued no token for E2E_MAKER_TOKEN/);
  });
});
