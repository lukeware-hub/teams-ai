import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Accounting } from '../../server/budget/accounting.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { readState, writeState } from '../../server/docs/project-state.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { runPhase6 } from '../../server/orchestrator/phases/report.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary });

type Agent = (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>;

let remote: Remote;
let journal: Journal;
let gh: FakeGh;
let calls: AgentStepRequest<any>[];

beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  gh = new FakeGh();
  calls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(agent: Agent): PhaseDeps {
  const ghExec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
  gh.install(ghExec);
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  return {
    journal, ws, spec, project, specHash: HASH, firstSpec: true, exec: execCommand,
    runAgent: (async (req) => { calls.push(req); return agent(req); }) as PhaseDeps['runAgent'],
    mergeQueue: new MergeQueue(),
    mergeDeps: { journal, ws, exec: execCommand, ghExec: ghExec.exec, gates: async () => ({ results: [], blockingFailure: null }), graphify: null, secretValues: () => [], handoffs: [], clock: () => new Date() },
    packBase: () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 }),
    godNodes: async () => [],
  };
}

const report = () => ok({ specHash: HASH, delivered: [], blocked: [], assumptions: [], exploratoryScript: [], summary: 'done' });
const p6 = (agent: Agent) => runPhase6({ ...deps(agent), runId: 'r1', accounting: new Accounting(), result: 'awaiting-validation' });


