import { describe, expect, it } from 'vitest';
import { gitAuthEnv, withGitAuthEnv } from '../../server/git/auth.js';

// The two hardening entries of SAFE_GIT_ENV in github.ts, as a gh call carries them.
const SAFE = {
  GH_PROMPT_DISABLED: '1',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: '',
};

describe('gh environment with the token', () => {
  it('appends the credential helper after the hardening entries and keeps both', () => {
    expect(withGitAuthEnv(SAFE, 'ghp_secret')).toEqual({
      GH_PROMPT_DISABLED: '1',
      GH_TOKEN: 'ghp_secret',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.helper',
      GIT_CONFIG_VALUE_2: expect.stringContaining('$GH_TOKEN'),
    });
  });

  it('leaves the environment unchanged when no token is saved', () => {
    expect(withGitAuthEnv(SAFE, undefined)).toBe(SAFE);
  });

  it('gitAuthEnv still gives the token with its one credential helper', () => {
    expect(Object.keys(gitAuthEnv('ghp_secret')).sort()).toEqual(['GH_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
    expect(gitAuthEnv('ghp_secret').GIT_CONFIG_COUNT).toBe('1');
  });
});
