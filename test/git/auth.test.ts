import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandSpec } from '../../server/exec/command.js';
import { gitAuthEnv, withGitAuth } from '../../server/git/auth.js';

let secretsDir: string;
const seen: CommandSpec[] = [];
const base = async (spec: CommandSpec) => {
  seen.push(spec);
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false } as never;
};

beforeEach(async () => {
  seen.length = 0;
  secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-auth-'));
});
afterEach(() => fs.rm(secretsDir, { recursive: true, force: true }));

describe('gitAuthEnv', () => {
  it('is empty without a token, and carries a credential helper that reads the token from the environment', () => {
    expect(gitAuthEnv(undefined)).toEqual({});
    const env = gitAuthEnv('ghp_secret');
    expect(env.GH_TOKEN).toBe('ghp_secret');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toContain('$GH_TOKEN');
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('ghp_secret');
  });
});

describe('withGitAuth', () => {
  it('gives git commands the token saved in the secrets directory, read on every call, and leaves other commands alone', async () => {
    const exec = withGitAuth(base, secretsDir);
    await exec({ bin: 'git', args: ['fetch', 'origin'], cwd: '.', timeoutMs: 1000 });
    expect(seen[0]!.env).toBeUndefined(); // no token saved yet
    await fs.writeFile(path.join(secretsDir, 'GITHUB_TOKEN'), 'ghp_saved_later\n');
    await exec({ bin: 'git', args: ['fetch', 'origin'], cwd: '.', timeoutMs: 1000, env: { KEEP: '1' } });
    expect(seen[1]!.env).toMatchObject({ KEEP: '1', GH_TOKEN: 'ghp_saved_later', GIT_CONFIG_KEY_0: 'credential.helper' });
    await exec({ bin: 'docker', args: ['ps'], cwd: '.', timeoutMs: 1000 });
    expect(seen[2]!.env).toBeUndefined();
  });
});
