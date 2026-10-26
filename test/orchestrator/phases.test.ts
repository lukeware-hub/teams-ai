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
import { makeFrozenSpec, makePlan, makePlanTask, makeProject, makeServicesPlan } from '../fixtures/contracts.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import { serviceWorkspace } from '../../server/orchestrator/workspace.js';
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

/** orders-api already has code on main; inventory-api holds only its workflows, as Phase 0 and the workflow bootstrap leave it. */
async function cloneServices(ws: PhaseDeps['ws']): Promise<Remote[]> {
  const origins: Remote[] = [];
  for (const [service, files] of [['orders-api', { 'src/index.ts': 'x' }], ['inventory-api', { '.github/workflows/ci.yml': 'name: ci\n' }]] as const) {
    const origin = await makeRemote(files);
    origins.push(origin);
    const repo = serviceWorkspace(ws, service).repo;
    await fs.mkdir(path.dirname(repo), { recursive: true });
    await git(path.dirname(repo), ['clone', '-q', origin.origin, path.basename(repo)]);
  }
  return origins;
}

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
    expect(journal.events.some((e) => e.type === OrchEvent.PreplanDeviation)).toBe(false);
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/plan.json'])).tasks.map((t: { id: string }) => t.id)).toEqual(plan.tasks.map((t) => t.id));
    expect([...journal.state.tasks.keys()]).toEqual(plan.tasks.map((t) => t.id));
    expect(gh.prs[0]!.title).toBe('docs(spec-001): plan');
  });

  it('ranks SM alternatives with decision 12 and writes the winner without the alternatives field', async () => {
    const primary = makePlan(spec);
    const alt = makePlan(spec, { stack: 'node-alt' });
    const invalid = { ...makePlan(spec, { stack: 'broken' }), specHash: `sha256:${'f'.repeat(64)}` };
    const asked: unknown[][] = [];
    const decider = { decide: async (...args: unknown[]) => { asked.push(args); return { answered: true as const, backend: 'jev' as const, escalated: false, answers: { c0: { type: 'score' as const, value: 1, probabilities: {}, confidence: 0.9 }, c1: { type: 'score' as const, value: 4, probabilities: {}, confidence: 0.9 } } }; } };
    const r = await runPhase2({ ...deps(async () => ok({ ...primary, alternatives: [alt, invalid] })), decider }, '# Tech spec');
    expect(r.ok).toBe(true);
    expect(asked[0]![0]).toBe('plan-rank');
    expect(String(asked[0]![1])).not.toContain('broken'); // a candidate with the wrong specHash is never ranked
    await git(remote.repo, ['fetch', '-q', 'origin']);
    const written = JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/plan.json']));
    expect(written.stack).toBe('node-alt');
    expect(written.alternatives).toBeUndefined();
    expect(journal.events.some((e) => e.type === OrchEvent.PlanChosen && e.data.index === 1 && e.data.candidates === 2)).toBe(true);
  });

  it('plans again when the plan on main was written for an earlier version of the spec', async () => {
    const stale = { ...makePlan(spec), specHash: `sha256:${'0'.repeat(64)}` };
    await fs.mkdir(path.join(remote.repo, 'docs', 'specs', 'spec-001'), { recursive: true });
    await fs.writeFile(path.join(remote.repo, 'docs', 'specs', 'spec-001', 'plan.json'), JSON.stringify(stale));
    await git(remote.repo, ['add', '-A']);
    await git(remote.repo, ['commit', '-q', '-m', 'docs: old plan']);
    await git(remote.repo, ['push', '-q', 'origin', 'main']);
    const fresh = makePlan(spec);
    const r = await runPhase2(deps(async () => ok(fresh)), '# Tech spec');
    expect(r.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/plan.json'])).specHash).toBe(fresh.specHash);
  });

  it('gives a task id the journal held from an earlier version of the spec the definition of the new plan, once', async () => {
    const file = path.join(remote.root, 'events.ndjson');
    await journal.close();
    const earlier = await Journal.open({ file, runId: 'r1', specHash: `sha256:${'0'.repeat(64)}` });
    await earlier.fact(RunEvent.TaskPlanned, { task: makePlanTask({ id: 'T1-create', title: 'Old definition' }) });
    await earlier.close();
    journal = await Journal.open({ file, runId: 'r1', specHash: HASH });
    const plan = makePlan(spec);
    expect((await runPhase2(deps(async () => ok(plan)), '# Tech spec')).ok).toBe(true);
    expect(journal.state.tasks.get('T1-create')!.def).toEqual(plan.tasks.find((t) => t.id === 'T1-create'));
    // A later resume under the same version keeps what the journal holds.
    expect((await runPhase2(deps(async () => ok(plan)), '# Tech spec')).ok).toBe(true);
    expect(journal.events.filter((e) => e.type === RunEvent.TaskRedefined)).toHaveLength(1);
  });

  it('passes a preplan.json on main as context and journals which of its criteria the real plan dropped', async () => {
    await git(remote.repo, ['fetch', '-q', 'origin']);
    await fs.writeFile(path.join(remote.repo, 'docs', 'specs', 'spec-001', 'preplan.json'), JSON.stringify({
      specId: 'spec-001', specRev: HASH, inputHash: HASH,
      modules: [{ name: 'core', purpose: 'p' }],
      tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'dev', criteriaRefs: spec.acceptanceCriteria.map((c) => c.id), dependsOn: [] }],
      risks: [],
    }));
    await git(remote.repo, ['add', '-A'], execCommand);
    await git(remote.repo, ['commit', '-q', '-m', 'preplan'], execCommand);
    await git(remote.repo, ['push', '-q', 'origin', 'main'], execCommand);
    const plan = { ...makePlan(spec), tasks: makePlan(spec).tasks.map((t) => ({ ...t, criteriaRefs: t.criteriaRefs.filter((id) => id !== spec.acceptanceCriteria[0]!.id) })) };
    const r = await runPhase2(deps(async (req) => {
      expect(req.pack.feedback).toContain('"specId": "spec-001"'); // the preplan JSON reaches the pack
      return ok(plan);
    }), '# Tech spec');
    expect(r.ok).toBe(true);
    const deviation = journal.events.find((e) => e.type === OrchEvent.PreplanDeviation);
    expect(deviation?.data.missingCriteria).toEqual([spec.acceptanceCriteria[0]!.id]);
  });

  it('feeds the Spec Kit plan.md and tasks.md to the plan step and rejects a plan that leaves a tasks.md task out', async () => {
    const feature = 'specs/001-todo';
    await fs.mkdir(path.join(remote.repo, feature), { recursive: true });
    await fs.writeFile(path.join(remote.repo, feature, 'plan.md'), '# Plano\nUse Express.');
    await fs.writeFile(path.join(remote.repo, feature, 'tasks.md'), '- [ ] T001 Criar o projeto\n- [ ] T002 [P] [US1] Criar a rota\n');
    await git(remote.repo, ['add', '-A']);
    await git(remote.repo, ['commit', '-q', '-m', 'speckit']);
    await git(remote.repo, ['push', '-q', 'origin', 'main']);
    const plan = makePlan(spec);
    const covered = { ...plan, tasks: plan.tasks.map((t, i) => (i === 0 ? { ...t, speckitTasks: ['T001', 'T002'] } : t)) };
    // The fake agent applies the step's semantic checks: the first plan lists no Spec Kit task, the second lists both.
    const agent: Agent = async (req) => {
      const value = calls.length === 1 ? plan : covered;
      const errors = (req.semantic ?? []).flatMap((check) => (check as (v: unknown) => string[])(value));
      return errors.length > 0 ? { ok: false, failure: 'schema', errors, summary, sandboxDisabled: false } : ok(value);
    };
    const d = deps(agent);
    const r = await runPhase2({ ...d, packBase: () => ({ ...d.packBase(), speckitFeature: feature }) }, '# Tech spec');
    expect(calls[0]!.pack.feedback).toContain('Use Express.');
    expect(calls[0]!.pack.feedback).toContain('T002 [P] [US1] Criar a rota');
    expect(calls[1]!.pack.feedback).toContain('Spec Kit task T002 of tasks.md has no plan task');
    expect(r.ok).toBe(true);
  });

  it('asks a project of services for a services plan with a scaffold per new service and a port per service', async () => {
    const services = ['orders-api', 'inventory-api'];
    const shop = makeProject({ projectId: 'shop', services, platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] });
    const origins = await cloneServices(deps(async () => ok(null)).ws);
    const plan = makeServicesPlan(spec);
    const root = path.join(remote.root, 'workspaces');
    const r = await runPhase2({ ...deps(async () => ok(plan)), project: shop, workspacesRoot: root }, '# Tech spec');
    for (const o of origins) await o.cleanup();
    expect(r.ok).toBe(true);
    expect(calls[0]!.kind).toBe('services-plan');
    expect(calls[0]!.pack.feedback).toContain('new services (their main holds no code yet): inventory-api');
    expect(calls[0]!.pack.feedback).toContain('- files on main of orders-api: src/index.ts');
    const ports = JSON.parse(await fs.readFile(path.join(root, '.ports.json'), 'utf8')) as Record<string, number>;
    expect(Object.keys(ports).sort()).toEqual(['shop/inventory-api', 'shop/orders-api']);
    expect(ports['shop/orders-api']).not.toBe(ports['shop/inventory-api']);
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(Object.keys(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/plan.json'])).services).sort()).toEqual(['inventory-api', 'orders-api']);
  });

  it('holds each service of a services plan to its assigned port, with the semantic checks on', async () => {
    const shop = makeProject({ projectId: 'shop', services: ['orders-api', 'inventory-api'] });
    const origins = await cloneServices(deps(async () => ok(null)).ws);
    const root = path.join(remote.root, 'workspaces');
    const plan = makeServicesPlan(spec);
    // The fake agent applies the step's semantic checks: it swaps the assigned ports first, then uses them.
    const agent: Agent = async (req) => {
      const ports = JSON.parse(await fs.readFile(path.join(root, '.ports.json'), 'utf8')) as Record<string, number>;
      const [orders, inventory] = calls.length === 1 ? [ports['shop/inventory-api']!, ports['shop/orders-api']!] : [ports['shop/orders-api']!, ports['shop/inventory-api']!];
      const at = (name: 'orders-api' | 'inventory-api', port: number) => ({ ...plan.services[name]!, deploy: { ...plan.services[name]!.deploy, port } });
      const value = { ...plan, services: { 'orders-api': at('orders-api', orders), 'inventory-api': at('inventory-api', inventory) } };
      const errors = (req.semantic ?? []).flatMap((check) => (check as (v: unknown) => string[])(value));
      return errors.length > 0 ? { ok: false, failure: 'schema', errors, summary, sandboxDisabled: false } : ok(value);
    };
    const r = await runPhase2({ ...deps(agent), project: shop, workspacesRoot: root }, '# Tech spec');
    for (const o of origins) await o.cleanup();
    expect(calls[1]!.pack.feedback).toContain('the port the orchestrator assigned it');
    expect(r.ok).toBe(true);
  });

  it('feeds a services plan error back: a new service without its scaffold', async () => {
    const shop = makeProject({ projectId: 'shop', services: ['orders-api', 'inventory-api'] });
    const origins = await cloneServices(deps(async () => ok(null)).ws);
    const plan = makeServicesPlan(spec);
    const noScaffold = { ...plan, tasks: plan.tasks.filter((t) => t.id !== 'T0-scaffold-inventory-api').map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== 'T0-scaffold-inventory-api') })) };
    // The fake agent applies the step's semantic checks, as runAgentStep does after the schema.
    const agent: Agent = async (req) => {
      const errors = (req.semantic ?? []).flatMap((check) => (check as (v: unknown) => string[])(noScaffold));
      return errors.length > 0 ? { ok: false, failure: 'schema', errors, summary, sandboxDisabled: false } : ok(noScaffold);
    };
    const r = await runPhase2({ ...deps(agent), project: shop }, '# Tech spec');
    for (const o of origins) await o.cleanup();
    expect(r.ok).toBe(false);
    expect(calls[1]!.pack.feedback).toContain('service inventory-api');
    expect(calls[1]!.pack.feedback).not.toContain('service orders-api');
  });

  it('feeds back the errors of every rejected attempt, so a later plan does not bring back an error an earlier one fixed', async () => {
    const errors = ['gate coverage names a.json', 'commands.e2e must reference delivery.e2eSuite'];
    await runPhase2(deps(async () => ({ ok: false, failure: 'schema', errors: [errors[calls.length - 1] ?? 'other'], summary, sandboxDisabled: false })), '# Tech spec');
    expect(calls).toHaveLength(3);
    expect(calls[2]!.pack.feedback).toContain(errors[0]);
    expect(calls[2]!.pack.feedback).toContain(errors[1]);
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
