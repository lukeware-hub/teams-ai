import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settingsRoutes } from '../../server/api/settings-routes.js';
import { startApi } from '../../server/api/server.js';

let api: { port: number; close(): Promise<void> };
let home = '';
const base = () => `http://127.0.0.1:${api.port}/api/settings/agents`;
const put = (url: string, body: unknown) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-settings-'));
  api = await startApi({ routes: settingsRoutes({ home }) }, 0);
});
afterEach(async () => {
  await api.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe('settings routes', () => {
  it('lists the nine agents on automatic by default, then shows a manual pick', async () => {
    const first = (await (await fetch(`${base()}/demo`)).json()) as { agents: Array<{ role: string; setting: unknown }> };
    expect(first.agents.map((a) => a.role)).toEqual(['sm', 'po', 'front', 'dev', 'test', 'sec', 'devops', 'env']);
    expect(first.agents.every((a) => a.setting === null)).toBe(true);

    expect((await put(`${base()}/demo/dev`, { mode: 'manual', model: 'claude-opus-5-5', effort: 'max' })).status).toBe(200);
    const after = (await (await fetch(`${base()}/demo`)).json()) as { agents: Array<{ role: string; setting: unknown }> };
    expect(after.agents.find((a) => a.role === 'dev')!.setting).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
  });

  it('gives an agent back to automatic with mode auto', async () => {
    await put(`${base()}/demo/dev`, { mode: 'manual', model: 'claude-haiku-5-5', effort: 'low' });
    expect((await put(`${base()}/demo/dev`, { mode: 'auto' })).status).toBe(200);
    const after = (await (await fetch(`${base()}/demo`)).json()) as { agents: Array<{ setting: unknown }> };
    expect(after.agents.every((a) => a.setting === null)).toBe(true);
  });

  it('refuses an unknown role with 404 and a bad model, effort, mode or project id with 400', async () => {
    expect((await put(`${base()}/demo/qa`, { mode: 'auto' })).status).toBe(404);
    expect((await put(`${base()}/demo/dev`, { mode: 'manual', model: 'gpt', effort: 'low' })).status).toBe(400);
    expect((await put(`${base()}/demo/dev`, { mode: 'manual', model: 'claude-opus-5-5', effort: 'turbo' })).status).toBe(400);
    expect((await put(`${base()}/demo/dev`, { mode: 'nope' })).status).toBe(400);
    expect((await put(`${base()}/Bad_Id/dev`, { mode: 'auto' })).status).toBe(400);
    expect((await fetch(`${base()}/Bad_Id`)).status).toBe(400);
  });

  it('gives a project its time limit in minutes, 20 by default, and saves a new one', async () => {
    const url = `http://127.0.0.1:${api.port}/api/settings/step-timeout/demo`;
    expect(await (await fetch(url)).json()).toEqual({ timeoutMinutes: 60 });
    expect((await put(url, { timeoutMinutes: 45 })).status).toBe(200);
    expect(await (await fetch(url)).json()).toEqual({ timeoutMinutes: 45 });
  });

  it('refuses a time limit that is not a whole number of minutes a timer can hold, and keeps the old one', async () => {
    const url = `http://127.0.0.1:${api.port}/api/settings/step-timeout/demo`;
    for (const body of [{}, { timeoutMinutes: 0 }, { timeoutMinutes: 1.5 }, { timeoutMinutes: '45' }, { timeoutMinutes: 35_792 }]) {
      expect((await put(url, body)).status).toBe(400);
    }
    expect(await (await fetch(url)).json()).toEqual({ timeoutMinutes: 60 });
  });
});
