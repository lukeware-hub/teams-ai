import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { loadConfig } from '../../server/config/config.js';
import { gateTriageQuestions } from '../../server/decide/decisions/gate-triage.js';
import { execCommand, type CommandSpec, type Exec } from '../../server/exec/command.js';
import { commitAll, fetch as gitFetch, git, withRepoLock } from '../../server/git/git.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import type { Graphify } from '../../server/knowledge/graphify.js';
import { Journal } from '../../server/orchestrator/events.js';
import { checkoutMain, readDocs, withMainSnapshot, type PhaseDeps } from '../../server/orchestrator/phases/shared.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import { TaskRunner, type TaskRunnerDeps } from '../../server/orchestrator/task-runner.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import type { StepOutcome, StepRequest } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { DEFAULT_POLICY, type FailureKind } from '../../server/scheduler/retry-policy.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

// The main checkout of ws.repo is rewritten by afterMerge (checkout + reset --hard) under the repo lock. Whatever else
// touches that repository or reads that checkout while tasks run in parallel has to queue on the same lock, or work
// from a copy that afterMerge cannot reach.

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const T1 = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const plan = makePlan(spec, { tasks: [T1] });
const replacement = makePlanTask({ id: 'T1-r1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const JUNIT = `<testsuite name="sum"><testcase classname="sum" name="[AC-001] adds"/></testsuite>`;
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary });
const failed = (failure: FailureKind, ...errors: string[]): StepOutcome<never> => ({ ok: false, failure, errors, summary: { ...summary, isError: true }, sandboxDisabled: false });

