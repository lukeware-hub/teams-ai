import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSecrets, writeSecret } from '../../server/core/secrets.js';

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

describe('writeSecret', () => {
  it('writes the trimmed value with mode 0600 into a 0700 directory and loadSecrets reads it back', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-secrets-'));
    const target = path.join(dir, 'nested');
    await writeSecret(target, 'GITHUB_TOKEN', ' ghp_' + 'x'.repeat(36) + '\n');
    expect(await loadSecrets(target)).toEqual({ GITHUB_TOKEN: 'ghp_' + 'x'.repeat(36) });
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(target, 'GITHUB_TOKEN'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    }
    expect((await fs.readdir(target)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing value atomically and rejects bad names and multi-line values', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-secrets-'));
    await writeSecret(dir, 'OPENROUTER_API_KEY', 'sk-or-v1-old');
    await writeSecret(dir, 'OPENROUTER_API_KEY', 'sk-or-v1-new');
    expect(await loadSecrets(dir)).toEqual({ OPENROUTER_API_KEY: 'sk-or-v1-new' });
    await expect(writeSecret(dir, 'lowercase', 'x')).rejects.toThrow(RangeError);
    await expect(writeSecret(dir, 'TWO_LINES', 'a\nb')).rejects.toThrow(RangeError);
    await expect(writeSecret(dir, 'EMPTY', '   ')).rejects.toThrow(RangeError);
  });
});
