import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseSpecId, failedDecision, loadRunDeps, main, markAwaitingValidation, startsAsDraft } from '../server/cli.js';
import { loadConfig } from '../server/config/config.js';
import type { RunControlDeps, SpawnArgs } from '../server/api/run-control.js';
import type { RunDeps } from '../server/orchestrator/run.js';
import { RefineEvent } from '../server/refine/events.js';
import { RefineJournal } from '../server/refine/session.js';
import { makeRemote } from './fixtures/git-remote.js';
import { writeRun } from './fixtures/runs/write-run.js';

const io = (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { argv, env: {}, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out, err };
};

describe('teams-ai cli', () => {
  it('prints usage and exits 2 on an unknown command or missing flags', async () => {
    const a = io(['nope']);
    expect(await main(a.io)).toBe(2);
    expect(a.err.join('\n')).toContain('Usage');
    expect(a.err.join('\n')).toContain('teams-ai ui');
    const b = io(['run']);
    expect(await main(b.io)).toBe(2);
    expect(b.err.join('\n')).toContain('--project');
  });

  it('spec deploy is listed and rejects an unknown --target before loading anything', async () => {
    const a = io(['spec', 'deploy', '--project', '/nowhere', '--spec', 's', '--target', 'aws']);
    expect(await main(a.io)).toBe(2);
    expect(a.err.join('\n')).toContain('spec deploy');
    expect(a.err.join('\n')).toContain('--target must be docker-local');
    const b = io(['spec', 'deploy']);
    expect(await main(b.io)).toBe(2);
    expect(b.err.join('\n')).toContain('--project');
  });

  it('maps run results to exit codes', async () => {
    const results = ['complete', 'blocked', 'deadlocked', 'phase-failed', 'drained', 'paused:auth'] as const;
    const codes: number[] = [];
    for (const r of results) {
      const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001']);
      codes.push(await main(a.io, async () => ({ execute: async () => r, close: async () => {}, runId: 'spec-001-r1', journal: { state: { tasks: new Map() } }, accounting: { total: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }) } }) as never));
    }
    expect(codes).toEqual([0, 2, 2, 2, 3, 2]);
  });

  it('supervise requires --project and a positive --interval, and rejects a non-positive --interval', async () => {
    const a = io(['supervise']);
    expect(await main(a.io)).toBe(2);
    expect(a.err.join('\n')).toContain('--project');
    const b = io(['supervise', '--project', '/nowhere', '--interval', '0']);
    expect(await main(b.io, undefined, { signals: () => () => {} })).toBe(2);
    expect(b.err.join('\n')).toContain('--interval must be a positive number');
  });

  it('supervise resumes an interrupted run once, leaves live and finished runs alone, and exits 0 on SIGTERM', async () => {
    const hello = path.resolve('test/fixtures/hello-app');
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-cli-sup-'));
    try {
      const runs = path.join(home, 'runs');
      const started = (runId: string) => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
      const state = { runId: 'x', at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 1 } };
      await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state, 111); // dead: interrupted
      await writeRun(runs, 'hello-001-r2', [started('hello-001-r2')], state, 112); // live
      await writeRun(runs, 'hello-001-r3', [started('hello-001-r3'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state, 113); // finished
      const alive = new Set([112]);
      const spawned: SpawnArgs[] = [];
      let stop = () => {};
      let sleeps = 0;
      const control = {
        spawn: (a: SpawnArgs) => { spawned.push(a); alive.add(5000); return { pid: 5000 }; },
        kill: () => true,
        // 1s slices: the first scan, one full 1s interval, a second scan, then SIGTERM
        sleep: async () => { if (++sleeps === 2) stop(); },
        cliEntry: () => ({ bin: 'node', prefix: ['cli.ts'] }),
        repoRoot: '/repo',
      } as RunControlDeps;
      const idx = { cfg: loadConfig({ paths: { runs: runs.split(path.sep).join('/') }, projects: [{ dir: hello }] }), home, isAlive: (pid: number) => alive.has(pid) };
      const a = io(['supervise', '--project', hello, '--interval', '1']);
      const code = await main(a.io, undefined, { supervision: { idx, control }, signals: (onStop) => { stop = onStop; return () => {}; } });
      expect(code).toBe(0);
      expect(sleeps).toBe(2);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.args).toContain('resume');
      expect(spawned[0]!.args).toContain('hello-001-r1');
      expect(a.err.join('|')).toContain('resumed hello-001-r1');
      expect(a.err.join('|')).toContain('supervise: stopped');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('ui starts the API on the requested port and serves the status route', async () => {
    const a = io(['ui', '--port', '0', '--project', '/tmp/p']);
    let closed = false;
    const code = await main(a.io, undefined, {
      startUi: async (port) => ({ port: port === 0 ? 45678 : port, close: async () => { closed = true; } }),
      waitForSignal: async () => undefined,
    });
    expect(code).toBe(0);
    expect(a.err.join('\n')).toContain('http://localhost:45678/');
    expect(closed).toBe(true);
  });

  it('run passes --run-id to the factory and a SIGTERM requests a stop', async () => {
    const seen: Array<string | undefined> = [];
    let stops = 0;
    let fireStop: () => void = () => {};
    let resolveRun: (r: 'drained') => void = () => {};
    let onExecute: () => void = () => {};
    const executing = new Promise<void>((r) => (onExecute = r));
    const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001', '--run-id', 'spec-001-r9']);
    const code = main(
      a.io,
      async (_deps, runId, explicitId) => {
        seen.push(runId, explicitId);
        return {
          runId: explicitId ?? 'x',
          execute: () => {
            onExecute();
            return new Promise<'drained'>((r) => (resolveRun = r));
          },
          requestStop: async () => { stops += 1; },
          close: async () => {},
          journal: { state: { tasks: new Map() } },
          accounting: { total: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }) },
        } as never;
      },
      { signals: (cb) => { fireStop = cb; return () => {}; } },
    );
    // The stop handler is registered before execute starts, so the signal fires while the run executes.
    await executing;
    fireStop();
    expect(stops).toBe(1);
    resolveRun('drained');
    expect(await code).toBe(3);
    expect(seen).toEqual([undefined, 'spec-001-r9']);
  });

  it('resume --retry-blocked gives the blocked tasks a fresh start before the run goes on; a plain resume does not', async () => {
    for (const [flags, expected] of [[['--retry-blocked'], 1], [[], 0]] as const) {
      let retried = 0;
      const a = io(['resume', '--project', '/tmp/p', '--run', 'spec-001-r1', ...flags]);
      const code = await main(a.io, async () => ({
        runId: 'spec-001-r1',
        retryBlocked: async () => { retried += 1; },
        execute: async () => 'complete',
        requestStop: async () => {},
        close: async () => {},
        journal: { state: { tasks: new Map() } },
        accounting: { total: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }) },
      }) as never);
      expect(code).toBe(0);
      expect(retried).toBe(expected);
    }
  });

  it('run accepts --draft and still reaches the factory', async () => {
    const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001', '--draft']);
    let reached = false;
    const code = await main(
      a.io,
      async () => {
        reached = true;
        return { runId: 'x', execute: async () => 'complete', requestStop: async () => {}, close: async () => {}, journal: { state: { tasks: new Map() } }, accounting: { total: () => ({ costUsd: 0 }) } } as never;
      },
      { signals: () => () => {} },
    );
    expect(code).toBe(0);
    expect(reached).toBe(true);
  });
});