describe('Phase 6 report', () => {
  it('writes the report and the awaiting-validation status to the mirror, and the docs to main', async () => {
    const mirror = { root: remote.root };
    await writeState(mirror, `specs/${spec.specId}/spec.json`, JSON.stringify(spec));
    const d = deps(async () => report());
    const r = await runPhase6({ ...d, docsRepo: true, runId: 'r1', accounting: new Accounting(), result: 'awaiting-validation' });
    expect(r.ok).toBe(true);
    expect(await readState(mirror, `specs/${spec.specId}/report.json`)).toMatchObject({ specId: spec.specId });
    expect(await readState(mirror, `specs/${spec.specId}/spec.json`)).toMatchObject({ status: 'awaiting-validation' });
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(await git(remote.repo, ['ls-tree', '-r', '--name-only', 'origin/main', 'docs/specs'], execCommand)).not.toContain('report.json');
  });

  it('puts the deploy port, health path, kind and docs path into report.service', async () => {
    await journal.fact(OrchEvent.DeployVerified, { attempt: 1, url: 'http://dind:3000', smoke: [], healthcheck: 'HTTP 200', tag: 't', port: 3000, healthcheckPath: '/health', kind: 'api', docsPath: '/docs' });
    const r = await p6(async () => report());
    expect(r.report.service).toMatchObject({ url: 'http://dind:3000', port: 3000, healthcheckPath: '/health', kind: 'api', docsPath: '/docs' });
  });

  it('lists every service of a services run and gives the SM only their host addresses', async () => {
    // The platform in a container reaches each service at http://dind:<port>, an address the human never opens.
    const card = (service: string, port: number) => ({ service, url: `http://dind:${port}`, port, healthcheck: 'HTTP 200', healthcheckPath: '/health' });
    await journal.fact(OrchEvent.DeployVerified, { attempt: 1, ...card('orders', 20001), smoke: [], services: [card('orders', 20001), { ...card('inventory', 20002), kind: 'api', docsPath: '/docs' }] });
    const r = await p6(async () => report());
    expect(r.report.services!.map((s) => [s.service, s.port])).toEqual([['orders', 20001], ['inventory', 20002]]);
    const pack = JSON.stringify(calls[0]!.pack);
    expect(pack).toContain('http://localhost:20001 (orders), http://localhost:20002 (inventory)');
    expect(pack).not.toContain('http://dind:');
  });

  it('counts the report step itself in report.tokens', async () => {
    const accounting = new Accounting();
    const usage = { inputTokens: 6, outputTokens: 8613, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const agent: Agent = async () => { accounting.record({ role: 'sm', phase: 'phase6', taskId: null, attempt: 1, stepKind: 'report', provider: 'claude', model: 'm', usage, costUsd: 0.28, durationMs: 1, numTurns: 1, at: '2026-10-09T00:00:00.000Z' }); return report(); };
    const r = await runPhase6({ ...deps(agent), runId: 'r1', accounting, result: 'awaiting-validation' });
    expect(r.report.tokens.total).toEqual({ inputTokens: 6, outputTokens: 8613, costUsd: 0.28 });
    expect(r.report.tokens.byRole.sm.costUsd).toBe(0.28);
  });

  it('puts the run metrics from the journal in the report, so each rerun can be compared with the last', async () => {
    await journal.fact(OrchEvent.StepFinished, { stepId: 's1', kind: 'dev', taskId: 'T1', attempt: 1, ok: true, costUsd: 2 });
    await journal.fact(OrchEvent.StepFinished, { stepId: 's2', kind: 'dev', taskId: 'T900-fix-1', attempt: 1, ok: true, costUsd: 1 });
    const r = await runPhase6({ ...deps(async () => report()), runId: 'r1', accounting: new Accounting(), result: 'awaiting-validation' });
    expect(r.report.metrics).toMatchObject({ costUsd: 3, fixCostUsd: 1, tasks: 2 });
    expect(r.report.metrics!.fixCostShare).toBeCloseTo(1 / 3);
  });

  it('blocks when the report step itself fails', async () => {
    const r = await p6(async () => ({ ok: false, failure: 'schema', errors: ['bad shape'], summary, sandboxDisabled: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('bad shape');
  });

  it('lists the pull requests of the run in report.json', async () => {
    await journal.fact(OrchEvent.PrCreated, { branch: 'task/spec-001-T1', number: 4, url: 'https://github.com/o/shop/pull/4', created: true });
    const r = await p6(async () => report());
    expect(r.report.prs).toEqual([{ task: 'T1', branch: 'task/spec-001-T1', number: 4, url: 'https://github.com/o/shop/pull/4', repository: 'o/shop', merged: false }]);
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/report.json'], execCommand)).prs).toHaveLength(1);
  });

  it('keeps in report.json the pull requests an earlier run of the spec merged', async () => {
    // An earlier run merged the technical spec, then stopped; this run went on from there.
    const earlier = await Journal.open({ file: path.join(remote.root, 'shop--spec-001--run-1', 'events.ndjson'), runId: 'shop--spec-001--run-1', specHash: HASH });
    await earlier.fact(OrchEvent.RunStarted, { runId: 'shop--spec-001--run-1', specId: 'spec-001', projectId: 'shop', firstSpec: true });
    await earlier.fact(OrchEvent.PrCreated, { branch: 'docs/spec-001', number: 1, url: 'https://github.com/o/shop/pull/1', created: true });
    await earlier.fact(OrchEvent.DocsMerged, { phase: 1, pr: 1, branch: 'docs/spec-001' });
    await earlier.close();
    await journal.fact(OrchEvent.PrCreated, { branch: 'task/spec-001-T1', number: 4, url: 'https://github.com/o/shop/pull/4', created: true });
    const r = await p6(async () => report());
    expect(r.report.prs.map((p) => [p.number, p.merged])).toEqual([[1, true], [4, false]]);
  });

});

describe('Phase 6 gap check', () => {
  const cited = makeFrozenSpec({ derivedFrom: { backlogKey: 'todos', inputHash: HASH, docsHash: HASH, sources: [{ doc: 'briefing.md', heading: 'Create a todo', hash: HASH, bodyHash: HASH }] } });
  const gapAnswer = (missing: string) => ok({ specHash: HASH, items: [{ doc: 'briefing.md', heading: 'Create a todo', status: 'missing', evidence: [], missing, acIds: [] }] });
  const withGaps = (gaps: Agent): Agent => async (req) => (req.kind === 'gaps' ? gaps(req) : report());
  const run = (agent: Agent) => runPhase6({ ...deps(agent), spec: cited, runId: 'r1', accounting: new Accounting(), result: 'awaiting-validation' });

  it('judges the cited sections once, read-only, and keeps the answer in the report and the journal', async () => {
    const r = await run(withGaps(async () => gapAnswer('Falta a tela de lista.')));
    expect(r.report.gaps).toEqual({ items: [{ doc: 'briefing.md', heading: 'Create a todo', status: 'missing', evidence: [], missing: 'Falta a tela de lista.', acIds: [], cause: { kind: 'no-task' } }] });
    const gaps = calls.filter((c) => c.kind === 'gaps');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ role: 'test', phase: 'phase6', protectedDirs: [expect.any(String)] });
    expect(journal.events.filter((e) => e.type === OrchEvent.GapsChecked)).toHaveLength(1);
  });

  it('reuses the journaled check when the report is written again after a failure', async () => {
    const failing: Agent = async (req) => (req.kind === 'gaps' ? gapAnswer('Falta a tela de lista.') : { ok: false, failure: 'schema', errors: ['bad shape'], summary, sandboxDisabled: false });
    const blocked = await run(failing);
    expect(blocked.ok).toBe(false);
    calls = [];
    const r = await run(withGaps(async () => { throw new Error('the gap check must not run again'); }));
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.kind === 'gaps')).toBe(false);
    expect(r.report.gaps).toMatchObject({ items: [{ heading: 'Create a todo' }] });
  });

  it('writes the report with the reason when the check fails twice', async () => {
    const r = await run(withGaps(async () => ({ ok: false, failure: 'schema', errors: ['not an object'], summary, sandboxDisabled: false })));
    expect(r.ok).toBe(true);
    expect(r.report.gaps).toEqual({ unavailable: 'not an object' });
    expect(calls.filter((c) => c.kind === 'gaps')).toHaveLength(2);
  });
});
