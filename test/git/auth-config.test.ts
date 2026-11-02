import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandSpec } from '../../server/exec/command.js';
import { gitAuthEnv, withGhAuth, withGitConfig } from '../../server/git/auth.js';

let secretsDir: string;
const seen: CommandSpec[] = [];
const base = async (spec: CommandSpec) => {
  seen.push(spec);
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false } as never;
};

beforeEach(async () => {
  seen.length = 0;
  secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-auth-config-'));
});
afterEach(() => fs.rm(secretsDir, { recursive: true, force: true }));

describe('withGitConfig', () => {
  it('appends after the existing count and keeps the earlier keys', () => {
    const env = withGitConfig({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1' }, [['c.d', '2']]);
    expect(env).toEqual({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2' });
  });

  it('starts at index 0 when no count is set', () => {
    expect(withGitConfig({}, [['a.b', '1']])).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1' });
  });

  it('refuses a count that is not a whole number instead of overwriting entries', () => {
    expect(() => withGitConfig({ GIT_CONFIG_COUNT: 'NaN' }, [['a.b', '1']])).toThrow(RangeError);
  });

  it('keeps the hardening entries and the credential helper together', () => {
    // The same two hardening entries as SAFE_GIT_ENV in github.ts, appended after the credential helper of gitAuthEnv.
    const safe: Array<[string, string]> = [
      ['core.hooksPath', '/dev/null'],
      ['core.fsmonitor', ''],
    ];
    const auth = gitAuthEnv('ghp_secret');
    const env = withGitConfig(auth, safe);
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: '',
    });
  });
});

describe('withGhAuth', () => {
  it('gives gh the saved token and adds no GIT_CONFIG variable', async () => {
    await fs.writeFile(path.join(secretsDir, 'GITHUB_TOKEN'), 'ghp_saved\n');
    await withGhAuth(base, secretsDir)({ bin: 'gh', args: ['repo', 'view'], timeoutMs: 1000, env: { GH_PROMPT_DISABLED: '1' } });
    expect(seen[0]!.env).toMatchObject({ GH_TOKEN: 'ghp_saved', GH_PROMPT_DISABLED: '1' });
    expect(Object.keys(seen[0]!.env!).some((k) => k.startsWith('GIT_CONFIG_'))).toBe(false);
  });

  it('leaves git commands alone, and sets no token when none is saved', async () => {
    const exec = withGhAuth(base, secretsDir);
    await exec({ bin: 'gh', args: ['repo', 'view'], timeoutMs: 1000 });
    expect(seen[0]!.env).toBeUndefined();
    await fs.writeFile(path.join(secretsDir, 'GITHUB_TOKEN'), 'ghp_saved\n');
    await exec({ bin: 'git', args: ['fetch'], timeoutMs: 1000 });
    expect(seen[1]!.env).toBeUndefined();
  });
});
