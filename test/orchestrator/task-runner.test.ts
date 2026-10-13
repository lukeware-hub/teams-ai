import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { commitAll, createWorktree, git, headSha } from '../../server/git/git.js';
import { MergeQueue, type MergeOutcome, type MergeSteps } from '../../server/git/merge-queue.js';
import { buildContextPack } from '../../server/knowledge/context-pack.js';
import { Intent, Journal, OrchEvent } from '../../server/orchestrator/events.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import { TaskRunner, type TaskRunnerDeps } from '../../server/orchestrator/task-runner.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { DEFAULT_POLICY, type FailureKind } from '../../server/scheduler/retry-policy.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const T1 = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const plan = makePlan(spec, { tasks: [T1] });
const summary = (over: Partial<ResultSummary> = {}): ResultSummary => ({
  found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 100, costUsd: 0.01,
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null,
  apiErrorStatus: null, rateLimit: null, compactions: 0, ...over,
});
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary: summary() });
const failed = (failure: FailureKind, ...errors: string[]): StepOutcome<never> => ({ ok: false, failure, errors, summary: summary({ isError: true }), sandboxDisabled: false });
const gate = (name: string, over: Partial<GateResult> = {}): GateResult => ({
  name, blocking: true, passed: true, exitCode: 0, timedOut: false, durationMs: 10, stdoutTail: '', stderrTail: '',
  junit: [{ id: 'sum::[AC-001] adds', name: '[AC-001] adds', classname: 'sum', status: 'passed', acIds: ['AC-001'] }], failure: null, ...over,
});

type Agent = (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>;
const secApprove = () => ok({ specHash: HASH, decision: 'approve', findings: [] });
const devDone = (message = 'feat: T1'): Agent => async (req) => {
  if (req.kind === 'security') return secApprove();
  await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true });
  await fs.writeFile(path.join(req.cwd, 'src', 'a.ts'), `// ${Date.now()}\n`);
  return ok({ specHash: HASH, status: 'done', summary: 'did T1', changedFiles: ['src/a.ts'], commitMessage: message });
};
const approve = () => ok({ specHash: HASH, decision: 'approve', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }], findings: [] });

let remote: Remote;
let journal: Journal;
let agentCalls: AgentStepRequest<any>[] = [];
beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'spec-001-r1', specHash: HASH });
  await journal.fact(RunEvent.TaskPlanned, { task: T1 });
  await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
  agentCalls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(over: Partial<TaskRunnerDeps> & { agent?: Agent; merge?: Partial<MergeSteps> | MergeOutcome } = {}): TaskRunnerDeps {
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: path.join(remote.root, 'graph'), knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  const agent = over.agent ?? devDone();
  const forced: MergeOutcome | null = over.merge && 'ok' in over.merge ? over.merge : null;
  const steps: MergeSteps = {
    alreadyMerged: async () => null,
    rebase: async () => ({ ok: true, baseSha: 'base' }),
    gates: async () => ({ ok: true }),
    push: async () => {},
    ensurePr: async () => ({ number: 7 }),
    remoteMainSha: async () => 'base',
    merge: async () => (forced && !forced.ok ? { merged: false, reason: forced.detail } : { merged: true }),
    ...(over.merge && !('ok' in over.merge) ? over.merge : {}),
  };
  const { agent: _a, merge: _m, ...rest } = over;
  return {
    journal, ws, spec, project, plan, specHash: HASH, firstSpec: false,
    exec: execCommand,
    runAgent: (async (req) => { agentCalls.push(req); return agent(req); }) as TaskRunnerDeps['runAgent'],
    gates: async () => ({ results: [gate('unit-test')], blockingFailure: null }),
    installDeps: async () => null,
    mergeQueue: new MergeQueue(),
    mergeSteps: () => steps,
    code: async () => ({ source: 'none' }),
    impact: async () => ({ source: 'none' }),
    decider: { decide: async () => ({ answered: false, reason: 'disabled' }) },
    tierModel: (_role, tier) => ({ small: 'haiku', medium: 'sonnet', large: 'opus' })[tier],
    policy: DEFAULT_POLICY,
    packBase: () => ({ spec, project, specHash: HASH, assumptions: journal.assumptions(), budgetTokens: 8000 }),
    handoffs: () => [],
    boundaries: async () => ['src'],
    deliveredBefore: new Set(),
    ...rest,
  };
}
const types = () => journal.events.map((e) => `${e.kind}:${e.type}`);
const state = () => journal.state.tasks.get('T1')!;

