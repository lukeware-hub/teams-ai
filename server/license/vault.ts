import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';
import { expandHome } from '../orchestrator/workspace.js';

const CODE = /^[0-9a-f]{64}$/;

export function licenseCodeFile(home?: string): string {
  return path.join(expandHome('~/.teams-ai', home), 'license', 'code');
}

export async function readLicenseCode(home?: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(licenseCodeFile(home), 'utf8')).trim();
    return text === '' ? null : text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function clearLicenseCode(home?: string): Promise<void> {
  try {
    await fs.unlink(licenseCodeFile(home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export async function writeLicenseCode(code: string, home?: string): Promise<void> {
  const trimmed = code.trim();
  if (!CODE.test(trimmed)) throw new RangeError('license code must be 64 hex characters');
  const file = licenseCodeFile(home);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await writeFileAtomic(file, trimmed, { mode: 0o600 });
}
