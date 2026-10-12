import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import type { Accounting } from '../../server/budget/accounting.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import { CI_PATH, RELEASE_PATH } from '../../server/orchestrator/workflows.js';
import { serviceWorkspace, type Workspace } from '../../server/orchestrator/workspace.js';
import type { StepOutcome, StepRequest } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlanTask, makeProject, makeServicesPlan } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject({ projectId: 'shop', services: ['orders', 'inventory'] });
const base = makeServicesPlan(spec);
// orders is a Node service and inventory a Go one; the inventory task waits on the orders task across repositories.
const plan = {
  ...base,
  tasks: [
    makePlanTask({ id: 'T1-publish-order', service: 'orders', criteriaRefs: ['AC-001'], affectedPaths: ['src/orders/**'] }),
    makePlanTask({ id: 'T2-reserve-stock', service: 'inventory', criteriaRefs: ['AC-002'], dependsOn: ['T1-publish-order'], affectedPaths: ['src/stock/**'] }),
  ],
  // Each service deploys with its own compose file.
  services: { orders: { ...base.services.orders!, delivery: { compose: 'docker-compose.yml' } }, inventory: { ...base.services.inventory!, stack: 'go', gateImage: 'golang:1.26-bookworm', delivery: { compose: 'docker-compose.yml' } } },
};
const FILE: Record<string, string> = { 'T1-publish-order': 'src/orders/index.ts', 'T2-reserve-stock': 'src/stock/index.ts' };
const TEST: Record<string, [string, string]> = { 'T1-publish-order': ['AC-001', 'sum::[AC-001] publishes'], 'T2-reserve-stock': ['AC-002', 'sum::[AC-002] reserves'] };
const JUNIT = '<testsuite name="sum"><testcase classname="sum" name="[AC-001] publishes"/><testcase classname="sum" name="[AC-002] reserves"/></testsuite>';
const summary = (): ResultSummary => ({ found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 5, costUsd: 0.001, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 });

async function script(req: StepRequest): Promise<StepOutcome<any>> {
  const id = req.taskId!;
  switch (req.kind) {
    case 'dev':
      await fs.mkdir(path.dirname(path.join(req.cwd, FILE[id]!)), { recursive: true });
      await fs.writeFile(path.join(req.cwd, FILE[id]!), `export const done = '${id}';\n`);
      return { ok: true, value: { specHash: HASH, status: 'done', summary: `did ${id}`, changedFiles: [FILE[id]], commitMessage: `feat: ${id}` }, summary: summary() };
    case 'review':
      return { ok: true, value: { specHash: HASH, decision: 'approve', criteria: [{ id: TEST[id]![0], status: 'passed', evidence: [TEST[id]![1]] }], findings: [] }, summary: summary() };
    case 'security':
      return { ok: true, value: { specHash: HASH, decision: 'approve', findings: [] }, summary: summary() };
    default:
      throw new Error(`unexpected step ${req.kind}`);
  }
}

let projectRemote: Remote;
let services: Record<'orders' | 'inventory', Remote>;
let ws: Workspace;
let fake: FakeExec;
const ghs = new Map<string, FakeGh>();
const ghExecs = new Map<string, FakeExec>();
const domains = new Map<string, string[]>();
const prompts = new Map<string, string>();

beforeEach(async () => {
  projectRemote = await makeRemote({
    'docs/project.json': JSON.stringify(project),
    'docs/specs/spec-001/spec.json': JSON.stringify(spec),
    'docs/specs/spec-001/tech-spec.md': '# Tech spec\n',
    'docs/specs/spec-001/plan.json': JSON.stringify(plan),
  });
  services = { orders: await makeRemote({ 'README.md': '# orders\n' }), inventory: await makeRemote({ 'README.md': '# inventory\n' }) };
  const root = path.join(projectRemote.root, 'ws');
  ws = { projectId: 'shop', root, repo: projectRemote.repo, worktrees: path.join(root, 'wt'), graph: path.join(root, 'graph'), knowledgeDb: '', secrets: path.join(root, 'secrets'), runs: path.join(projectRemote.root, 'runs') };
  for (const [service, remote] of Object.entries(services)) {
    const repo = serviceWorkspace(ws, service).repo;
    await fs.mkdir(path.dirname(repo), { recursive: true });
    await git(path.dirname(repo), ['clone', '-q', remote.origin, path.basename(repo)]);
    // One fake GitHub per repository: each service's pull requests live in its own repository.
    const gh = new FakeGh();
    const exec = new FakeExec();
    gh.install(exec);
    ghs.set(service, gh);
    ghExecs.set(repo, exec);
  }
});
afterEach(async () => {
  ghs.clear();
  ghExecs.clear();
  domains.clear();
  prompts.clear();
  for (const remote of [projectRemote, ...Object.values(services)]) await remote.cleanup();
});

