import { promises as fs } from 'node:fs';
import path from 'node:path';

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

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