describe('TaskRunner: implementing', () => {
  it('creates the worktree, runs Dev, commits and moves to validating with intent/confirm pairs', async () => {
    const r = new TaskRunner('T1', deps());
    await r.advance();
    expect(state().state).toBe('validating');
    expect(types()).toEqual([
      'fact:TASK_PLANNED', 'fact:TASK_STATE_CHANGED', 'fact:TASK_STATE_CHANGED',
      `intent:${Intent.WorktreeCreate}`, `confirm:${Intent.WorktreeCreate}`,
      `intent:${Intent.Commit}`, `confirm:${Intent.Commit}`, `fact:${OrchEvent.DevCommitted}`, 'fact:TASK_STATE_CHANGED',
    ]);
    const sha = await headSha(r.worktree);
    expect(journal.events.find((e) => e.type === OrchEvent.DevCommitted)!.data).toMatchObject({ taskId: 'T1', sha, changedFiles: ['src/a.ts'] });
    expect(await git(r.worktree, ['log', '-1', '--format=%s'])).toBe('feat: T1');
    expect(agentCalls[0]).toMatchObject({ kind: 'dev', role: 'dev', taskId: 'T1', attempt: 1, cwd: r.worktree });
    expect(agentCalls[0]!.pack.feedback).toBeUndefined();
  });

  it('deletes files the Dev lists in deletedFiles before committing', async () => {
    await journal.close();
    await remote.cleanup();
    remote = await makeRemote({
      'docs/project.json': JSON.stringify(project),
      'docs/specs/spec-001/spec.json': JSON.stringify(spec),
      'src/old.ts': '// stale\n',
    });
    journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'spec-001-r1', specHash: HASH });
    await journal.fact(RunEvent.TaskPlanned, { task: T1 });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
    const devDeletes: Agent = async (req) => {
      if (req.kind === 'security') return secApprove();
      await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true });
      await fs.writeFile(path.join(req.cwd, 'src', 'a.ts'), `// ${Date.now()}\n`);
      return ok({
        specHash: HASH, status: 'done', summary: 'did T1', changedFiles: ['src/a.ts'],
        deletedFiles: ['src/old.ts'], commitMessage: 'feat: T1',
      });
    };
    const r = new TaskRunner('T1', deps({ agent: devDeletes }));
    await r.advance();
    expect(state().state).toBe('validating');
    await expect(fs.access(path.join(r.worktree, 'src', 'old.ts'))).rejects.toThrow();
    expect(await git(r.worktree, ['show', '--stat', '-1', '--format='])).toContain('old.ts');
    const event = journal.events.find((e) => e.type === OrchEvent.DevCommitted)!.data as { changedFiles: string[] };
    expect(event.changedFiles).toContain('src/old.ts');
  });

  it('passes the ephemeral test database URL as extraEnv to Dev and Test when one was provisioned for this run', async () => {
    const agent: Agent = async (req) => {
      if (req.kind === 'review') return approve();
      return devDone()(req);
    };
    const r = new TaskRunner('T1', deps({ agent, testDatabaseUrl: 'postgres://u:p@dind:55432/t' }));
    for (let i = 0; i < 3; i++) await r.advance();
    const dev = agentCalls.find((c) => c.kind === 'dev')!;
    const review = agentCalls.find((c) => c.kind === 'review')!;
    expect(dev.extraEnv).toEqual({ DATABASE_URL: 'postgres://u:p@dind:55432/t' });
    expect(review.extraEnv).toEqual({ DATABASE_URL: 'postgres://u:p@dind:55432/t' });
  });

  it('sends no extraEnv to Dev when no test database was provisioned for this run', async () => {
    const r = new TaskRunner('T1', deps());
    await r.advance();
    expect(agentCalls[0]!.extraEnv).toBeUndefined();
  });

  it('routes a spec-gap to the SM, journals the assumption and re-runs Dev with the answer, no attempt consumed', async () => {
    let devCalls = 0;
    const agent: Agent = async (req) => {
      if (req.kind === 'spec-gap') return ok({ specHash: HASH, answer: 'Use UTC everywhere', assumption: 'T1: timezone → UTC' });
      devCalls += 1;
      if (devCalls === 1) return ok({ specHash: HASH, status: 'spec-gap', summary: 'unclear', changedFiles: [], question: 'Which timezone?' });
      return devDone()(req);
    };
    const r = new TaskRunner('T1', deps({ agent }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'validating', attempts: 0 });
    expect(journal.events.find((e) => e.type === OrchEvent.SpecGapAnswered)!.data).toMatchObject({ taskId: 'T1', question: 'Which timezone?', answer: 'Use UTC everywhere', assumption: 'T1: timezone → UTC' });
    expect(agentCalls.map((c) => c.kind)).toEqual(['dev', 'spec-gap', 'dev']);
    expect(agentCalls[2]!.pack.feedback).toContain('Use UTC everywhere');
    expect(agentCalls[2]!.pack.assumptions).toContain('T1: timezone → UTC');
  });

  it('a blocked Dev blocks the task at once with the reason: no SM round, no attempt consumed', async () => {
    const agent: Agent = async () => ok({ specHash: HASH, status: 'blocked', summary: 'cannot deploy', changedFiles: [], reason: 'the smoke gate has no network' });
    const r = new TaskRunner('T1', deps({ agent }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'blocked', attempts: 0 });
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked)!.data).toMatchObject({ taskId: 'T1', reason: 'the smoke gate has no network' });
    expect(agentCalls.map((c) => c.kind)).toEqual(['dev']);
  });

  it('retries a blocked Dev whose tool result shows the sandbox failing to start, whatever language it reports in', async () => {
    let devCalls = 0;
    const agent: Agent = async (req) => {
      if (req.kind !== 'dev') return devDone()(req);
      devCalls += 1;
      if (devCalls === 1) {
        const out = ok({ specHash: HASH, status: 'blocked', summary: 'sem shell', changedFiles: [], reason: 'O Bash foi negado e o sandbox falhou ao inicializar.' });
        return { ...out, summary: { ...out.summary, profile: { thinkingTokens: 0, durationApiMs: 0, toolCalls: { Bash: 1 }, toolResultChars: 80, sandboxInitFailed: true } } };
      }
      return devDone()(req);
    };
    const r = new TaskRunner('T1', deps({ agent }));
    for (let i = 0; i < 2; i++) await r.advance();
    expect(state()).toMatchObject({ state: 'validating', attempts: 0 });
    expect(devCalls).toBe(2);
  });

  it('a blocked Dev citing a sandbox startup failure is retried, not blocked, without spending an attempt', async () => {
    // "Failed to create bridge sockets" is the claude CLI's own sandbox init failing, a known transient flake of
    // this session (unrelated to network policy or installed dependencies) — one extra try is cheap and often works.
    let devCalls = 0;
    const agent: Agent = async (req) => {
      if (req.kind !== 'dev') return devDone()(req);
      devCalls += 1;
      if (devCalls === 1) return ok({ specHash: HASH, status: 'blocked', summary: 'no shell', changedFiles: [], reason: "Failed to create bridge sockets after 5 attempts; Bash was denied." });
      return devDone()(req);
    };
    const r = new TaskRunner('T1', deps({ agent }));
    for (let i = 0; i < 2; i++) await r.advance();
    expect(state()).toMatchObject({ state: 'validating', attempts: 0 });
    expect(journal.events.some((e) => e.type === OrchEvent.TaskBlocked)).toBe(false);
    expect(journal.events.find((e) => e.type === RunEvent.InfraRetry)!.data).toMatchObject({ taskId: 'T1' });
    expect(devCalls).toBe(2);
  });

  it('caps spec-gap rounds at three per attempt', async () => {
    const agent: Agent = async (req) =>
      req.kind === 'spec-gap' ? ok({ specHash: HASH, answer: 'a', assumption: 'T1: q → a' }) : ok({ specHash: HASH, status: 'spec-gap', summary: 's', changedFiles: [], question: 'q' });
    const r = new TaskRunner('T1', deps({ agent }));
    await r.advance();
    expect(agentCalls.filter((c) => c.kind === 'dev')).toHaveLength(4);
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('spec-gap rounds exhausted');
  });

  it('treats a scope violation as a failed attempt with the offending files as feedback', async () => {
    const agent: Agent = async (req) => {
      await fs.writeFile(path.join(req.cwd, 'README.md'), 'oops');
      return ok({ specHash: HASH, status: 'done', summary: 'x', changedFiles: ['README.md'], commitMessage: 'feat: x' });
    };
    const r = new TaskRunner('T1', deps({ agent }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('README.md');
    expect(journal.events.some((e) => e.type === Intent.Commit)).toBe(false);
  });

  it('a Dev that changes nothing fails the attempt instead of reaching gates, review and a PR', async () => {
    const r = new TaskRunner('T1', deps({ agent: async () => ok({ specHash: HASH, status: 'done', summary: 'nothing', changedFiles: [], commitMessage: 'feat: nothing' }) }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('no changes');
  });

  it('a Dev that changes nothing on a task whose paths are all on main already adopts it as merged (an earlier run delivered it)', async () => {
    const done = makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['docs/project.json'] });
    await journal.fact(RunEvent.TaskPlanned, { task: done });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T2', to: 'ready' });
    const r = new TaskRunner('T2', deps({ plan: makePlan(spec, { tasks: [T1, done] }), agent: async () => ok({ specHash: HASH, status: 'done', summary: 'already there', changedFiles: [], commitMessage: 'feat: nothing' }) }));
    await r.advance();
    expect(journal.state.tasks.get('T2')).toMatchObject({ state: 'merged', attempts: 0 });
    expect(journal.events.some((e) => e.type === OrchEvent.AlreadyOnMain && e.data.taskId === 'T2')).toBe(true);
  });

  // Plan 75 review: a new version re-plans the scaffold of a project's first spec, which has no criteria, so only
  // an earlier delivery of the same id tells an empty diff apart from a Dev that did nothing.
  it('a Dev that changes nothing on a task an earlier run of the spec delivered adopts it as merged, even with no criteria', async () => {
    const scaffold = makePlanTask({ id: 'T2', criteriaRefs: [], affectedPaths: ['src/not-on-main.ts'] });
    await journal.fact(RunEvent.TaskPlanned, { task: scaffold });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T2', to: 'ready' });
    const agent: Agent = async () => ok({ specHash: HASH, status: 'done', summary: 'nothing left to change', changedFiles: [], commitMessage: 'feat: nothing' });
    const r = new TaskRunner('T2', deps({ deliveredBefore: new Set(['T2']), plan: makePlan(spec, { tasks: [T1, scaffold] }), agent }));
    await r.advance();
    expect(journal.state.tasks.get('T2')).toMatchObject({ state: 'merged', attempts: 0 });
    expect(journal.events.some((e) => e.type === OrchEvent.AlreadyOnMain && e.data.taskId === 'T2')).toBe(true);
  });

  it('pauses the run on a quota failure without consuming an attempt', async () => {
    const r = new TaskRunner('T1', deps({ agent: async () => failed('quota', 'usage limit reached') }));
    await r.advance();
    expect(journal.state.status).toBe('paused:quota');
    expect(state()).toMatchObject({ state: 'implementing', attempts: 0 });
  });

  it('a front-owned task runs the implement step as role front, not dev', async () => {
    const front = makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['web/src/x.tsx'], owner: 'front' });
    await journal.fact(RunEvent.TaskPlanned, { task: front });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T2', to: 'ready' });
    const r = new TaskRunner('T2', deps({ plan: makePlan(spec, { tasks: [T1, front] }) }));
    await r.advance();
    expect(agentCalls[0]).toMatchObject({ kind: 'dev', role: 'front', taskId: 'T2' });
    expect(agentCalls[0]!.pack.role).toBe('front');
  });

  it('a devops-owned task runs the implement step as role devops, not dev', async () => {
    const infra = makePlanTask({ id: 'T3', criteriaRefs: ['AC-001'], affectedPaths: ['Dockerfile'], owner: 'devops' });
    await journal.fact(RunEvent.TaskPlanned, { task: infra });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T3', to: 'ready' });
    const r = new TaskRunner('T3', deps({ plan: makePlan(spec, { tasks: [T1, infra] }) }));
    await r.advance();
    expect(agentCalls[0]).toMatchObject({ kind: 'dev', role: 'devops', taskId: 'T3' });
    expect(agentCalls[0]!.pack.role).toBe('devops');
  });
});

