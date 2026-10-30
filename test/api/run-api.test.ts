import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { commitAll } from '../../server/git/git.js';
import { claimLaunch } from '../../server/api/run-index.js';
import { runRoutes } from '../../server/api/run-routes.js';
import { startApi } from '../../server/api/server.js';
import type { RunControlDeps } from '../../server/api/run-control.js';
import type { HttpGet } from '../../server/deploy/target.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { superviseTick, type SuperviseDeps } from '../../server/supervisor/supervise.js';
import { appendEvents, eventLines, writeRun } from '../fixtures/runs/write-run.js';
import { makeFrozenSpec, makePlan, makeServicesPlan } from '../fixtures/contracts.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
let runs = '';
let api: { port: number; close(): Promise<void> };
const alive = new Set<number>();
let control: RunControlDeps;
let spawns: Array<{ args: string[]; logFile: string }>;
let signals: Array<[number, string | number]>;
let onSpawn: (runId: string) => Promise<void>;
/** What the last fake child is still writing; the launch's wait lets it finish before looking for its journal. */
let spawning: Promise<void> = Promise.resolve();
let onSignal: () => void;
let onSleep: () => Promise<void>;
let cloned: Array<{ url: string; destination: string }>;
let backlogStarted: string[];
let probe: HttpGet;
let probed: string[];
const docker: string[] = [];
let resolved: Record<string, string> = {};
const base = () => `http://127.0.0.1:${api.port}`;
const post = (p: string, body?: unknown) => fetch(`${base()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const del = (p: string) => fetch(`${base()}${p}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runapi-'));
  runs = path.join(home, 'runs');
  await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
  await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }));
  alive.clear();
  spawns = [];
  signals = [];
  cloned = [];
  backlogStarted = [];
  probed = [];
  probe = async () => ({ status: 200 });
  resolved = {};
  onSpawn = async () => {};
  onSignal = () => {};
  // A real wait loop yields real time; an instant one let the fake child lose the race under a loaded suite.
  onSleep = () => new Promise((r) => setTimeout(r, 1));
  control = {
    spawn: (a) => {
      spawns.push({ args: a.args, logFile: a.logFile });
      const runId = a.args[a.args.indexOf('--run-id') + 1] ?? a.args[a.args.indexOf('--run') + 1]!;
      alive.add(5000 + spawns.length);
      spawning = onSpawn(runId);
      return { pid: 5000 + spawns.length };
    },
    kill: (pid, sig) => {
      signals.push([pid, sig]);
      const p = Math.abs(pid);
      if (!alive.has(p)) return false;
      if (sig === 'SIGTERM' || sig === 'SIGKILL') alive.delete(p);
      if (sig === 'SIGTERM') onSignal();
      return true;
    },
    sleep: async () => {
      await spawning;
      await onSleep();
    },
    cliEntry: () => ({ bin: 'node', prefix: ['cli'] }),
    repoRoot: '/repo',
  };
  docker.length = 0;
  api = await startApi({ routes: runRoutes({ cfg: async () => (await readUserConfig(home)).cfg, home, control, exec: async (s) => { docker.push(s.args.join(" ")); return { exitCode: 0, stdout: "", stderr: "", timedOut: false } as never; }, httpGet: async (u, t) => { probed.push(u); return probe(u, t); }, clearChat: async (id) => fs.rm(path.join(home, '.teams-ai', 'chats', `${id}.json`), { force: true }), resolveHost: async (n) => [resolved[n] ?? '140.82.112.3'], importBacklog: async (projectId) => { backlogStarted.push(projectId); }, cloneProject: async (url, destination) => { cloned.push({ url, destination }); await (url.includes('no-docs') ? fs.mkdir(destination, { recursive: true }) : fs.cp(HELLO, destination, { recursive: true })); if (url.includes('backlog-app')) await fs.writeFile(path.join(destination, 'docs', 'specs', 'hello-001', 'spec.json'), (await fs.readFile(path.join(destination, 'docs', 'specs', 'hello-001', 'spec.json'), 'utf8')).replace('"status": "running"', '"status": "planned"'));if (url.includes('walks-out')) await fs.writeFile(path.join(destination, 'docs', 'project.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(path.join(HELLO, 'docs', 'project.json'), 'utf8')), services: ['../../../escaped'] })); } }) }, 0);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.close();
  await fs.rm(home, { recursive: true, force: true });
});

const started = (runId: string) => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
const state = (status: string) => ({ runId: 'x', at: '2026-09-24T10:01:00.000Z', status, tasks: [], tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, steps: 1 } });

/** The supervisor of the same project, sharing the fake process table with the routes. */
const supervisorDeps = async (): Promise<SuperviseDeps> => ({ idx: { cfg: (await readUserConfig(home)).cfg, home, isAlive: (pid) => alive.has(pid) }, control, projectDir: HELLO, intervalMs: 1000, now: () => 0, log: () => {} });

/** Pauses the launch of `runId` right before it spawns: the route has passed its checks, nothing is spawned yet. */
function holdLaunch(runId: string): { reached: Promise<void>; release: () => void } {
  let reached = () => {};
  let release = () => {};
  const hit = new Promise<void>((r) => (reached = r));
  const open = new Promise<void>((r) => (release = r));
  const realMkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
    if (path.resolve(String(args[0])) === path.resolve(runs, runId)) {
      reached();
      await open;
    }
    return realMkdir(...args);
  }) as typeof fs.mkdir);
  return { reached: hit, release: () => release() };
}

/** Registers a copy of the hello project whose spec is awaiting validation, the only status `complete` accepts. */
async function useAwaitingValidationProject(): Promise<void> {
  const project = path.join(home, 'project');
  await fs.cp(HELLO, project, { recursive: true });
  const file = path.join(project, 'docs', 'specs', 'hello-001', 'spec.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), status: 'awaiting-validation' }));
  await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: project }] }));
}

