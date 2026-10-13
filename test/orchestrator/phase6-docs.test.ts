import { promises as fs } from 'node:fs';
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

/** Earlier specs' docs reach main from elsewhere, so the run's own checkout stays behind main, as between runs. */
async function mainWrites(files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) await fs.writeFile(path.join(remote.repo, rel), text);
  await git(remote.repo, ['add', '-A'], execCommand);
  await git(remote.repo, ['commit', '-q', '-m', 'earlier spec docs'], execCommand);
  await git(remote.repo, ['push', '-q', 'origin', 'HEAD:main'], execCommand);
  await git(remote.repo, ['reset', '-q', '--hard', 'HEAD~1'], execCommand);
}

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

  it('lists every service of a services run and gives the SM only their host addresses', async () => {
    // The platform in a container reaches each service at http://dind:<port>, an address the human never opens.
    const card = (service: string, port: number) => ({ service, url: `http://dind:${port}`, port, healthcheck: 'HTTP 200', healthcheckPath: '/health' });
    await journal.fact(OrchEvent.DeployVerified, { attempt: 1, ...card('orders', 20001), smoke: [], services: [card('orders', 20001), { ...card('inventory', 20002), kind: 'api', docsPath: '/docs' }] });
    const r = await p6(async () => report(GOOD));
    expect(r.report.services!.map((s) => [s.service, s.port])).toEqual([['orders', 20001], ['inventory', 20002]]);
    const pack = JSON.stringify(calls[0]!.pack);
    expect(pack).toContain('http://localhost:20001 (orders), http://localhost:20002 (inventory)');
    expect(pack).not.toContain('http://dind:');
  });

  it('counts the report step itself in report.tokens', async () => {
    const accounting = new Accounting();
    const usage = { inputTokens: 6, outputTokens: 8613, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const agent: Agent = async () => { accounting.record({ role: 'sm', phase: 'phase6', taskId: null, attempt: 1, stepKind: 'report', provider: 'claude', model: 'm', usage, costUsd: 0.28, durationMs: 1, numTurns: 1, at: '2026-10-09T00:00:00.000Z' }); return report(GOOD); };
    const r = await runPhase6({ ...deps(agent), runId: 'r1', accounting, result: 'awaiting-validation' });
    expect(r.report.tokens.total).toEqual({ inputTokens: 6, outputTokens: 8613, costUsd: 0.28 });
    expect(r.report.tokens.byRole.sm.costUsd).toBe(0.28);
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

  it('gives the report step the docs earlier specs wrote, in its working directory too, and keeps the endpoints they document', async () => {
    await mainWrites({ 'docs/README.md': '# Loja\n\n- AC-001: o estoque cadastra um sku.\n', 'docs/API.md': '# API\n\n### POST /stock\n' });
    const seen: string[] = [];
    let n = 0;
    const r = await p6(async (req) => {
      seen.push(await fs.readFile(path.join(req.cwd, 'docs', 'API.md'), 'utf8').catch(() => 'missing'));
      return report({ ...GOOD, apiDocs: ++n === 1 ? '# API\n\n### GET /orders\n' : '# API\n\n### POST /stock\n\n### GET /orders\n' });
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0]!.pack)).toContain('AC-001: o estoque cadastra um sku.');
    expect(seen[0]).toContain('### POST /stock');
    expect(JSON.stringify(calls[1]!.pack)).toContain('docs/API.md dropped endpoint /stock');
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(await git(remote.repo, ['show', 'origin/main:docs/API.md'], execCommand)).toContain('### POST /stock');
  });

  it('accepts docPatches over the docs on main instead of whole files, and feeds a bad find back', async () => {
    await mainWrites({ 'docs/README.md': `${GOOD.readme}\n- AC-001: o estoque cadastra um sku.\n`, 'docs/RUNBOOK.md': GOOD.runbook, 'docs/API.md': '# API\n\n### POST /stock\n' });
    let n = 0;
    const r = await p6(async () => ok({ specHash: HASH, delivered: [], blocked: [], assumptions: [], exploratoryScript: [], summary: 'done', docPatches: [
      { file: 'docs/README.md', find: ++n === 1 ? 'not there' : '- AC-001: o estoque cadastra um sku.', replace: '- AC-001: o estoque cadastra um sku.\n- AC-002: o pedido reserva o estoque.' },
      { file: 'docs/API.md', find: '', replace: '### GET /orders\n' },
    ] }));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.pack)).toContain('find must occur exactly once');
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(await git(remote.repo, ['show', 'origin/main:docs/README.md'], execCommand)).toContain('AC-002: o pedido reserva o estoque.');
    expect(await git(remote.repo, ['show', 'origin/main:docs/API.md'], execCommand)).toContain('### POST /stock\n\n### GET /orders');
  });

  it('lists the pull requests of the run in report.json', async () => {
    await journal.fact(OrchEvent.PrCreated, { branch: 'task/spec-001-T1', number: 4, url: 'https://github.com/o/shop/pull/4', created: true });
    const r = await p6(async () => report(GOOD));
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
    const r = await p6(async () => report(GOOD));
    expect(r.report.prs.map((p) => [p.number, p.merged])).toEqual([[1, true], [4, false]]);
  });

  it('starts the docs worktree again from main after a failed report, so the next run sees what other specs merged since', async () => {
    expect((await p6(async () => report({ readme: '# App', runbook: GOOD.runbook }))).ok).toBe(false);
    await mainWrites({ 'docs/API.md': '# API\n\n### POST /orders\n' });
    // The next run of this spec has its own journal and the same project checkout.
    await journal.close();
    journal = await Journal.open({ file: path.join(remote.root, 'events-2.ndjson'), runId: 'r2', specHash: HASH });
    calls = [];
    const r = await p6(async () => report({ ...GOOD, apiDocs: '# API\n\n### POST /orders\n' }));
    expect(JSON.stringify(calls[0]!.pack)).toContain('### POST /orders');
    expect(r.ok).toBe(true);
  });
});
