import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSecrets } from '../../server/core/secrets.js';

let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('loadSecrets', () => {
  it('reads one file per secret name and trims the trailing newline', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-secrets-'));
    await fs.writeFile(path.join(dir, 'OPENROUTER_API_KEY'), 'sk-or-v1-abc\n');
    await fs.writeFile(path.join(dir, 'DB_PASSWORD'), '  p@ss  ');
    await fs.writeFile(path.join(dir, 'lowercase'), 'ignored');
    await fs.mkdir(path.join(dir, 'SUBDIR'));
    expect(await loadSecrets(dir)).toEqual({ OPENROUTER_API_KEY: 'sk-or-v1-abc', DB_PASSWORD: 'p@ss' });
  });

  it('returns an empty map when the directory does not exist', async () => {
    expect(await loadSecrets(path.join(os.tmpdir(), 'teams-ai-none-' + Date.now()))).toEqual({});
  });
});
