import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { listProjects, listRuns, readProject, SAFE_ID } from '../../server/api/run-index.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
let runs = '';
const alive = new Set<number>();
const deps = () => ({ cfg: loadConfig({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }), home, isAlive: (pid: number) => alive.has(pid) });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-idx-'));
  runs = path.join(home, 'runs');
  alive.clear();
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const started = (runId: string) => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
const state = (status: string) => ({ runId: 'x', at: '2026-09-24T10:01:00.000Z', status, tasks: [], tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25, steps: 2 } });

describe('run index', () => {
  it('readProject parses project.json and every spec', async () => {
    const { project, specs } = await readProject(HELLO);
    expect(project.projectId).toBe('hello-app');
    expect(specs.map((s) => [s.specId, s.status])).toEqual([['hello-001', 'running']]);
    await expect(readProject(home)).rejects.toThrow(/project\.json/);
  });

  it('lists runs newest first with status from state.json, pid liveness and stoppable', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2')], state('paused:auth'));
    await writeRun(runs, 'hello-001-r3', [started('hello-001-r3')], state('running'), 777);
    await writeRun(runs, 'hello-001-r4', [started('hello-001-r4')], state('running'), 778);
    alive.add(778);
    await writeRun(runs, 'other-r1', [{ type: 'RUN_STARTED', data: { runId: 'other-r1', specId: 'o', projectId: 'other' } }], state('running'));
    await fs.mkdir(path.join(runs, 'hello-001-r5'), { recursive: true });
    const rows = await listRuns(deps(), 'hello-app');
    expect(rows.map((r) => [r.runId, r.status, r.stoppable])).toEqual([
      ['hello-001-r5', 'unknown', false],
      ['hello-001-r4', 'running', true],
      ['hello-001-r3', 'interrupted', false],
      ['hello-001-r2', 'paused:auth', false],
      ['hello-001-r1', 'complete', false],
    ]);
    expect(rows[1]).toMatchObject({ specId: 'hello-001', projectId: 'hello-app', tokens: 150, cost: 0.25, at: '2026-09-24T10:01:00.000Z' });
    // the dead pid file is gone after the listing
    await expect(fs.access(path.join(runs, 'hello-001-r3', 'pid'))).rejects.toThrow();
  });

  it('reads a run that left only ui.log behind as launch-failed, dated by that log', async () => {
    await fs.mkdir(path.join(runs, 'hello-001-r1'), { recursive: true });
    await fs.writeFile(path.join(runs, 'hello-001-r1', 'ui.log'), 'boom');
    const [row] = await listRuns(deps(), 'hello-app');
    expect(row).toMatchObject({ runId: 'hello-001-r1', status: 'launch-failed', stoppable: false });
    expect(row!.at).not.toBeNull();
  });

  it('reads a run whose process is alive but has not written state.json yet as running, so its spec is already claimed', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], null, 900); // Phases 0-2 write the journal before any state snapshot
    alive.add(900);
    const rows = await listRuns(deps(), 'hello-app');
    expect(rows.map((r) => [r.runId, r.status, r.stoppable])).toEqual([['hello-001-r1', 'running', true]]);
    expect((await listProjects(deps()))[0]!.specs).toEqual([{ specId: 'hello-001', status: 'running', activeRunId: 'hello-001-r1' }]);
  });

  it('listProjects reports specs with their active run and skips unreadable dirs', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('paused:quota'), 1);
    const d = deps();
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), projects: [{ dir: HELLO }, { dir: path.join(home, 'missing') }] });
    const rows = await listProjects(d);
    expect(rows).toEqual([{
      projectId: 'hello-app', dir: HELLO, name: 'Hello app',
      description: 'A tiny HTTP service that greets by name, used to exercise the orchestrator end to end.',
      specs: [{ specId: 'hello-001', status: 'running', activeRunId: 'hello-001-r1' }],
    }]);
  });

  it('listProjects reports a spec as done once its complete run finished, even while the registered dir still has the pre-merge status', async () => {
    await writeRun(runs, 'hello-001-complete-r1', [started('hello-001-complete-r1'), { type: 'RUN_FINISHED', data: { result: 'done' } }], state('running'));
    const rows = await listProjects(deps());
    expect(rows[0]!.specs).toEqual([{ specId: 'hello-001', status: 'done', activeRunId: null }]);
  });

  it('turns only the newest delivery before a finished completion into done, from the completion journal alone', async () => {
    const at = (iso: string) => ({ ...state('running'), at: iso });
    const finished = (runId: string, result: string) => [started(runId), { type: 'RUN_FINISHED', data: { result } }];
    await writeRun(runs, 'hello-001-r5', finished('hello-001-r5', 'awaiting-validation'), at('2026-09-24T10:05:00.000Z'));
    await writeRun(runs, 'hello-001-r6', finished('hello-001-r6', 'awaiting-validation'), at('2026-09-24T10:06:00.000Z'));
    await writeRun(runs, 'hello-001-complete-r1', finished('hello-001-complete-r1', 'done'), at('2026-09-24T10:07:00.000Z'));
    await writeRun(runs, 'hello-001-r7', finished('hello-001-r7', 'awaiting-validation'), at('2026-09-24T10:08:00.000Z'));
    const rows = await listRuns(deps(), 'hello-app'); // the fixture spec still reads running, as a draft root does
    expect(rows.map((r) => [r.runId, r.status])).toEqual([
      ['hello-001-r7', 'awaiting-validation'],
      ['hello-001-complete-r1', 'done'],
      ['hello-001-r6', 'done'],
      ['hello-001-r5', 'awaiting-validation'],
    ]);
  });

  it('does not count a readme or deploy run finishing "done" as the spec itself being done', async () => {
    await writeRun(runs, 'hello-001-readme-r1', [started('hello-001-readme-r1'), { type: 'RUN_FINISHED', data: { result: 'done' } }], state('running'));
    await writeRun(runs, 'hello-001-deploy-r1', [started('hello-001-deploy-r1'), { type: 'RUN_FINISHED', data: { result: 'done' } }], state('running'));
    const rows = await listProjects(deps());
    expect(rows[0]!.specs).toEqual([{ specId: 'hello-001', status: 'running', activeRunId: null }]);
  });

  it('SAFE_ID rejects path tricks', () => {
    expect(SAFE_ID.test('hello-001-r1')).toBe(true);
    expect(SAFE_ID.test('../x')).toBe(false);
    expect(SAFE_ID.test('a/b')).toBe(false);
    for (const id of ['.', '..', '.hidden', '...']) expect(SAFE_ID.test(id), id).toBe(false);
    expect(SAFE_ID.test('hello-001.r1_x')).toBe(true);
  });
});
