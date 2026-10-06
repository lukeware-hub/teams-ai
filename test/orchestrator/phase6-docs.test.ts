import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Accounting } from '../../server/budget/accounting.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
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

const section = (t: string) => `## ${t}\n\nReal explanatory content that is long enough to count.\n`;
const GOOD = { readme: `# App\n\n${['Run', 'Test', 'Environment variables', 'Architecture', 'Pipeline'].map(section).join('\n')}`, runbook: `# Runbook\n\n${['Start', 'Stop', 'Logs', 'Rollback'].map(section).join('\n')}` };
const report = (docs: { readme: string; runbook?: string; apiDocs?: string }) => ok({ specHash: HASH, delivered: [], blocked: [], assumptions: [], exploratoryScript: [], summary: 'done', ...docs });
const p6 = (agent: Agent) => runPhase6({ ...deps(agent), runId: 'r1', accounting: new Accounting(), result: 'awaiting-validation' });

describe('Phase 6 documentation gate', () => {
  it('merges valid docs on the first try', async () => {
    const r = await p6(async () => report(GOOD));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(await git(remote.repo, ['show', 'origin/main:docs/RUNBOOK.md'], execCommand)).toContain('Rollback');
  });

  it('puts the deploy port, health path, kind and docs path into report.service', async () => {
    await journal.fact(OrchEvent.DeployVerified, { attempt: 1, url: 'http://dind:3000', smoke: [], healthcheck: 'HTTP 200', tag: 't', port: 3000, healthcheckPath: '/health', kind: 'api', docsPath: '/docs' });
    const r = await p6(async () => report(GOOD));
    expect(r.report.service).toMatchObject({ url: 'http://dind:3000', port: 3000, healthcheckPath: '/health', kind: 'api', docsPath: '/docs' });
  });

  it('feeds validator errors back and accepts the corrected docs', async () => {
    let n = 0;
    const r = await p6(async () => report(++n === 1 ? { readme: '# App', runbook: GOOD.runbook } : GOOD));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.pack)).toContain('docs/README.md is missing a \\"run\\" section');
  });

  it('blocks the phase when the docs are invalid twice', async () => {
    const r = await p6(async () => report({ readme: '# App', runbook: GOOD.runbook }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Phase 6 blocked: documentation rejected/);
    expect(calls).toHaveLength(2);
    expect(journal.events.find((e) => e.type === OrchEvent.PhaseFailed)!.data).toMatchObject({ phase: 6 });
    expect(journal.events.some((e) => e.type === OrchEvent.ReportReady)).toBe(false);
  });

  it('blocks when the report step itself fails', async () => {
    const r = await p6(async () => ({ ok: false, failure: 'schema', errors: ['bad shape'], summary, sandboxDisabled: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('bad shape');
  });
});
