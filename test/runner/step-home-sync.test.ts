import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncBackCredentials } from '../../server/runner/step-home.js';
import { classifyFailure } from '../../server/runner/step.js';

let dir: string;
let hostHome: string;
let stepHome: string;
const cred = (expiresAt: number, refreshToken = 'r') => JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken, expiresAt } });
const hostFile = () => path.join(hostHome, '.claude', '.credentials.json');
const stepFile = () => path.join(stepHome, '.claude', '.credentials.json');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-credsync-'));
  hostHome = path.join(dir, 'host');
  stepHome = path.join(dir, 'step');
  await fs.mkdir(path.join(hostHome, '.claude'), { recursive: true });
  await fs.mkdir(path.join(stepHome, '.claude'), { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('syncBackCredentials', () => {
  it('writes a token the CLI refreshed inside the step HOME back to the host, so the rotated refresh token is not lost', async () => {
    await fs.writeFile(hostFile(), cred(1_000, 'old-refresh'));
    await fs.writeFile(stepFile(), cred(9_000, 'new-refresh'));
    await syncBackCredentials(stepHome, { HOME: hostHome });
    expect(JSON.parse(await fs.readFile(hostFile(), 'utf8')).claudeAiOauth).toMatchObject({ refreshToken: 'new-refresh', expiresAt: 9_000 });
    if (process.platform !== 'win32') expect((await fs.stat(hostFile())).mode & 0o777).toBe(0o600);
  });

  it('leaves the host file alone when the step did not refresh (same or older expiry)', async () => {
    await fs.writeFile(hostFile(), cred(5_000, 'host-refresh'));
    await fs.writeFile(stepFile(), cred(5_000, 'host-refresh'));
    await syncBackCredentials(stepHome, { HOME: hostHome });
    await fs.writeFile(stepFile(), cred(1_000, 'stale'));
    await syncBackCredentials(stepHome, { HOME: hostHome });
    expect(JSON.parse(await fs.readFile(hostFile(), 'utf8')).claudeAiOauth.refreshToken).toBe('host-refresh');
  });

  it('never writes an invalid or refresh-less file, and does nothing without a step credential', async () => {
    await fs.writeFile(hostFile(), cred(1_000, 'host-refresh'));
    await fs.writeFile(stepFile(), '{ not json');
    await syncBackCredentials(stepHome, { HOME: hostHome });
    await fs.writeFile(stepFile(), JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: 9_000 } }));
    await syncBackCredentials(stepHome, { HOME: hostHome });
    await fs.rm(stepFile());
    await syncBackCredentials(stepHome, { HOME: hostHome });
    expect(JSON.parse(await fs.readFile(hostFile(), 'utf8')).claudeAiOauth.refreshToken).toBe('host-refresh');
  });

  it('creates the host file when the host has none (first login done in the step)', async () => {
    await fs.writeFile(stepFile(), cred(9_000, 'fresh'));
    await fs.rm(hostFile(), { force: true });
    await syncBackCredentials(stepHome, { HOME: hostHome });
    expect(JSON.parse(await fs.readFile(hostFile(), 'utf8')).claudeAiOauth.refreshToken).toBe('fresh');
  });
});

describe('expired login is an auth failure, not a code failure', () => {
  const raw = (resultText: string) => ({ summary: { found: true, isError: true, subtype: 'success', resultText, apiErrorStatus: null, rateLimit: null, compactions: 0, terminalReason: null }, killedBy: null, sandboxDisabled: false }) as never;
  it('recognizes the CLI messages of a dead OAuth session', () => {
    for (const text of ['Failed to authenticate: OAuth session expired and could not be refreshed', 'OAuth session expired', 'API Error: authentication_error', 'Please run /login']) {
      expect(classifyFailure(raw(text)), text).toBe('auth');
    }
  });
  it('does not turn an unrelated failure into auth', () => {
    expect(classifyFailure(raw('Tests failed in auth.test.ts'))).toBe('code');
  });
});
