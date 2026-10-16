import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMachine } from '../../server/license/machine.js';

let home = '';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-machine-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('machine data', () => {
  it('prefers the host data and keeps the same fingerprint across reads', async () => {
    const env = { TEAMS_AI_HOST_NAME: 'DESKTOP-1', TEAMS_AI_HOST_USER: 'diego', TEAMS_AI_HOST_OS: 'Windows_NT' };
    const first = await readMachine(home, env);
    expect(first).toMatchObject({ hostname: 'DESKTOP-1', user: 'diego', os: 'Windows_NT' });
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await readMachine(home, env)).fingerprint).toBe(first.fingerprint);
  });

  it('gives another installation another fingerprint', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-machine-'));
    try {
      expect((await readMachine(other, {})).fingerprint).not.toBe((await readMachine(home, {})).fingerprint);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