describe('projects', () => {
  it('lists registered projects with specs and runs', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 1);
    const projects = await (await fetch(`${base()}/api/projects`)).json();
    // repoUrl depends on the origin of the checkout holding the fixture.
    expect(projects).toMatchObject([{
      projectId: 'hello-app', dir: HELLO, name: 'Hello app',
      description: 'A tiny HTTP service that greets by name, used to exercise the orchestrator end to end.',
      specs: [{ specId: 'hello-001', status: 'running', activeRunId: 'hello-001-r1' }],
    }]);
    const rows = await (await fetch(`${base()}/api/projects/hello-app/runs`)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: 'hello-001-r1', status: 'interrupted', stoppable: false });
  });

  it('shows the run that delivered a concluded spec as done, not awaiting validation', async () => {
    await useAwaitingValidationProject();
    const specFile = path.join(home, 'project', 'docs', 'specs', 'hello-001', 'spec.json');
    const finished = { type: 'RUN_FINISHED', data: { result: 'awaiting-validation' } };
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), finished], state('awaiting-validation'), 1);
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), finished], state('awaiting-validation'), 2);
    const status = async (): Promise<Record<string, string>> => Object.fromEntries((await (await fetch(`${base()}/api/projects/hello-app/runs`)).json()).map((r: { runId: string; status: string }) => [r.runId, r.status]));
    expect(await status()).toEqual({ 'hello-001-r1': 'awaiting-validation', 'hello-001-r2': 'awaiting-validation' });
    await fs.writeFile(specFile, JSON.stringify({ ...JSON.parse(await fs.readFile(specFile, 'utf8')), status: 'done' }));
    // only the newest run delivered the spec; the older one keeps what its journal says
    expect(await status()).toEqual({ 'hello-001-r1': 'awaiting-validation', 'hello-001-r2': 'done' });
    // the single-run endpoint answers with the same status as the list
    const detail = async (runId: string): Promise<string> => (await (await fetch(`${base()}/api/runs/${runId}`)).json()).status;
    expect([await detail('hello-001-r1'), await detail('hello-001-r2')]).toEqual(['awaiting-validation', 'done']);
  });

  it('lists each service of a project with the GitHub page of its clone, also right after registering it', async () => {
    const project = path.join(home, '.teams-ai', 'workspaces', 'shop-docs');
    await fs.cp(HELLO, project, { recursive: true });
    const json = path.join(project, 'docs', 'project.json');
    await fs.writeFile(json, JSON.stringify({ ...JSON.parse(await fs.readFile(json, 'utf8')), services: ['orders-api', 'inventory-api'] }));
    const clone = path.join(home, '.teams-ai', 'workspaces', 'hello-app', 'services', 'orders-api', 'repo');
    await fs.mkdir(clone, { recursive: true });
    await execCommand({ bin: 'git', args: ['init', '-q'], cwd: clone, timeoutMs: 10_000 });
    await execCommand({ bin: 'git', args: ['remote', 'add', 'origin', 'https://github.com/acme/orders-api.git'], cwd: clone, timeoutMs: 10_000 });
    const registered = await (await post('/api/projects', { dir: project })).json();
    expect(registered.services).toEqual([{ name: 'orders-api', repoUrl: 'https://github.com/acme/orders-api' }, { name: 'inventory-api', repoUrl: null }]);
    const listed = (await (await fetch(`${base()}/api/projects`)).json()) as Array<{ services?: unknown }>;
    expect(listed.find((p) => p.services)!.services).toEqual(registered.services);
  });

  it('registers a project once and refuses a directory without a valid project.json', async () => {
    const other = path.join(home, '.teams-ai', 'workspaces', 'proj');
    await fs.mkdir(path.join(other, 'docs', 'specs'), { recursive: true });
    await fs.writeFile(path.join(other, 'docs', 'project.json'), await fs.readFile(path.join(HELLO, 'docs', 'project.json'), 'utf8'));
    const ok = await post('/api/projects', { dir: other });
    expect(ok.status).toBe(200);
    // Same project id as HELLO: one project, the newest dir first, with the specs of both dirs.
    expect(await ok.json()).toMatchObject({ projectId: 'hello-app', dir: other, specs: [{ specId: 'hello-001' }] });
    expect((await post('/api/projects', { dir: other })).status).toBe(200);
    expect((await readUserConfig(home)).cfg.projects).toEqual([{ dir: HELLO }, { dir: other }]);
    const bad = await post('/api/projects', { dir: path.join(home, '.teams-ai', 'workspaces', 'nope') });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/project\.json/);
    expect((await post('/api/projects', { dir: 42 })).status).toBe(400);
    // Audit M1: a valid project outside paths.workspaces is not registered (HELLO is already listed, so use a copy elsewhere).
    const outside = path.join(home, 'outside');
    await fs.mkdir(path.join(outside, 'docs'), { recursive: true });
    await fs.writeFile(path.join(outside, 'docs', 'project.json'), await fs.readFile(path.join(HELLO, 'docs', 'project.json'), 'utf8'));
    const refused = await post('/api/projects', { dir: outside });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/paths\.workspaces/);
    expect((await post('/api/projects', { dir: path.join(other, '..', '..', '..', 'outside') })).status).toBe(400);
    expect((await readUserConfig(home)).cfg.projects).toHaveLength(2);
    expect((await fetch(`${base()}/api/projects/nobody/runs`)).status).toBe(404);
  });
  it('validates a Git URL, clones it into an isolated directory and supports multiple imports', async () => {
    expect((await post('/api/projects', { url: 'github.com/acme/demo' })).status).toBe(400);
    const first = await post('/api/projects', { url: 'https://github.com/acme/demo.git' });
    const second = await post('/api/projects', { url: 'https://github.com/acme/another.git' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(cloned).toHaveLength(2);
    expect(cloned[0]!.destination).toContain(`${path.sep}imports${path.sep}demo-`);
    expect(cloned[1]!.destination).toContain(`${path.sep}imports${path.sep}another-`);
    // The download moves to the project's own clone, where refinement and runs look for it.
    const repo = path.posix.join(home, '.teams-ai', 'workspaces', 'hello-app', 'repo');
    expect((await first.json()).dir).toBe(repo);
    expect((await fs.stat(path.join(repo, 'docs', 'project.json'))).isFile()).toBe(true);
    await expect(fs.access(cloned[0]!.destination)).rejects.toThrow();
    // Both fixtures are the same project, so they share one clone.
    expect((await readUserConfig(home)).cfg.projects.map((p) => p.dir)).toEqual(expect.arrayContaining([repo]));
    expect((await readUserConfig(home)).cfg.projects.map((p) => p.dir)).not.toContain(cloned[0]!.destination);
  });

  it('starts the backlog of a git import only when it holds a planned spec', async () => {
    expect((await post('/api/projects', { url: 'https://github.com/acme/hello-app.git' })).status).toBe(200);
    expect(backlogStarted).toEqual([]);
    expect((await post('/api/projects', { url: 'https://github.com/acme/backlog-app.git' })).status).toBe(200);
    expect(backlogStarted).toEqual(['hello-app']);
  });

  it('tells an import of a repository without docs/project.json to import the project repository instead', async () => {
    const res = await post('/api/projects', { url: 'https://github.com/acme/shop-no-docs.git' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/docs\/project\.json não foi encontrado; .*serviço.*repositório de documentação/);
  });

  it('refuses a service name that walks out of the workspace, before any service is cloned', async () => {
    const res = await post('/api/projects', { url: 'https://github.com/acme/walks-out.git' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/docs\/project\.json inválido/);
    expect(cloned.map((c) => c.url)).toEqual(['https://github.com/acme/walks-out.git']);
  });

  it('refuses an import whose project id already belongs to a clone of another repository', async () => {
    const repo = path.posix.join(home, '.teams-ai', 'workspaces', 'hello-app', 'repo');
    await fs.mkdir(repo, { recursive: true });
    for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/acme/owner.git']]) await execCommand({ bin: 'git', args, cwd: repo, timeoutMs: 10_000 });
    const res = await post('/api/projects', { url: 'https://github.com/acme/intruder.git' });
    expect(res.status).toBe(409);
    expect((await readUserConfig(home)).cfg.projects.map((p) => p.dir)).not.toContain(repo);
  });

  it('refuses hosts outside the allowlist, private literals, internal names and private resolutions (audit M1)', async () => {
    const err = async (url: string) => {
      const r = await post('/api/projects', { url });
      expect(r.status).toBe(400);
      return (await r.json()).error as string;
    };
    expect(await err('https://evil.example/acme/demo.git')).toMatch(/lista permitida/);
    expect(await err('http://169.254.169.254/acme/demo.git')).toMatch(/lista permitida/);
    expect(await err('https://kubernetes.default.svc/acme/demo.git')).toMatch(/lista permitida/);
    expect(cloned).toHaveLength(0);
    // A listed host is still refused when it is private or resolves to a private address.
    await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }], github: { allowedHosts: ['github.com', '10.0.0.5', 'git.internal', 'sneaky.example'] } }));
    expect(await err('http://10.0.0.5/acme/demo.git')).toMatch(/interno/);
    expect(await err('https://git.internal/acme/demo.git')).toMatch(/interno/);
    resolved['sneaky.example'] = '169.254.169.254';
    expect(await err('https://sneaky.example/acme/demo.git')).toMatch(/interno/);
    expect(cloned).toHaveLength(0);
    expect((await readUserConfig(home)).cfg.projects).toEqual([{ dir: HELLO }]);
  });

  it('deletes a project from disk: its directory, workspace root, gate caches, runs and config entry, and takes down each of its services', async () => {
    const project = path.join(home, 'project');
    await fs.cp(HELLO, project, { recursive: true });
    const json = path.join(project, 'docs', 'project.json');
    await fs.writeFile(json, JSON.stringify({ ...JSON.parse(await fs.readFile(json, 'utf8')), services: ['orders-api'] }));
    await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: project }] }));
    const ws = path.join(home, '.teams-ai', 'workspaces', 'hello-app');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'marker.txt'), 'x');
    const gates = path.join(home, '.teams-ai', 'gate-cache');
    const gateCache = path.join(gates, 'gates', 'hello-app');
    const cargoRoot = path.join(gates, 'cargo-root', 'hello-app');
    await fs.mkdir(gateCache, { recursive: true });
    await fs.mkdir(cargoRoot, { recursive: true });
    const otherGateCache = path.join(gates, 'gates', 'other-app');
    await fs.mkdir(otherGateCache, { recursive: true });
    const chat = path.join(home, '.teams-ai', 'chats', 'hello-app.json');
    await fs.mkdir(path.dirname(chat), { recursive: true });
    await fs.writeFile(chat, '[]');
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'done' } }], state('done'), 1);
    // Another project with a spec of the same id keeps its run.
    const other = { type: 'RUN_STARTED', data: { runId: 'other-app--hello-001--run-1', specId: 'hello-001', projectId: 'other-app' } };
    await writeRun(runs, 'other-app--hello-001--run-1', [other], state('done'), 2);
    const exists = (p: string) => fs.access(p).then(() => true, () => false);
    const res = await del('/api/projects/hello-app');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await exists(project)).toBe(false);
    expect(await exists(ws)).toBe(false);
    expect(await exists(gateCache)).toBe(false);
    expect(await exists(cargoRoot)).toBe(false);
    expect(await exists(otherGateCache)).toBe(true);
    expect(await exists(chat)).toBe(false);
    expect(await exists(path.join(runs, 'hello-001-r1'))).toBe(false);
    expect(await exists(path.join(runs, 'other-app--hello-001--run-1'))).toBe(true);
    expect((await readUserConfig(home)).cfg.projects).toEqual([]);
    expect(docker).toEqual(expect.arrayContaining(['compose -p teams-ai-hello-app down -v', 'compose -p teams-ai-hello-app--orders-api down -v', 'network rm teams-ai-hello-app_net']));
  });

  it('gives a run the services plan of its spec', async () => {
    const project = path.join(home, 'project');
    await fs.cp(HELLO, project, { recursive: true });
    await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: project }] }));
    await fs.writeFile(path.join(project, 'docs', 'specs', 'hello-001', 'plan.json'), JSON.stringify(makeServicesPlan(makeFrozenSpec({ specId: 'hello-001' }))));
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 1);
    const detail = await (await fetch(`${base()}/api/runs/hello-001-r1`)).json();
    expect(Object.keys(detail.plan.services)).toEqual(['orders-api', 'inventory-api']);
  });

  it('stops an active run, then deletes the project', async () => {
    const project = path.join(home, 'project');
    await fs.cp(HELLO, project, { recursive: true });
    await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: project }] }));
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 1);
    alive.add(1);
    const res = await del('/api/projects/hello-app');
    expect(res.status).toBe(200);
    expect(alive.has(1)).toBe(false);
    expect(await fs.access(project).then(() => true, () => false)).toBe(false);
  });

  it('404s deleting an unknown project', async () => {
    expect((await del('/api/projects/nobody')).status).toBe(404);
  });
});

