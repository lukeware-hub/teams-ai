import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import type { Accounting } from '../../server/budget/accounting.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { CrashInjected, Run, type RunDeps } from '../../server/orchestrator/run.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import type { StepRequest, StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec, { tasks: [makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src/a'] }), makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['src/b'] })] });
const JUNIT = `<testsuite name="sum"><testcase classname="sum" name="[AC-001] adds"/></testsuite>`;
const summary = (over: Partial<ResultSummary> = {}): ResultSummary => ({ found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 5, costUsd: 0.001, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0, ...over });

type Script = (req: StepRequest) => Promise<StepOutcome<any>>;
const happy: Script = async (req) => {
  switch (req.kind) {
    case 'dev': {
      const dir = path.join(req.cwd, 'src', req.taskId === 'T1' ? 'a' : 'b');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'index.ts'), `export const ${req.taskId} = 1;\n`);
      return { ok: true, value: { specHash: HASH, status: 'done', summary: `did ${req.taskId}`, changedFiles: [`src/${req.taskId === 'T1' ? 'a' : 'b'}/index.ts`], commitMessage: `feat: ${req.taskId}` }, summary: summary() };
    }
    case 'review':
      return { ok: true, value: { specHash: HASH, decision: 'approve', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }], findings: [] }, summary: summary() };
    case 'security':
      return { ok: true, value: { specHash: HASH, decision: 'approve', findings: [] }, summary: summary() };
    case 'replan':
      // Not scripted: a failed replan blocks the task, which is what these tests observe.
      return { ok: false, failure: 'code', errors: ['replan not scripted'], summary: summary({ isError: true }), sandboxDisabled: false };
    default:
      throw new Error(`unexpected step ${req.kind}`);
  }
};

let remote: Remote;
let gh: FakeGh;
let clock: { now: Date };
let sleeps: number[];

beforeEach(async () => {
  remote = await makeRemote({
    'docs/project.json': JSON.stringify(project),
    'docs/specs/spec-001/spec.json': JSON.stringify(spec),
    'docs/specs/spec-001/tech-spec.md': '# Tech spec\n\n## AC-001\nsum',
    'docs/specs/spec-001/plan.json': JSON.stringify(plan),
  });
  gh = new FakeGh();
  clock = { now: new Date('2026-09-24T10:00:00Z') };
  sleeps = [];
});
afterEach(async () => {
  await remote.cleanup();
});

function deps(script: Script, over: Partial<RunDeps> = {}): RunDeps {
  const cfg = loadConfig({ paths: { workspaces: path.join(remote.root, 'ws').replace(/\\/g, '/'), runs: path.join(remote.root, 'runs').replace(/\\/g, '/'), secrets: '/tmp/none' }, budgets: { observeOnly: false, perTaskTokens: 50_000, perRunTokens: 1_000_000 } });
  const exec = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .onArgs('docker', ['run'], async (s) => {
      // Every gate passes and leaves a JUnit report in the bind-mounted worktree.
      // The gate runner mounts the worktree with `--mount type=bind,source=<host>,target=/work`.
      const mount = s.args.find((a) => a.startsWith('type=bind,source=') && a.endsWith(',target=/work'))!;
      const wt = mount.slice('type=bind,source='.length, mount.length - ',target=/work'.length);
      await fs.mkdir(path.join(wt, 'reports'), { recursive: true });
      await fs.writeFile(path.join(wt, 'reports', 'junit.xml'), JUNIT);
      return { exitCode: 0 };
    });
  gh.install(exec);
  const ws = { projectId: 'shop', root: path.join(remote.root, 'ws'), repo: remote.repo, worktrees: path.join(remote.root, 'ws', 'wt'), graph: path.join(remote.root, 'ws', 'graph'), knowledgeDb: '', secrets: path.join(remote.root, 'ws', 'secrets'), runs: path.join(remote.root, 'runs') };
  return {
    cfg, ws, project, spec, firstSpec: false,
    exec: exec.exec, ghExec: exec.exec,
    // The real runStep books its usage in accounting (Plan 3); the fake does the same so budgets apply.
    runStep: (async (req: StepRequest, stepDeps: { accounting: Accounting }) => {
      const out = await script(req);
      stepDeps.accounting.record({ role: req.role, phase: req.phase, taskId: req.taskId, attempt: req.attempt, stepKind: req.kind, provider: 'claude', model: req.model, usage: out.summary.usage, costUsd: out.summary.costUsd, durationMs: out.summary.durationMs, numTurns: out.summary.numTurns, at: clock.now.toISOString() });
      return out;
    }) as RunDeps['runStep'],
    binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: undefined as never,
    graphify: null, knowledge: null, secrets: {},
    clock: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.now = new Date(clock.now.getTime() + ms); },
    log: () => {},
    ...over,
  };
}
async function withAgents(d: RunDeps): Promise<RunDeps> {
  return { ...d, agents: await loadAgents(path.resolve('.claude/agents')) };
}

