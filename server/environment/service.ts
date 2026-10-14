import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EnvironmentAnswer, EnvironmentVariable } from '../agents/outputs.js';
import type { Plan } from '../contracts/plan.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import type { DeployTarget } from '../deploy/target.js';
import type { StepOutcome } from '../runner/step.js';
import { OrchEvent } from '../orchestrator/events.js';
import type { PhaseDeps } from '../orchestrator/phases/shared.js';
import { environmentPack, type PackBase } from '../orchestrator/steps.js';
import { applyRecipes, mintValues, type MintRecipe } from './executor.js';
import { scanRepository, unknownVariables, type ScannedFile } from './scan.js';

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
  target: Pick<DeployTarget, 'provide' | 'serviceEnv'>;
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

/** A recipe per name; a newer one replaces an older one. */
const merged = (older: readonly EnvironmentVariable[], newer: readonly EnvironmentVariable[]): EnvironmentVariable[] => [...new Map([...older, ...newer].map((v) => [v.name, v] as const)).values()];

/** Variable names a failure text cites, as the UI reads them: A_B style, minus what the platform provides. */
export function citedVariables(text: string): string[] {
  const names = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return [...new Set(names)].filter((n) => !/^(SERVICE_URL(_\w+)?|TEAMS_AI_IMAGE|AC_\d+)$/.test(n));
}

/** The text of a deploy or suite failure that says a variable or a credential is missing: the one case the environment step can fix. */
export const MISSING_VARIABLE = /required variable|is missing a value|missing secret|declares secret .* not available|não foram? definid|not (?:been )?defined|is not set|variável de ambiente/i;

async function askAgent(host: EnvironmentHost, repo: EnvironmentRepo, files: readonly ScannedFile[], wanted: readonly string[], failure: string | null): Promise<EnvironmentVariable[]> {
  const unknown = Object.fromEntries(wanted.map((n) => [n, files.filter((f) => f.text.includes(n)).map((f) => f.path)]));
  const pack = environmentPack(host.packBase(), { unknown, existing: Object.keys(host.secrets), services: host.services, failure });
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
  const known = new Set([...Object.keys(host.secrets), ...remembered.map((v) => v.name)]);
  const files = await scanRepository(repo.dir, { compose: repo.plan.delivery?.compose, e2eSuite: repo.plan.delivery?.e2eSuite });
  const wanted = new Set(unknownVariables(files, known));
  for (const n of failure === null ? [] : citedVariables(failure)) if (!known.has(n)) wanted.add(n);
  for (const n of wanted) if (RESERVED.test(n)) wanted.delete(n);
  const fresh = wanted.size > 0 ? await askAgent(host, repo, files, [...wanted], failure) : [];
  const recipes = merged(remembered, fresh);
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