describe('start, resume, stop', () => {
  it('starts a spec from the registered directory that holds it when several directories share the project id', async () => {
    const other = path.join(home, 'other-draft'); // every draft registers its own root; this one has no spec of its own
    await fs.cp(HELLO, other, { recursive: true });
    await fs.rm(path.join(other, 'docs', 'specs', 'hello-001'), { recursive: true });
    await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: other }, { dir: HELLO }] }));
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    const r = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(r.status).toBe(200);
    expect(spawns[0]!.args).toEqual(['cli', 'run', '--project', HELLO, '--spec', 'hello-001', '--run-id', 'hello-app--hello-001--run-1']);
  });

  it('starts a run: computes the next id, spawns the CLI, waits for the journal, writes the pid', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    const r = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ runId: 'hello-app--hello-001--run-2' });
    expect(spawns[0]!.args).toEqual(['cli', 'run', '--project', HELLO, '--spec', 'hello-001', '--run-id', 'hello-app--hello-001--run-2']);
    expect(spawns[0]!.logFile).toBe(path.join(runs, 'hello-app--hello-001--run-2', 'ui.log'));
    expect(await fs.readFile(path.join(runs, 'hello-app--hello-001--run-2', 'pid'), 'utf8')).toBe('5001');
    const rows = await (await fetch(`${base()}/api/projects/hello-app/runs`)).json();
    expect(rows[0]).toMatchObject({ runId: 'hello-app--hello-001--run-2', status: 'running', stoppable: true });
  });

  it('two concurrent starts on one spec launch exactly one run', async () => {
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    const [a, b] = await Promise.all([post('/api/projects/hello-app/specs/hello-001/runs'), post('/api/projects/hello-app/specs/hello-001/runs')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(spawns).toHaveLength(1);
    const again = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(again.status).toBe(409); // the run is now live, not just launching
  });

  it('two concurrent resumes of one run launch exactly one process', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('paused:auth'));
    const [a, b] = await Promise.all([post('/api/runs/hello-001-r1/resume'), post('/api/runs/hello-001-r1/resume')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(spawns).toHaveLength(1);
  });

  // One writer per spec: while one of start, complete and readme is launching, the other two answer 409.
  const WRITERS = {
    start: { url: '/api/projects/hello-app/specs/hello-001/runs', runId: 'hello-app--hello-001--run-2' },
    complete: { url: '/api/projects/hello-app/specs/hello-001/complete', runId: 'hello-app--hello-001--complete-run-1' },
    readme: { url: '/api/runs/hello-001-r1/readme', runId: 'hello-app--hello-001--readme-run-1' },
  };
  // Start needs a running spec and complete one awaiting validation, so each pair runs on a spec both of its writers accept.
  it.each([
    ['start', 'readme', 'running'],
    ['readme', 'start', 'running'],
    ['complete', 'readme', 'awaiting-validation'],
    ['readme', 'complete', 'awaiting-validation'],
  ] as const)('while %s is launching, %s on the same %s spec answers 409 and only one process is spawned', async (first, second, status) => {
    if (status === 'awaiting-validation') await useAwaitingValidationProject();
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'awaiting-validation' } }], state('running'));
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    const hold = holdLaunch(WRITERS[first].runId);
    const winner = post(WRITERS[first].url);
    await hold.reached; // inside its critical section, nothing spawned yet
    const loser = await post(WRITERS[second].url);
    hold.release();
    expect((await winner).status).toBeLessThan(300);
    expect(loser.status).toBe(409);
    expect(spawns).toHaveLength(1);
  });

  it('stores the owner answers to a block, shows them on the run, and refuses a task nobody asked about', async () => {
    // The fixture project is the repository's own folder: its answers must not outlive the test.
    onTestFinished(() => fs.rm(path.join(HELLO, 'decisions'), { recursive: true, force: true }));
    const options =[{ label: 'Go 1.26.9', detail: 'O gate já tem essa versão.', recommended: true }, { label: 'Go 1.27.2', detail: 'Exige outra imagem.' }];
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'DECISION_REQUESTED', data: { taskId: 'T1-a', reason: 'no toolchain', question: 'Qual versão do Go?', options } }], state('blocked'), 1);
    const post = (body: unknown) => fetch(`${base()}/api/runs/hello-001-r1/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ decisions: [{ taskId: 'T9', answer: 'x' }] })).status).toBe(404);
    expect((await post({ decisions: [] })).status).toBe(400);
    expect((await post({ decisions: [{ taskId: 'T1-a', answer: 'Go 1.26.9' }] })).status).toBe(200);
    const detail = await (await fetch(`${base()}/api/runs/hello-001-r1`)).json();
    expect(detail.decisions).toEqual([{ taskId: 'T1-a', question: 'Qual versão do Go?', options, answer: 'Go 1.26.9' }]);
  });

  it('complete refuses an unknown spec (404) and a spec not awaiting validation (409) without keeping the spec locked', async () => {
    const complete = '/api/projects/hello-app/specs/hello-001/complete';
    expect((await post('/api/projects/hello-app/specs/nope/complete')).status).toBe(404);
    expect((await post(complete)).status).toBe(409); // the fixture spec is running
    expect(spawns).toHaveLength(0);
    await useAwaitingValidationProject();
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    expect((await post(complete)).status).toBe(202);
    expect(spawns).toHaveLength(1);
  });

  it('deploy again spawns spec deploy for a delivered spec, and refuses an unknown spec (404) or a running one (409)', async () => {
    const url = '/api/projects/hello-app/specs/hello-001/deploy';
    expect((await post('/api/projects/hello-app/specs/nope/deploy')).status).toBe(404);
    expect((await post(url)).status).toBe(409); // the fixture spec is running
    expect(spawns).toHaveLength(0);
    await useAwaitingValidationProject();
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    const ok = await post(url);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ runId: 'hello-app--hello-001--deploy-run-1' });
    expect(spawns[0]!.args).toEqual(expect.arrayContaining(['spec', 'deploy', '--spec', 'hello-001', '--run-id', 'hello-app--hello-001--deploy-run-1']));
    expect((await post(url)).status).toBe(409); // its own run now holds the spec
  });

  it('service status probes the deployed health url and says whether it answers', async () => {
    const deployed = { type: 'DEPLOY_VERIFIED', data: { attempt: 1, url: 'http://dind:3000', smoke: [], healthcheck: 'HTTP 200', tag: 't', port: 3000, healthcheckPath: '/health' } };
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), deployed], state('running'));
    const answer = await (await fetch(base() + '/api/runs/hello-001-r1/service')).json();
    expect(answer).toMatchObject({ online: true, status: 200 });
    expect(answer.services).toBeUndefined();
    expect(probed).toEqual(['http://dind:3000/health', 'http://dind:3000/']);
    expect(answer.ui).toBe(false);
    probe = async () => ({ status: 200, html: true });
    expect(await (await fetch(base() + '/api/runs/hello-001-r1/service')).json()).toMatchObject({ online: true, ui: true });
    probe = async () => null;
    expect(await (await fetch(base() + '/api/runs/hello-001-r1/service')).json()).toMatchObject({ online: false, status: null });
    probe = async () => ({ status: 503 });
    expect(await (await fetch(base() + '/api/runs/hello-001-r1/service')).json()).toMatchObject({ online: false, status: 503 });
  });

  it('service status of a services run probes every service and is online only when all answer', async () => {
    const card = (service: string, port: number) => ({ service, url: `http://dind:${port}`, port, healthcheck: 'HTTP 200', healthcheckPath: '/health' });
    const deployed = { type: 'DEPLOY_VERIFIED', data: { attempt: 1, ...card('orders', 20001), smoke: [], services: [card('orders', 20001), card('inventory', 20002)] } };
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), deployed], state('running'));
    probe = async (u) => (u.includes('20001') ? { status: 200 } : null);
    expect(await (await fetch(base() + '/api/runs/hello-001-r1/service')).json()).toMatchObject({
      online: false,
      status: 200,
      services: [{ service: 'orders', online: true, status: 200 }, { service: 'inventory', online: false, status: null }],
    });
    expect(probed).toEqual(expect.arrayContaining(['http://dind:20001/health', 'http://dind:20002/health']));
  });

  it('service status of an older run without a health path counts any HTTP answer as online', async () => {
    const deployed = { type: 'DEPLOY_VERIFIED', data: { attempt: 1, url: 'http://dind:3000', smoke: [], healthcheck: 'HTTP 200', tag: 't' } };
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), deployed], state('running'));
    probe = async () => ({ status: 404 });
    expect(await (await fetch(base() + '/api/runs/hello-001-r1/service')).json()).toMatchObject({ online: true, status: 404 });
    probe = async () => null;
    expect(await (await fetch(base() + '/api/runs/hello-001-r1/service')).json()).toMatchObject({ online: false, status: null });
  });

  it('serves the artifact of a mobile run as a download, and refuses a run without one', async () => {
    const deployed = { type: 'DEPLOY_VERIFIED', data: { attempt: 1, url: '', smoke: [], healthcheck: 'artifact', kind: 'mobile', artifact: 'app-debug.apk' } };
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), deployed], state('running'));
    await fs.mkdir(path.join(runs, 'hello-001-r1', 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(runs, 'hello-001-r1', 'artifacts', 'app-debug.apk'), 'APK');
    const res = await fetch(base() + '/api/runs/hello-001-r1/artifact');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="app-debug.apk"');
    expect(await res.text()).toBe('APK');
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), { type: 'DEPLOY_VERIFIED', data: { attempt: 1, url: 'http://dind:3000', smoke: [], healthcheck: 'HTTP 200', tag: 't' } }], state('running'));
    expect((await fetch(base() + '/api/runs/hello-001-r2/artifact')).status).toBe(404);
  });

  it('service status is 404 for a run that never deployed', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'));
    expect((await fetch(base() + '/api/runs/hello-001-r1/service')).status).toBe(404);
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
    // nothing is left behind to show up as a run
    await expect(fs.access(path.join(runs, 'hello-app--hello-001--run-1'))).rejects.toThrow();
    expect(await (await fetch(`${base()}/api/projects/hello-app/runs`)).json()).toEqual([]);
  }, 15_000);

  it('redacts the ui.log tail with secrets read at request time (audit M3/M4)', async () => {
    const secrets = path.join(home, '.teams-ai', 'secrets');
    await fs.mkdir(secrets, { recursive: true });
    onSpawn = async (runId) => {
      // Written after startup: a list loaded once at boot would not know it. Short value, base64 form, URL-encoded form.
      await fs.writeFile(path.join(secrets, 'DB_PASSWORD'), 'p@ss w0rd!');
      await fs.mkdir(path.join(runs, runId), { recursive: true });
      const value = 'p@ss w0rd!';
      await fs.writeFile(path.join(runs, runId, 'ui.log'), `fail ${value} / ${encodeURIComponent(value)} / ${Buffer.from(value).toString('base64')}
`);
      alive.clear();
    };
    const r = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(r.status).toBe(500);
    const text = JSON.stringify(await r.json());
    expect(text).not.toContain('p@ss');
    expect(text).not.toContain(encodeURIComponent('p@ss w0rd!'));
    expect(text).not.toContain(Buffer.from('p@ss w0rd!').toString('base64'));
    expect(text).toContain('[REDACTED]');
  }, 15_000);

  it('stops a child that is alive but has written no journal when the wait ends: no orphan, no second run beside it', async () => {
    const start = '/api/projects/hello-app/specs/hello-001/runs';
    let retry: Promise<Response> | undefined;
    onSignal = () => {
      retry = post(start); // arrives while the first request is still waiting for the child to exit
    };
    onSleep = async () => {
      await retry;
    };
    expect((await post(start)).status).toBe(500); // the child stays alive and silent for the whole wait
    expect(signals).toContainEqual([-5001, 'SIGTERM']);
    expect((await retry!).status).toBe(409); // the spec was not released while the child was still exiting
    expect([...alive]).toEqual([]);
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    expect((await post(start)).status).toBe(200); // released afterwards
    expect([...alive]).toEqual([5002]); // the retry is the only live process
  });

  it('a concluded spec is read-only: no resume of its runs, no new run and no README', async () => {
    await useAwaitingValidationProject(); // concluded by its completion run, as a draft root that never sees the merged done
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 901); // dead pid: interrupted
    await writeRun(runs, 'hello-001-complete-r1', [started('hello-001-complete-r1'), { type: 'RUN_FINISHED', data: { result: 'done' } }], state('running'));
    const resume = await post('/api/runs/hello-001-r1/resume');
    expect(resume.status).toBe(409);
    expect((await resume.json()).error).toContain('concluded');
    const start = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(start.status).toBe(409);
    expect((await start.json()).error).toContain('concluded');
    expect(spawns).toHaveLength(0);
    expect((await (await fetch(`${base()}/api/runs/hello-001-r1`)).json()).locked).toBe(true);
    expect((await (await fetch(`${base()}/api/runs/hello-001-r1`)).json()).agentsDecide).toBe(false);
    const answer = await fetch(`${base()}/api/runs/hello-001-r1/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisions: [{ taskId: 'T1', answer: 'yes' }] }) });
    expect(answer.status).toBe(409);
    for (const url of ['/api/runs/hello-001-r1/readme']) {
      const r = await post(url);
      expect(r.status, url).toBe(409);
      expect((await r.json()).error).toContain('concluded');
    }
    expect(spawns).toHaveLength(0);
  });

  it('a concluded spec can still deploy again: the app starts with nothing changed in the spec', async () => {
    await useAwaitingValidationProject();
    await writeRun(runs, 'hello-001-complete-r1', [started('hello-001-complete-r1'), { type: 'RUN_FINISHED', data: { result: 'done' } }], state('running'));
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    expect((await post('/api/projects/hello-app/specs/hello-001/deploy')).status).toBe(202);
    expect(spawns[0]!.args).toEqual(expect.arrayContaining(['spec', 'deploy']));
  });

  it('a spec awaiting validation gets no new run: a 409 says so before any process starts, so no dead run is left', async () => {
    await useAwaitingValidationProject();
    // Live: the launched process refused it, the route answered 500, and a launch-failed run stayed in the list.
    const start = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(start.status).toBe(409);
    expect((await start.json()).error).toBe('spec hello-001 is awaiting-validation; only a running spec gets a new run');
    expect(spawns).toHaveLength(0);
  });

  it('a spec the running backlog program owns is queued in that program instead of getting a loose run', async () => {
    const queued: string[] = [];
    const own = await startApi({ routes: runRoutes({ cfg: async () => (await readUserConfig(home)).cfg, home, control, queueInProgram: async (p, s) => (queued.push(`${p}/${s}`), { draftId: 'hello-draft' }) }) }, 0);
    try {
      const start = await fetch(`http://127.0.0.1:${own.port}/api/projects/hello-app/specs/hello-001/runs`, { method: 'POST', headers: { 'content-type': 'application/json' } });
      expect(start.status).toBe(200);
      expect(await start.json()).toEqual({ queued: true, draftId: 'hello-draft' });
      expect(queued).toEqual(['hello-app/hello-001']);
      expect(spawns).toHaveLength(0);
    } finally {
      await own.close();
    }
  });

  it('says why a spec the program holds back cannot run now, before any process starts', async () => {
    const own = await startApi({ routes: runRoutes({ cfg: async () => (await readUserConfig(home)).cfg, home, control, queueInProgram: async () => ({ refused: 'A spec hello-001 está bloqueada no programa: depends on base, which failed' }) }) }, 0);
    try {
      const start = await fetch(`http://127.0.0.1:${own.port}/api/projects/hello-app/specs/hello-001/runs`, { method: 'POST', headers: { 'content-type': 'application/json' } });
      expect(start.status).toBe(409);
      expect((await start.json()).error).toBe('A spec hello-001 está bloqueada no programa: depends on base, which failed');
      expect(spawns).toHaveLength(0);
    } finally {
      await own.close();
    }
  });

  it('resume is allowed only for paused:auth, interrupted or verification-failed runs', async () => {
    // Each run is the latest of its spec when it is resumed: an earlier run never resumes behind a later one.
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('paused:auth'));
    onSpawn = async () => {};
    const ok = await post('/api/runs/hello-001-r1/resume');
    expect(ok.status).toBe(200);
    // The user's resume retries the blocked tasks too: the cause may be fixed now (the supervisor's resume never does).
    expect(spawns[0]!.args).toEqual(['cli', 'resume', '--project', HELLO, '--run', 'hello-001-r1', '--retry-blocked']);
    expect(await fs.readFile(path.join(runs, 'hello-001-r1', 'pid'), 'utf8')).toBe('5001');
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    expect((await post('/api/runs/hello-001-r2/resume')).status).toBe(409);
    await writeRun(runs, 'hello-001-r3', [started('hello-001-r3')], state('running'), 901);
    const interrupted = await post('/api/runs/hello-001-r3/resume'); // pid 901 is dead
    expect(interrupted.status).toBe(200);
    // A run that failed verification resumes too, with the same retry of its blocked tasks.
    await writeRun(runs, 'hello-001-r4', [started('hello-001-r4'), { type: 'RUN_FINISHED', data: { result: 'verification-failed' } }], state('running'));
    const retried = await post('/api/runs/hello-001-r4/resume');
    expect(retried.status).toBe(200);
    expect(spawns.at(-1)!.args).toEqual(['cli', 'resume', '--project', HELLO, '--run', 'hello-001-r4', '--retry-blocked']);
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

  it('a run stopped from the UI stays stopped: the supervisor leaves it alone until the user resumes it', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 950);
    alive.add(950);
    expect((await post('/api/runs/hello-001-r1/stop')).status).toBe(200);
    expect(await superviseTick(await supervisorDeps(), new Map())).toEqual([]);
    expect(spawns).toHaveLength(0);
    expect((await post('/api/runs/hello-001-r1/resume')).status).toBe(200); // the user's resume lifts the stop
    alive.delete(5001); // the run dies again later: now it is the supervisor's to bring back
    expect(await superviseTick(await supervisorDeps(), new Map())).toEqual(['hello-001-r1']);
    expect(spawns).toHaveLength(2);
  });

  it('a run the user stopped no longer holds its spec: a new run starts, and the stopped one may not resume behind it', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 950);
    alive.add(950);
    expect((await post('/api/runs/hello-001-r1/stop')).status).toBe(200);
    // Live: the stopped run stayed interrupted and refused every new run of its spec.
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    const start = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(start.status).toBe(200);
    const { runId } = (await start.json()) as { runId: string };
    const resume = await post('/api/runs/hello-001-r1/resume');
    expect(resume.status).toBe(409);
    expect((await resume.json()).error).toBe(`run hello-001-r1 is behind ${runId} of spec hello-001; only the latest run of a spec resumes`);
  });

  it('a supervisor scan between the stop signal and the pid cleanup does not resume the run', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 950);
    alive.add(950);
    let scan: Promise<string[]> = Promise.resolve([]);
    onSignal = () => {
      scan = supervisorDeps().then((d) => superviseTick(d, new Map())); // the process is gone, the route is still waiting on it
    };
    onSleep = async () => {
      await scan;
    };
    expect((await post('/api/runs/hello-001-r1/stop')).status).toBe(200);
    expect(await scan).toEqual([]);
    expect(spawns).toHaveLength(0);
  });

  it('a supervisor scan during a UI resume does not spawn a second process for the run', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111); // dead pid: interrupted
    const hold = holdLaunch('hello-001-r1');
    const resume = post('/api/runs/hello-001-r1/resume');
    await hold.reached;
    expect(await superviseTick(await supervisorDeps(), new Map())).toEqual([]);
    hold.release();
    expect((await resume).status).toBe(200);
    expect(spawns).toHaveLength(1);
    expect(await fs.readFile(path.join(runs, 'hello-001-r1', 'pid'), 'utf8')).toBe('5001');
  });

  it('resume answers 409 while another spawner holds the launch claim of the run, and releases its own claim', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111);
    const release = (await claimLaunch(runs, 'hello-001-r1'))!;
    expect((await post('/api/runs/hello-001-r1/resume')).status).toBe(409);
    expect(spawns).toHaveLength(0);
    await release();
    expect((await post('/api/runs/hello-001-r1/resume')).status).toBe(200);
    expect(spawns).toHaveLength(1);
    expect(await claimLaunch(runs, 'hello-001-r1')).not.toBeNull();
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
      // A comment block (the stream's first frame and its pings) is not an event.
      if (block.startsWith(':')) continue;
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

  it('detail reports interrupted when the process of an unfinished run died, with or without a state snapshot', async () => {
    // A completion run writes no state.json until it finishes, so the dead pid alone must say that it was interrupted.
    await writeRun(runs, 'hello-001-complete-r1', [started('hello-001-complete-r1')], null, 111); // pid 111 is not alive
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 112);
    for (const id of ['hello-001-complete-r1', 'hello-001-r1']) {
      const d = await (await fetch(`${base()}/api/runs/${id}`)).json();
      expect(d).toMatchObject({ status: 'interrupted', finished: null });
      // The first look retired the pid file to pid.gone: the run keeps showing interrupted until it is resumed.
      await expect(fs.access(path.join(runs, id, 'pid.gone'))).resolves.toBeUndefined();
      expect((await (await fetch(`${base()}/api/runs/${id}`)).json()).status).toBe('interrupted');
    }
  });

  it('detail keeps the journal status while the process is alive and the result once the run finished', async () => {
    alive.add(900);
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 900);
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), { type: 'RUN_FINISHED', data: { result: 'done' } }], state('running'), 111); // dead pid, but it finished
    await writeRun(runs, 'hello-001-r3', [started('hello-001-r3')], state('running')); // started from a terminal: no pid file, nothing to judge by
    expect((await (await fetch(`${base()}/api/runs/hello-001-r1`)).json()).status).toBe('running');
    expect((await (await fetch(`${base()}/api/runs/hello-001-r2`)).json()).status).toBe('done');
    expect((await (await fetch(`${base()}/api/runs/hello-001-r3`)).json()).status).toBe('running');
  });

  it('returns the persisted plan artifact when the run project contains plan.json', async () => {
    const project = path.join(home, 'project');
    await fs.cp(HELLO, project, { recursive: true });
    await fs.mkdir(path.join(project, 'docs', 'specs', 'hello-001'), { recursive: true });
    await fs.writeFile(path.join(project, 'docs', 'specs', 'hello-001', 'plan.json'), JSON.stringify(makePlan(makeFrozenSpec({ specId: 'hello-001' }))));
    await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: project }] }));
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'));
    const d = await (await fetch(`${base()}/api/runs/hello-001-r1`)).json();
    expect(d.plan.specId).toBe('hello-001');
    expect(d.plan.tasks.some((task: { id: string }) => task.id === 'T0-scaffold')).toBe(true);
  });

  it('accepts an open section of the report as out of scope, and only an open one with a note', async () => {
    const gap = (heading: string, status: string) => ({ doc: 'briefing.md', heading, status, evidence: [], missing: 'Falta a lista.', acIds: [], cause: null });
    const report = { runId: 'hello-001-r1', gaps: { items: [gap('Create a todo', 'missing'), gap('Delivered', 'delivered')] } };
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'REPORT_READY', data: { report, merged: true } }, { type: 'RUN_FINISHED', data: { result: 'awaiting-validation' } }], state('awaiting-validation'));
    const accept = { doc: 'briefing.md', heading: 'Create a todo', note: 'Fica para a próxima spec.' };
    expect((await post('/api/runs/hello-001-r1/gaps/accept', { ...accept, note: '  ' })).status).toBe(400);
    expect((await post('/api/runs/hello-001-r1/gaps/accept', { doc: 'briefing.md', heading: 'Delivered', note: 'x' })).status).toBe(404);
    expect((await post('/api/runs/hello-001-r1/gaps/accept', accept)).status).toBe(200);
    const d = await (await fetch(`${base()}/api/runs/hello-001-r1`)).json();
    expect(d.gapDecisions).toEqual([{ ...accept, at: expect.any(String) }]);
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

  it('a reopened run is running again: the old RUN_FINISHED neither ends its detail nor its event stream', async () => {
    const earlier = [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'verification-failed' } }, { type: 'RUN_REOPENED', data: { manual: true } }];
    await writeRun(runs, 'hello-001-r1', [...earlier, { type: 'PHASE_STARTED', data: { phase: 3 } }], state('running'), 960);
    alive.add(960);
    const detail = await (await fetch(`${base()}/api/runs/hello-001-r1`)).json();
    expect(detail.status).toBe('running');
    expect(detail.finished).toBeNull();
    const { events } = await readSse(`${base()}/api/runs/hello-001-r1/events`, null, (ev) => ev.length >= 4);
    expect(events.map((e) => [e.event, e.id])).toEqual([['journal', '1'], ['journal', '2'], ['journal', '3'], ['journal', '4']]);
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
    // Audit L1: a `..` id never reaches the handler over HTTP (URL parsing collapses it), but the id check must hold on its own.
    await fs.writeFile(path.join(runs, 'prompt.md'), 'outside');
    expect((await fetch(`${base()}/api/runs/hello-001-r1/steps/..`)).status).toBe(404);
  });

  it('spawns `spec readme` for a finished run and refuses while the spec has an active run', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    onSpawn = async (runId) => {
      await writeRun(runs, runId, [started(runId)], state('running'));
    };
    const ok = await post('/api/runs/hello-001-r1/readme');
    expect(ok.status).toBe(202);
    const { runId } = await ok.json();
    expect(runId).toBe('hello-app--hello-001--readme-run-1');
    expect(spawns[0]!.args).toEqual(['cli', 'spec', 'readme', '--project', HELLO, '--spec', 'hello-001', '--run-id', runId]);
    expect((await post('/api/runs/hello-001-r1/readme')).status).toBe(409); // the readme run itself is now active
    expect((await post('/api/runs/missing/readme')).status).toBe(404);
  });
});

