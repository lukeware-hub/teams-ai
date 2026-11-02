import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { MergeQueue, type MergeSteps } from '../../server/git/merge-queue.js';
import { Journal } from '../../server/orchestrator/events.js';
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
const T1 = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src', 'docs'] });
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

/** A Dev that changes `src/a.ts` and the `extra` files, and lists every snapshot document it read. */
function dev(extra: string[]) {
  return async (req: AgentStepRequest<any>): Promise<StepOutcome<any>> => {
    if (req.kind === 'security') return ok({ specHash: HASH, decision: 'approve', findings: [] });
    if (req.kind === 'ui-check' || req.kind === 'review') return approve();
    const changed = ['src/a.ts', ...extra];
    for (const file of changed) {
      await fs.mkdir(path.dirname(path.join(req.cwd, file)), { recursive: true });
      await fs.writeFile(path.join(req.cwd, file), `// ${Date.now()}\n`);
    }
    const filesRead = [PLAN, ...DOCS].map((file) => path.join(snapshot, file));
    return ok({ specHash: HASH, status: 'done', summary: 'did T1', changedFiles: changed, commitMessage: 'feat: T1', deviations: [], filesRead, scopeJustification: 'the docs' });
  };
}

function deps(over: Partial<TaskRunnerDeps>, agent: ReturnType<typeof dev>): TaskRunnerDeps {
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: path.join(remote.root, 'graph'), knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  const steps: MergeSteps = {
    alreadyMerged: async () => null, rebase: async () => ({ ok: true, baseSha: 'base' }), gates: async () => ({ ok: true }), push: async () => {},
    ensurePr: async () => ({ number: 7 }), remoteMainSha: async () => 'base', merge: async () => ({ merged: true }),
  };
  return {
    journal, ws, spec, project, plan, specHash: HASH, firstSpec: false, skillsRoot: path.join(remote.root, 'skills'), exec: execCommand,
    runAgent: (async (req: AgentStepRequest<any>) => agent(req)) as TaskRunnerDeps['runAgent'],
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

/** Runs one advance of T1 with the given Dev and returns the feedback the Dev received, or null. */
async function advance(over: Partial<TaskRunnerDeps>, extra: string[]): Promise<string | null> {
  await new TaskRunner('T1', deps(over, dev(extra))).advance();
  return journal.lastFeedback('T1');
}

describe('TaskRunner: frozen documents of a docs-repo monolith (plan 119, I8 item 3)', () => {
  const docs = { style: 'monolith' as const, snapshot };

  it('fails a monolith build change to docs/project.md with the frozen message', async () => {
    const feedback = await advance({ docs }, ['docs/project.md']);
    expect(feedback).toContain('frozen files modified: docs/project.md');
  });

  it('lets a monolith build change docs/README.md', async () => {
    const feedback = await advance({ docs }, ['docs/README.md']);
    expect(feedback).toBeNull();
  });

  it('keeps a legacy project unchanged: docs/project.md is not frozen', async () => {
    const feedback = await advance({}, ['docs/project.md']);
    expect(feedback).toBeNull();
  });
});
