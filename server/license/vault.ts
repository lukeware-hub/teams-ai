import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';
import { expandHome } from '../orchestrator/workspace.js';

const CODE = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function licenseCodeFile(home?: string): string {
  return path.join(expandHome('~/.teams-ai', home), 'license', 'code');
}

export function licenseTokenFile(home?: string): string {
  return path.join(path.dirname(licenseCodeFile(home)), 'token');
}

async function readSecret(file: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim();
    return text === '' ? null : text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function clearSecret(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function writeSecret(file: string, value: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await writeFileAtomic(file, value, { mode: 0o600 });
}

export function readLicenseCode(home?: string): Promise<string | null> {
  return readSecret(licenseCodeFile(home));
}

export function clearLicenseCode(home?: string): Promise<void> {
  return clearSecret(licenseCodeFile(home));
}

export async function writeLicenseCode(code: string, home?: string): Promise<void> {
  const trimmed = code.trim();
  if (!CODE.test(trimmed)) throw new RangeError('license code must be 64 hex characters');
  await writeSecret(licenseCodeFile(home), trimmed);
}

export function readLicenseToken(home?: string): Promise<string | null> {
  return readSecret(licenseTokenFile(home));
}

export function clearLicenseToken(home?: string): Promise<void> {
  return clearSecret(licenseTokenFile(home));
}

export async function writeLicenseToken(token: string, home?: string): Promise<void> {
  if (!TOKEN.test(token)) throw new RangeError('license token is malformed');
  await writeSecret(licenseTokenFile(home), token);
}