type Agent = (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>;
type Script = (req: StepRequest) => Promise<StepOutcome<any>>;

let remote: Remote;
beforeEach(async () => {
  remote = await makeRemote({
    'docs/project.json': JSON.stringify(project),
    'docs/specs/spec-001/spec.json': JSON.stringify(spec),
    'docs/specs/spec-001/tech-spec.md': '# Tech spec',
    'docs/specs/spec-001/plan.json': JSON.stringify(plan),
    'docs/adr/ADR-001-stack.md': '# ADR-001 stack\n',
    'src/index.ts': 'export const main = 1;\n',
  });
});
afterEach(async () => {
  await remote.cleanup();
});

const wsOf = () => ({ projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: path.join(remote.root, 'graph'), knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: path.join(remote.root, 'runs') });

/** git() puts `-c key=value` pairs in front of every command; the arguments of the command itself follow the last one. */
const gitArgs = (s: CommandSpec) => s.args.slice(s.args.lastIndexOf('-c') + 2);

/**
 * Wraps `inner` so that each git command `watch` selects triggers a request for the repo lock while it is in flight.
 * A command that runs under the lock keeps that request waiting until its critical section is over; one that runs
 * outside it lets the request through in the middle. The timeline holds `start`/`end` of every watched command and
 * `rival` for the moment the requester got the lock.
 */
function lockProbe(inner: Exec = execCommand, watch: (args: string[]) => boolean = () => true) {
  const timeline: string[] = [];
  const rivals: Promise<void>[] = [];
  const exec: Exec = async (command) => {
    const args = command.bin === 'git' ? gitArgs(command) : [];
    if (command.bin !== 'git' || !watch(args)) return inner(command);
    const label = args.join(' ');
    timeline.push(`start ${label}`);
    rivals.push(withRepoLock(remote.repo, async () => { timeline.push(`rival ${label}`); }));
    const result = await inner(command);
    await new Promise((r) => setImmediate(r)); // a request the lock does not hold back is served by now
    timeline.push(`end ${label}`);
    return result;
  };
  return {
    exec,
    timeline,
    /** Waits for every queued request; call before reading the timeline. */
    settle: async () => { await Promise.all(rivals); },
    started: () => timeline.filter((e) => e.startsWith('start ')).map((e) => e.slice('start '.length)),
    /** Requests that were served while a watched command ran. Empty when every command ran under the lock. */
    interleaved: () => {
      const hits: string[] = [];
      let open: string | null = null;
      for (const entry of timeline) {
        if (entry.startsWith('start ')) open = entry.slice('start '.length);
        else if (entry.startsWith('end ')) open = null;
        else if (open !== null) hits.push(`${entry} during ${open}`);
      }
      return hits;
    },
  };
}

interface Inspected { cwd: string; head: string; branch: string; docs: boolean; lock: 'free' | 'held' }

/** What an agent step sees from its cwd, plus whether the repo lock is free while it runs (the step must not hold it). */
async function inspect(cwd: string): Promise<Inspected> {
  let timer: NodeJS.Timeout | undefined;
  const lock = await Promise.race([
    withRepoLock(remote.repo, async () => 'free' as const),
    new Promise<'held'>((resolve) => { timer = setTimeout(() => resolve('held'), 2000); }),
  ]);
  clearTimeout(timer);
  return {
    cwd,
    head: await git(cwd, ['rev-parse', 'HEAD']),
    branch: await git(cwd, ['branch', '--show-current']),
    docs: await fs.access(path.join(cwd, 'docs', 'project.json')).then(() => true, () => false),
    lock,
  };
}

/** A snapshot is a checkout of its own: detached at origin/main, with the repo's files, and not the main checkout. */
async function expectSnapshot(seen: Inspected | undefined, originMain: string): Promise<void> {
  expect(seen).toBeDefined();
  expect(path.resolve(seen!.cwd)).not.toBe(path.resolve(remote.repo));
  expect(seen).toMatchObject({ head: originMain, branch: '', docs: true, lock: 'free' });
  await expect(fs.access(seen!.cwd)).rejects.toThrow(); // gone once the step is over
}

/** What another task's merge does: origin/main advances, then afterMerge checks out main and resets it to origin/main. */
async function mergeLands(file: string, text: string): Promise<void> {
  const other = path.join(remote.root, 'other');
  await git(remote.root, ['clone', '-q', remote.origin, other]);
  await fs.writeFile(path.join(other, file), text);
  await commitAll(other, 'feat: lands');
  await git(other, ['push', '-q', 'origin', 'main']);
  await gitFetch(remote.repo);
  await withRepoLock(remote.repo, async () => {
    await git(remote.repo, ['checkout', '-q', 'main']);
    await git(remote.repo, ['reset', '-q', '--hard', 'origin/main']);
  });
}

describe('phase helpers on the main checkout', () => {
  it('checkoutMain detaches the checkout and names its commit under the repo lock', async () => {
    const probe = lockProbe(execCommand, (a) => a[0] === 'checkout' || a[0] === 'rev-parse');
    const short = await checkoutMain({ ws: wsOf(), exec: probe.exec } as unknown as PhaseDeps);
    await probe.settle();
    expect(short).toBe(await git(remote.repo, ['rev-parse', '--short', 'origin/main']));
    // One critical section: nothing else gets the lock between the checkout and the rev-parse that names its result.
    expect(probe.timeline).toEqual([
      'start checkout -q --detach origin/main', 'end checkout -q --detach origin/main',
      'start rev-parse --short HEAD', 'end rev-parse --short HEAD',
      'rival checkout -q --detach origin/main', 'rival rev-parse --short HEAD',
    ]);
  });

  it('readDocs reads origin/main under the repo lock', async () => {
    const probe = lockProbe(execCommand, (a) => a[0] === 'show');
    const docs = await readDocs(remote.repo, 'spec-001', probe.exec);
    await probe.settle();
    expect(docs.techSpecText).toContain('# Tech spec');
    expect(docs.plan?.specId).toBe('spec-001');
    expect(probe.started()).toHaveLength(3); // tech-spec.md, plan.json, preplan.json
    expect(probe.interleaved()).toEqual([]);
  });
});

describe('withMainSnapshot', () => {
  it('hands the step a detached checkout of origin/main, holds the lock only to add and remove it, and removes it afterwards', async () => {
    const probe = lockProbe(execCommand, (a) => a[0] === 'worktree');
    let seen: Inspected | undefined;
    await withMainSnapshot(wsOf(), probe.exec, async (cwd) => { seen = await inspect(cwd); });
    await probe.settle();
    await expectSnapshot(seen, await git(remote.repo, ['rev-parse', 'origin/main']));
    expect(probe.started().some((l) => l.startsWith('worktree add --detach '))).toBe(true);
    expect(probe.started().some((l) => l.startsWith('worktree remove '))).toBe(true);
    expect(probe.interleaved()).toEqual([]);
    expect(await git(remote.repo, ['worktree', 'list', '--porcelain'])).not.toContain('snapshot__');
  });

  it('removes the snapshot and passes the error on when the step fails', async () => {
    let dir = '';
    await expect(withMainSnapshot(wsOf(), execCommand, async (cwd) => { dir = cwd; throw new Error('step failed'); })).rejects.toThrow('step failed');
    expect(dir).not.toBe('');
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('gives steps that overlap a snapshot each', async () => {
    const dirs = await Promise.all([1, 2].map(() => withMainSnapshot(wsOf(), execCommand, async (cwd) => { await new Promise((r) => setTimeout(r, 50)); return cwd; })));
    expect(new Set(dirs).size).toBe(2);
  });
});

describe('SM steps of a task', () => {
  let journal: Journal;
  beforeEach(async () => {
    journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'spec-001-r1', specHash: HASH });
    await journal.fact(RunEvent.TaskPlanned, { task: T1 });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
  });
  afterEach(async () => {
    await journal.close();
  });

  function taskDeps(agent: Agent, exec: Exec): TaskRunnerDeps {
    return {
      journal, ws: wsOf(), spec, project, plan, specHash: HASH, firstSpec: false, exec, skillsRoot: path.join(remote.root, 'skills'),
      runAgent: (async (req) => agent(req)) as TaskRunnerDeps['runAgent'],
      gates: async () => ({ results: [], blockingFailure: null }),
      installDeps: async () => null,
      mergeQueue: new MergeQueue(),
      mergeSteps: () => { throw new Error('these tests never reach the merge'); },
      code: async () => ({ source: 'none' }),
      impact: async () => ({ source: 'none' }),
      decider: { decide: async () => ({ answered: false, reason: 'disabled' }) },
      tierModel: (_role, tier) => ({ small: 'haiku', medium: 'sonnet', large: 'opus' })[tier],
      policy: DEFAULT_POLICY,
      packBase: () => ({ spec, project, specHash: HASH, assumptions: journal.assumptions(), budgetTokens: 8000 }),
      handoffs: () => [],
      boundaries: async () => ['src'],
      deliveredBefore: new Set(),
    };
  }

  it('a spec-gap answer is produced in a snapshot of origin/main that a merge landing on main does not change', async () => {
    const originMain = await git(remote.repo, ['rev-parse', 'origin/main']);
    const read = (cwd: string) => fs.readFile(path.join(cwd, 'src', 'index.ts'), 'utf8');
    const reads: string[] = [];
    let seen: Inspected | undefined;
    let devCalls = 0;
    const agent: Agent = async (req) => {
      if (req.kind === 'spec-gap') {
        seen = await inspect(req.cwd);
        reads.push(await read(req.cwd));
        await mergeLands('src/index.ts', 'export const main = 2;\n'); // afterMerge of another task, mid-step
        reads.push(await read(req.cwd));
        return ok({ specHash: HASH, answer: 'Use UTC', assumption: 'T1: timezone -> UTC' });
      }
      return ++devCalls === 1
        ? ok({ specHash: HASH, status: 'spec-gap', summary: 'unclear', changedFiles: [], question: 'Which timezone?' })
        : ok({ specHash: HASH, status: 'blocked', summary: 'stop here', changedFiles: [], reason: 'the test ends here' });
    };
    const probe = lockProbe(execCommand, (a) => a[0] === 'worktree');
    await new TaskRunner('T1', taskDeps(agent, probe.exec)).advance();
    await probe.settle();
    await expectSnapshot(seen, originMain);
    expect(reads).toEqual(['export const main = 1;\n', 'export const main = 1;\n']);
    expect(await read(remote.repo)).toBe('export const main = 2;\n'); // the main checkout did move
    expect(journal.state.tasks.get('T1')!.state).toBe('blocked');
    expect(probe.started().some((l) => l.startsWith('worktree add --detach '))).toBe(true);
    expect(probe.interleaved()).toEqual([]);
  });

  it('a replan is produced in a snapshot of origin/main', async () => {
    const originMain = await git(remote.repo, ['rev-parse', 'origin/main']);
    let seen: Inspected | undefined;
    const agent: Agent = async (req) => {
      if (req.kind === 'dev') return failed('compaction', 'the Dev ran out of context'); // the policy answers with a replan
      seen = await inspect(req.cwd);
      return ok({ specHash: HASH, replacements: [replacement] });
    };
    const probe = lockProbe(execCommand, (a) => a[0] === 'worktree');
    await new TaskRunner('T1', taskDeps(agent, probe.exec)).advance();
    await probe.settle();
    await expectSnapshot(seen, originMain);
    expect(journal.state.tasks.get('T1')!.state).toBe('superseded');
    expect(probe.started().some((l) => l.startsWith('worktree add --detach '))).toBe(true);
    expect(probe.interleaved()).toEqual([]);
  });
});

describe('Run', () => {
  async function runDeps(script: Script, over: Partial<RunDeps> = {}): Promise<RunDeps> {
    const cfg = loadConfig({ paths: { workspaces: path.join(remote.root, 'ws').replace(/\\/g, '/'), runs: path.join(remote.root, 'runs').replace(/\\/g, '/'), secrets: '/tmp/none' } });
    const exec = new FakeExec()
      .on((s) => s.bin === 'git', (s) => execCommand(s))
      .onArgs('docker', ['run'], async (s) => {
        // The smoke gate passes and leaves a JUnit report in the bind-mounted context.
        const mount = s.args.find((a) => a.startsWith('type=bind,source=') && a.endsWith(',target=/work'))!;
        const dir = mount.slice('type=bind,source='.length, mount.length - ',target=/work'.length);
        await fs.mkdir(path.join(dir, 'reports'), { recursive: true });
        await fs.writeFile(path.join(dir, 'reports', 'junit.xml'), JUNIT);
        return { exitCode: 0 };
      });
    return {
      cfg, ws: wsOf(), project, spec, firstSpec: false,
      exec: exec.exec, ghExec: exec.exec,
      runStep: (async (req: StepRequest) => script(req)) as RunDeps['runStep'],
      binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
      agents: await loadAgents(path.resolve('.claude/agents')),
      graphify: null, knowledge: null, secrets: {}, log: () => {},
      ...over,
    };
  }
  const noStep: Script = async (req) => { throw new Error(`unexpected agent step: ${req.kind}`); };

  it('loads the ADRs from origin/main under the repo lock', async () => {
    const probe = lockProbe(execCommand, (a) => a[0] === 'ls-tree' || a[0] === 'show');
    const run = await Run.create(await runDeps(noStep, { exec: probe.exec }));
    await run['loadAdrs']();
    await probe.settle();
    expect(run['adrs'].map((a) => a.id)).toEqual(['ADR-001']);
    expect(probe.started()).toEqual(['ls-tree --name-only origin/main docs/adr/', 'show origin/main:docs/adr/ADR-001-stack.md']);
    expect(probe.interleaved()).toEqual([]);
    await run.close();
  });

  it('lists the tracked files of the main checkout for the graph coverage under the repo lock', async () => {
    const timeline: string[] = [];
    const rivals: Promise<void>[] = [];
    const graphify = {
      trackedFiles: async () => {
        timeline.push('start trackedFiles');
        rivals.push(withRepoLock(remote.repo, async () => { timeline.push('rival'); }));
        await new Promise((r) => setImmediate(r));
        timeline.push('end trackedFiles');
        return ['src/index.ts'];
      },
      coverage: async () => ({ extracted: 0, failed: 0, nodes: 0, links: 0, ratio: 0 }),
    } as unknown as Graphify;
    const run = await Run.create(await runDeps(noStep, { graphify }));
    await run['codeFor']({ service: null, plan })(remote.repo, T1);
    await Promise.all(rivals);
    expect(timeline).toEqual(['start trackedFiles', 'end trackedFiles', 'rival']);
    await run.close();
  });

  it('lists the replan boundaries from origin/main under the repo lock', async () => {
    const probe = lockProbe(execCommand, (a) => a[0] === 'ls-tree');
    const run = await Run.create(await runDeps(noStep, { exec: probe.exec }));
    expect(await run['runnerDeps']({ service: null, plan }).boundaries()).toEqual(['docs', 'src']);
    await probe.settle();
    expect(probe.started()).toEqual(['ls-tree --name-only origin/main']);
    expect(probe.interleaved()).toEqual([]);
    await run.close();
  });

  it('deployOnly fetches and reads the plan from origin/main under the repo lock', async () => {
    const probe = lockProbe(execCommand, (a) => a[0] === 'fetch' || a[0] === 'show' || a[0] === 'checkout');
    const fake = (await runDeps(noStep)).exec;
    const target = {
      name: 'kind' as const,
      validate: async () => [] as string[],
      build: async () => undefined,
      apply: async () => ({ previous: null }),
      verify: async () => ({ healthy: true, detail: 'HTTP 200' }),
      currentImage: async () => null,
      rollback: async () => undefined,
      destroy: async () => undefined,
      serviceUrl: async () => 'http://127.0.0.1:3000',
    };
    // Git goes through the probe, everything else (docker for the smoke gate) through the scripted fake.
    const routed: Exec = (command) => (command.bin === 'git' ? probe.exec(command) : fake(command));
    const run = await Run.create(await runDeps(noStep, { exec: routed, ghExec: routed, target: target as never }), 'spec-001-deploy-r1');
    expect(await run.deployOnly()).toBe('done');
    await probe.settle();
    expect(probe.started().some((l) => l.startsWith('fetch '))).toBe(true);
    expect(probe.started()).toContain('show origin/main:docs/specs/spec-001/plan.json');
    expect(probe.interleaved()).toEqual([]);
    await run.close();
  });

  it('a Claude escalation of the decider runs in a snapshot of origin/main, not in the main checkout', async () => {
    const originMain = await git(remote.repo, ['rev-parse', 'origin/main']);
    let seen: Inspected | undefined;
    const script: Script = async (req) => {
      if (req.kind !== 'decide') throw new Error(`unexpected agent step: ${req.kind}`);
      seen = await inspect(req.cwd);
      return ok({ specHash: HASH, answers: { kind: { type: 'choice', value: 'code' } } });
    };
    const cfg = loadConfig({ paths: { workspaces: path.join(remote.root, 'ws').replace(/\\/g, '/'), runs: path.join(remote.root, 'runs').replace(/\\/g, '/'), secrets: '/tmp/none' }, decisions: { enabled: true } });
    const run = await Run.create(await runDeps(script, { cfg }));
    // No OpenRouter key and no local server: the chain skips to Claude.
    const outcome = await run['decider']().decide('gate-triage', 'gate: unit-test', gateTriageQuestions(), { confidential: false });
    expect(outcome).toMatchObject({ answered: true, backend: 'claude', escalated: true });
    await expectSnapshot(seen, originMain);
    await run.close();
  });
});
