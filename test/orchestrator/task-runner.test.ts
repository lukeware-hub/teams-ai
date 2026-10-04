import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { commitAll, createWorktree, git, headSha } from '../../server/git/git.js';
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
    mergeQueue: new MergeQueue(),
    mergeSteps: () => steps,
    code: async () => ({ source: 'none' }),
    impact: async () => ({ source: 'none' }),
    decider: { decide: async () => ({ answered: false, reason: 'disabled' }) },
    tierModel: () => null,
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

  it('a blocked Dev blocks the task at once with the reason: no SM round, no attempt consumed', async () => {
    const agent: Agent = async () => ok({ specHash: HASH, status: 'blocked', summary: 'cannot deploy', changedFiles: [], reason: 'the smoke gate has no network' });
    const r = new TaskRunner('T1', deps({ agent }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'blocked', attempts: 0 });
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked)!.data).toMatchObject({ taskId: 'T1', reason: 'the smoke gate has no network' });
    expect(agentCalls.map((c) => c.kind)).toEqual(['dev']);
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
    expect(call.pack.feedback).toContain('Diff against origin/main');
    expect(call.pack.feedback).toContain('src/a.ts');
    expect(agentCalls.map((c) => c.kind)).toEqual(['dev', 'review', 'security']);
    expect(types()).toContain(`fact:${OrchEvent.SecurityApproved}`);
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

  it('never replans a task that was already replanned; it retries instead', async () => {
    // The reducer marks replacements `replanned: true`; replace T1 by T2 through the journal, then run T2.
    const T2 = makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['src'], dependsOn: [] });
    await journal.fact(RunEvent.TaskReplanned, { taskId: 'T1', replacements: [T2] });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T2', to: 'ready' });
    const r = new TaskRunner('T2', deps({ agent: replanAgent, gates: failingGates, decider: stalled }));
    await r.advance(); await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.filter((c) => c.kind === 'replan')).toHaveLength(0);
    expect(journal.state.tasks.get('T2')).toMatchObject({ state: 'implementing', attempts: 2, replanned: true });
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

  it('leaves model unset when the role is not on a claude profile (OmniRoute pin kept)', async () => {
    const r = new TaskRunner('T1', deps({ decider: tierDecider, tierModel: () => null }));
    await r.advance();
    expect(agentCalls[0]!.model).toBeUndefined();
    expect(agentCalls[0]!.effort).toBeUndefined();
  });

  it('with the decision off nothing is set', async () => {
    const r = new TaskRunner('T1', deps({ tierModel: (_role, tier) => tiers[tier]! }));
    await r.advance();
    expect(agentCalls[0]!.model).toBeUndefined();
    expect(agentCalls[0]!.effort).toBeUndefined();
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
    const r = new TaskRunner('T1', deps({ agent, gates: failingGates, decider: d }));
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

  it('model tier: effort is not applied when the role is off the claude profile, and one decision serves dev and review', async () => {
    const calls: string[] = [];
    const tierDecider = { decide: async (id: string) => { calls.push(id); return id === 'model-tier' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { tier: { type: 'choice' as const, value: 'small', probabilities: { small: 0.9 }, confidence: 0.9 }, effort: { type: 'score' as const, value: 0, probabilities: {}, confidence: 0.9 } } } : { answered: false as const, reason: 'disabled' as const }; } };
    const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, decider: tierDecider, tierModel: () => null }));
    await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.map((c) => [c.kind, c.model, c.effort])).toEqual([['dev', undefined, undefined], ['review', undefined, undefined], ['security', undefined, undefined]]);
    expect(calls.filter((id) => id === 'model-tier')).toHaveLength(1);
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
});
