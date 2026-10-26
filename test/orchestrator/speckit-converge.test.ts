import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { planSpecKitGaps, runSpecKitRound } from '../../server/orchestrator/phases/speckit.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const FEATURE = 'specs/001-login';
const TASKS = ['# Tasks', '- [ ] T001 Create model', '- [ ] T002 Add route', ''].join('\n');
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary });
type Agent = (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>;
const converged = ok({ specHash: HASH, status: 'converged', summary: 'all built' });
const allCriteria = spec.acceptanceCriteria.map((c) => c.id);

let remote: Remote;
let journal: Journal;
let gh: FakeGh;
let calls: AgentStepRequest<any>[];

beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec), [`${FEATURE}/tasks.md`]: TASKS });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  gh = new FakeGh();
  calls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

/** One merged task of the plan, which owns T001; the Spec Kit feature is the spec's own folder. */
function deps(agent: Agent): PhaseDeps {
  const ghExec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
  gh.install(ghExec);
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  const plan = makePlan(spec, { tasks: [makePlanTask({ id: 'T1-create', criteriaRefs: allCriteria, speckitTasks: ['T001'] })] });
  return {
    journal, ws, spec, project, specHash: HASH, firstSpec: false, exec: execCommand, plan,
    runAgent: (async (req) => { calls.push(req); return agent(req); }) as PhaseDeps['runAgent'],
    mergeQueue: new MergeQueue(),
    mergeDeps: { journal, ws, exec: execCommand, ghExec: ghExec.exec, gates: async () => ({ results: [], blockingFailure: null }), graphify: null, secretValues: () => [], handoffs: [], clock: () => new Date() },
    packBase: () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000, speckitFeature: FEATURE }),
    godNodes: async () => [],
    tasks: (() => [{ state: 'merged', def: plan.tasks[0]! }]) as unknown as PhaseDeps['tasks'],
  };
}

const tasksOnMain = async (): Promise<string> => {
  await git(remote.repo, ['fetch', '-q', 'origin']);
  return git(remote.repo, ['show', `origin/main:${FEATURE}/tasks.md`]);
};

describe('Spec Kit convergence round', () => {
  it('marks the merged tasks and commits the verdict as one docs change', async () => {
    expect(await runSpecKitRound(deps(async () => converged), 1)).toEqual({ kind: 'done' });
    expect(await tasksOnMain()).toContain('- [X] T001 Create model');
    expect(journal.events.find((e) => e.type === OrchEvent.SpecKitConverged)?.data).toMatchObject({ round: 1, status: 'converged' });
    expect(gh.prs[0]!.title).toBe('docs(spec-001): Spec Kit tasks and convergence, round 1');
    expect(calls[0]!.kind).toBe('converge');
    expect(calls[0]!.extraEnv).toEqual({ SPECIFY_FEATURE_DIRECTORY: FEATURE });
  });

  it('a verdict that names an id tasks.md does not list as open fails the round', async () => {
    const r = await runSpecKitRound(deps(async () => ok({ specHash: HASH, status: 'tasks-appended', appended: ['T099'], summary: 'gap' })), 1);
    expect(r).toEqual({ kind: 'failed', reason: expect.stringContaining('T099') });
    expect(await tasksOnMain()).not.toContain('T099');
  });

  it('the convergence agent may change tasks.md only', async () => {
    const r = await runSpecKitRound(deps(async (req) => {
      await fs.writeFile(path.join(req.cwd, 'src.ts'), 'export {};\n');
      return converged;
    }), 1);
    expect(r).toEqual({ kind: 'failed', reason: expect.stringContaining('src.ts') });
  });

  it('a resumed round whose commit is confirmed merges it without asking the agent again', async () => {
    const d = deps(async () => converged);
    await runSpecKitRound(d, 1);
    const asked = calls.length;
    expect(await runSpecKitRound(d, 1)).toEqual({ kind: 'done' });
    expect(calls.length).toBe(asked);
  });
});

describe('Spec Kit gaps become fix tasks', () => {
  const appended = (agent: Agent): Agent => async (req) => (req.kind === 'converge' ? ok({ specHash: HASH, status: 'tasks-appended', appended: ['T002'], summary: 'no route' }) : agent(req));

  it('the SM plans the gap as a fix task that names the id it builds', async () => {
    const d = deps(appended(async () => ok({ specHash: HASH, tasks: [makePlanTask({ id: 'T900-route', criteriaRefs: allCriteria, speckitTasks: ['T002'], affectedPaths: ['src/route.ts'] })] })));
    const round = await runSpecKitRound(d, 1);
    expect(round).toEqual({ kind: 'appended', appended: ['T002'] });
    const gaps = await planSpecKitGaps(d, 1, ['T002']);
    expect(gaps.kind).toBe('planned');
    expect(journal.events.find((e) => e.type === RunEvent.FixTasksPlanned)?.data).toMatchObject({ speckitRound: 1 });
    expect(calls.find((c) => c.kind === 'fix-tasks')!.pack.feedback).toContain('T002');
  });

  it('a fix-task answer that leaves an appended id without a task is refused', async () => {
    const d = deps(appended(async () => ok({ specHash: HASH, tasks: [makePlanTask({ id: 'T900-route', criteriaRefs: allCriteria, affectedPaths: ['src/route.ts'] })] })));
    await runSpecKitRound(d, 1);
    expect((await planSpecKitGaps(d, 1, ['T002'])).kind).toBe('failed');
  });
});