describe('TaskRunner: installing dependencies before the Dev starts', () => {
  // A fresh worktree from origin/main never has node_modules (R11.2 live check, 2026-10-07): the Dev's own
  // rules make it run the project's test command to self-verify before reporting done, and with nothing
  // installed Node's resolver climbed out of the worktree and picked up teams-ai's own dependency tree
  // instead, failing on a native binding teams-ai's copy doesn't even need. Installing before the Dev
  // starts (not only in the gate afterwards) closes that window.
  it('installs dependencies in the worktree before the Dev agent runs', async () => {
    const calls: string[] = [];
    const installDeps: TaskRunnerDeps['installDeps'] = async (worktree) => {
      calls.push(`install:${worktree}`);
      return null;
    };
    const agent: Agent = async (req) => {
      calls.push(`agent:${req.kind}`);
      return devDone()(req);
    };
    const r = new TaskRunner('T1', deps({ agent, installDeps }));
    await r.advance();
    expect(calls[0]).toBe(`install:${r.worktree}`);
    expect(calls[1]).toBe('agent:dev');
    expect(state().state).toBe('validating');
  });

  it('a failing install fails the task like a blocking gate, without ever calling the Dev agent', async () => {
    let devCalled = false;
    const agent: Agent = async (req) => {
      if (req.kind === 'dev') devCalled = true;
      return devDone()(req);
    };
    const installDeps: TaskRunnerDeps['installDeps'] = async () => gate('install', { passed: false, exitCode: 1, failure: 'code', junit: null, stderrTail: 'npm ERR! network timeout' });
    const r = new TaskRunner('T1', deps({ agent, installDeps }));
    await r.advance();
    expect(devCalled).toBe(false);
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('npm ERR! network timeout');
  });
});

describe('TaskRunner: validating', () => {
  async function implemented(over: Parameters<typeof deps>[0] = {}) {
    const r = new TaskRunner('T1', deps(over));
    await r.advance();
    expect(state().state).toBe('validating');
    return r;
  }
  const failing = (over: Partial<GateResult>): TaskRunnerDeps['gates'] => async () => {
    const g = gate('unit-test', { passed: false, exitCode: 1, failure: 'code', junit: null, ...over });
    return { results: [g], blockingFailure: g };
  };

  it('passes every gate and moves to reviewing', async () => {
    const r = await implemented();
    await r.advance();
    expect(state().state).toBe('reviewing');
    expect(journal.events.filter((e) => e.type === OrchEvent.GatePassed).map((e) => e.data.gate)).toEqual(['unit-test']);
  });

  it('returns a code failure to Dev with the failed tests and the tail as feedback', async () => {
    const r = await implemented({ gates: failing({ stderrTail: 'AssertionError: 2 != 3', junit: [{ id: 'sum::[AC-001] adds', name: '[AC-001] adds', classname: 'sum', status: 'failed', acIds: ['AC-001'] }] }) });
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.events.find((e) => e.type === OrchEvent.GateFailed)!.data).toMatchObject({ gate: 'unit-test', failure: 'code' });
    const fb = journal.lastFeedback('T1')!;
    expect(fb).toContain('sum::[AC-001] adds');
    expect(fb).toContain('AssertionError');
  });

  it('re-runs an infra failure without consuming an attempt', async () => {
    const r = await implemented({ gates: failing({ exitCode: 137, failure: 'infra' }) });
    await r.advance();
    expect(state()).toMatchObject({ state: 'validating', attempts: 0, infraRetries: { 'unit-test': 1 } });
  });

  it('uses the decider triage when the rule says code', async () => {
    const r = await implemented({
      decider: { decide: async () => ({ answered: true, backend: 'jev', escalated: false, answers: { kind: { type: 'choice', value: 'flaky-test', probabilities: { 'flaky-test': 0.9, code: 0.1 }, confidence: 0.9 } } }) },
      gates: failing({}),
    });
    await r.advance();
    expect(state()).toMatchObject({ state: 'validating', attempts: 0, flakyRetries: { 'unit-test': 1 } });
  });
});

describe('TaskRunner: reviewing', () => {
  const review = (decision: 'approve' | 'changes', evidence = ['sum::[AC-001] adds']) =>
    ok({ specHash: HASH, decision, criteria: [{ id: 'AC-001', status: decision === 'approve' ? 'passed' : 'failed', evidence }], findings: decision === 'changes' ? [{ file: 'src/a.ts', line: 1, severity: 'important', problem: 'no test for the empty case', fix: 'add it', acIds: ['AC-001'] }] : [] });
  async function validated(reviewer: Agent) {
    const r = new TaskRunner('T1', deps({ agent: async (req) => (req.kind === 'review' ? reviewer(req) : devDone()(req)) }));
    await r.advance();
    await r.advance();
    expect(state().state).toBe('reviewing');
    return r;
  }

  it('approves with verified evidence and moves to rebasing', async () => {
    const r = await validated(async () => review('approve'));
    await r.advance();
    expect(state().state).toBe('rebasing');
    expect(types()).toContain(`fact:${OrchEvent.ReviewApproved}`);
    expect(agentCalls.find((c) => c.kind === 'review')!.pack.changeSet).toContain('src/a.ts');
  });

  it('returns findings to Dev on changes', async () => {
    const r = await validated(async () => review('changes'));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('no test for the empty case');
  });

  it('runs the security review beside the Test review but counts it only when Test approves', async () => {
    const r = await validated(async () => review('changes'));
    await r.advance();
    expect(agentCalls.map((c) => c.kind)).toEqual(expect.arrayContaining(['review', 'security']));
    expect(types()).not.toContain(`fact:${OrchEvent.SecurityApproved}`);
    expect(types()).not.toContain(`fact:${OrchEvent.SecurityChanges}`);
  });

  it('rejects a review whose evidence does not exist as a schema failure, then counts an attempt', async () => {
    const r = await validated(async () => review('approve', ['sum::[AC-001] ghost']));
    await r.advance();
    expect(state()).toMatchObject({ state: 'reviewing', attempts: 0 });
    expect(journal.lastFeedback('T1')).toContain('ghost');
    await r.advance();
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
  });
});