async function deps(over: Partial<RunDeps> = {}): Promise<RunDeps> {
  const cfg = loadConfig({ paths: { workspaces: ws.root, runs: ws.runs, secrets: '/tmp/none' } });
  fake = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .on((s) => s.bin === 'gh' && ghExecs.has(s.cwd ?? ''), (s) => ghExecs.get(s.cwd!)!.exec(s))
    .onArgs('docker', ['run'], async (s) => {
      // Every gate passes and leaves the JUnit report in the bind-mounted worktree.
      const mount = s.args.find((a) => a.startsWith('type=bind,source=') && a.endsWith(',target=/work'))!;
      const wt = mount.slice('type=bind,source='.length, mount.length - ',target=/work'.length);
      await fs.mkdir(path.join(wt, 'reports'), { recursive: true });
      await fs.writeFile(path.join(wt, 'reports', 'junit.xml'), JUNIT);
      return { exitCode: 0 };
    });
  return {
    cfg, ws, project, spec, firstSpec: false,
    exec: fake.exec, ghExec: fake.exec,
    runStep: (async (req: StepRequest, stepDeps: { accounting: Accounting; network: { allowedDomains: readonly string[] } }) => {
      domains.set(`${req.kind}:${req.taskId}`, [...stepDeps.network.allowedDomains]);
      prompts.set(`${req.role}:${req.kind}:${req.taskId}`, req.prompt);
      const out = await script(req);
      stepDeps.accounting.record({ role: req.role, phase: req.phase, taskId: req.taskId, attempt: req.attempt, stepKind: req.kind, provider: 'claude', model: req.model, usage: out.summary.usage, costUsd: out.summary.costUsd, durationMs: out.summary.durationMs, numTurns: out.summary.numTurns, at: new Date().toISOString() });
      return out;
    }) as RunDeps['runStep'],
    binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: await loadAgents(path.resolve('.claude/agents')),
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
    ...over,
  };
}