describe('test links', () => {
  const GO = 'package tests\n\nfunc TestAc_001_Soma(t *testing.T) {\n\tt.Run("[AC-001] soma dois números", func(t *testing.T) {})\n}\n';
  const line = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const passed = (classname: string, name: string, acIds: string[]) => ({ id: `${classname}::${name}`, name, classname, status: 'passed', acIds });
  const gate = (data: Record<string, unknown>) => ({ type: 'GATE_PASSED', data: { gate: 'unit-test', failure: null, ...data } });
  const links = async (runId: string) => (await fetch(`${base()}/api/runs/${runId}/test-links`)).json();

  /** A clone with its files committed, its origin set to `remote` and origin/main on the commit; answers the commit. */
  async function cloneWith(dir: string, files: Record<string, string>, remote: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    await execCommand({ bin: 'git', args: ['init', '-q'], cwd: dir, timeoutMs: 20_000 });
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    }
    await commitAll(dir, 'init', { exclude: [] });
    await execCommand({ bin: 'git', args: ['remote', 'add', 'origin', remote], cwd: dir, timeoutMs: 20_000 });
    await execCommand({ bin: 'git', args: ['update-ref', 'refs/remotes/origin/main', 'HEAD'], cwd: dir, timeoutMs: 20_000 });
    return (await execCommand({ bin: 'git', args: ['rev-parse', 'HEAD'], cwd: dir, timeoutMs: 20_000 })).stdout.trim();
  }

  it('links each acceptance test of a one-repository project to its line on GitHub', async () => {
    const sha = await cloneWith(path.join(home, '.teams-ai', 'workspaces', 'hello-app', 'repo'), { 'tests/soma_test.go': GO }, 'https://github.com/acme/hello-app.git');
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      { type: 'GATE_PASSED', data: { phase: 4, round: 1, gate: 'unit-test', failure: null, junit: [passed('hello-app/tests', 'TestAc_001_Soma/[AC-001]_soma_dois_números', ['AC-001']), passed('hello-app/tests', 'TestHelper', [])] } },
    ]);
    expect(await links('hello-001-r1')).toEqual({
      'hello-app/tests::TestAc_001_Soma/[AC-001]_soma_dois_números': { url: `https://github.com/acme/hello-app/blob/${sha}/tests/soma_test.go#L${line(GO, 't.Run("[AC-001]')}`, path: 'tests/soma_test.go', line: 4 },
    });
  });

  it('links each service test to the clone of its own repository and leaves out a service that is not cloned', async () => {
    const workspace = path.join(home, '.teams-ai', 'workspaces', 'hello-app', 'services');
    const orders = await cloneWith(path.join(workspace, 'orders-api', 'repo'), { 'tests/pedido_test.go': 'package tests\n\nfunc TestAc_002_Pedido(t *testing.T) {}\n' }, 'https://github.com/acme/orders-api.git');
    const inventory = await cloneWith(path.join(workspace, 'inventory-api', 'repo'), { 'tests/estoque_test.go': 'package tests\n\nfunc TestAc_003_Estoque(t *testing.T) {}\n' }, 'https://github.com/acme/inventory-api.git');
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      { type: 'TASK_PLANNED', data: { task: { ...task('T1'), service: 'orders-api' } } },
      { type: 'TASK_PLANNED', data: { task: { ...task('T2'), service: 'billing-api' } } },
      gate({ taskId: 'T1', junit: [passed('hello-app/tests', 'TestAc_002_Pedido', ['AC-002'])] }),
      gate({ taskId: 'T2', junit: [passed('hello-app/billing', 'TestAc_004_Cobranca', ['AC-004'])] }),
      gate({ phase: 4, round: 1, service: 'inventory-api', junit: [passed('hello-app/tests', 'TestAc_003_Estoque', ['AC-003'])] }),
    ]);
    expect(await links('hello-001-r1')).toEqual({
      'hello-app/tests::TestAc_002_Pedido': { url: `https://github.com/acme/orders-api/blob/${orders}/tests/pedido_test.go#L3`, path: 'tests/pedido_test.go', line: 3 },
      'hello-app/tests::TestAc_003_Estoque': { url: `https://github.com/acme/inventory-api/blob/${inventory}/tests/estoque_test.go#L3`, path: 'tests/estoque_test.go', line: 3 },
    });
  });

  it('leaves out a test id that two repositories report', async () => {
    const workspace = path.join(home, '.teams-ai', 'workspaces', 'hello-app', 'services');
    await cloneWith(path.join(workspace, 'orders-api', 'repo'), { 'tests/pedido_test.go': 'package tests\n\nfunc TestAc_002_Pedido(t *testing.T) {}\n' }, 'https://github.com/acme/orders-api.git');
    await cloneWith(path.join(workspace, 'inventory-api', 'repo'), { 'tests/pedido_test.go': 'package tests\n\nfunc TestAc_002_Pedido(t *testing.T) {}\n' }, 'https://github.com/acme/inventory-api.git');
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      { type: 'TASK_PLANNED', data: { task: { ...task('T1'), service: 'orders-api' } } },
      gate({ taskId: 'T1', junit: [passed('hello-app/tests', 'TestAc_002_Pedido', ['AC-002'])] }),
      gate({ phase: 4, round: 1, service: 'inventory-api', junit: [passed('hello-app/tests', 'TestAc_002_Pedido', ['AC-002'])] }),
    ]);
    expect(await links('hello-001-r1')).toEqual({});
  });

  it('answers 404 for an unknown run, and gives no link for a repository that is not on GitHub', async () => {
    expect((await fetch(`${base()}/api/runs/nope-r1/test-links`)).status).toBe(404);
    await cloneWith(path.join(home, '.teams-ai', 'workspaces', 'hello-app', 'repo'), { 'tests/soma_test.go': GO }, '/local/path/hello-app');
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), gate({ phase: 4, round: 1, junit: [passed('hello-app/tests', 'TestAc_001_Soma', ['AC-001'])] })]);
    expect(await links('hello-001-r1')).toEqual({});
  });
});
