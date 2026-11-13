import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EnvironmentAnswer, EnvironmentVariable } from '../agents/outputs.js';
import type { Plan } from '../contracts/plan.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import type { DeployTarget } from '../deploy/target.js';
import type { StepOutcome } from '../runner/step.js';
import { OrchEvent } from '../orchestrator/events.js';
import type { PhaseDeps } from '../orchestrator/phases/shared.js';
import { citedVariables } from '../orchestrator/stop-explain.js';
import { environmentPack, type PackBase } from '../orchestrator/steps.js';
import { randomBytes } from 'node:crypto';
import type { PlatformService } from '../contracts/project.js';
import { writeSecret } from '../core/secrets.js';
import { applyRecipes, mintValues, type MintRecipe } from './executor.js';
import { issueTokens, keycloakContainer, KEYCLOAK_PASSWORD } from './keycloak.js';
import { composeVariables, scanRepository, unknownVariables, type ScannedFile } from './scan.js';

export interface EnvironmentHost {
  projectId: string;
  specId: string;
  /** The project's secrets directory and the directory where each spec's recipes are remembered, both outside every worktree. */
  secretsDir: string;
  manifestDir: string;
  /** The run's own secrets: a new value is added here so redaction and the suites see it. */
  secrets: Record<string, string>;
  /** The names the smoke and e2e suites may read, shared with the run's gate secrets. */
  suiteNames: Set<string>;
  /** The project's services, the names a recipe may point at. */
  services: readonly string[];
  target: Pick<DeployTarget, 'provide' | 'serviceEnv' | 'platformRequest'>;
  runAgent: PhaseDeps['runAgent'];
  packBase: () => PackBase;
  /** Waits out a quota or login pause; true when the run cannot go on. */
  pause: (failure: string) => Promise<boolean>;
  journal: { fact(type: string, data: Record<string, unknown>): Promise<unknown> };
  fetch?: typeof fetch;
}

/** One repository the deploy builds: a service's own, or the project's single one. */
export interface EnvironmentRepo {
  service: string | null;
  dir: string;
  plan: Plan;
}

const manifestFile = (host: EnvironmentHost) => path.join(host.manifestDir, `${host.specId}.json`);

async function readManifest(host: EnvironmentHost): Promise<EnvironmentVariable[]> {
  const text = await fs.readFile(manifestFile(host), 'utf8').catch(() => null);
  if (text === null) return [];
  try {
    return (JSON.parse(text) as { variables?: EnvironmentVariable[] }).variables ?? [];
  } catch {
    return [];
  }
}

async function writeManifest(host: EnvironmentHost, variables: readonly EnvironmentVariable[]): Promise<void> {
  await fs.mkdir(host.manifestDir, { recursive: true });
  await writeFileAtomic(manifestFile(host), `${JSON.stringify({ specId: host.specId, variables }, null, 2)}\n`);
}

/** Names the platform keeps for itself: a recipe for one would shadow the real credential in the project's secrets at the next run. */
export const RESERVED = /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_\w+|GITHUB_TOKEN|GH_TOKEN|OPENROUTER_API_KEY|TEAMS_AI_\w+)$/;

/** A suite failure that says the credential was refused: a token that is not the issuer's, the case where a random one was made up. */
export const AUTH_FAILURE = /\bUNAUTHENTICATED\b|\b401\b/;

/** A recipe per name; a newer one replaces an older one. */
const merged = (older: readonly EnvironmentVariable[], newer: readonly EnvironmentVariable[]): EnvironmentVariable[] => [...new Map([...older, ...newer].map((v) => [v.name, v] as const)).values()];

/** The text of a deploy or suite failure that says a variable or a credential is missing: the one case the environment step can fix. */
export const MISSING_VARIABLE = /required variable|is missing a value|missing secret|declares secret .* not available|não foram? definid|not (?:been )?defined|is not set|variável de ambiente/i;

async function askAgent(host: EnvironmentHost, repo: EnvironmentRepo, files: readonly ScannedFile[], wanted: readonly string[], failure: string | null, stale: ReadonlySet<string>): Promise<EnvironmentVariable[]> {
  const unknown = Object.fromEntries(wanted.map((n) => [n, files.filter((f) => f.text.includes(n)).map((f) => f.path)]));
  // A refused credential is asked again, so the pack must not also say it exists: the agent never answers a variable that does.
  const pack = environmentPack(host.packBase(), { unknown, existing: Object.keys(host.secrets).filter((n) => !stale.has(n)), services: host.services, failure });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = (await host.runAgent<'environment'>({ kind: 'environment', role: 'env', pack, cwd: repo.dir, phase: 'phase5', taskId: null, attempt })) as StepOutcome<EnvironmentAnswer>;
    if (out.ok) return out.value.variables.filter((v) => wanted.includes(v.name));
    if ((out.failure === 'quota' || out.failure === 'auth') && (await host.pause(out.failure))) return [];
  }
  return [];
}

/** Makes the values the recipes name exist for the compose file and the suites of this run. */
async function register(host: EnvironmentHost, recipes: readonly EnvironmentVariable[], values: Readonly<Record<string, string>>): Promise<void> {
  Object.assign(host.secrets, values);
  const compose = Object.fromEntries(recipes.filter((v) => v.scope !== 'suites' && values[v.name] !== undefined).map((v) => [v.name, values[v.name]!]));
  if (Object.keys(compose).length > 0) host.target.provide?.(compose);
  for (const v of recipes) if (v.scope !== 'compose') host.suiteNames.add(v.name);
}