describe('TaskRunner: security review', () => {
  const finding = (severity: string) => ({ file: 'src/a.ts', line: 3, severity, category: 'injection', problem: 'user input reaches a shell', fix: 'use execFile with an argument array' });
  async function secured(sec: Agent) {
    const r = new TaskRunner('T1', deps({ agent: async (req) => (req.kind === 'review' ? approve() : req.kind === 'security' ? sec(req) : devDone()(req)) }));
    for (let i = 0; i < 3; i++) await r.advance();
    return r;
  }

  it('runs the sec role on the diff after Test approves, then moves to rebasing', async () => {
    await secured(async () => secApprove());
    expect(state().state).toBe('rebasing');
    const call = agentCalls.find((c) => c.kind === 'security')!;
    expect(call).toMatchObject({ role: 'sec', taskId: 'T1' });
    expect(call.model).toBeUndefined();
    expect(call.effort).toBeUndefined();
    expect(call.pack.changeSet).toContain('Diff against origin/main');
    expect(call.pack.changeSet).toContain('src/a.ts');
    expect(call.pack.changeSet).not.toContain('diff truncated');
    expect(agentCalls.map((c) => c.kind)).toEqual(['dev', 'security', 'review']);
    expect(types()).toContain(`fact:${OrchEvent.SecurityApproved}`);
  });

  it('tells sec the diff was cut at the inline limit and where to look for the rest', async () => {
    const bigDev: Agent = async (req) => {
      if (req.kind === 'security') return secApprove();
      await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true });
      await fs.writeFile(path.join(req.cwd, 'src', 'big.ts'), '// padding that makes the diff larger than the inline limit\n'.repeat(2000));
      return ok({ specHash: HASH, status: 'done', summary: 'did T1', changedFiles: ['src/big.ts'], commitMessage: 'feat: T1' });
    };
    const r = new TaskRunner('T1', deps({ agent: async (req) => (req.kind === 'review' ? approve() : bigDev(req)) }));
    for (let i = 0; i < 3; i++) await r.advance();
    const changeSet = agentCalls.find((c) => c.kind === 'security')!.pack.changeSet!;
    const total = Number(/\[diff truncated: first 80000 of (\d+) characters shown/.exec(changeSet)?.[1]);
    expect(total).toBeGreaterThan(80_000);
    expect(changeSet).toContain('affectedPaths');
    // What sec is shown stays within the limit (plus the headings and the notice), not the whole diff.
    expect(changeSet.length).toBeLessThan(80_000 + 1000);
    expect(state().state).toBe('rebasing');
  });

  describe('under the run budget (budgetTokens 12_000, as in run.ts)', () => {
    // The sec prompt is buildContextPack(pack), which is what runAgentStep sends: the budget trims the pack, not the request.
    async function secPrompt(diffChars: number) {
      const padding = `// ${'p'.repeat(76)}\n`.repeat(Math.ceil(diffChars / 80)); // 80 chars a line, 81 once the diff prefixes it
      const dev: Agent = async (req) => {
        if (req.kind === 'review') return approve();
        if (req.kind === 'security') return secApprove();
        await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true });
        await fs.writeFile(path.join(req.cwd, 'src', 'big.ts'), `${padding}// END-OF-FILE\n`);
        return ok({ specHash: HASH, status: 'done', summary: 'did T1', changedFiles: ['src/big.ts'], commitMessage: 'feat: T1' });
      };
      const r = new TaskRunner('T1', deps({ agent: dev, packBase: () => ({ spec, project, specHash: HASH, assumptions: journal.assumptions(), budgetTokens: 12_000 }) }));
      for (let i = 0; i < 3; i++) await r.advance();
      const full = await git(r.worktree, ['diff', 'origin/main...HEAD']);
      return { full, built: buildContextPack(agentCalls.find((c) => c.kind === 'security')!.pack) };
    }

    it('delivers a 60k-character diff to the sec prompt untouched: the generic budget does not drop it', async () => {
      const { full, built } = await secPrompt(60_000);
      expect(full.length).toBeGreaterThan(60_000);
      expect(full.length).toBeLessThan(62_000);
      expect(built.text).toContain(full);
      expect(built.text).not.toContain('diff truncated');
      expect(built.dropped).toEqual([]);
      expect(state().state).toBe('rebasing');
    });

    it('cuts a 100k-character diff at the inline limit and the sec prompt still carries the notice', async () => {
      const { full, built } = await secPrompt(100_000);
      expect(full.length).toBeGreaterThan(100_000);
      expect(built.text).toContain(full.slice(0, 80_000));
      expect(built.text).toContain(`[diff truncated: first 80000 of ${full.length} characters shown.`);
      expect(built.text).toContain('affectedPaths');
      expect(built.text).not.toContain('END-OF-FILE'); // the tail of the diff is the part that was not shown
      expect(built.dropped).toEqual([]);
      expect(state().state).toBe('rebasing');
    });
  });

  it('returns critical and high findings to Dev as an attempt, even when the decision says approve', async () => {
    await secured(async () => ok({ specHash: HASH, decision: 'approve', findings: [finding('high'), { ...finding('low'), problem: 'verbose log line' }] }));
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('user input reaches a shell');
    expect(journal.lastFeedback('T1')).not.toContain('verbose log line');
    expect(types()).toContain(`fact:${OrchEvent.SecurityChanges}`);
  });

  it('records medium and low findings without blocking the merge', async () => {
    await secured(async () => ok({ specHash: HASH, decision: 'approve', findings: [finding('medium'), finding('low')] }));
    expect(state().state).toBe('rebasing');
    expect(journal.events.find((e) => e.type === OrchEvent.SecurityApproved)!.data.findings).toHaveLength(2);
  });

  it('does not block on a changes decision whose findings are only medium or low: the severities decide', async () => {
    await secured(async () => ok({ specHash: HASH, decision: 'changes', findings: [finding('medium'), finding('low')] }));
    expect(state()).toMatchObject({ state: 'rebasing', attempts: 0 });
    expect(types()).not.toContain(`fact:${OrchEvent.SecurityChanges}`);
    expect(journal.events.find((e) => e.type === OrchEvent.SecurityApproved)!.data.findings).toHaveLength(2);
  });

  it('does not block on a changes decision without findings: there is nothing to send back to Dev', async () => {
    await secured(async () => ok({ specHash: HASH, decision: 'changes', findings: [] }));
    expect(state()).toMatchObject({ state: 'rebasing', attempts: 0 });
    expect(types()).not.toContain(`fact:${OrchEvent.SecurityChanges}`);
  });

  it('sends only the critical and high findings back to Dev when the review also lists medium ones', async () => {
    await secured(async () => ok({ specHash: HASH, decision: 'changes', findings: [{ ...finding('medium'), problem: 'permissive CORS' }, finding('critical')] }));
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('user input reaches a shell');
    expect(journal.lastFeedback('T1')).not.toContain('permissive CORS');
    expect(journal.events.find((e) => e.type === OrchEvent.SecurityChanges)!.data.findings).toHaveLength(2);
  });
});

