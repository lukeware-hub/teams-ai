import { describe, expect, it } from 'vitest';
import type { CommandResult, Exec } from '../../server/exec/command.js';
import { viewerLogin } from '../../server/git/github.js';

const answer = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, signal: null, stdout, stderr: exitCode === 0 ? '' : 'You are not logged in', timedOut: false, durationMs: 1, truncated: false });

describe('viewerLogin', () => {
  it('reads the login of the account gh is signed in as, with one read-only call', async () => {
    const seen: (readonly string[])[] = [];
    const exec: Exec = async (spec) => {
      seen.push(spec.args);
      return answer(JSON.stringify({ login: 'octo' }));
    };
    expect(await viewerLogin(process.cwd(), exec)).toBe('octo');
    expect(seen).toEqual([['api', 'user']]);
  });

  it('is null when no account is signed in', async () => {
    expect(await viewerLogin(process.cwd(), async () => answer('', 1))).toBeNull();
  });

  it('is null when gh answers without a login', async () => {
    expect(await viewerLogin(process.cwd(), async () => answer('{}'))).toBeNull();
  });
});
