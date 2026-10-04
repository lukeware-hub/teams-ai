import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opsRoutes } from '../../server/api/ops-routes.js';
import { startApi } from '../../server/api/server.js';
import { loadConfig } from '../../server/config/config.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let runs = '';
let api: { port: number; close(): Promise<void> };
const base = () => `http://127.0.0.1:${api.port}`;

beforeEach(async () => {
  runs = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-ops-'));
  const cfg = loadConfig({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] });
  api = await startApi({ routes: opsRoutes({ index: async () => ({ cfg, isAlive: () => false }) }) }, 0);
});
afterEach(async () => {
  await api.close();
  await fs.rm(runs, { recursive: true, force: true });
});

describe('ops routes', () => {
  it('/healthz answers ok', async () => {
    const res = await fetch(`${base()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('/metrics renders runs by status, token and cost totals and the quota pause state', async () => {
    const started = (runId: string) => [{ type: 'RUN_STARTED', data: { specId: 'hello', projectId: 'hello-app' } }];
    await writeRun(runs, 'hello-r1', started('hello-r1'), { at: '2026-09-24T10:00:00.000Z', status: 'paused:quota', tokens: { inputTokens: 100, outputTokens: 50, costUsd: 0.25 } });
    await writeRun(runs, 'hello-r2', [...started('hello-r2'), { type: 'RUN_FINISHED', data: { result: 'done' } }], { at: '2026-09-24T11:00:00.000Z', status: 'done', tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } });
    const res = await fetch(`${base()}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('# TYPE teams_ai_runs gauge');
    expect(text).toMatch(/teams_ai_runs\{status="done"\} 1\n/);
    expect(text).toMatch(/teams_ai_runs\{status="paused:quota"\} 1\n/);
    expect(text).toContain('teams_ai_tokens_total 165\n');
    expect(text).toContain('teams_ai_cost_usd_total 0.75\n');
    expect(text).toContain('teams_ai_quota_paused 1\n');
  });
});
