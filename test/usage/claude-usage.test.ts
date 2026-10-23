import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeUsage, type ClaudeUsageDeps } from '../../server/usage/claude-usage.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const REPLY = readFileSync(fileURLToPath(new URL('../fixtures/usage/get-usage-reply.ndjson', import.meta.url)), 'utf8');
const MINUTE = 60_000;
const answer = (body: unknown) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'usage', response: body } });

let home = '';
let now = 0;
let fake: FakeExec;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-usage-'));
  now = Date.parse('2026-10-23T18:00:00Z');
  fake = new FakeExec().onArgs('claude', ['-p'], () => ({ stdout: REPLY }));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Writes a stored claude.ai login into the temp HOME, expiring `inMs` from now. */
async function login(inMs = 3 * 60 * MINUTE, tier?: string) {
  await mkdir(path.join(home, '.claude'), { recursive: true });
  const oauth = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: now + inMs, subscriptionType: 'max', ...(tier ? { rateLimitTier: tier } : {}) };
  await writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
}

function usage(overrides: Partial<ClaudeUsageDeps> = {}) {
  return createClaudeUsage({ exec: fake.exec, hostEnv: { HOME: home }, authMode: async () => 'subscription', now: () => now, ...overrides });
}

describe('claude usage', () => {
  it('reads the plan rows as the server sent them, with the plan tier', async () => {
    await login(3 * 60 * MINUTE, 'default_claude_max_5x');
    expect(await usage()()).toEqual({
      available: true,
      plan: 'Max (5x)',
      limits: [
        { kind: 'session', label: null, percent: 84, severity: 'warning', resetsAt: '2026-10-23T20:10:00.368027+00:00', allowancePercent: null },
        { kind: 'weekly_all', label: null, percent: 62, severity: 'normal', resetsAt: '2026-10-24T12:00:00.368052+00:00', allowancePercent: null },
        { kind: 'weekly_scoped', label: 'Fable', percent: 0, severity: 'normal', resetsAt: '2026-10-24T12:00:00.368243+00:00', allowancePercent: 50 },
      ],
    });
    expect(fake.calls[0]?.stdin).toContain('"subtype":"get_usage"');
  });

  it('names the plan without a tier', async () => {
    await login();
    expect(await usage()()).toMatchObject({ available: true, plan: 'Max' });
  });

  it('says there is no plan when the CLI reports no plan limits', async () => {
    await login();
    fake = new FakeExec().onArgs('claude', ['-p'], () => ({ stdout: answer({ subscription_type: 'max', rate_limits_available: false, rate_limits: null }) }));
    expect(await usage()()).toEqual({ available: false, reason: 'no-plan' });
  });

  it.each([
    ['an error reply', { stdout: JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'usage', error: 'boom' } }) }],
    ['a failed exit', { exitCode: 1, stdout: '', stderr: 'boom' }],
    ['a timeout', { exitCode: null, timedOut: true, stdout: '' }],
    ['no JSON', { stdout: 'not json' }],
    ['a reply in another shape', { stdout: answer({ subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: 'broken' } }) }],
  ])('gives failed for %s', async (_name, result) => {
    await login();
    fake = new FakeExec().onArgs('claude', ['-p'], () => result);
    expect(await usage()()).toEqual({ available: false, reason: 'failed' });
  });

  it('says not logged in without a stored login and does not run the CLI', async () => {
    expect(await usage()()).toEqual({ available: false, reason: 'not-logged-in' });
    expect(fake.calls).toHaveLength(0);
  });

  it('does not run the CLI while the stored login is about to renew', async () => {
    await login(4 * MINUTE);
    expect(await usage()()).toEqual({ available: false, reason: 'renewing' });
    expect(fake.calls).toHaveLength(0);
  });

  it('says api-key when the agents bill an API key, without running the CLI', async () => {
    await login();
    expect(await usage({ authMode: async () => 'api-key' })()).toEqual({ available: false, reason: 'api-key' });
    expect(fake.calls).toHaveLength(0);
  });

  it('runs the CLI with an environment token, which never renews', async () => {
    expect(await usage({ hostEnv: { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } })()).toMatchObject({ available: true, plan: 'Max' });
    expect(fake.calls).toHaveLength(1);
  });

  it('runs the CLI at most once a minute', async () => {
    await login();
    const read = usage();
    await read();
    now += 30 * 1000;
    await read();
    expect(fake.calls).toHaveLength(1);
    now += 31 * 1000;
    await read();
    expect(fake.calls).toHaveLength(2);
  });

  it('shares one run between calls that arrive together', async () => {
    await login();
    const read = usage();
    await Promise.all([read(), read()]);
    expect(fake.calls).toHaveLength(1);
  });
});
