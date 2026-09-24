import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GITHUB_OWNER, readUserConfig, setGithubOwner, userConfigFile } from '../../server/onboarding/config-store.js';

let home = '';
afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
  home = '';
});

describe('config store', () => {
  it('reads defaults when the file is missing and writes the owner without touching other keys', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    expect(userConfigFile(home)).toBe(path.join(home, '.teams-ai', 'config.json'));
    expect((await readUserConfig(home)).cfg.github.owner).toBeUndefined();
    await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
    await fs.writeFile(userConfigFile(home), JSON.stringify({ omniroute: { enabled: true }, github: { owner: 'old' } }));
    const cfg = await setGithubOwner('diego-dm-morais', home);
    expect(cfg.github.owner).toBe('diego-dm-morais');
    const raw = JSON.parse(await fs.readFile(userConfigFile(home), 'utf8'));
    expect(raw).toEqual({ omniroute: { enabled: true }, github: { owner: 'diego-dm-morais' } });
  });

  it('rejects an owner that is not a GitHub login', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    for (const bad of ['', '-lead', 'trail-', 'has space', 'a'.repeat(40), 'x/y']) {
      expect(GITHUB_OWNER.test(bad)).toBe(false);
      await expect(setGithubOwner(bad, home)).rejects.toThrow(RangeError);
    }
    expect(GITHUB_OWNER.test('lukeware70X7')).toBe(true);
  });
});
