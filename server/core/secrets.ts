import { randomBytes } from 'node:crypto';
import { promises as fs, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';

export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Spec §10/§14: `~/.teams-ai/secrets/<NAME>` holds one secret per file. Only upper-case names are
 * secrets; anything else in the directory is ignored. Values are trimmed so an editor's trailing
 * newline never becomes part of a token.
 */
export async function loadSecrets(dir: string): Promise<Record<string, string>> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (!e.isFile() || !SECRET_NAME.test(e.name)) continue;
    out[e.name] = (await fs.readFile(path.join(dir, e.name), 'utf8')).trim();
  }
  return out;
}

/**
 * Audit M4: the values to redact with, read from disk on every call so a secret stored a moment ago is
 * masked at once. An unreadable directory yields none rather than failing the response being redacted.
 */
export async function loadSecretValues(dir: string): Promise<string[]> {
  return Object.values(await loadSecrets(dir).catch(() => ({})));
}

/** Synchronous twin of `loadSecretValues`, for callers that cannot await (the login transcript reader). */
export function loadSecretValuesSync(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && SECRET_NAME.test(e.name))
      .map((e) => readFileSync(path.join(dir, e.name), 'utf8').trim());
  } catch {
    return [];
  }
}

/**
 * Spec (onboarding) §4: one file per secret, mode 0600 in a 0700 directory, written through a temp
 * file and rename (`writeFileAtomic`, so concurrent writers of one secret cannot trip over each other)
 * so a crash never leaves a half-written token. The value is trimmed (editors add a
 * newline) and must be a single line; `loadSecrets` reads it back unchanged.
 */
export async function writeSecret(dir: string, name: string, value: string): Promise<void> {
  if (!SECRET_NAME.test(name)) throw new RangeError(`secret name must match ${SECRET_NAME}: ${name}`);
  const trimmed = value.trim();
  if (trimmed === '') throw new RangeError(`secret ${name} is empty`);
  if (/[\r\n]/.test(trimmed)) throw new RangeError(`secret ${name} must be a single line`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await writeFileAtomic(path.join(dir, name), trimmed, { mode: 0o600 });
}

/** Creates each generated secret that no directory holds yet, as 64 random hex characters; one that exists is never replaced. */
export async function ensureGeneratedSecrets(dir: string, names: readonly string[], existing: Readonly<Record<string, string>>): Promise<void> {
  const held = { ...existing, ...(await loadSecrets(dir)) };
  for (const name of new Set(names)) if (!(name in held)) await writeSecret(dir, name, randomBytes(32).toString('hex'));
}
