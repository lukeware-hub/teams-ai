import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv, hasScript, shellQuote, spawnScriptPty } from '../../server/onboarding/pty.js';

const FAKE = path.resolve('test/fixtures/fake-cli/gh.sh');

describe('pty helpers', () => {
  it('quotes arguments for a POSIX shell', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });

  it('builds a sanitized child environment with HOME and the extras', () => {
    const env = childEnv({ HOME: '/home/u', PATH: '/bin', GITHUB_TOKEN: 'leak', TERM: 'xterm' }, { FAKE_CLI_SCENARIO: 'success' });
    expect(env).toEqual({ HOME: '/home/u', PATH: '/bin', TERM: 'xterm', FAKE_CLI_SCENARIO: 'success' });
  });
});

describe('spawnScriptPty', async () => {
  const available = await hasScript();
  it.skipIf(!available)('streams the child output, delivers stdin writes and reports the exit code', async () => {
    const pty = spawnScriptPty({ bin: 'bash', args: [FAKE, 'auth', 'login', '--web'], env: childEnv(process.env) });
    const chunks: string[] = [];
    const exit = new Promise<number | null>((resolve) => pty.onExit(resolve));
    pty.onData((c) => {
      chunks.push(c);
      if (chunks.join('').includes('Press Enter')) pty.write('\n');
    });
    expect(await exit).toBe(0);
    const all = chunks.join('');
    expect(all).toContain('one-time code: FAKE-CODE');
    expect(all).toContain('Logged in as fake-user');
  });

  it.skipIf(!available)('kill ends the process', async () => {
    const pty = spawnScriptPty({ bin: 'bash', args: [FAKE, 'auth', 'login'], env: childEnv(process.env, { FAKE_CLI_SCENARIO: 'timeout' }) });
    const exit = new Promise<number | null>((resolve) => pty.onExit(resolve));
    setTimeout(() => pty.kill(), 200);
    expect(await exit).not.toBe(0);
  });
});