describe('TaskRunner: merging', () => {
  async function reviewed(over: Parameters<typeof deps>[0] = {}) {
    const r = new TaskRunner('T1', deps({ ...over, agent: async (req) => (req.kind === 'review' ? approve() : devDone()(req)) }));
    for (let i = 0; i < 3; i++) await r.advance();
    expect(state().state).toBe('rebasing');
    return r;
  }

  it('merges through the queue and finishes the task', async () => {
    const r = await reviewed();
    await r.advance();
    expect(state().state).toBe('merged');
    expect(journal.events.find((e) => e.type === OrchEvent.PrMerged)!.data).toMatchObject({ taskId: 'T1', pr: 7 });
    const changes = journal.events.filter((e) => e.type === 'TASK_STATE_CHANGED').map((e) => e.data.to);
    expect(changes.slice(-2)).toEqual(['merging', 'merged']);
  });

  /** Main gets `content` for `file`, committed and pushed, as another task's merge would leave it. */
  async function mainWrites(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(remote.repo, file)), { recursive: true });
    await fs.writeFile(path.join(remote.repo, file), content);
    await git(remote.repo, ['add', '-A']);
    await git(remote.repo, ['commit', '-q', '-m', `main: ${file}`]);
    await git(remote.repo, ['push', '-q', 'origin', 'HEAD:main']);
  }

  it('moves a conflicting task onto the current main with conflict markers, so the next Dev attempt can resolve them', async () => {
    await mainWrites('src/a.ts', 'base\n');
    const r = await reviewed({ merge: { rebase: async () => ({ ok: false, conflicts: ['src/a.ts'] }) } });
    const previous = await headSha(r.worktree);
    await mainWrites('src/a.ts', 'from main\n');
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(await fs.readFile(path.join(r.worktree, 'src', 'a.ts'), 'utf8')).toMatch(/^<<<<<<< [\s\S]*from main/m);
    expect(await git(r.worktree, ['rev-parse', 'HEAD~1'])).toBe(await git(remote.repo, ['rev-parse', 'HEAD']));
    expect(journal.events.find((e) => e.type === OrchEvent.RebaseReplayed)!.data).toEqual({ taskId: 'T1', previous, files: ['src/a.ts'] });
    expect(journal.lastFeedback('T1')).toContain('moved this task onto the current origin/main');
  });

  it('merges again without spending an attempt when the replay onto main is clean', async () => {
    await mainWrites('src/a.ts', 'base\n');
    let calls = 0;
    const r = await reviewed({ merge: { rebase: async () => (calls++ === 0 ? { ok: false, conflicts: ['src/a.ts'] } : { ok: true, baseSha: 'base' }) } });
    await mainWrites('src/other.ts', 'unrelated\n');
    await r.advance();
    expect(state()).toMatchObject({ state: 'rebasing', attempts: 0 });
    expect(journal.events.find((e) => e.type === OrchEvent.RebaseReplayed)!.data).toMatchObject({ files: [] });
    await r.advance();
    expect(state().state).toBe('merged');
  });

  it('keeps the conflict list as feedback when git cannot replay the task, such as an edit of a file main deleted', async () => {
    await mainWrites('src/a.ts', 'base\n');
    const r = await reviewed({ merge: { rebase: async () => ({ ok: false, conflicts: ['src/a.ts'] }) } });
    const previous = await headSha(r.worktree);
    await git(remote.repo, ['rm', '-q', 'src/a.ts']);
    await git(remote.repo, ['commit', '-q', '-m', 'main: drop a']);
    await git(remote.repo, ['push', '-q', 'origin', 'HEAD:main']);
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toBe('Rebase conflicts on origin/main:\nsrc/a.ts');
    expect(await headSha(r.worktree)).toBe(previous);
    expect(journal.events.some((e) => e.type === OrchEvent.RebaseReplayed)).toBe(false);
  });

  it('never replays when the rebase stage failed without conflicts, such as a gh call that failed', async () => {
    // Live risk: a clean replay keeps the task in rebasing for free, so this failure would loop forever.
    const r = await reviewed({ merge: { alreadyMerged: async () => { throw new Error('gh pr list failed (1): HTTP 401'); } } });
    await r.advance();
    expect(journal.events.some((e) => e.type === OrchEvent.RebaseReplayed)).toBe(false);
    expect(state().attempts).toBe(1);
  });

  it('refuses to merge a task whose branch still holds conflict markers, as a replay interrupted by a crash leaves it', async () => {
    const queueSteps: string[] = [];
    const r = await reviewed({ merge: { rebase: async () => { queueSteps.push('rebase'); return { ok: true, baseSha: 'base' }; } } });
    await fs.writeFile(path.join(r.worktree, 'src', 'a.ts'), '<<<<<<< ours\nmain\n=======\ntask\n>>>>>>> theirs\n');
    await git(r.worktree, ['commit', '-q', '-am', 'T1: replay onto origin/main']);
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('src/a.ts');
    expect(queueSteps).toEqual([]);
  });

  it('refuses a Dev result that leaves conflict markers, before any gate runs', async () => {
    const gatesRun: string[] = [];
    const markers: Agent = async (req) => {
      // A Markdown file: no gate would fail on the markers, so only the guard stops them.
      await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true });
      await fs.writeFile(path.join(req.cwd, 'src', 'notes.md'), '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> task\n');
      return ok({ specHash: HASH, status: 'done', summary: 'notes', changedFiles: ['src/notes.md'], commitMessage: 'docs: notes' });
    };
    const r = new TaskRunner('T1', deps({ agent: markers, gates: async (wt) => { gatesRun.push(wt); return { results: [], blockingFailure: null }; } }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('src/notes.md');
    expect(gatesRun).toEqual([]);
  });

  it('a refused merge returns the task to rebasing without consuming an attempt', async () => {
    const r = await reviewed({ merge: { ok: false, stage: 'merge', detail: 'main moved' } });
    await r.advance();
    expect(state()).toMatchObject({ state: 'rebasing', attempts: 0 });
  });
});

