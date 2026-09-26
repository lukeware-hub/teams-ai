import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Intent, Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase1, runPhase2, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makeProject } from '../fixtures/contracts.js';
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

const writeTechSpec: Agent = async (req) => {
  await fs.mkdir(path.join(req.cwd, 'docs', 'specs', 'spec-001'), { recursive: true });
  await fs.mkdir(path.join(req.cwd, 'docs', 'adr'), { recursive: true });
  await fs.writeFile(path.join(req.cwd, 'docs', 'specs', 'spec-001', 'tech-spec.md'), '# Tech spec\n\n## AC-001\nsum');
  await fs.writeFile(path.join(req.cwd, 'docs', 'adr', 'ADR-001.md'), '# ADR-001 stack');
  return ok({ specHash: HASH, techSpecPath: 'docs/specs/spec-001/tech-spec.md', adrs: [{ id: 'ADR-001', title: 'stack', path: 'docs/adr/ADR-001.md' }], stack: 'node', summary: 'wrote it' });
};
const coverage = (covered: boolean) => ok({ specHash: HASH, coverage: spec.acceptanceCriteria.map((c) => ({ acId: c.id, section: covered ? 'AC-001' : null, covered, note: '' })) });

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

describe('Phase 1', () => {
  it('writes the tech spec, checks coverage and merges the docs branch', async () => {
    let n = 0;
    const r = await runPhase1(deps(async (req) => (req.kind === 'tech-spec' ? writeTechSpec(req) : (n++, coverage(n > 1)))));
    expect(r.ok).toBe(true);
    expect(r.techSpecText).toContain('# Tech spec');
    expect(calls.map((c) => c.kind)).toEqual(['tech-spec', 'coverage', 'tech-spec', 'coverage']);
    expect(calls[2]!.pack.feedback).toContain('AC-001');
    expect(gh.prs[0]!.title).toBe('docs(spec-001): technical spec');
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/tech-spec.md'])).toContain('# Tech spec');
    expect(journal.events.map((e) => e.type)).toContain(OrchEvent.DocsMerged);
    expect(journal.events.filter((e) => e.type === OrchEvent.CoverageChecked).map((e) => e.data.uncovered)).toEqual([spec.acceptanceCriteria.map((c) => c.id), []]);
  });

  it('a quota failure pauses the run and retries the step without consuming a phase attempt', async () => {
    const paused: string[] = [];
    let n = 0;
    const d = deps(async (req) => {
      if (req.kind === 'tech-spec' && n++ === 0) return { ok: false, failure: 'quota', errors: ['usage limit'], summary: { ...summary, isError: true }, sandboxDisabled: false };
      return req.kind === 'tech-spec' ? writeTechSpec(req) : coverage(true);
    });
    d.pause = async (failure) => {
      paused.push(failure);
      return 'resumed';
    };
    const r = await runPhase1(d);
    expect(r.ok).toBe(true);
    expect(paused).toEqual(['quota']);
    expect(calls.map((c) => [c.kind, c.attempt])).toEqual([['tech-spec', 1], ['tech-spec', 1], ['coverage', 1]]);
  });

  it('an auth failure returns paused:auth so the CLI can stop without failing the phase', async () => {
    const d = deps(async () => ({ ok: false, failure: 'auth', errors: ['not logged in'], summary: { ...summary, isError: true }, sandboxDisabled: false }));
    d.pause = async () => 'auth';
    expect(await runPhase1(d)).toEqual({ ok: false, reason: 'paused:auth' });
    expect(journal.events.some((e) => e.type === OrchEvent.PhaseFailed)).toBe(false);
  });

  it('fails the phase after three uncovered rounds', async () => {
    const r = await runPhase1(deps(async (req) => (req.kind === 'tech-spec' ? writeTechSpec(req) : coverage(false))));
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('AC-001') });
    expect(journal.events.find((e) => e.type === OrchEvent.PhaseFailed)!.data).toMatchObject({ phase: 1 });
    expect(gh.prs).toHaveLength(0);
  });

  it('is idempotent: a tech spec already on main skips the phase', async () => {
    await fs.mkdir(path.join(remote.repo, 'docs', 'specs', 'spec-001'), { recursive: true });
    await fs.writeFile(path.join(remote.repo, 'docs', 'specs', 'spec-001', 'tech-spec.md'), '# existing');
    await git(remote.repo, ['add', '-A']);
    await git(remote.repo, ['commit', '-q', '-m', 'docs: existing']);
    await git(remote.repo, ['push', '-q', 'origin', 'main']);
    const r = await runPhase1(deps(async () => { throw new Error('no agent call expected'); }));
    expect(r).toEqual({ ok: true, techSpecText: '# existing' });
    expect(calls).toHaveLength(0);
  });
  it('a crash between the docs commit confirm and the merge skips the agents and merges the committed branch', async () => {
    // First pass: agents run and the docs commit is confirmed, then the process "dies" before the merge.
    const dying = deps(async (req) => (req.kind === 'tech-spec' ? writeTechSpec(req) : coverage(true)));
    dying.mergeQueue = { enqueue: async () => { throw Object.assign(new Error('crash before merge'), { fatal: true }); } } as never;
    await expect(runPhase1(dying)).rejects.toThrow('crash before merge');
    expect(journal.isConfirmed(Intent.DocsCommit, 'spec-001-1')).toBe(true);
    const agentCalls = calls.length;
    // Resume: nothing on main yet, but the commit is confirmed → no agent step, straight to the merge.
    const r = await runPhase1(deps(async () => { throw new Error('no agent call expected on resume'); }));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(agentCalls);
    expect(gh.prs.map((p) => p.state)).toEqual(['MERGED']);
  });
});

describe('Phase 2', () => {
  it('plans, validates, commits plan.json and journals every task', async () => {
    const plan = makePlan(spec);
    const r = await runPhase2(deps(async () => ok(plan)), '# Tech spec');
    expect(r.ok).toBe(true);
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/plan.json'])).tasks.map((t: { id: string }) => t.id)).toEqual(plan.tasks.map((t) => t.id));
    expect([...journal.state.tasks.keys()]).toEqual(plan.tasks.map((t) => t.id));
    expect(gh.prs[0]!.title).toBe('docs(spec-001): plan');
  });

  it('feeds validation errors back and fails after the retries', async () => {
    const bad = { ...makePlan(spec), tasks: [] };
    const r = await runPhase2(deps(async () => ({ ok: false, failure: 'schema', errors: ['tasks: Too small: expected array to have >=1 items'], summary, sandboxDisabled: false })), '# Tech spec');
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.pack.feedback).toContain('Too small');
    expect(journal.events.find((e) => e.type === OrchEvent.PhaseFailed)!.data).toMatchObject({ phase: 2 });
    void bad;
  });
});
