import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../server/config/config.js';
import { GITHUB_OWNER, addProject, readUserConfig, setGithubOwner, userConfigFile } from '../../server/onboarding/config-store.js';

let home = '';
afterEach(async () => {
  vi.restoreAllMocks();
  if (home) await fs.rm(home, { recursive: true, force: true });
  home = '';
});

const dirsOf = (raw: { projects: Array<{ dir: string }> }) => raw.projects.map((p) => p.dir).sort();

/** Sets `home` to a fresh dir whose config.json holds `content` as is, so it can be broken on purpose. */
async function homeWithConfig(content: string): Promise<void> {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
  await fs.mkdir(path.dirname(userConfigFile(home)), { recursive: true });
  await fs.writeFile(userConfigFile(home), content);
}

describe('config store', () => {
  it('reads defaults when the file is missing and writes the owner without touching other keys', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    expect(userConfigFile(home)).toBe(path.join(home, '.teams-ai', 'config.json'));
    expect((await readUserConfig(home)).cfg.github.owner).toBeUndefined();
    await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
    await fs.writeFile(userConfigFile(home), JSON.stringify({ concurrency: { maxParallel: 2 }, github: { owner: 'old' } }));
    const cfg = await setGithubOwner('diego-dm-morais', home);
    expect(cfg.github.owner).toBe('diego-dm-morais');
    const raw = JSON.parse(await fs.readFile(userConfigFile(home), 'utf8'));
    expect(raw).toEqual({ concurrency: { maxParallel: 2 }, github: { owner: 'diego-dm-morais' } });
  });

  it('survives concurrent writers: none rejects, config.json is valid JSON, no tmp file is left', async () => {
    // The tmp name was config.json.<pid>.tmp, shared by every concurrent writer in this process.
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    const owners = Array.from({ length: 50 }, (_, i) => `owner-${i}`);
    const results = await Promise.allSettled(owners.map((owner) => setGithubOwner(owner, home)));
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const raw = JSON.parse(await fs.readFile(userConfigFile(home), 'utf8'));
    expect(owners).toContain(raw.github.owner);
    expect(await fs.readdir(path.dirname(userConfigFile(home)))).toEqual(['config.json']);
  });

  it('rejects an owner that is not a GitHub login', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    for (const bad of ['', '-lead', 'trail-', 'has space', 'a'.repeat(40), 'x/y']) {
      expect(GITHUB_OWNER.test(bad)).toBe(false);
      await expect(setGithubOwner(bad, home)).rejects.toThrow(RangeError);
    }
    expect(GITHUB_OWNER.test('lukeware70X7')).toBe(true);
  });

  it('addProject appends once by dir and validates the whole config', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    await addProject('/home/u/proj', home);
    const twice = await addProject('/home/u/proj', home);
    expect(twice.projects).toEqual([{ dir: '/home/u/proj' }]);
    const raw = JSON.parse(await fs.readFile(userConfigFile(home), 'utf8'));
    expect(raw.projects).toEqual([{ dir: '/home/u/proj' }]);
  });

  it('keeps every project when 50 addProject calls with different dirs run at once', async () => {
    // Each call read config.json before any other had written it, so each write replaced the list with its own dir.
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    const dirs = Array.from({ length: 50 }, (_, i) => `/home/u/proj-${i}`);
    const results = await Promise.allSettled(dirs.map((dir) => addProject(dir, home)));
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const raw = JSON.parse(await fs.readFile(userConfigFile(home), 'utf8'));
    expect(dirsOf(raw)).toEqual([...dirs].sort());
    expect(await fs.readdir(path.dirname(userConfigFile(home)))).toEqual(['config.json']);
    expect((await readUserConfig(home)).cfg.projects).toHaveLength(50);
  });

  it('loses neither the owner, a project nor an untouched key when setGithubOwner and addProject run at once', async () => {
    await homeWithConfig(JSON.stringify({ concurrency: { maxParallel: 2 }, github: { owner: 'old', allowedHosts: ['github.com'] } }));
    const dirs = Array.from({ length: 20 }, (_, i) => `/home/u/proj-${i}`);
    await Promise.all([
      ...dirs.slice(0, 10).map((dir) => addProject(dir, home)),
      setGithubOwner('diego-dm-morais', home),
      ...dirs.slice(10).map((dir) => addProject(dir, home)),
    ]);
    const raw = JSON.parse(await fs.readFile(userConfigFile(home), 'utf8'));
    expect(dirsOf(raw)).toEqual([...dirs].sort());
    expect(raw.github).toEqual({ owner: 'diego-dm-morais', allowedHosts: ['github.com'] });
    expect(raw.concurrency).toEqual({ maxParallel: 2 });
  });

  it('refuses to write over a config.json it cannot parse: the file stays as it was and the error names it', async () => {
    const broken = '{ "github": { "owner": "kept-owner" }, "projects": [{ "dir": "/home/u/kept" }'; // cut off mid-write
    await homeWithConfig(broken);
    const file = userConfigFile(home);
    for (const attempt of [() => addProject('/home/u/new', home), () => setGithubOwner('diego-dm-morais', home), () => readUserConfig(home)]) {
      const err = await attempt().then(() => null, (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err!.message).toContain(file);
      expect(err!.message).toMatch(/not valid JSON/);
      expect(err!.message).not.toContain('kept-owner'); // never echo a snippet of the file
    }
    expect(await fs.readFile(file, 'utf8')).toBe(broken);
    expect(await fs.readdir(path.dirname(file))).toEqual(['config.json']);
  });

  it('refuses a config.json that is valid JSON but not a config, and leaves it alone', async () => {
    await homeWithConfig('[]');
    await expect(addProject('/home/u/new', home)).rejects.toThrow(ConfigError);
    await expect(setGithubOwner('diego-dm-morais', home)).rejects.toThrow(ConfigError);
    expect(await fs.readFile(userConfigFile(home), 'utf8')).toBe('[]');
  });

  it('treats only a missing file as empty: a read error stops the write instead of replacing the config', async () => {
    const kept = JSON.stringify({ projects: [{ dir: '/home/u/kept' }] });
    await homeWithConfig(kept);
    const busy = () => Object.assign(new Error(`EBUSY: resource busy or locked, open '${userConfigFile(home)}'`), { code: 'EBUSY' });
    const read = vi.spyOn(fs, 'readFile');
    read.mockRejectedValueOnce(busy());
    await expect(addProject('/home/u/new', home)).rejects.toThrow(/EBUSY/);
    read.mockRejectedValueOnce(busy());
    await expect(setGithubOwner('diego-dm-morais', home)).rejects.toThrow(/EBUSY/);
    read.mockRejectedValueOnce(busy());
    await expect(readUserConfig(home)).rejects.toThrow(/EBUSY/);
    expect(await fs.readFile(userConfigFile(home), 'utf8')).toBe(kept);
    expect(await fs.readdir(path.dirname(userConfigFile(home)))).toEqual(['config.json']);
  });
});