describe('TaskRunner: attempts, replan, block', () => {
  const alwaysFailGates: TaskRunnerDeps['gates'] = async () => {
    const g = gate('unit-test', { passed: false, exitCode: 1, failure: 'code', junit: null });
    return { results: [g], blockingFailure: g };
  };
  const replacement = makePlanTask({ id: 'T1-r1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });

  it('gives every Dev attempt of a task the same session, with the feedback as the resume prompt', async () => {
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [replacement] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: alwaysFailGates }));
    for (let i = 0; i < 4; i++) await r.advance();
    const sessions = agentCalls.filter((c) => c.kind === 'dev').map((c) => c.session!);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(1);
    expect(sessions[1]!.resumePrompt).toContain('Feedback from the previous attempt');
    expect(sessions[1]!.resumePrompt).toContain(journal.lastFeedback('T1')!.slice(0, 20));
  });

  it('replans once after three attempts and supersedes the task', async () => {
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [replacement] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: alwaysFailGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(state().state).toBe('superseded');
    expect(journal.state.tasks.get('T1-r1')).toMatchObject({ state: 'planned', attempts: 0, replanned: true });
    expect(agentCalls.filter((c) => c.kind === 'replan')).toHaveLength(1);
    expect(r.done).toBe(true);
  });

  it('keeps a replacement in the service of the task it replaces', async () => {
    await journal.close();
    journal = await Journal.open({ file: path.join(remote.root, 'events-service.ndjson'), runId: 'spec-001-r1', specHash: HASH });
    await journal.fact(RunEvent.TaskPlanned, { task: { ...T1, service: 'orders' } });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [replacement] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: alwaysFailGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(journal.state.tasks.get('T1-r1')!.def.service).toBe('orders');
  });

  it('drops a service the agent puts on a replacement when the plan has one repository', async () => {
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [{ ...replacement, service: 'api' }] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: alwaysFailGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(journal.state.tasks.get('T1-r1')!.def.service).toBeUndefined();
  });

  it('budgetExceeded consumes an attempt with the token count as feedback', async () => {
    const r = new TaskRunner('T1', deps());
    await r.advance();
    await r.budgetExceeded(1_600_000, 1_500_000);
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('1600000');
  });

  it('blocks a replanned task when its attempts are spent', async () => {
    await journal.fact(RunEvent.TaskReplanned, { taskId: 'T1', replacements: [replacement] });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1-r1', to: 'ready' });
    const r = new TaskRunner('T1-r1', deps({ gates: alwaysFailGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(journal.state.tasks.get('T1-r1')!.state).toBe('blocked');
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked)!.data).toMatchObject({ taskId: 'T1-r1' });
  });
});

describe('TaskRunner: merge gates triage', () => {
  const toRebasing = async (r: TaskRunner) => {
    await r.advance(); // implementing → validating
    await r.advance(); // validating → reviewing
    await r.advance(); // reviewing → rebasing
  };
  const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));

  it('sends a merge-gate failure to the gate triage and uses its kind', async () => {
    const calls: unknown[][] = [];
    const decider = { decide: async (...args: unknown[]) => { calls.push(args); return { answered: true, backend: 'jev', escalated: false, answers: { kind: { type: 'choice', value: 'flaky-test', probabilities: { 'flaky-test': 0.9 }, confidence: 0.9 } } } as const; } };
    const failure = gate('unit-test', { passed: false, exitCode: 1, stderrTail: 'boom', failure: 'code' });
    const r = new TaskRunner('T1', deps({ agent, decider, merge: { gates: async () => ({ ok: false, detail: '[code] unit-test exit 1\nboom', failure }) } }));
    await toRebasing(r);
    await r.advance();
    expect(calls.map((c) => c[0])).toContain('gate-triage');
    expect(journal.events.find((e) => e.type === RunEvent.FlakyRetry)!.data).toMatchObject({ taskId: 'T1', gate: 'merge-gates' });
    expect(journal.events.find((e) => e.type === OrchEvent.GateFailed && e.data.gate === 'merge-gates')!.data).toMatchObject({ failure: 'code', exitCode: 1 });
  });

  it('falls back to the [infra] prefix when the merge steps give no GateResult', async () => {
    const r = new TaskRunner('T1', deps({ agent, merge: { gates: async () => ({ ok: false, detail: '[infra] docker daemon down' }) } }));
    await toRebasing(r);
    await r.advance();
    expect(journal.events.find((e) => e.type === RunEvent.InfraRetry)!.data).toMatchObject({ taskId: 'T1', gate: 'merge-gates' });
  });
});

describe('TaskRunner: attempt progress', () => {
  const failingGates = async () => { const f = gate('unit-test', { passed: false, exitCode: 1, stderrTail: 'boom', failure: 'code' as const }); return { results: [f], blockingFailure: f }; };
  const stalled = { decide: async (id: string) => (id === 'attempt-progress' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { progress: { type: 'score' as const, value: 1, probabilities: {}, confidence: 0.9 } } } : { answered: false as const, reason: 'disabled' as const }) };
  const replanAgent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001'], affectedPaths: ['src'], dependsOn: [] })] }) : devDone()(req));

  it('replans after the second failed attempt when progress is stalled', async () => {
    const r = new TaskRunner('T1', deps({ agent: replanAgent, gates: failingGates, decider: stalled }));
    await r.advance(); await r.advance(); // attempt 1 fails → retry-dev
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    await r.advance(); await r.advance(); // attempt 2 fails → stalled → replan
    expect(agentCalls.map((c) => c.kind)).toEqual(['dev', 'dev', 'replan']);
    expect(journal.events.find((e) => e.type === RunEvent.TaskReplanned)).toBeTruthy();
  });

  it('never replans a task that was already replanned; when its attempts stall it blocks instead of spending the rest', async () => {
    // The reducer marks replacements `replanned: true`; replace T1 by T2 through the journal, then run T2.
    const T2 = makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['src'], dependsOn: [] });
    await journal.fact(RunEvent.TaskReplanned, { taskId: 'T1', replacements: [T2] });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T2', to: 'ready' });
    const r = new TaskRunner('T2', deps({ agent: replanAgent, gates: failingGates, decider: stalled }));
    await r.advance(); await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.filter((c) => c.kind === 'replan')).toHaveLength(0);
    expect(journal.state.tasks.get('T2')).toMatchObject({ state: 'blocked', attempts: 2, replanned: true });
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked)!.data.reason).toContain('on a replanned task');
  });
});

describe('TaskRunner: review profile', () => {
  const risky = (value: number) => ({ decide: async (id: string) => (id === 'pr-risk' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { risk: { type: 'score' as const, value, probabilities: {}, confidence: 0.9 } } } : { answered: false as const, reason: 'disabled' as const }) });
  const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));

  it('asks pr-risk before review, journals the profile and passes the depth to impact', async () => {
    const depths: number[] = [];
    const r = new TaskRunner('T1', deps({ agent, decider: risky(3), impact: async (_w, _b, _c, depth) => { depths.push(depth); return { source: 'none' }; } }));
    await r.advance(); await r.advance(); await r.advance();
    expect(depths).toEqual([3]);
    expect(journal.events.find((e) => e.type === OrchEvent.ReviewProfileChosen)!.data).toMatchObject({ taskId: 'T1', risk: 'high', profile: 'deep', source: 'jev' });
    expect(agentCalls.find((c) => c.kind === 'review')!.pack.feedback).toContain('Review profile: deep');
  });

  it('quick profile skips the impact query', async () => {
    const depths: number[] = [];
    const r = new TaskRunner('T1', deps({ agent, decider: risky(0), impact: async (_w, _b, _c, depth) => { depths.push(depth); return { source: 'graph', affected: [] }; } }));
    await r.advance(); await r.advance(); await r.advance();
    expect(depths).toEqual([]);
    expect(agentCalls.find((c) => c.kind === 'review')!.pack.code).toEqual({ source: 'none' });
  });

  it('high scope drift forces the deep profile over a trivial risk and never blocks the task', async () => {
    const depths: number[] = [];
    const decider = {
      decide: async (id: string): Promise<DecisionOutcome> => {
        if (id === 'pr-risk') return { answered: true as const, backend: 'jev' as const, escalated: false, answers: { risk: { type: 'score' as const, value: 0, probabilities: {}, confidence: 0.9 } } };
        if (id === 'scope-drift') return { answered: true as const, backend: 'jev' as const, escalated: false, answers: { unrequired: { type: 'noul' as const, value: 0.9, probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 } } };
        return { answered: false as const, reason: 'disabled' as const };
      },
    };
    const r = new TaskRunner('T1', deps({ agent, decider, impact: async (_w, _b, _c, depth) => { depths.push(depth); return { source: 'none' }; } }));
    await r.advance(); await r.advance(); await r.advance();
    expect(depths).toEqual([3]);
    expect(journal.events.find((e) => e.type === OrchEvent.ScopeDriftScored)!.data).toMatchObject({ taskId: 'T1', drift: 'high', unrequired: [], source: 'jev' });
    expect(journal.events.find((e) => e.type === OrchEvent.ReviewProfileChosen)!.data).toMatchObject({ risk: 'trivial', profile: 'deep', forcedBy: 'scope-drift' });
    expect(agentCalls.find((c) => c.kind === 'review')!.pack.feedback).toContain('Review profile: deep');
    expect(r.task.state).not.toBe('blocked');
  });
});

