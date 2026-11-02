import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandSpec } from '../../server/exec/command.js';
import { withGitAuth } from '../../server/git/auth.js';

// The two hardening entries of SAFE_GIT_ENV in github.ts, as a git call carries them.
const SAFE = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: '',
};

let secretsDir: string;
const seen: CommandSpec[] = [];
const base = async (spec: CommandSpec) => {
  seen.push(spec);
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false } as never;
};

beforeEach(async () => {
  seen.length = 0;
  secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-env-lane4-'));
});
afterEach(() => fs.rm(secretsDir, { recursive: true, force: true }));

describe('git environment with the saved token', () => {
  it('appends the credential helper and keeps hooksPath and fsmonitor, with GIT_CONFIG_COUNT=3', async () => {
    await fs.writeFile(path.join(secretsDir, 'GITHUB_TOKEN'), 'ghp_saved\n');
    await withGitAuth(base, secretsDir)({ bin: 'git', args: ['fetch'], timeoutMs: 1000, env: SAFE });
    expect(seen[0]!.env).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.helper',
      GH_TOKEN: 'ghp_saved',
    });
  });

  it('passes a git call through unchanged when no token is saved', async () => {
    await withGitAuth(base, secretsDir)({ bin: 'git', args: ['fetch'], timeoutMs: 1000, env: SAFE });
    expect(seen[0]!.env).toBe(SAFE);
  });
});