describe('Run', () => {
  it('runs two independent tasks in parallel to merged and finishes complete', async () => {
    const run = await Run.create(await withAgents(deps(happy)));
    expect(await run.execute()).toBe('complete');
    const s = run.journal.state;
    expect([...s.tasks.values()].map((t) => t.state)).toEqual(['merged', 'merged']);
    expect(gh.prs.map((p) => p.state)).toEqual(['MERGED', 'MERGED']);
    expect(run.journal.events.at(-1)!.type).toBe(OrchEvent.RunFinished);
    expect(run.journal.events.at(-1)!.data).toMatchObject({ result: 'complete', merged: ['T1', 'T2'], blocked: [] });
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(await git(remote.repo, ['ls-tree', '--name-only', 'origin/main', 'src/'])).toContain('src/a');
    expect(run.accounting.records().length).toBeGreaterThanOrEqual(4);
    await run.close();
  }, 30_000);

  it('pauses after the in-flight step returns and resumes without re-running it', async () => {
    let devCalls = 0;
    const script: Script = async (req) => {
      if (req.kind === 'dev' && devCalls++ === 0) {
        return { ok: false, failure: 'quota', errors: ['usage limit'], summary: summary({ isError: true, rateLimit: { status: 'rejected', resetsAt: Math.floor(clock.now.getTime() / 1000) + 600, fiveHourUtilization: 1, fiveHourResetsAt: Math.floor(clock.now.getTime() / 1000) + 600, sevenDayUtilization: 0, sevenDayResetsAt: Math.floor(clock.now.getTime() / 1000) + 600 } }), sandboxDisabled: false };
      }
      return happy(req);
    };
    const run = await Run.create(await withAgents(deps(script)));
    expect(await run.execute()).toBe('complete');
    const types = run.journal.events.map((e) => e.type);
    expect(types).toContain('RUN_PAUSED');
    expect(types).toContain('RUN_RESUMED');
    expect(types.indexOf('RUN_PAUSED')).toBeGreaterThan(types.indexOf(OrchEvent.StepFinished));
    expect(sleeps.length).toBeGreaterThan(0);
    expect(run.journal.events.filter((e) => e.type === OrchEvent.StepStarted && e.data.kind === 'dev' && e.data.taskId === 'T1')).toHaveLength(2);
    expect(run.journal.state.tasks.get('T1')!.attempts).toBe(0);
    await run.close();
  }, 30_000);

  it('drains when the run budget is spent: in-flight tasks finish, nothing new starts', async () => {
    const d = await withAgents(deps(happy, { maxParallel: 1 }));
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), budgets: { observeOnly: false, perTaskTokens: 50_000, perRunTokens: 2_000 } });
    const run = await Run.create(d);
    expect(await run.execute()).toBe('drained');
    const states = [...run.journal.state.tasks.values()].map((t) => t.state);
    expect(states).toContain('merged');
    // The never-started task stays where the plan left it (ready: no dependencies).
    expect(states).toContain('ready');
    expect(run.journal.events.map((e) => e.type)).toContain('RUN_BUDGET_EXHAUSTED');
    await run.close();
  });

  it('charges a task over its budget with a failed attempt', async () => {
    const d = await withAgents(deps(async (req) => (req.kind === 'dev' ? { ...(await happy(req)), summary: summary({ usage: { inputTokens: 60_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }) } : happy(req)), { maxParallel: 1 }));
    const run = await Run.create(d);
    await run.execute();
    expect(run.journal.events.some((e) => e.type === 'ATTEMPT_CONSUMED')).toBe(true);
    expect(run.journal.events.filter((e) => e.type === OrchEvent.Feedback).some((e) => String(e.data.text).includes('budget'))).toBe(true);
    await run.close();
  }, 30_000);

  it('blocks a task that spends its attempts and reports it', async () => {
    const script: Script = async (req) => (req.kind === 'review' ? { ok: true, value: { specHash: HASH, decision: 'changes', criteria: [{ id: 'AC-001', status: 'failed', evidence: [] }], findings: [{ file: 'src/a/index.ts', line: 1, severity: 'major', text: 'wrong', acIds: ['AC-001'] }] }, summary: summary() } : req.kind === 'replan' ? { ok: false, failure: 'code', errors: ['no'], summary: summary({ isError: true }), sandboxDisabled: false } : happy(req));
    const run = await Run.create(await withAgents(deps(script)));
    expect(await run.execute()).toBe('blocked');
    expect(run.journal.events.at(-1)!.data).toMatchObject({ result: 'blocked', blocked: [expect.objectContaining({ taskId: 'T1' }), expect.objectContaining({ taskId: 'T2' })] });
    await run.close();
  });

  it('runs a replacement task from a successful replan to merged', async () => {
    let reviews = 0;
    const script: Script = async (req) => {
      if (req.kind === 'review' && req.taskId === 'T1') {
        reviews += 1;
        return { ok: true, value: { specHash: HASH, decision: 'changes', criteria: [{ id: 'AC-001', status: 'failed', evidence: [] }], findings: [{ file: 'src/a/index.ts', line: 1, severity: 'important', problem: 'wrong', fix: 'fix it', acIds: ['AC-001'] }] }, summary: summary() };
      }
      if (req.kind === 'replan') {
        return { ok: true, value: { specHash: HASH, replacements: [{ id: 'T1-r1', title: 'T1 again', description: 'smaller', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: ['src/a'], owner: 'dev' }] }, summary: summary() };
      }
      if (req.kind === 'dev' && req.taskId === 'T1-r1') return happy({ ...req, taskId: 'T1' });
      return happy(req);
    };
    const run = await Run.create(await withAgents(deps(script, { maxParallel: 1 })));
    expect(await run.execute()).toBe('complete');
    expect(reviews).toBe(3);
    const s = run.journal.state;
    expect(s.tasks.get('T1')!.state).toBe('superseded');
    expect(s.tasks.get('T1-r1')).toMatchObject({ state: 'merged', replanned: true });
    expect(s.tasks.get('T2')!.state).toBe('merged');
    await run.close();
  }, 30_000);

  it('an auth failure returns paused:auth and resume continues after the human logged in again', async () => {
    let first = true;
    const script: Script = async (req) => {
      if (req.kind === 'dev' && first) {
        first = false;
        return { ok: false, failure: 'auth', errors: ['not logged in'], summary: summary({ isError: true }), sandboxDisabled: false };
      }
      return happy(req);
    };
    const d = await withAgents(deps(script, { maxParallel: 1 }));
    const run = await Run.create(d);
    expect(await run.execute()).toBe('paused:auth');
    expect(run.journal.state.status).toBe('paused:auth');
    await run.close();
    const resumed = await Run.resume(d, run.runId);
    expect(await resumed.execute()).toBe('complete');
    expect(resumed.journal.state.tasks.get('T1')!.attempts).toBe(0);
    await resumed.close();
  }, 30_000);

  it('rebuilds accounting from the journal on resume', async () => {
    const d = await withAgents(deps(happy, { maxParallel: 1, crashAfterIntent: (id) => id.startsWith('PR_MERGE:task/spec-001-T1@') }));
    const run = await Run.create(d);
    await run.execute().catch(() => undefined);
    const before = run.accounting.total();
    await run.close();
    const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, run.runId);
    expect(resumed.accounting.total().steps).toBe(before.steps);
    expect(resumed.accounting.total().inputTokens).toBe(before.inputTokens);
    await resumed.close();
  }, 30_000);

  it('journals every decision with its backend and cost', async () => {
    const d = await withAgents(deps(happy));
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), decisions: { enabled: true } });
    const failing = new FakeExec()
      .on((s) => s.bin === 'git', (s) => execCommand(s))
      .onArgs('docker', ['run'], async () => ({ exitCode: 1, stderr: 'AssertionError' }));
    gh.install(failing);
    d.exec = failing.exec;
    d.ghExec = failing.exec;
    d.fetch = (async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13-20260917', answers: { kind: { type: 'choice', choice: 'code', probabilities: { code: 1, 'flaky-test': 0, infra: 0, environment: 0, dependency: 0 }, confidence: 1 } }, usage: { input_tokens: 300, output_tokens: 20, cost: 0.00001 } }), { status: 200 })) as typeof fetch;
    d.secrets = { OPENROUTER_API_KEY: 'sk-or-v1-' + 'ab'.repeat(32) };
    const run = await Run.create(d);
    await run.execute();
    const made = run.journal.events.filter((e) => e.type === OrchEvent.DecisionMade);
    expect(made.length).toBeGreaterThan(0);
    expect(made.map((e) => (e.data.record as { decisionId: string }).decisionId)).toContain('gate-triage');
    expect(made.find((e) => (e.data.record as { decisionId: string }).decisionId === 'gate-triage')!.data.record).toMatchObject({ decisionId: 'gate-triage', backend: 'jev' });
    expect(run.accounting.total({ provider: 'openrouter' }).steps).toBeGreaterThan(0);
    await run.close();
  });

  it('resume after a crash injected on the PR_MERGE intent confirms the merge and finishes', async () => {
    // PR_MERGE intents are keyed `<branch>@<head sha>`.
    const d = await withAgents(deps(happy, { maxParallel: 1, crashAfterIntent: (id) => id.startsWith('PR_MERGE:task/spec-001-T1@') }));
    const run = await Run.create(d);
    await expect(run.execute()).rejects.toBeInstanceOf(CrashInjected);
    const runId = run.runId;
    await run.close();
    // The intent was journaled, the effect never ran: reconcile must see an OPEN PR and let the queue merge it.
    const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, runId);
    expect(await resumed.execute()).toBe('complete');
    expect(gh.prs.filter((p) => p.head === 'task/spec-001-T1')).toHaveLength(1);
    expect(resumed.journal.events.filter((e) => e.type === OrchEvent.PrMerged && e.data.taskId === 'T1')).toHaveLength(1);
    await resumed.close();
  }, 30_000);

  it('requestStop lets the in-flight step finish and ends the run drained', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let devStarted: () => void = () => {};
    const started = new Promise<void>((r) => (devStarted = r));
    const script: Script = async (req) => {
      if (req.kind === 'dev') {
        devStarted();
        await gate;
      }
      return happy(req);
    };
    const run = await Run.create(await withAgents(deps(script, { maxParallel: 1 })));
    const done = run.execute();
    await started;
    await run.requestStop();
    await run.requestStop(); // idempotent
    release();
    expect(await done).toBe('drained');
    const types = run.journal.events.map((e) => e.type);
    expect(types.filter((t) => t === 'RUN_STOP_REQUESTED')).toHaveLength(1);
    const states = [...run.journal.state.tasks.values()].map((t) => t.state);
    expect(states).toContain('merged');
    expect(states).toContain('ready');
    await run.close();
  }, 30_000);

  it('resume clears the pid.gone marker the UI leaves behind, so a CLI resume is not listed as interrupted', async () => {
    const d = await withAgents(deps(happy));
    const run = await Run.create(d);
    await run.close();
    const marker = path.join(d.ws.runs, run.runId, 'pid.gone');
    await fs.writeFile(marker, '');
    const resumed = await Run.resume(d, run.runId);
    await expect(fs.access(marker)).rejects.toThrow();
    await resumed.close();
  });

  it('a hand resume of a stopped run is journaled after the stop, so the supervisor stops treating the stop as current', async () => {
    const d = await withAgents(deps(happy));
    const run = await Run.create(d);
    await run.requestStop();
    await run.close();
    const resumed = await Run.resume(d, run.runId);
    const types = resumed.journal.events.map((e) => e.type);
    expect(types.lastIndexOf('RUN_RESUMED')).toBeGreaterThan(types.lastIndexOf('RUN_STOP_REQUESTED'));
    await resumed.close();
  });

  it('refuses to start or resume a run with the sandbox off unless both opt-ins are set', async () => {
    const off = deps(happy, { cfg: { ...deps(happy).cfg, sandbox: { enabled: false, unsafeNoSandbox: false } } });
    await expect(Run.create(off)).rejects.toThrow(/sandbox\.enabled=false is refused/);
    await expect(Run.resume(off, 'spec-001-r1')).rejects.toThrow(/sandbox\.enabled=false is refused/);
    expect((await fs.readdir(path.join(remote.root, 'runs')).catch(() => [])).length).toBe(0); // nothing was journaled
  });

  it('refuses the k8s gate executor with a deploy target that has no in-cluster URL', async () => {
    const target = { name: 'docker-local' } as never;
    const d = deps(happy, { target, gateExecutor: { kind: 'k8s', run: async () => { throw new Error('unused'); } } as never });
    await expect(Run.create(d)).rejects.toThrow(/in-cluster service URL; the docker-local target does not/);
  });

  it('create accepts an explicit run id', async () => {
    const run = await Run.create(await withAgents(deps(happy)), 'spec-001-r7');
    expect(run.runId).toBe('spec-001-r7');
    expect(run.journal.events[0]!.data).toMatchObject({ runId: 'spec-001-r7' });
    await run.close();
  });

  describe('deployOnly (spec deploy)', () => {
    const noAgent: Script = async (req) => { throw new Error(`deploy-only ran an agent step: ${req.kind}`); };
    const target = (over: Record<string, unknown> = {}) => ({
      name: 'kind' as const,
      validate: async () => [] as string[],
      build: async () => undefined,
      apply: async () => ({ previous: null }),
      verify: async () => ({ healthy: true, detail: 'HTTP 200' }),
      currentImage: async () => null,
      rollback: async () => undefined,
      destroy: async () => undefined,
      serviceUrl: async () => 'http://127.0.0.1:3000',
      ...over,
    });

    it('deploys the plan on main with no agent step and finishes done', async () => {
      const run = await Run.create(deps(noAgent, { target: target() as never }), 'spec-001-deploy-r1');
      expect(await run.deployOnly()).toBe('done');
      expect(run.journal.events.some((e) => e.type === OrchEvent.DeployVerified && e.data.url === 'http://127.0.0.1:3000')).toBe(true);
      await run.close();
    });

    it('a failed deploy ends deploy-failed with the reason and plans no fix task', async () => {
      const run = await Run.create(deps(noAgent, { target: target({ validate: async () => ['kind target requires at least one manifest'] }) as never }), 'spec-001-deploy-r2');
      expect(await run.deployOnly()).toBe('deploy-failed');
      const finished = run.journal.events.find((e) => e.type === OrchEvent.RunFinished)!;
      expect(String(finished.data.reason)).toContain('kind target requires at least one manifest');
      expect(run.journal.events.some((e) => e.type === 'FIX_TASKS_PLANNED')).toBe(false);
      await run.close();
    });

    it('refuses without a deployment target', async () => {
      const run = await Run.create(deps(noAgent), 'spec-001-deploy-r3');
      expect(await run.deployOnly()).toBe('phase-failed');
      await run.close();
    });
  });
});