describe('TaskRunner: model tier', () => {
  const tierDecider = { decide: async (id: string) => (id === 'model-tier' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { tier: { type: 'choice' as const, value: 'small', probabilities: { small: 0.9 }, confidence: 0.9 }, effort: { type: 'score' as const, value: 0, probabilities: {}, confidence: 0.9 } } } : { answered: false as const, reason: 'disabled' as const }) };
  const tiers: Record<string, string> = { small: 'haiku', medium: 'sonnet', large: 'opus' };

  it('dev attempt 1 runs on the small tier with low effort; review on the test role uses the same decision', async () => {
    const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, decider: tierDecider, tierModel: (_role, tier) => tiers[tier]! }));
    await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.find((c) => c.kind === 'dev')).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(agentCalls.find((c) => c.kind === 'review')).toMatchObject({ model: 'haiku', effort: 'low' });
  });

  it('attempt 2 moves one tier up', async () => {
    const failingGates = async () => { const f = gate('unit-test', { passed: false, exitCode: 1, failure: 'code' as const }); return { results: [f], blockingFailure: f }; };
    const r = new TaskRunner('T1', deps({ gates: failingGates, decider: tierDecider, tierModel: (_role, tier) => tiers[tier]! }));
    await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.map((c) => [c.kind, c.model, c.effort])).toEqual([['dev', 'haiku', 'low'], ['dev', 'sonnet', 'medium']]);
  });

  it('with the decision off nothing is set', async () => {
    const r = new TaskRunner('T1', deps({ tierModel: (_role, tier) => tiers[tier]! }));
    await r.advance();
    expect(agentCalls[0]!.model).toBeUndefined();
    expect(agentCalls[0]!.effort).toBeUndefined();
  });
});

describe('TaskRunner: tier routing', () => {
  const models = { small: 'sonnet', medium: 'sonnet', large: 'opus' };
  const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));

  it('off sets nothing and journals nothing', async () => {
    const r = new TaskRunner('T1', deps({ agent, routing: { tiers: 'off', models } }));
    await r.advance();
    expect(agentCalls[0]!.model).toBeUndefined();
    expect(journal.events.some((e) => e.type === OrchEvent.ModelTierChosen)).toBe(false);
  });

  it('shadow journals the choice and still runs the role profile', async () => {
    const r = new TaskRunner('T1', deps({ agent, routing: { tiers: 'shadow', models } }));
    await r.advance();
    expect(agentCalls[0]!.model).toBeUndefined();
    const chosen = journal.events.filter((e) => e.type === OrchEvent.ModelTierChosen);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.data).toMatchObject({ taskId: 'T1', attempt: 1, tier: 'small', model: 'sonnet', applied: false, source: 'heuristic' });
  });

  it('on runs the Dev on the routed model but leaves the review on its profile', async () => {
    const r = new TaskRunner('T1', deps({ agent, routing: { tiers: 'on', models } }));
    await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.find((c) => c.kind === 'dev')!.model).toBe('sonnet');
    expect(agentCalls.find((c) => c.kind === 'review')!.model).toBeUndefined();
    expect(journal.events.filter((e) => e.type === OrchEvent.ModelTierChosen)).toHaveLength(1);
  });

  it('defers to the decision layer when it answers', async () => {
    const decider = { decide: async (id: string) => (id === 'model-tier' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { tier: { type: 'choice' as const, value: 'large', probabilities: { large: 0.9 }, confidence: 0.9 }, effort: { type: 'score' as const, value: 3, probabilities: {}, confidence: 0.9 } } } : { answered: false as const, reason: 'disabled' as const }) };
    const r = new TaskRunner('T1', deps({ agent, decider, routing: { tiers: 'on', models: { small: 'haiku', medium: 'haiku', large: 'haiku' } } }));
    await r.advance();
    expect(agentCalls[0]).toMatchObject({ model: 'opus', effort: 'max' });
  });
});

describe('TaskRunner: final review fixes', () => {
  const failingGates = async () => { const f = gate('unit-test', { passed: false, exitCode: 1, stderrTail: 'boom', failure: 'code' as const }); return { results: [f], blockingFailure: f }; };
  const stalledRecording = () => {
    const states: string[] = [];
    return { states, decide: async (id: string, state: string) => { if (id === 'attempt-progress') { states.push(state); return { answered: true as const, backend: 'jev' as const, escalated: false, answers: { progress: { type: 'score' as const, value: 1, probabilities: {}, confidence: 0.9 } } }; } return { answered: false as const, reason: 'disabled' as const }; } };
  };
  const replacement = makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001'], affectedPaths: ['src'], dependsOn: [] });

  it('attempt progress history holds only the deltas that consumed an attempt, not schema retries', async () => {
    let devCalls = 0;
    const agent: Agent = async (req) => {
      if (req.kind === 'replan') return ok({ specHash: HASH, replacements: [replacement] });
      devCalls += 1;
      if (devCalls === 1) return failed('schema', 'SCHEMA-RETRY-TEXT');
      return devDone()(req);
    };
    const d = stalledRecording();
    // A different failure each time, so the repeated-failure rule stays out and the decider is asked.
    let gateCalls = 0;
    const changingGates = async () => { const f = gate('unit-test', { passed: false, exitCode: 1, stderrTail: `boom ${++gateCalls}`, failure: 'code' as const }); return { results: [f], blockingFailure: f }; };
    const r = new TaskRunner('T1', deps({ agent, gates: changingGates, decider: d }));
    for (let i = 0; i < 5; i++) await r.advance();
    expect(d.states).toHaveLength(1);
    expect(d.states[0]).not.toContain('SCHEMA-RETRY-TEXT');
    expect(d.states[0]).toContain('Gate unit-test failed');
  });

  it('early replan consumes the failed attempt', async () => {
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [replacement] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: failingGates, decider: stalledRecording() }));
    for (let i = 0; i < 4; i++) await r.advance();
    expect(state()).toMatchObject({ state: 'superseded', attempts: 2 });
  });

  it('a failed early replan falls back to the normal retry instead of blocking', async () => {
    const agent: Agent = async (req) => (req.kind === 'replan' ? failed('code', 'sm broke') : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: failingGates, decider: stalledRecording() }));
    for (let i = 0; i < 4; i++) await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 2 });
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked)).toBeUndefined();
  });

});

