import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EnvironmentVariable } from '../agents/outputs.js';
import { platformRequest } from '../deploy/docker-local.js';
import { issueTokens, KEYCLOAK_PASSWORD, type TokenRecipe } from '../environment/keycloak.js';
import type { Exec } from '../exec/command.js';

/** A test identity the project's environment can sign a token for: who it is, not the token. */
export interface TokenChoice {
  name: string;
  username: string;
}

const isOidc = (v: EnvironmentVariable) => v.strategy === 'oidc-issuer' || v.strategy === 'oidc-token';

/** The identity-provider recipes every spec of the project remembered, one per name. */
async function recipesOf(manifestDir: string): Promise<EnvironmentVariable[]> {
  const files = (await fs.readdir(manifestDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  const found = new Map<string, EnvironmentVariable>();
  for (const file of files) {
    const text = await fs.readFile(path.join(manifestDir, file), 'utf8').catch(() => '');
    try {
      for (const v of (JSON.parse(text) as { variables?: EnvironmentVariable[] }).variables ?? []) if (isOidc(v)) found.set(v.name, v);
    } catch {
      // A manifest that is not JSON names no recipe.
    }
  }
  return [...found.values()];
}

/** The identities the owner can ask a token for. */
export async function tokenChoices(manifestDir: string): Promise<TokenChoice[]> {
  const tokens = (await recipesOf(manifestDir)).filter((v): v is TokenRecipe => v.strategy === 'oidc-token');
  return tokens.map((t) => ({ name: t.name, username: t.username }));
}

/**
 * A fresh access token for `name`, signed by the project's own Keycloak with the platform's administrator password,
 * which never leaves the server. The platform issues tokens the same way at every deploy.
 */
export async function mintProjectToken(exec: Exec, projectId: string, dirs: { manifestDir: string; secretsDir: string }, name: string, issue: typeof issueTokens = issueTokens): Promise<string> {
  const recipes = await recipesOf(dirs.manifestDir);
  if (!recipes.some((v) => v.strategy === 'oidc-token' && v.name === name)) throw new Error(`no token recipe named ${name}`);
  const adminPassword = (await fs.readFile(path.join(dirs.secretsDir, KEYCLOAK_PASSWORD), 'utf8').catch(() => '')).trim();
  if (adminPassword === '') throw new Error('the project has no identity provider yet: deploy the project again');
  const values = await issue(recipes, { adminPassword, http: (req) => platformRequest(exec, projectId, req) });
  const token = values[name];
  if (token === undefined) throw new Error(`the identity provider issued no token for ${name}`);
  return token;
}
