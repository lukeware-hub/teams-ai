import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { git, headSha } from '../../server/git/git.js';
import { MergeQueue, type MergeOutcome, type MergeSteps } from '../../server/git/merge-queue.js';
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
const devDone = (message = 'feat: T1'): Agent => async (req) => {
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
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: path.join(remote.root, 'graph'), knowledgeDb: '', runs: remote.root };
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
    mergeQueue: new MergeQueue(),
    mergeSteps: () => steps,
    code: async () => ({ source: 'none' }),
    impact: async () => ({ source: 'none' }),
    decider: { decide: async () => ({ answered: false, reason: 'disabled' }) },
    policy: DEFAULT_POLICY,
    packBase: () => ({ spec, project, specHash: HASH, assumptions: journal.assumptions(), budgetTokens: 8000 }),
    handoffs: () => [],
    boundaries: async () => ['src'],
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

  it('pauses the run on a quota failure without consuming an attempt', async () => {
    const r = new TaskRunner('T1', deps({ agent: async () => failed('quota', 'usage limit reached') }));
    await r.advance();
    expect(journal.state.status).toBe('paused:quota');
    expect(state()).toMatchObject({ state: 'implementing', attempts: 0 });
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
    expect(agentCalls.at(-1)!.pack.feedback).toContain('src/a.ts');
  });

  it('returns findings to Dev on changes', async () => {
    const r = await validated(async () => review('changes'));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('no test for the empty case');
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

  it('sends rebase conflicts back to Dev as an attempt', async () => {
    const r = await reviewed({ merge: { rebase: async () => ({ ok: false, conflicts: ['src/a.ts'] }) } });
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('src/a.ts');
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

  it('replans once after three attempts and supersedes the task', async () => {
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [replacement] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: alwaysFailGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(state().state).toBe('superseded');
    expect(journal.state.tasks.get('T1-r1')).toMatchObject({ state: 'planned', attempts: 0, replanned: true });
    expect(agentCalls.filter((c) => c.kind === 'replan')).toHaveLength(1);
    expect(r.done).toBe(true);
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
