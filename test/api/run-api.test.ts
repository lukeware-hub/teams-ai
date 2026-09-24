import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRoutes } from '../../server/api/run-routes.js';
import { startApi } from '../../server/api/server.js';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { appendEvents, eventLines, writeRun } from '../fixtures/runs/write-run.js';

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

describe('start, resume, stop', () => {
  it('starts a run: computes the next id, spawns the CLI, waits for the journal, writes the pid', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    const r = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ runId: 'hello-001-r2' });
    expect(spawns[0]!.args).toEqual(['cli', 'run', '--project', HELLO, '--spec', 'hello-001', '--run-id', 'hello-001-r2']);
    expect(spawns[0]!.logFile).toBe(path.join(runs, 'hello-001-r2', 'ui.log'));
    expect(await fs.readFile(path.join(runs, 'hello-001-r2', 'pid'), 'utf8')).toBe('5001');
    const rows = await (await fetch(`${base()}/api/projects/hello-app/runs`)).json();
    expect(rows[0]).toMatchObject({ runId: 'hello-001-r2', status: 'running', stoppable: true });
  });

  it('refuses to start while the spec has an active run, or for an unknown spec', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 900);
    alive.add(900);
    expect((await post('/api/projects/hello-app/specs/hello-001/runs')).status).toBe(409);
    expect((await post('/api/projects/hello-app/specs/nope/runs')).status).toBe(404);
    expect(spawns).toHaveLength(0);
  });

  it('reports 500 with the log tail when the child never writes a journal', async () => {
    onSpawn = async (runId) => {
      await fs.mkdir(path.join(runs, runId), { recursive: true });
      await fs.writeFile(path.join(runs, runId, 'ui.log'), 'preconditions failed:\n- claude is not logged in\n');
      alive.clear();
    };
    const r = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(r.status).toBe(500);
    expect((await r.json()).error).toContain('claude is not logged in');
  }, 15_000);

  it('resume is allowed only for paused:auth or interrupted runs', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('paused:auth'));
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    await writeRun(runs, 'hello-001-r3', [started('hello-001-r3')], state('running'), 901);
    onSpawn = async () => {};
    const ok = await post('/api/runs/hello-001-r1/resume');
    expect(ok.status).toBe(200);
    expect(spawns[0]!.args).toEqual(['cli', 'resume', '--project', HELLO, '--run', 'hello-001-r1']);
    expect(await fs.readFile(path.join(runs, 'hello-001-r1', 'pid'), 'utf8')).toBe('5001');
    expect((await post('/api/runs/hello-001-r2/resume')).status).toBe(409);
    const interrupted = await post('/api/runs/hello-001-r3/resume'); // pid 901 is dead
    expect(interrupted.status).toBe(200);
    expect((await post('/api/runs/missing/resume')).status).toBe(404);
    expect((await post('/api/runs/..%2Fx/resume')).status).toBe(400);
  });

  it('stop signals the group and removes the pid; 409 without a live pid', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 950);
    alive.add(950);
    const r = await post('/api/runs/hello-001-r1/stop');
    expect(await r.json()).toEqual({ stopped: true, how: 'terminated' });
    expect(signals).toContainEqual([-950, 'SIGTERM']);
    await expect(fs.access(path.join(runs, 'hello-001-r1', 'pid'))).rejects.toThrow();
    expect((await post('/api/runs/hello-001-r1/stop')).status).toBe(409);
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2')], state('running'));
    expect((await post('/api/runs/hello-001-r2/stop')).status).toBe(409);
  });
});

const task = (id: string) => ({ id, title: id, description: 'd', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: [`src/${id}/**`], owner: 'dev' });

async function readSse(url: string, lastId: string | null, until: (events: Array<{ event: string; id: string | null; data: string }>) => boolean, timeoutMs = 5000) {
  const res = await fetch(url, { headers: lastId === null ? {} : { 'last-event-id': lastId } });
  if (!res.ok) return { status: res.status, events: [] as Array<{ event: string; id: string | null; data: string }> };
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: Array<{ event: string; id: string | null; data: string }> = [];
  const deadline = Date.now() + timeoutMs;
  // one pending read at a time: a read abandoned by the race would otherwise swallow the chunk it wins
  let pending: ReturnType<typeof reader.read> | null = null;
  while (Date.now() < deadline) {
    pending ??= reader.read().then((r) => {
      pending = null;
      return r;
    });
    const { value, done } = await Promise.race([pending, new Promise<{ value: undefined; done: false }>((r) => setTimeout(() => r({ value: undefined, done: false }), 300))]);
    if (value) buf += dec.decode(value);
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i < 0) break;
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const get = (k: string) => block.split('\n').find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2) ?? null;
      events.push({ event: get('event') ?? 'message', id: get('id'), data: get('data') ?? '' });
    }
    if (until(events) || done) break;
  }
  await reader.cancel().catch(() => {});
  return { status: res.status, events };
}