describe('Run with a services plan', () => {
  it('runs each task in its own service repository, merges it there and keeps the project repository for the docs', async () => {
    const run = await Run.create(await deps());
    expect(await run.execute()).toBe('complete');
    expect([...run.journal.state.tasks.values()].map((t) => [t.def.id, t.state])).toEqual([['T1-publish-order', 'merged'], ['T2-reserve-stock', 'merged']]);
    for (const [service, file] of [['orders', 'src/orders/index.ts'], ['inventory', 'src/stock/index.ts']] as const) {
      const remote = services[service];
      await git(remote.repo, ['fetch', '-q', 'origin']);
      expect(await git(remote.repo, ['ls-tree', '-r', '--name-only', 'origin/main'])).toContain(file);
      expect(ghs.get(service)!.prs.map((p) => p.state)).toEqual(['MERGED']);
    }
    await git(projectRemote.repo, ['fetch', '-q', 'origin']);
    expect(await git(projectRemote.repo, ['ls-tree', '-r', '--name-only', 'origin/main'])).not.toContain('src/');
    // A service's repository holds no docs: each task is told where the other services answer.
    expect(prompts.get('dev:dev:T1-publish-order')).toContain(`inventory at http://inventory:${plan.services.inventory!.deploy.port}`);
    expect(prompts.get('dev:dev:T2-reserve-stock')).toContain(`orders at http://orders:${plan.services.orders!.deploy.port}`);
    expect(prompts.get('test:review:T2-reserve-stock')).toContain('This task changes the service inventory');
    // Each task's sandbox reaches its own stack's registries only, and each stack gets its own gate image.
    expect(domains.get('dev:T2-reserve-stock')).toContain('proxy.golang.org');
    expect(domains.get('dev:T1-publish-order')).not.toContain('proxy.golang.org');
    const inspected = fake.lines('docker').filter((l) => l.startsWith('image inspect '));
    expect(inspected.some((l) => l.includes('golang-1.26-bookworm'))).toBe(true);
    expect(inspected.some((l) => l.includes('node-22-bookworm'))).toBe(true);
    await run.close();
  }, 60_000);

  const scaffold = (service: string) => makePlanTask({ id: `T0-scaffold-${service}`, service, affectedPaths: ['package.json'] });
  const filesOnMain = async (service: 'orders' | 'inventory') => {
    await git(services[service].repo, ['fetch', '-q', 'origin']);
    return git(services[service].repo, ['ls-tree', '-r', '--name-only', 'origin/main']);
  };

  it("gives a front task of a service the project's design doc, which its repository lacks", async () => {
    const front = { ...plan, tasks: plan.tasks.map((t) => (t.id === 'T2-reserve-stock' ? { ...t, owner: 'front' as const } : t)) };
    await fs.writeFile(path.join(projectRemote.repo, 'docs', 'specs', 'spec-001', 'plan.json'), JSON.stringify(front));
    await fs.writeFile(path.join(projectRemote.repo, 'docs', 'design.md'), '# Design\n\nPrimary color #0b5fff.\n');
    await git(projectRemote.repo, ['add', '-A']);
    await git(projectRemote.repo, ['commit', '-q', '-m', 'docs: design']);
    await git(projectRemote.repo, ['push', '-q', 'origin', 'main']);
    const run = await Run.create(await deps());
    expect(await run.execute()).toBe('complete');
    expect(prompts.get('front:dev:T2-reserve-stock')).toContain('Primary color #0b5fff.');
    expect(prompts.get('dev:dev:T1-publish-order')).not.toContain('Primary color #0b5fff.');
  });

  it('commits the workflows to the repository of each new service, each under its own journal key', async () => {
    const run = await Run.create(await deps());
    expect(await run.executeWorkflows({ ...plan, tasks: [...plan.tasks, scaffold('orders'), scaffold('inventory')] })).toEqual({ ok: true });
    for (const service of ['orders', 'inventory'] as const) {
      expect(await filesOnMain(service)).toContain(CI_PATH);
      expect(await filesOnMain(service)).toContain(RELEASE_PATH);
    }
    expect(run.journal.events.filter((e) => e.kind === 'confirm' && e.type === 'DOCS_COMMIT').map((e) => e.intentId)).toEqual(['DOCS_COMMIT:spec-001-7-orders', 'DOCS_COMMIT:spec-001-7-inventory']);
    await run.close();
  });

  it("names the service whose workflows did not land", async () => {
    const inventory = serviceWorkspace(ws, 'inventory').repo;
    const refusing = new FakeExec().onArgs('gh', ['pr', 'merge'], () => ({ exitCode: 1, stderr: 'merge blocked by a branch rule' }));
    ghs.get('inventory')!.install(refusing);
    ghExecs.set(inventory, refusing);
    const run = await Run.create(await deps());
    const r = await run.executeWorkflows({ ...plan, tasks: [...plan.tasks, scaffold('orders'), scaffold('inventory')] });
    expect(r.ok ? '' : r.reason).toMatch(/^service inventory: /);
    await run.close();
  });

  it('leaves a service that is not new without workflows', async () => {
    const run = await Run.create(await deps());
    expect(await run.executeWorkflows({ ...plan, tasks: [...plan.tasks, scaffold('inventory')] })).toEqual({ ok: true });
    expect(await filesOnMain('inventory')).toContain(CI_PATH);
    expect(await filesOnMain('orders')).not.toContain(CI_PATH);
    await run.close();
  });

  it('deploys every service of a services plan on spec deploy', async () => {
    const applied: string[] = [];
    const recording = {
      name: 'docker-local' as const, validate: async () => [], build: async () => undefined,
      apply: async (i: { shared?: { alias: string } }) => { applied.push(i.shared!.alias); return { previous: null }; },
      verify: async () => ({ healthy: true, detail: 'HTTP 200' }), currentImage: async () => null, rollback: async () => undefined, destroy: async () => undefined,
      serviceUrl: () => 'http://127.0.0.1:3000', gateServiceUrl: () => 'http://x:3000', gateNetwork: () => 'teams-ai-shop_net',
      startPlatform: async () => ({ ok: true, detail: 'no platform' }),
    };
    const run = await Run.create(await deps({ target: recording as unknown as RunDeps['target'] }));
    expect(await run.deployOnly()).toBe('done');
    expect(applied).toEqual(['orders', 'inventory']);
    await run.close();
  });
});