describe('chooseSpecId', () => {
  const dirs = ['a-001', 'a-001-z'];
  it('prefers --spec, then the spec of the run being resumed, then the last spec directory', () => {
    expect(chooseSpecId('a-001', 'a-001-z', dirs)).toBe('a-001');
    expect(chooseSpecId(undefined, 'a-001', dirs)).toBe('a-001');
    expect(chooseSpecId(undefined, null, dirs)).toBe('a-001-z');
    expect(chooseSpecId(undefined, null, [])).toBeUndefined();
  });
});

describe('startsAsDraft', () => {
  const ws = { root: path.resolve('/ws/shop'), repo: path.resolve('/ws/shop/repo') };
  const exec = (exitCode: number) => async () => ({ exitCode, stdout: '', stderr: '', timedOut: false, durationMs: 0, signal: null, truncated: false });
  it('publishes again a refinement whose spec main lacks, and never a spec already on main or a project outside the refinements', async () => {
    const draftRoot = path.join(ws.root, 'refine', 'list-users');
    expect(await startsAsDraft(exec(128), draftRoot, ws, 'list-users')).toBe(true); // Phase 0 stopped before main had it
    expect(await startsAsDraft(exec(0), draftRoot, ws, 'list-users')).toBe(false);
    expect(await startsAsDraft(exec(128), path.resolve('/imports/shop'), ws, 'list-users')).toBe(false);
    expect(await startsAsDraft(exec(128), ws.repo, ws, 'list-users')).toBe(false);
  });
});

