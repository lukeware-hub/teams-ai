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

  it('keeps a run paused by an expired login as paused:auth after its process exits, so nothing resumes it on the same login', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('paused:auth'), 779);
    const [row] = await listRuns(deps(), 'hello-app');
    expect(row).toMatchObject({ runId: 'hello-001-r1', status: 'paused:auth', stoppable: false });
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

  it('listProjects carries the services and the platform of project.json', async () => {
    const dir = path.join(home, 'shop');
    await fs.cp(HELLO, dir, { recursive: true });
    const file = path.join(dir, 'docs', 'project.json');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), services: ['orders', 'inventory'], platform: [{ name: 'nats', image: 'nats:2.10.22-alpine', command: ['-js'] }] }));
    const d = deps();
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), projects: [{ dir }] });
    const [row] = await listProjects(d);
    expect(row!.services).toEqual(['orders', 'inventory']);
    expect(row!.platform).toEqual([{ name: 'nats', image: 'nats:2.10.22-alpine' }]);
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

  it('fills kind and number, and locks every run of a concluded spec', async () => {
    const done = (runId: string) => [started(runId), { type: 'RUN_FINISHED', data: { result: 'done' } }];
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111); // dead pid: interrupted
    await writeRun(runs, 'hello-001-complete-r1', done('hello-001-complete-r1'), state('running'));
    await writeRun(runs, 'hello-001-deploy-r2', done('hello-001-deploy-r2'), state('running'));
    await writeRun(runs, 'hello-001-readme-r3', done('hello-001-readme-r3'), state('running'));
    const rows = await listRuns(deps(), 'hello-app');
    expect(Object.fromEntries(rows.map((r) => [r.runId, [r.kind, r.n, r.locked]]))).toEqual({
      'hello-001-r1': ['run', 1, true],
      'hello-001-complete-r1': ['complete', 1, true],
      'hello-001-deploy-r2': ['deploy', 2, true],
      'hello-001-readme-r3': ['readme', 3, true],
    });
    // the locked interrupted run no longer holds the concluded spec
    expect((await listProjects(deps()))[0]!.specs).toEqual([{ specId: 'hello-001', status: 'done', activeRunId: null }]);
  });

  it('leaves every run unlocked while the spec is not concluded', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'awaiting-validation' } }], state('running'));
    await writeRun(runs, 'hello-001-complete-r1', [started('hello-001-complete-r1'), { type: 'RUN_FINISHED', data: { result: 'phase-failed' } }], state('running'));
    expect((await listRuns(deps(), 'hello-app')).map((r) => r.locked)).toEqual([false, false]);
  });

  it('lists a project registered in several dirs once: each spec takes the status of its own refinement dir', async () => {
    // A started refinement registers its own dir: the second spec's dir also carries a copy of the first spec.
    const second = path.join(home, 'refine', 'hello-002');
    await fs.cp(HELLO, second, { recursive: true });
    const write = async (specId: string, status: string) => {
      const file = path.join(second, 'docs', 'specs', specId, 'spec.json');
      const spec = JSON.parse(await fs.readFile(path.join(HELLO, 'docs', 'specs', 'hello-001', 'spec.json'), 'utf8'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ ...spec, specId, status }));
    };
    await write('hello-001', 'awaiting-validation');
    await write('hello-002', 'awaiting-validation');
    const d = deps();
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), projects: [{ dir: HELLO }, { dir: second }] });
    const rows = await listProjects(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dir).toBe(second); // the newest dir carries the latest project docs
    expect(rows[0]!.specs).toEqual([
      { specId: 'hello-001', status: 'running', activeRunId: null },
      { specId: 'hello-002', status: 'awaiting-validation', activeRunId: null },
    ]);
  });

  it('reports a spec its run delivered from the clone as awaiting-validation, though its own refinement dir still says running', async () => {
    const own = path.join(home, 'refine', 'hello-001');
    await fs.cp(HELLO, own, { recursive: true });
    const clone = path.join(home, 'clone');
    await fs.cp(HELLO, clone, { recursive: true });
    const file = path.join(clone, 'docs', 'specs', 'hello-001', 'spec.json');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), status: 'awaiting-validation' }));
    const d = deps();
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), projects: [{ dir: clone }, { dir: own }] });
    expect((await listProjects(d))[0]!.specs).toEqual([{ specId: 'hello-001', status: 'awaiting-validation', activeRunId: null }]);
  });

  it('SAFE_ID rejects path tricks', () => {
    expect(SAFE_ID.test('hello-001-r1')).toBe(true);
    expect(SAFE_ID.test('../x')).toBe(false);
    expect(SAFE_ID.test('a/b')).toBe(false);
    for (const id of ['.', '..', '.hidden', '...']) expect(SAFE_ID.test(id), id).toBe(false);
    expect(SAFE_ID.test('hello-001.r1_x')).toBe(true);
  });
});