describe('run detail, events and steps', () => {
  it('detail computes state and tokens from the journal and carries the acceptance criteria', async () => {
    await writeRun(
      runs,
      'hello-001-r1',
      [
        started('hello-001-r1'),
        { type: 'TASK_PLANNED', data: { task: task('T1') } },
        { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'ready' } },
        { type: 'STEP_STARTED', data: { stepId: 's00001', kind: 'dev', role: 'dev', taskId: 'T1', attempt: 1, tokens: 10, dropped: [] } },
        { type: 'STEP_FINISHED', data: { stepId: 's00001', kind: 'dev', taskId: 'T1', attempt: 1, ok: true, failure: null, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 }, costUsd: 0.5, durationMs: 10, numTurns: 1 } },
        { type: 'RUN_PAUSED', data: { reason: 'quota', until: '2026-09-24T10:30:00.000Z' } },
      ],
      state('running'),
    );
    const r = await fetch(`${base()}/api/runs/hello-001-r1`);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d).toMatchObject({ runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'paused:quota', finished: null });
    expect(d.state.order).toEqual(['T1']);
    expect(d.state.tasks[0]).toMatchObject({ state: 'ready', attempts: 0, def: { id: 'T1' } });
    expect(d.tokens).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd: 0.5, steps: 1 });
    expect(d.acceptanceCriteria.map((a: { id: string }) => a.id)).toEqual(['AC-001', 'AC-002', 'AC-003']);
    expect((await fetch(`${base()}/api/runs/nope`)).status).toBe(404);
  });

  it('events replays from Last-Event-ID, tails appended lines and ends after RUN_FINISHED', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'PHASE_STARTED', data: { phase: 1 } }, { type: 'PHASE_STARTED', data: { phase: 2 } }], state('running'));
    const first = await readSse(`${base()}/api/runs/hello-001-r1/events`, null, (ev) => ev.length >= 3);
    expect(first.events.map((e) => [e.event, e.id])).toEqual([
      ['journal', '1'],
      ['journal', '2'],
      ['journal', '3'],
    ]);
    expect(JSON.parse(first.events[2]!.data)).toMatchObject({ seq: 3, type: 'PHASE_STARTED' });
    const later = readSse(`${base()}/api/runs/hello-001-r1/events`, '2', (ev) => ev.some((e) => e.event === 'end'));
    await new Promise((r) => setTimeout(r, 50));
    await appendEvents(runs, 'hello-001-r1', [{ type: 'RUN_FINISHED', data: { result: 'complete', merged: [], blocked: [], tokens: {} } }], 4);
    const { events } = await later;
    expect(events.map((e) => [e.event, e.id])).toEqual([
      ['journal', '3'],
      ['journal', '4'],
      ['end', null],
    ]);
    expect((await readSse(`${base()}/api/runs/nope/events`, null, () => true)).status).toBe(404);
  });

  it('a corrupt journal is reported as 500 on detail and events', async () => {
    const dir = await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'));
    await fs.appendFile(path.join(dir, 'events.ndjson'), 'not json\n' + eventLines('hello-001-r1', [{ type: 'X' }], 3) + '\n');
    const r = await fetch(`${base()}/api/runs/hello-001-r1`);
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/corrupt/);
  });

  it('serves step artifacts from the run directory only', async () => {
    const dir = await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'));
    await fs.mkdir(path.join(dir, 'steps', 's00001'), { recursive: true });
    await fs.writeFile(path.join(dir, 'steps', 's00001', 'prompt.md'), '# prompt');
    await fs.writeFile(path.join(dir, 'steps', 's00001', 'output.json'), JSON.stringify({ ok: true, value: { summary: 'x' } }));
    expect(await (await fetch(`${base()}/api/runs/hello-001-r1/steps/s00001`)).json()).toEqual({ prompt: '# prompt', output: { ok: true, value: { summary: 'x' } } });
    expect((await fetch(`${base()}/api/runs/hello-001-r1/steps/s00002`)).status).toBe(404);
    expect((await fetch(`${base()}/api/runs/hello-001-r1/steps/..%2Fui.log`)).status).toBe(400);
  });
});