describe('markAwaitingValidation', () => {
  const draft = async (status: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-cli-mark-'));
    const file = path.join(dir, 'docs', 'specs', 'hello-001', 'spec.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const spec = JSON.parse(await fs.readFile('test/fixtures/hello-app/docs/specs/hello-001/spec.json', 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...spec, status }));
    return { dir, read: async () => JSON.parse(await fs.readFile(file, 'utf8')).status };
  };

  it('moves the draft root spec from running to awaiting-validation so the UI can complete it', async () => {
    const d = await draft('running');
    await markAwaitingValidation(d.dir, 'hello-001', '/elsewhere/repo');
    expect(await d.read()).toBe('awaiting-validation');
  });

  it('leaves the repo clone and any other status alone', async () => {
    const clone = await draft('running');
    await markAwaitingValidation(clone.dir, 'hello-001', clone.dir);
    expect(await clone.read()).toBe('running');
    const done = await draft('done');
    await markAwaitingValidation(done.dir, 'hello-001', '/elsewhere/repo');
    expect(await done.read()).toBe('done');
  });
});

describe('ui decider failure', () => {
  it('reports a thrown decider as an error with the redacted message, never as exhausted', () => {
    expect(failedDecision(new Error('openrouter down for sk-or-v1-abcdefghijklmnopqrstuv'))).toEqual({ answered: false, reason: 'error', message: 'openrouter down for [REDACTED]' });
  });
});

describe('loadRunDeps', () => {
  /** Loads the run deps of spec hello-001 from a project folder that `fill` completes, and returns what `read` takes from them before everything is removed. */
  async function fromRunDeps<T>(fill: (projectDir: string) => Promise<void>, read: (deps: RunDeps) => T): Promise<T> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-cli-deps-home-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-cli-deps-project-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const project = await fs.readFile('test/fixtures/hello-app/docs/project.json', 'utf8');
    const fixture = JSON.parse(await fs.readFile('test/fixtures/hello-app/docs/specs/hello-001/spec.json', 'utf8'));
    const spec = JSON.stringify({ ...fixture, status: 'awaiting-validation', specHash: `sha256:${'a'.repeat(64)}` });
    const remote = await makeRemote({ 'docs/project.json': project, 'docs/specs/hello-001/spec.json': spec });
    try {
      await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
      await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { workspaces: `${home}/ws`, runs: `${home}/runs`, secrets: `${home}/secrets` }, projects: [] }));
      await fs.mkdir(path.join(projectDir, 'docs', 'specs', 'hello-001'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'docs', 'project.json'), project);
      await fs.writeFile(path.join(projectDir, 'docs', 'specs', 'hello-001', 'spec.json'), spec);
      await fill(projectDir);
      await fs.mkdir(path.join(home, 'ws', 'hello-app'), { recursive: true });
      await fs.cp(remote.repo, path.join(home, 'ws', 'hello-app', 'repo'), { recursive: true });

      const deps = await loadRunDeps({ argv: [], env: {}, stdout: () => {}, stderr: () => {} }, projectDir, 'hello-001', { dryRun: true, complete: true });
      try {
        return read(deps);
      } finally {
        deps.knowledge!.close();
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await remote.cleanup();
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  }

  it('indexes the docs of the project folder, so the run can retrieve them', async () => {
    const hits = await fromRunDeps((dir) => fs.writeFile(path.join(dir, 'docs', 'specs', 'hello-001', 'spec.md'), '# Spec 1\nThe quota uses marker zebracorn-7741.\n'), (deps) => deps.knowledge!.search('zebracorn'));
    expect(hits.map((h) => h.docId)).toEqual(['docs/specs/hello-001/spec.md']);
  });

  it('gives the run of a spec the Spec Kit feature folder that the preparation of its draft recorded for that spec', async () => {
    const feature = await fromRunDeps(async (draftRoot) => {
      // The draft journal of a backlog whose preparation made a feature folder for each item, the spec's own last.
      const journal = await RefineJournal.open(path.join(draftRoot, 'events.ndjson'), { projectId: 'hello-app', specId: path.basename(draftRoot) });
      const item = (key: string, rank: number) => ({ key, title: key, epic: 'core', priority: 'must', rank, size: 'S', scope: 's', rationale: 'r', dependsOn: [], sources: [] });
      await journal.fact(RefineEvent.BacklogEnabled, { keyIds: true });
      await journal.fact(RefineEvent.BacklogDerived, { project: null, epics: [], items: [item('login', 1), item('hello-001', 2)], cycle: 1 });
      await journal.fact(RefineEvent.SpeckitStarted, { total: 9 });
      for (const key of ['login', 'hello-001']) await journal.fact(RefineEvent.SpeckitStepDone, { command: 'specify', itemKey: key, files: [`specs/${key}/spec.md`], featureDir: `specs/${key}` });
      await journal.close();
    }, (deps) => deps.speckitFeature);
    expect(feature).toBe('specs/hello-001');
  });
});
