import { randomBytes } from 'node:crypto';
import type { EnvironmentVariable } from '../agents/outputs.js';
import { redactSecrets } from '../core/redact.js';
import { writeSecret } from '../core/secrets.js';

export type MintRecipe = Extract<EnvironmentVariable, { strategy: 'mint' }>;

export interface EnvironmentDeps {
  /** The project's secrets directory: outside every worktree, one 0600 file per name. */
  secretsDir: string;
  /** What already exists (platform and project secrets): a held value always wins over a recipe. */
  held: Readonly<Record<string, string>>;
  /** The value a deployed service of the project runs with, or null when it is not there. */
  serviceEnv: (service: string, variable: string) => Promise<string | null>;
  random?: (bytes: number) => Buffer;
}

export interface AppliedVariable {
  name: string;
  scope: EnvironmentVariable['scope'];
  strategy: EnvironmentVariable['strategy'];
  /** `kept`: a value already existed; `fallback`: `from-service` found nothing and a random one was made; `deferred`: minted after the deploy. */
  outcome: 'created' | 'kept' | 'fallback' | 'deferred';
}

export interface ApplyResult {
  /** The values of the variables that exist now, by name; a `mint` one is not among them yet. */
  values: Record<string, string>;
  applied: AppliedVariable[];
  mints: MintRecipe[];
}

const DEFAULT_LENGTH = 32;

function randomText(format: 'hex' | 'base64url' | 'alnum', length: number, random: (bytes: number) => Buffer): string {
  if (format === 'hex') return random(Math.ceil(length / 2)).toString('hex').slice(0, length);
  if (format === 'base64url') return random(Math.ceil((length * 3) / 4)).toString('base64url').slice(0, length);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...random(length)].map((b) => chars[b % chars.length]).join('');
}

function valueOf(v: EnvironmentVariable, random: (bytes: number) => Buffer): string {
  if (v.strategy === 'fake') return `${v.prefix ?? ''}${randomText('hex', Math.max(v.minLength ?? DEFAULT_LENGTH, 16), random)}`;
  const format = v.strategy === 'random' ? (v.format ?? 'hex') : 'hex';
  const length = v.strategy === 'random' ? (v.minLength ?? DEFAULT_LENGTH) : DEFAULT_LENGTH;
  return randomText(format, length, random);
}

/** Creates what the recipes name, once: a value that exists is kept, the rest is made up and stored. A `mint` recipe waits for the deploy. */
export async function applyRecipes(variables: readonly EnvironmentVariable[], deps: EnvironmentDeps): Promise<ApplyResult> {
  const random = deps.random ?? randomBytes;
  const values: Record<string, string> = {};
  const applied: AppliedVariable[] = [];
  const mints: MintRecipe[] = [];
  const seen = new Set<string>();
  for (const v of variables) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    const base = { name: v.name, scope: v.scope, strategy: v.strategy };
    if (v.strategy === 'mint') {
      mints.push(v);
      applied.push({ ...base, outcome: 'deferred' });
      continue;
    }
    const held = deps.held[v.name];
    if (held !== undefined) {
      values[v.name] = held;
      applied.push({ ...base, outcome: 'kept' });
      continue;
    }
    // Only the variable of the same name: a recipe cannot read another variable of a service and relabel it.
    const copied = v.strategy === 'from-service' && v.variable === v.name ? await deps.serviceEnv(v.service, v.variable).catch(() => null) : null;
    const value = copied ?? valueOf(v, random);
    await writeSecret(deps.secretsDir, v.name, value);
    values[v.name] = value;
    applied.push({ ...base, outcome: v.strategy === 'from-service' && copied === null ? 'fallback' : 'created' });
  }
  return { values, applied, mints };
}

export interface MintDeps {
  /** The address of each deployed service of the project: a recipe may call only these. */
  urls: Readonly<Record<string, string>>;
  /** The secrets a request may name with `${NAME}`: only the ones this environment made up, never a platform or third-party secret. */
  secrets: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface MintResult {
  values: Record<string, string>;
  failed: Array<{ name: string; reason: string }>;
}

const MINT_TIMEOUT_MS = 10_000;
const MINT_MAX_BYTES = 64 * 1024;

function resolveTemplate(text: string, known: Readonly<Record<string, string>>): string {
  return text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_m, name: string) => {
    const v = known[name];
    if (v === undefined) throw new Error(`\${${name}} does not exist`);
    return v;
  });
}

function walk(json: unknown, dotted: string): string {
  let at: unknown = json;
  for (const part of dotted.split('.')) {
    if (at === null || typeof at !== 'object') throw new Error(`no "${dotted}" in the response`);
    at = (at as Record<string, unknown>)[part];
  }
  if (typeof at !== 'string' && typeof at !== 'number') throw new Error(`"${dotted}" is not a string in the response`);
  return String(at);
}

/** Calls the deployed services the recipes name and takes the value out of each answer; a call outside the project's own services is refused. */
export async function mintValues(mints: readonly MintRecipe[], deps: MintDeps): Promise<MintResult> {
  const doFetch = deps.fetch ?? fetch;
  const known: Record<string, string> = { ...deps.secrets };
  const values: Record<string, string> = {};
  const failed: MintResult['failed'] = [];
  for (const m of mints) {
    try {
      const base = deps.urls[m.service];
      if (base === undefined) throw new Error(`service ${m.service} is not deployed`);
      const url = new URL(m.request.path, base);
      if (url.origin !== new URL(base).origin) throw new Error(`path ${m.request.path} leaves the service`);
      const headers = Object.fromEntries(Object.entries(m.request.headers ?? {}).map(([k, v]) => [k, resolveTemplate(v, known)]));
      const body = m.request.body === undefined ? undefined : resolveTemplate(m.request.body, known);
      // A redirect is never followed: it could leave the one service the recipe may call.
      const res = await doFetch(url, { method: m.request.method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.timeout(deps.timeoutMs ?? MINT_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${m.request.method} ${m.request.path} answered ${res.status}`);
      let raw: string;
      if (m.extract.from === 'header') {
        const h = res.headers.get(m.extract.path);
        if (h === null) throw new Error(`no header ${m.extract.path} in the response`);
        raw = h;
      } else {
        const text = (await res.text()).slice(0, deps.maxBytes ?? MINT_MAX_BYTES);
        raw = walk(JSON.parse(text), m.extract.path);
      }
      const value = (m.template ?? '{value}').replace('{value}', raw).trim();
      if (value === '' || /[\r\n]/.test(value)) throw new Error('the extracted value is empty or has several lines');
      values[m.name] = value;
      known[m.name] = value;
    } catch (err) {
      failed.push({ name: m.name, reason: redactSecrets((err as Error).message, Object.values(known)) });
    }
  }
  return { values, failed };
}
