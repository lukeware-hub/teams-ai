import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRoutes } from '../../server/api/run-routes.js';
import { startApi } from '../../server/api/server.js';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
let runs = '';
let api: { port: number; close(): Promise<void> };
const alive = new Set<number>();
let spawns: Array<{ args: string[]; logFile: string }>;
let signals: Array<[number, string | number]>;
let onSpawn: (runId: string) => Promise<void>;
const base = () => `http://127.0.0.1:${api.port}`;
const post = (p: string, body?: unknown) => fetch(`${base()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runapi-'));
  runs = path.join(home, 'runs');
  await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
  await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }));
  alive.clear();
  spawns = [];
  signals = [];
  onSpawn = async () => {};
  const control: RunControlDeps = {
    spawn: (a) => {
      spawns.push({ args: a.args, logFile: a.logFile });
      const runId = a.args[a.args.indexOf('--run-id') + 1] ?? a.args[a.args.indexOf('--run') + 1]!;
      alive.add(5000 + spawns.length);
      void onSpawn(runId);
      return { pid: 5000 + spawns.length };
    },
    kill: (pid, sig) => {
      signals.push([pid, sig]);
      const p = Math.abs(pid);
      if (!alive.has(p)) return false;
      if (sig === 'SIGTERM' || sig === 'SIGKILL') alive.delete(p);
      return true;
    },
    sleep: async () => {},
    cliEntry: () => ({ bin: 'node', prefix: ['cli'] }),
    repoRoot: '/repo',
  };
  api = await startApi({ routes: runRoutes({ cfg: async () => (await readUserConfig(home)).cfg, home, control }) }, 0);
});
afterEach(async () => {
  await api.close();
  await fs.rm(home, { recursive: true, force: true });
});

const started = (runId: string) => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
const state = (status: string) => ({ runId: 'x', at: '2026-09-24T10:01:00.000Z', status, tasks: [], tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, steps: 1 } });

describe('projects', () => {
  it('lists registered projects with specs and runs', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 1);
    const projects = await (await fetch(`${base()}/api/projects`)).json();
    expect(projects).toEqual([{ projectId: 'hello-app', dir: HELLO, specs: [{ specId: 'hello-001', status: 'running', activeRunId: 'hello-001-r1' }] }]);
    const rows = await (await fetch(`${base()}/api/projects/hello-app/runs`)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: 'hello-001-r1', status: 'interrupted', stoppable: false });
  });

  it('registers a project once and refuses a directory without a valid project.json', async () => {
    const other = path.join(home, 'proj');
    await fs.mkdir(path.join(other, 'docs', 'specs'), { recursive: true });
    await fs.writeFile(path.join(other, 'docs', 'project.json'), await fs.readFile(path.join(HELLO, 'docs', 'project.json'), 'utf8'));
    const ok = await post('/api/projects', { dir: other });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ projectId: 'hello-app', dir: other, specs: [] });
    expect((await post('/api/projects', { dir: other })).status).toBe(200);
    expect((await readUserConfig(home)).cfg.projects).toEqual([{ dir: HELLO }, { dir: other }]);
    const bad = await post('/api/projects', { dir: path.join(home, 'nope') });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/project\.json/);
    expect((await post('/api/projects', { dir: 42 })).status).toBe(400);
    expect((await readUserConfig(home)).cfg.projects).toHaveLength(2);
    expect((await fetch(`${base()}/api/projects/nobody/runs`)).status).toBe(404);
  });
});