describe('TaskRunner: replanning the scaffold task', () => {
  const failGates: TaskRunnerDeps['gates'] = async () => {
    const g = gate('unit-test', { passed: false, exitCode: 1, failure: 'code', junit: null });
    return { results: [g], blockingFailure: g };
  };
  const scaffold = makePlanTask({ id: 'T0-scaffold', criteriaRefs: ['AC-001'], affectedPaths: ['scripts'] });
  const piece = (id: string) => makePlanTask({ id, criteriaRefs: ['AC-001'], affectedPaths: ['scripts'], dependsOn: [] });

  it('rejects a replan that splits the scaffold, since no piece can run the gates alone', async () => {
    await journal.fact(RunEvent.TaskPlanned, { task: scaffold });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T0-scaffold', to: 'ready' });
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [piece('T0-scaffold-r1'), piece('T0-scaffold-r2')] }) : devDone()(req));
    const r = new TaskRunner('T0-scaffold', deps({ agent, gates: failGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(journal.state.tasks.get('T0-scaffold')!.state).toBe('blocked');
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked && e.data.taskId === 'T0-scaffold')!.data.reason).toMatch(/exactly one task/);
    expect(journal.state.tasks.has('T0-scaffold-r1')).toBe(false);
  });

  it('accepts a single replacement, which inherits the frozen-path permission', async () => {
    await journal.fact(RunEvent.TaskPlanned, { task: scaffold });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T0-scaffold', to: 'ready' });
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [piece('T0-scaffold-r1')] }) : devDone()(req));
    const r = new TaskRunner('T0-scaffold', deps({ agent, gates: failGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(journal.state.tasks.get('T0-scaffold')!.state).toBe('superseded');
    expect(journal.state.tasks.get('T0-scaffold-r1')).toMatchObject({ replanned: true, bootstrapsFrozenPaths: true });
  });

  // Live finding (R11.P, 2026-10-08): a zero-dependency project's scaffold task failed `npm ci` (EUSAGE,
  // no manifest yet) on every attempt because installDeps ran before the Dev ever got to write package.json;
  // the Dev was never invoked, so nothing could change between attempts and the task died after its replan.
  it('never calls installDeps for the scaffold task, so the Dev gets to write the manifest first', async () => {
    await journal.fact(RunEvent.TaskPlanned, { task: scaffold });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T0-scaffold', to: 'ready' });
    let devCalled = false;
    const agent: Agent = async (req) => {
      if (req.kind === 'security') return secApprove();
      if (req.kind !== 'dev') return devDone()(req);
      devCalled = true;
      await fs.mkdir(path.join(req.cwd, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(req.cwd, 'scripts', 'install.mjs'), `// ${Date.now()}\n`);
      return ok({ specHash: HASH, status: 'done', summary: 'scaffolded', changedFiles: ['scripts/install.mjs'], commitMessage: 'feat: scaffold' });
    };
    const installDeps: TaskRunnerDeps['installDeps'] = async () => gate('install', { passed: false, exitCode: 1, failure: 'code', junit: null, stderrTail: 'npm error EUSAGE' });
    const r = new TaskRunner('T0-scaffold', deps({ agent, installDeps }));
    await r.advance();
    expect(devCalled).toBe(true);
    expect(journal.state.tasks.get('T0-scaffold')!.state).toBe('validating');
  });
});

describe('TaskRunner: a replan cannot hand devops a task it has no Bash to run', () => {
  // Live finding (R11.2 program run, 2026-10-07): a devops-owned replacement that only touched a test file
  // got no Bash at all (ROLE_ALLOW.devops carries none) and looped GATE_FAILED -> replan on the same mistake.
  const failGates: TaskRunnerDeps['gates'] = async () => {
    const g = gate('unit-test', { passed: false, exitCode: 1, failure: 'code', junit: null });
    return { results: [g], blockingFailure: g };
  };

  it('hands a devops replacement whose affectedPaths are not infra to dev instead of blocking the run', async () => {
    // Live (user-api run-1, todo-001-r1): a deploy fix that also updated README.md was rejected and ended the run.
    const mixed = makePlanTask({ id: 'T1-r1', criteriaRefs: ['AC-001'], owner: 'devops', affectedPaths: ['Dockerfile', 'tests/unit/x.test.ts'], dependsOn: [] });
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [mixed] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: failGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(journal.state.tasks.get('T1')!.state).toBe('superseded');
    expect(journal.state.tasks.get('T1-r1')!.def.owner).toBe('dev');
  });
});

describe('TaskRunner: worktree left by an earlier run', () => {
  it('starts a new run from origin/main, discarding the stale branch and its commits', async () => {
    // A previous run of this spec left the task worktree behind, with a commit main never took.
    const r0 = new TaskRunner('T1', deps());
    await createWorktree(remote.repo, r0.worktree, r0.branch, 'origin/main');
    await fs.writeFile(path.join(r0.worktree, 'stale.txt'), 'from an earlier run\n');
    await commitAll(r0.worktree, 'chore: stale work from an earlier run');
    const staleSha = await headSha(r0.worktree);

    // A fresh journal = a new run; its first touch of T1 must not inherit that commit.
    await journal.close();
    journal = await Journal.open({ file: path.join(remote.root, 'events-run2.ndjson'), runId: 'spec-001-r2', specHash: HASH });
    await journal.fact(RunEvent.TaskPlanned, { task: T1 });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
    const r = new TaskRunner('T1', deps());
    await r.advance();
    expect(await git(r.worktree, ['log', '-1', '--format=%s'])).toBe('feat: T1');
    const log = await git(r.worktree, ['log', '--format=%H']);
    expect(log).not.toContain(staleSha);
    await expect(fs.access(path.join(r.worktree, 'stale.txt'))).rejects.toThrow();
  });

  it('blocks the task instead of resetting the worktree of an older run of the spec that is still live', async () => {
    // Run 1 is live (its journal holds the event-log lock) and has committed work in the T1 worktree.
    const older = await Journal.open({ file: path.join(remote.root, 'spec-001-r1', 'events.ndjson'), runId: 'spec-001-r1', specHash: HASH });
    const r0 = new TaskRunner('T1', deps());
    await createWorktree(remote.repo, r0.worktree, r0.branch, 'origin/main');
    await fs.writeFile(path.join(r0.worktree, 'live.txt'), 'work of the older run\n');
    await commitAll(r0.worktree, 'chore: work of the older run');
    const liveSha = await headSha(r0.worktree);

    // Run 2 of the same spec reaches the same task: it must leave all of that alone.
    await journal.close();
    journal = await Journal.open({ file: path.join(remote.root, 'events-run2.ndjson'), runId: 'spec-001-r2', specHash: HASH });
    await journal.fact(RunEvent.TaskPlanned, { task: T1 });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
    await new TaskRunner('T1', deps()).advance();

    expect(await headSha(r0.worktree)).toBe(liveSha);
    await expect(fs.access(path.join(r0.worktree, 'live.txt'))).resolves.toBeUndefined();
    expect(agentCalls).toHaveLength(0);
    expect(state().state).toBe('blocked');
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked)!.data.reason).toContain('spec-001-r1');
    // No intent either: on resume an unconfirmed WORKTREE_CREATE over an existing worktree counts as this run's own.
    expect(types()).not.toContain(`intent:${Intent.WorktreeCreate}`);
    await older.close();
  });
});
