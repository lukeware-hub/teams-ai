import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { MergeQueue, type MergeSteps } from '../../server/git/merge-queue.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import type { AgentStepRequest, PackBase } from '../../server/orchestrator/steps.js';
import { TaskRunner, type TaskRunnerDeps } from '../../server/orchestrator/task-runner.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { DEFAULT_POLICY } from '../../server/scheduler/retry-policy.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const T1 = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const plan = makePlan(spec, { tasks: [T1] });
const PLAN = 'docs/specify/spec-001/plan.md';
const DOCS = ['docs/project.md', 'docs/stack.md', 'docs/flow.md', 'docs/design.md', 'docs/briefing.md'];
const summary = (): ResultSummary => ({
  found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 100, costUsd: 0.01,
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null,
  apiErrorStatus: null, rateLimit: null, compactions: 0,
});
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary: summary() });
const gate = (name: string): GateResult => ({
  name, blocking: true, passed: true, exitCode: 0, timedOut: false, durationMs: 10, stdoutTail: '', stderrTail: '',
  junit: [{ id: 'sum::[AC-001] adds', name: '[AC-001] adds', classname: 'sum', status: 'passed', acIds: ['AC-001'] }], failure: null,
});
const approve = () => ok({ specHash: HASH, decision: 'approve', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }], findings: [] });

let remote: Remote;
let journal: Journal;
let snapshot: string;

beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  snapshot = path.join(remote.root, 'docs-at', 'draft-1');
  for (const file of [...DOCS, PLAN]) {
    await fs.mkdir(path.dirname(path.join(snapshot, file)), { recursive: true });
    await fs.writeFile(path.join(snapshot, file), `# ${file}\n`);
  }
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'spec-001-r1', specHash: HASH });
  await journal.fact(RunEvent.TaskPlanned, { task: T1 });
  await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

/** A Dev that changes one file and lists the files it read; `scope` is its scope justification. */
function dev(filesRead: (cwd: string) => string[], scopeJustification?: string) {
  return async (req: AgentStepRequest<any>): Promise<StepOutcome<any>> => {
    if (req.kind === 'security') return ok({ specHash: HASH, decision: 'approve', findings: [] });
    if (req.kind === 'ui-check' || req.kind === 'review') return approve();
    await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true });
    await fs.writeFile(path.join(req.cwd, 'src', 'a.ts'), `// ${Date.now()}\n`);
    return ok({ specHash: HASH, status: 'done', summary: 'did T1', changedFiles: ['src/a.ts'], commitMessage: 'feat: T1', deviations: [], filesRead: filesRead(req.cwd), scopeJustification });
  };
}

function deps(over: Partial<TaskRunnerDeps> = {}): TaskRunnerDeps {
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: path.join(remote.root, 'graph'), knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  const steps: MergeSteps = {
    alreadyMerged: async () => null, rebase: async () => ({ ok: true, baseSha: 'base' }), gates: async () => ({ ok: true }), push: async () => {},
    ensurePr: async () => ({ number: 7 }), remoteMainSha: async () => 'base', merge: async () => ({ merged: true }),
  };
  return {
    journal, ws, spec, project, plan, specHash: HASH, firstSpec: false, skillsRoot: path.join(remote.root, 'skills'), exec: execCommand,
    runAgent: (async (req: AgentStepRequest<any>) => dev(() => [])(req)) as TaskRunnerDeps['runAgent'],
    gates: async () => ({ results: [gate('unit-test')], blockingFailure: null }),
    installDeps: async () => null,
    mergeQueue: new MergeQueue(),
    mergeSteps: () => steps,
    code: async () => ({ source: 'none' }),
    impact: async () => ({ source: 'none' }),
    decider: { decide: async () => ({ answered: false, reason: 'disabled' }) },
    tierModel: (_role, tier) => ({ small: 'haiku', medium: 'sonnet', large: 'opus' })[tier],
    policy: DEFAULT_POLICY,
    packBase: () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000, docsRoot: snapshot, planFile: PLAN }) as PackBase,
    handoffs: () => [],
    boundaries: async () => ['src'],
    deliveredBefore: new Set(),
    ...over,
  } as TaskRunnerDeps;
}
const state = () => journal.state.tasks.get('T1')!;

describe('TaskRunner: documents read from the snapshot (plan 119, I8 item 1)', () => {
  it('lets the Dev list the snapshot documents by their absolute path', async () => {
    const reads = (cwd: string) => [path.join(snapshot, PLAN), ...DOCS.map((d) => path.join(snapshot, d))].map((p) => p.replace(cwd, ''));
    const r = new TaskRunner('T1', deps({ runAgent: (async (req: AgentStepRequest<any>) => dev(() => reads(req.cwd))(req)) as TaskRunnerDeps['runAgent'] }));
    await r.advance();
    expect(state().state).toBe('validating');
    expect(journal.lastFeedback('T1')).toBeNull();
  });

  it('sends the Dev back when filesRead leaves out a snapshot document', async () => {
    const r = new TaskRunner('T1', deps({ runAgent: (async (req: AgentStepRequest<any>) => dev(() => [path.join(snapshot, PLAN)])(req)) as TaskRunnerDeps['runAgent'] }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 0 });
    expect(journal.lastFeedback('T1')).toContain('docs/project.md');
  });

  it('starts no Dev step while a snapshot document is missing, and names the file', async () => {
    await fs.rm(path.join(snapshot, 'docs/stack.md'));
    let devCalls = 0;
    const r = new TaskRunner('T1', deps({ runAgent: (async (req: AgentStepRequest<any>) => { devCalls += 1; return dev(() => [])(req); }) as TaskRunnerDeps['runAgent'] }));
    await r.advance();
    expect(devCalls).toBe(0);
    expect(state().state).toBe('blocked');
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked)!.data.reason).toContain('docs/stack.md');
  });
});