/**
 * Before a deploy (and again after a failure that names a missing variable): finds what the compose file and the suites read
 * that nothing provides, asks the environment agent how to create it and creates it. True when something new came to exist.
 */
export async function prepareEnvironment(host: EnvironmentHost, repo: EnvironmentRepo, failure: string | null = null): Promise<boolean> {
  const remembered = await readManifest(host);
  // A refused credential that was made up at random is asked again: the code may check it against an issuer by now.
  const stale = new Set(failure !== null && AUTH_FAILURE.test(failure) ? remembered.filter((v) => (v.strategy === 'random' || v.strategy === 'fake') && v.scope === 'suites').map((v) => v.name) : []);
  const known = new Set([...Object.keys(host.secrets), ...remembered.map((v) => v.name)].filter((n) => !stale.has(n)));
  const files = await scanRepository(repo.dir, { compose: repo.plan.delivery?.compose, e2eSuite: repo.plan.delivery?.e2eSuite });
  const wanted = new Set(unknownVariables(files, known));
  for (const n of failure === null ? [] : citedVariables(failure, Infinity)) if (!known.has(n)) wanted.add(n);
  // The scan may not see a name a suite reads through a constant, so a refused credential is asked again whatever the files show.
  for (const n of stale) wanted.add(n);
  for (const n of wanted) if (RESERVED.test(n)) wanted.delete(n);
  const fresh = wanted.size > 0 ? await askAgent(host, repo, files, [...wanted], failure, stale) : [];
  for (const v of fresh) if (stale.has(v.name)) delete host.secrets[v.name];
  const recipes = merged(remembered, fresh);
  // A value that already existed never went through a recipe, so nothing handed it to compose: the compose file reads it by name and gets nothing (live: OIDC_AUDIENCE, every call UNAUTHENTICATED).
  const heldForCompose = composeVariables(files).filter((n) => host.secrets[n] !== undefined && !RESERVED.test(n) && !recipes.some((v) => v.name === n));
  if (heldForCompose.length > 0) host.target.provide?.(Object.fromEntries(heldForCompose.map((n) => [n, host.secrets[n]!])));
  if (recipes.length === 0) return false;
  const applied = await applyRecipes(recipes, { secretsDir: host.secretsDir, held: host.secrets, // Only a service of this project: the name goes to the docker command.
    serviceEnv: (service, variable) => (host.services.includes(service) ? host.target.serviceEnv?.(host.projectId, service, variable) ?? Promise.resolve(null) : Promise.resolve(null)) });
  await register(host, recipes, applied.values);
  const created = applied.applied.some((a) => a.outcome === 'created' || a.outcome === 'fallback');
  if (fresh.length > 0) {
    await writeManifest(host, recipes);
    await host.journal.fact(OrchEvent.EnvironmentPlanned, { ...(repo.service ? { service: repo.service } : {}), variables: applied.applied.filter((a) => fresh.some((v) => v.name === a.name)), reasons: Object.fromEntries(fresh.map((v) => [v.name, v.reason])) });
  }
  return fresh.length > 0 || created;
}

const isOidc = (v: EnvironmentVariable) => v.strategy === 'oidc-issuer' || v.strategy === 'oidc-token';

/** The platform containers the recipes need: Keycloak when any recipe of the spec is an issuer or a token. */
export async function environmentContainers(host: EnvironmentHost): Promise<PlatformService[]> {
  if (!(await readManifest(host)).some(isOidc)) return [];
  let password = host.secrets[KEYCLOAK_PASSWORD];
  if (password === undefined) {
    password = randomBytes(24).toString('base64url');
    await writeSecret(host.secretsDir, KEYCLOAK_PASSWORD, password);
    host.secrets[KEYCLOAK_PASSWORD] = password;
  }
  return [keycloakContainer(password)];
}

/** After the platform is up, before the suites: Keycloak creates the realms and signs the tokens the recipes name. A failure is thrown with Keycloak's own answer. */
export async function issueEnvironmentTokens(host: EnvironmentHost): Promise<void> {
  const recipes = (await readManifest(host)).filter(isOidc);
  if (!recipes.some((v) => v.strategy === 'oidc-token')) return;
  const request = host.target.platformRequest;
  const password = host.secrets[KEYCLOAK_PASSWORD];
  if (!request || password === undefined) throw new Error('the deploy target cannot reach the platform Keycloak');
  const values = await issueTokens(recipes, { adminPassword: password, http: (req) => request.call(host.target, host.projectId, req) });
  Object.assign(host.secrets, values);
  const named = recipes.filter((v) => values[v.name] !== undefined);
  await register(host, named, values);
  await host.journal.fact(OrchEvent.EnvironmentMinted, { names: Object.keys(values), failed: [] });
}

/** After the deploy, before the suites: asks the deployed services for the values only they can issue (a session header, say). */
export async function mintEnvironment(host: EnvironmentHost, urls: Readonly<Record<string, string>>): Promise<void> {
  const mints = (await readManifest(host)).filter((v): v is MintRecipe => v.strategy === 'mint');
  if (mints.length === 0) return;
  // A request may name only the values this environment made up: a platform or third-party secret never reaches a service.
  const ours = new Set((await readManifest(host)).map((v) => v.name));
  const result = await mintValues(mints, { urls, secrets: Object.fromEntries(Object.entries(host.secrets).filter(([name]) => ours.has(name))), fetch: host.fetch });
  Object.assign(host.secrets, result.values);
  for (const name of Object.keys(result.values)) host.suiteNames.add(name);
  await host.journal.fact(OrchEvent.EnvironmentMinted, { names: Object.keys(result.values), failed: result.failed });
}
