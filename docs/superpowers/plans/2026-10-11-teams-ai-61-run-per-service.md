# Plan 61 - Runs go through service views (roadmap R12.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: done, 2026-10-11: whole suite 1463 passed and 4 skipped (baseline 1454), type check clean. Roadmap item R12.2, stage 12 (plan 60).

**Goal:** A run accepts a plan of either shape, runs every task in the repository of its service with that service's settings, merges it there, and gives one verification verdict for the whole spec; a single-repository plan runs exactly as before.

**Architecture:** The run keeps the plan as `AnyPlan` and asks `servicePlans()` (plan 60) for the view of each task's service. Everything a task touches (workspace, gates, gate image, install, sandbox registries, merge, code graph) is built from that view and its workspace `services/<service>/` beside the project repository. Phase 4 checks the delivery files and runs the gates on main of every repository, joins the JUnit results and builds one evidence matrix, so the journal keeps one verdict per round. Deploying several services is roadmap R12.4: until then a services run ends before Phase 5 with a clear reason.

**Tech Stack:** TypeScript on Node (ES modules), zod 4, vitest, local git remotes in tests.

**Spec:** `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (sections "Design" and "Slices", item R12.2).

## Global Constraints

- A single-repository plan behaves exactly as today: same journal events and payloads, same paths, every existing test passes unchanged.
- No technology is fixed in code: stacks, images and service names come from the plan.
- Error messages that exist today keep their exact wording.
- Code follows `QUALITY_RULES` (`server/agents/registry.ts`): one-sentence comments, smallest working solution, no duplicated logic.
- Focused test: `npx vitest run <file>`; whole suite: `npx vitest run`; types: `npx tsc --noEmit`.
- Out of scope, each with its own slice: creating service repositories on GitHub, workflows per service and reconciling a resumed services run per repository (R12.3); deploying several services and the platform (R12.4); report and screens per service (R12.5); agent rules for writing a services plan (R12.6).

## Review Focus

1. Two services in different stacks: each task's sandbox reaches only its own stack's registries, and each gets its own prepared gate image (Task 3).
2. A task in one service that depends on a task in another runs after it, and each merge lands in its own repository only (Task 3).
3. A criterion proven only by another service's tests must not fail verification (Task 4).
4. A replacement from a replan stays in its task's service, and a service's scaffold keeps the frozen-path permission (Task 2).
5. A services run must never reach Phase 5 code written for one service (Task 4).

## Where the code assumes one repository today

- `server/orchestrator/run.ts`: `plan: Plan`, one `gateImageReady` for the whole run (a second stack would reuse the first image), `gates`, `installDeps`, `code`, `impact`, `boundaries`, `mergeDeps` and `runnerDeps` all read `this.plan` and `this.deps.ws`; the step sandbox reads one stack.
- `server/orchestrator/phases/shared.ts`: `readDocs` and `planIsStale` parse `Plan` only.
- `server/orchestrator/phases/plan.ts`: Phase 2 returns `Plan`.
- `server/pipeline/run-state.ts:76`: the scaffold is recognized by the single id `T0-scaffold`.
- `server/orchestrator/task-runner.ts:628-638`: replacements from a replan carry no service.
- `server/orchestrator/phases/verify.ts`: one repository, one `plan`, one `gates`; fix tasks are checked with `validatePlan`.

---

### Task 1: A workspace per service

**Files:**
- Modify: `server/orchestrator/workspace.ts`
- Test: `test/orchestrator/workspace.test.ts`

**Interfaces:**
- Produces: `serviceWorkspace(ws: Workspace, service: string | null): Workspace`; null returns `ws` itself.

- [ ] **Step 1: Write the failing test**

Add `serviceWorkspace` to the import from `../../server/orchestrator/workspace.js`, and add inside `describe('workspace', ...)`:

```ts
  it('gives a service its own repository, worktrees and graph beside the project, and keeps the rest', () => {
    const ws = workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u');
    expect(serviceWorkspace(ws, null)).toBe(ws);
    expect(serviceWorkspace(ws, 'orders')).toEqual({
      ...ws,
      repo: '/home/u/.teams-ai/workspaces/shop/services/orders/repo',
      worktrees: '/home/u/.teams-ai/workspaces/shop/services/orders/worktrees',
      graph: '/home/u/.teams-ai/workspaces/shop/services/orders/graph',
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/orchestrator/workspace.test.ts`
Expected: FAIL, `serviceWorkspace` is not a function.

- [ ] **Step 3: Write the implementation**

In `server/orchestrator/workspace.ts`, below `workspacePaths`:

```ts
/** Where a service's code lives: the project's own repository for null, else `services/<service>` beside it. */
export function serviceWorkspace(ws: Workspace, service: string | null): Workspace {
  if (service === null) return ws;
  const root = path.posix.join(ws.root, 'services', service);
  return { ...ws, repo: path.posix.join(root, 'repo'), worktrees: path.posix.join(root, 'worktrees'), graph: path.posix.join(root, 'graph') };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/orchestrator/workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/workspace.ts test/orchestrator/workspace.test.ts
git commit -m "feat(workspace): each service gets its own repository, worktrees and graph"
```

### Task 2: A task keeps its service through the scaffold rule and replans

**Files:**
- Modify: `server/pipeline/run-state.ts:3,76`
- Modify: `server/orchestrator/task-runner.ts:628`
- Test: `test/pipeline/run-state.test.ts`, `test/orchestrator/task-runner.test.ts`

**Interfaces:**
- Consumes: `scaffoldId(service: string | null): string` (plan 60, `server/validators/plan.ts`).

- [ ] **Step 1: Write the failing tests**

`test/pipeline/run-state.test.ts`, after the test "T0-scaffold starts with permission to write the frozen docs it bootstraps, and a replan inherits it":

```ts
  it("a service's scaffold is recognized by its own id, and only in its own service", () => {
    const state = reduceEvents([
      { type: RunEvent.TaskPlanned, data: { task: makePlanTask({ id: 'T0-scaffold-inventory', service: 'inventory' }) } },
      { type: RunEvent.TaskPlanned, data: { task: makePlanTask({ id: 'T0-scaffold-orders', service: 'inventory' }) } },
    ]);
    expect(state.tasks.get('T0-scaffold-inventory')!.bootstrapsFrozenPaths).toBe(true);
    expect(state.tasks.get('T0-scaffold-orders')!.bootstrapsFrozenPaths).toBe(false);
  });
```

`test/orchestrator/task-runner.test.ts`, inside `describe('TaskRunner: attempts, replan, block', ...)`:

```ts
  it('keeps a replacement in the service of the task it replaces', async () => {
    await journal.close();
    journal = await Journal.open({ file: path.join(remote.root, 'events-service.ndjson'), runId: 'spec-001-r1', specHash: HASH });
    await journal.fact(RunEvent.TaskPlanned, { task: { ...T1, service: 'orders' } });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [replacement] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: alwaysFailGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(journal.state.tasks.get('T1-r1')!.def.service).toBe('orders');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/pipeline/run-state.test.ts test/orchestrator/task-runner.test.ts`
Expected: FAIL on both new tests (`false` instead of `true`; `undefined` instead of `orders`).

- [ ] **Step 3: Write the implementation**

`server/pipeline/run-state.ts`: import `scaffoldId` instead of `SCAFFOLD_TASK_ID`, and in the `TaskPlanned` case:

```ts
      addTask(state, planned, false, planned.id === scaffoldId(planned.service ?? null));
```

`server/orchestrator/task-runner.ts`, in `replan()`, replace `const value = this.ownInfraOnly(outcome.value as ReplanOutput);` with:

```ts
    const own = this.ownInfraOnly(outcome.value as ReplanOutput);
    // A replacement changes the same repository as the task it replaces.
    const service = this.task.def.service;
    const value = service ? { ...own, replacements: own.replacements.map((r) => ({ ...r, service })) } : own;
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/pipeline test/orchestrator/task-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pipeline/run-state.ts server/orchestrator/task-runner.ts test/pipeline/run-state.test.ts test/orchestrator/task-runner.test.ts
git commit -m "feat(run): a service's scaffold and replacements stay in their service"
```

### Task 3: The run reads either plan shape and runs each task in its service

**Files:**
- Modify: `server/orchestrator/phases/shared.ts` (`readDocs`, `planIsStale`)
- Modify: `server/orchestrator/phases/plan.ts` (types only)
- Modify: `server/orchestrator/run.ts`
- Create: `test/orchestrator/read-docs.test.ts`
- Create: `test/orchestrator/run-services.test.ts`

**Interfaces:**
- Consumes: `AnyPlan`, `servicePlans`, `ServiceView` (plan 60); `serviceWorkspace` (Task 1); `scaffoldId` (plan 60).
- Produces: `readDocs(...)` returns `plan: AnyPlan | null`; `planIsStale(plan: AnyPlan | null, specHash: string)`; `runPhase2(...)` returns `plan?: AnyPlan`; in `run.ts`, private `wsOf(view)`, `firstSpecOf(view)`, `taskView(taskId)`, `registries(view?)`, `gatesFor(view)`, `installDeps(view, worktree)`, `codeFor(view)`, `impactFor(view)`, `mergeDeps(view | null)`, `runnerDeps(view)`, and module helpers `singlePlan(plan)` and `viewOf(plan, service)`.

- [ ] **Step 1: Write the failing tests**

`test/orchestrator/read-docs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planIsStale, readDocs } from '../../server/orchestrator/phases/shared.js';
import { makeFrozenSpec, makeServicesPlan } from '../fixtures/contracts.js';
import { makeRemote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();

describe('readDocs', () => {
  it('reads a services plan from main and judges it stale by its spec hash', async () => {
    const remote = await makeRemote({ 'docs/specs/spec-001/plan.json': JSON.stringify(makeServicesPlan(spec)) });
    const docs = await readDocs(remote.repo, 'spec-001');
    expect(docs.plan !== null && 'services' in docs.plan && Object.keys(docs.plan.services)).toEqual(['orders', 'inventory']);
    expect(planIsStale(docs.plan, spec.specHash!)).toBe(false);
    expect(planIsStale(docs.plan, `sha256:${'0'.repeat(64)}`)).toBe(true);
    await remote.cleanup();
  });
});
```

`test/orchestrator/run-services.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import type { Accounting } from '../../server/budget/accounting.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
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
  services: { ...base.services, inventory: { ...base.services.inventory!, stack: 'go', gateImage: 'golang:1.26-bookworm' } },
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
    // Each task's sandbox reaches its own stack's registries only, and each stack gets its own gate image.
    expect(domains.get('dev:T2-reserve-stock')).toContain('proxy.golang.org');
    expect(domains.get('dev:T1-publish-order')).not.toContain('proxy.golang.org');
    const inspected = fake.lines('docker').filter((l) => l.startsWith('image inspect '));
    expect(inspected.some((l) => l.includes('golang-1.26-bookworm'))).toBe(true);
    expect(inspected.some((l) => l.includes('node-22-bookworm'))).toBe(true);
    await run.close();
  }, 60_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/read-docs.test.ts test/orchestrator/run-services.test.ts`
Expected: FAIL; `readDocs` rejects the services plan (`Plan.parse` throws), and the run fails in Phase 1 for the same reason.

- [ ] **Step 3: Read either shape in the phases**

`server/orchestrator/phases/shared.ts`: import `AnyPlan` with `Plan`; `readDocs` returns `plan: AnyPlan | null` and parses with `AnyPlan.parse(JSON.parse(planText))`; `planIsStale` takes `plan: AnyPlan | null`.

`server/orchestrator/phases/plan.ts`: import `AnyPlan` with `Plan`; `runPhase2(...)` returns `Promise<PhaseResult & { plan?: AnyPlan }>`; the plan read back before a resumed docs merge is `AnyPlan.parse(...)`; `journalTasks(deps: PhaseDeps, plan: AnyPlan)`. The agent path keeps `Plan`: it only writes single-repository plans until R12.6.

- [ ] **Step 4: Run each task in its view (`server/orchestrator/run.ts`)**

Imports: `AnyPlan`, `servicePlans`, `type Plan`, `type PlanTask`, `type ServiceView` from `../contracts/plan.js`; `scaffoldId` from `../validators/plan.js`; `serviceWorkspace` and `worktreeDir` from `./workspace.js`.

Module level, below `buildTimeoutMs`:

```ts
/** The plan when it has one repository; a services plan is read per service instead. */
const singlePlan = (plan: AnyPlan | null): Plan | undefined => (plan && !('services' in plan) ? plan : undefined);

/** The view a task runs in: its service's, or the whole plan for a task without a service. */
function viewOf(plan: AnyPlan, service: string | undefined): ServiceView {
  const view = servicePlans(plan).find((v) => v.service === (service ?? null));
  if (!view) throw new Error(`the plan has no service ${service}`);
  return view;
}

/** Docs merges run no gates. */
const NO_GATES = async (): Promise<{ results: GateResult[]; blockingFailure: GateResult | null }> => ({ results: [], blockingFailure: null });
```

Fields: `private plan: AnyPlan | null = null;` and, in place of `gateImageReady`, `private readonly gateImages = new Map<string, Promise<string>>();`.

New private methods:

```ts
  private wsOf(view: ServiceView): Workspace {
    return serviceWorkspace(this.deps.ws, view.service);
  }

  /** A new service's repository is bootstrapped by its own scaffold; the project repository keeps the run's firstSpec. */
  private firstSpecOf(view: ServiceView): boolean {
    return view.service === null ? this.deps.firstSpec : view.plan.tasks.some((t) => t.id === scaffoldId(view.service));
  }

  private taskView(taskId: string): ServiceView {
    return viewOf(this.plan!, this.journal.state.tasks.get(taskId)?.def.service);
  }

  /** Package registries a step may reach: its task's stack, or every stack of the plan for a step outside a task. */
  private registries(view?: ServiceView): string[] {
    const views = view ? [view] : this.plan ? servicePlans(this.plan) : [];
    const texts = views.length > 0 ? views.map((v) => `${v.plan.stack} ${v.plan.gateImage} ${this.deps.project.stack ?? ''}`) : [this.deps.project.stack ?? ''];
    return [...new Set(texts.flatMap((text) => stackDomains(stackKind(text))))];
  }
```

Changed methods (each keeps its body except what is named here):

- `afterMergeOnResume`: after `const task = ...`, return when `!plan || !task`; then `const view = viewOf(plan, task.service);` and call `taskMergeSteps(this.mergeDeps(view), task, worktreeDir(this.wsOf(view), branch), ...)`. Delete `worktreeOf`, which `worktreeDir` already covers.
- `loadPlan(): Promise<AnyPlan | null>`.
- `stepDeps(view?: ServiceView)`: `network: { allowedDomains: [...this.registries(view), cfg.docker.serviceHost] }`.
- `agentDeps(view?: ServiceView)`: `stepDeps: this.stepDeps(view)`.
- `installDeps(view: ServiceView, worktree: string)`: reads `view.plan.commands.install` and `buildTimeoutMs(view.plan)`.
- `gateImage(image)`, one prepared image per stack image:

```ts
  /** The image every gate, smoke and e2e container of one stack runs, prepared once per run and image (jq, plus rustfmt and clippy for rust). */
  private gateImage(image: string): Promise<string> {
    let ready = this.gateImages.get(image);
    if (!ready) this.gateImages.set(image, (ready = prepareGateImage(image, this.deps.exec)));
    return ready;
  }
```

- `gates` becomes `gatesFor(view: ServiceView)`, returning today's arrow function with `const plan = view.plan;` and `this.installDeps(view, worktree)`.
- `mergeDeps(view: ServiceView | null)`: `ws: view ? this.wsOf(view) : this.deps.ws` and `gates: view ? this.gatesFor(view) : NO_GATES`.
- `code` and `impact` become `codeFor(view)` and `impactFor(view)`, returning today's arrow functions with `const ws = this.wsOf(view);` in place of `this.deps.ws`.
- `gitLocked(args: readonly string[], ws: Workspace = this.deps.ws)`, locking and running in `ws.repo`.
- `runnerDeps(view: ServiceView)`: `const ws = this.wsOf(view);` then `ws`, `plan: view.plan`, `firstSpec: this.firstSpecOf(view)`, `runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => runAgentStep(req, this.agentDeps(view))`, `gates: this.gatesFor(view)`, `installDeps: (worktree) => this.installDeps(view, worktree)`, `mergeSteps: (task, worktree, branch) => taskMergeSteps(this.mergeDeps(view), task, worktree, branch, spec, this.summaryOf(task.id))`, `code: this.codeFor(view)`, `impact: this.impactFor(view)`, and `boundaries` reading `graphDir(ws, null)` and `this.gitLocked(['ls-tree', '--name-only', 'origin/main'], ws)`.
- `phaseDeps()`: `const single = singlePlan(this.plan);` then `plan: single`, `gates: single ? this.gatesFor({ service: null, plan: single }) : undefined`, `mergeDeps: this.mergeDeps(null)`, and `const p = singlePlan(this.plan)!;` inside `smoke` and `e2e`.
- `executeWorkflows(plan: AnyPlan)`:

```ts
  async executeWorkflows(plan: AnyPlan): Promise<PhaseResult> {
    const single = singlePlan(plan);
    // Service repositories get their workflows when they are created (R12.3).
    if (!this.deps.bootstrap || !single) return { ok: true };
    return runWorkflowBootstrap(this.phaseDeps(), single);
  }
```

- `loop()`: both `new TaskRunner(id, this.runnerDeps())` become `new TaskRunner(id, this.runnerDeps(this.taskView(id)))`.
- `deployOnly()`: `this.plan = AnyPlan.parse(JSON.parse(text));`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/orchestrator test/e2e && npx tsc --noEmit`
Expected: PASS; every existing run test passes unchanged.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/phases/shared.ts server/orchestrator/phases/plan.ts server/orchestrator/run.ts test/orchestrator/read-docs.test.ts test/orchestrator/run-services.test.ts
git commit -m "feat(run): each task runs and merges in the repository of its service"
```

### Task 4: One verification verdict across every repository; no Phase 5 for services yet

**Files:**
- Modify: `server/orchestrator/phases/shared.ts` (`ServiceRepo`, `PhaseDeps.services`)
- Modify: `server/orchestrator/phases/index.ts` (export `type ServiceRepo`)
- Modify: `server/orchestrator/phases/verify.ts`
- Modify: `server/orchestrator/steps.ts` (`fixTasksPack`)
- Modify: `server/orchestrator/run.ts` (`phaseDeps`, `postPhases`, `deployOnly`)
- Create: `test/orchestrator/verify-services.test.ts`
- Modify: `test/orchestrator/run-services.test.ts`

**Interfaces:**
- Consumes: `validateServicesPlan`, `scaffoldId` (plan 60); `runnerDeps`, `gatesFor`, `wsOf`, `firstSpecOf`, `singlePlan` (Task 3).
- Produces: `interface ServiceRepo extends ServiceView { ws: Workspace; firstSpec: boolean; gates: NonNullable<PhaseDeps['gates']> }` and `PhaseDeps.services?: { plan: ServicesPlan; repos: ServiceRepo[] }` in `shared.ts`; `fixTasksPack` takes `plan: Pick<Plan, 'tasks' | 'gates'>` and `services?: readonly string[]`; `SERVICES_DEPLOY_PENDING` in `run.ts`.

- [ ] **Step 1: Write the failing tests**

`test/orchestrator/verify-services.test.ts`:

```ts
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { servicePlans, type ServicesPlan } from '../../server/contracts/plan.js';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase4, type PhaseDeps, type ServiceRepo } from '../../server/orchestrator/phases/index.js';
import { makeFrozenSpec, makeServicesPlan } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/run.test.ts', readmeSections: ['Run'] };
const unitGate = (ac: string, passed: boolean): GateResult => ({
  name: 'unit-test', blocking: true, passed, exitCode: passed ? 0 : 1, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: '',
  junit: [{ id: `t::[${ac}] works`, name: `[${ac}] works`, classname: 't', status: passed ? 'passed' : 'failed', acIds: [ac] }], failure: passed ? null : 'code',
});

let remotes: Remote[] = [];
let journal: Journal;
afterEach(async () => {
  await journal.close();
  for (const r of remotes) await r.cleanup();
  remotes = [];
});

/** orders delivers AC-001 and inventory, a new repository, delivers AC-002 (makeServicesPlan). */
async function setup(plan: ServicesPlan, passed: Record<string, boolean>): Promise<PhaseDeps> {
  const repos: ServiceRepo[] = [];
  for (const view of servicePlans(plan)) {
    const remote = await makeRemote({ 'README.md': '#\n' });
    remotes.push(remote);
    const result = unitGate(view.service === 'orders' ? 'AC-001' : 'AC-002', passed[view.service!]!);
    repos.push({ ...view, ws: { repo: remote.repo } as ServiceRepo['ws'], firstSpec: view.service === 'inventory', gates: async () => ({ results: [result], blockingFailure: result.passed ? null : result }) });
  }
  journal = await Journal.open({ file: path.join(remotes[0]!.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
  return { journal, ws: { repo: remotes[0]!.repo }, spec, exec: execCommand, firstSpec: false, tasks: () => [], services: { plan, repos } } as unknown as PhaseDeps;
}

describe('Phase 4 with several services', () => {
  it('passes once with one matrix when each criterion is proven in the repository of the service that delivers it', async () => {
    const res = await runPhase4(await setup(makeServicesPlan(spec), { orders: true, inventory: true }), 1);
    expect(res.ok).toBe(true);
    const passed = journal.events.filter((e) => e.type === OrchEvent.VerificationPassed);
    expect(passed).toHaveLength(1);
    expect((passed[0]!.data.matrix as Array<{ criterion: string; status: string }>).map((r) => [r.criterion, r.status])).toEqual([['AC-001', 'passed'], ['AC-002', 'passed']]);
    expect(journal.events.filter((e) => e.type === OrchEvent.GatePassed).map((e) => e.data.service)).toEqual(['orders', 'inventory']);
  });

  it("fails the spec when one service's tests fail", async () => {
    const res = await runPhase4(await setup(makeServicesPlan(spec), { orders: true, inventory: false }), 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('verification failed in round 2: 1 failing tests, 0 uncovered criteria');
  });

  it("plans the delivery fix tasks in the service whose repository misses files, after that service's scaffold", async () => {
    const base = makeServicesPlan(spec);
    const plan = { ...base, services: { ...base.services, inventory: { ...base.services.inventory!, delivery } } };
    const res = await runPhase4(await setup(plan, { orders: true, inventory: true }), 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('inventory: dockerfile: Dockerfile');
    expect(res.fixTasks?.map((t) => [t.id, t.service, t.dependsOn])).toEqual([
      ['T900-fix-1', 'inventory', ['T0-scaffold-inventory']],
      ['T900-fix-2', 'inventory', ['T0-scaffold-inventory']],
    ]);
  });
});
```

Add to `describe('Run with a services plan', ...)` in `test/orchestrator/run-services.test.ts`:

```ts
  it('ends a deploy of a services plan before Phase 5, which only knows one service until R12.4', async () => {
    const run = await Run.create(await deps({ target: {} as RunDeps['target'] }));
    expect(await run.deployOnly()).toBe('deploy-failed');
    expect(run.journal.events.at(-1)!.data.reason).toBe('deploying several services is not built yet (roadmap R12.4)');
    await run.close();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/verify-services.test.ts test/orchestrator/run-services.test.ts`
Expected: FAIL; Phase 4 throws "Phase 4 needs plan, gates and tasks", and `deployOnly` throws "Phase 5 needs plan, target and smoke".

- [ ] **Step 3: Write the implementation**

`server/orchestrator/phases/shared.ts`: import `ServicesPlan` and `ServiceView` (types); add above `PhaseDeps`:

```ts
/** A service's view with what Phase 4 runs it with: its workspace, its gates and whether its repository is new. */
export interface ServiceRepo extends ServiceView {
  ws: Workspace;
  firstSpec: boolean;
  gates: NonNullable<PhaseDeps['gates']>;
}
```

and the last field of `PhaseDeps`:

```ts
  /** A services plan and its repositories; absent means the project repository with `plan` and `gates`. */
  services?: { plan: ServicesPlan; repos: ServiceRepo[] };
```

`server/orchestrator/phases/index.ts`: export `type ServiceRepo` from `./shared.js`.

`server/orchestrator/steps.ts`, `fixTasksPack`: `plan: Pick<Plan, 'tasks' | 'gates'>` and `services?: readonly string[]`, with this line after `OWNER_RULE`:

```ts
    opts.services ? `Each task names its service, one of: ${opts.services.join(', ')}. A task changes only that service's repository.` : '',
```

`server/orchestrator/phases/verify.ts`: import `scaffoldId` and `validateServicesPlan`, and add above `runPhase4`:

```ts
/** Fix tasks join the plan they fix and must keep it valid: one repository's plan, or the whole services plan. */
function fixTaskErrors(deps: PhaseDeps, fixTasks: readonly PlanTask[]): string[] {
  const services = deps.services;
  if (!services) return validatePlan({ ...deps.plan!, tasks: [...deps.plan!.tasks, ...fixTasks] }, deps.spec, { firstSpec: deps.firstSpec });
  const newServices = new Set(services.repos.filter((r) => r.firstSpec).map((r) => r.service!));
  return validateServicesPlan({ ...services.plan, tasks: [...services.plan.tasks, ...fixTasks] }, deps.spec, { services: Object.keys(services.plan.services), newServices });
}
```

In `runPhase4`:

- The guard becomes:

```ts
  const repos: ServiceRepo[] = deps.services?.repos ?? (deps.plan && deps.gates ? [{ service: null, plan: deps.plan, ws: deps.ws, firstSpec: deps.firstSpec, gates: deps.gates }] : []);
  if (repos.length === 0 || !deps.tasks) throw new Error('Phase 4 needs plan, gates and tasks');
```

- The delivery check runs per repository and plans the fix tasks in it:

```ts
  const missing: Array<{ repo: ServiceRepo; items: MissingItem[] }> = [];
  for (const repo of repos) {
    await checkoutMain({ ...deps, ws: repo.ws });
    const items = await missingItems(repo.ws.repo, repo.plan);
    if (items.length > 0) missing.push({ repo, items });
  }
  if (missing.length > 0) {
    const absent = missing.flatMap(({ repo, items }) => items.map((m) => `${repo.service ? `${repo.service}: ` : ''}${m.field}: ${m.target}`));
    const reason = `delivery contract not met on main, missing: ${absent.join(', ')}`;
    await deps.journal.fact(OrchEvent.VerificationFailed, { round, failedTests: [], uncoveredAcs: [], matrix: [], gate: 'delivery', missingDelivery: absent });
    if (round === 2) return { ok: false, reason };
    // Round 1 spends the existing round budget on one automatic fix round; round 2 is the verdict.
    let existing = [...deps.journal.state.tasks.keys()].filter((id) => id.startsWith('T900-fix-')).length;
    const fixTasks = missing.flatMap(({ repo, items }) => {
      const scaffold = scaffoldId(repo.service);
      const tasks = deliveryFixTasks(items, existing, repo.firstSpec && repo.plan.tasks.some((t) => t.id === scaffold) ? [scaffold] : []);
      existing += tasks.length;
      return repo.service ? tasks.map((t) => ({ ...t, service: repo.service! })) : tasks;
    });
    const errors = fixTaskErrors(deps, fixTasks);
    if (errors.length) return { ok: false, reason: `${reason}; fix tasks rejected: ${errors.join('; ')}` };
    await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: fixTasks, round });
    return { ok: false, reason: `${reason}; fix tasks planned`, fixTasks };
  }
```

- The gates run on main of every repository; the results join one evidence matrix:

```ts
  const results: GateResult[] = [];
  let blocking: GateResult | null = null;
  let failing: ServiceRepo | undefined;
  for (const repo of repos) {
    let own: GateResult[] = [];
    let fail: GateResult | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      ({ results: own, blockingFailure: fail } = await repo.gates(repo.ws.repo, 'main'));
      if (!fail || !['infra', 'environment', 'flaky-test'].includes(String(fail.failure)) || attempt === 3) break;
    }
    for (const r of own) await deps.journal.fact(r.passed ? OrchEvent.GatePassed : OrchEvent.GateFailed, { phase: 4, round, gate: r.name, failure: r.failure, junit: r.junit ?? [], ...(repo.service ? { service: repo.service } : {}) });
    results.push(...own);
    if (fail && !blocking) [blocking, failing] = [fail, repo];
  }
```

- The fix-tasks step reads every service's tasks and test gates, runs in the repository that failed, and the fix tasks are checked with `fixTaskErrors`:

```ts
    const services = deps.services;
    const plan = services ? { tasks: services.plan.tasks, gates: repos.flatMap((r) => r.plan.gates) } : deps.plan!;
    const out = await deps.runAgent<'fix-tasks'>({ kind: 'fix-tasks', role: 'sm', pack: fixTasksPack(deps.packBase(), { failedTests, tails: tail(results.map((r) => `${r.name}: ${r.stderrTail || r.stdoutTail}`).join('\n')), uncoveredAcs, plan, ...(services ? { services: Object.keys(services.plan.services) } : {}), boundaries: deps.boundaries ? await deps.boundaries() : [], feedback }), cwd: (failing ?? repos[0]!).ws.repo, phase: 'phase4', taskId: null, attempt }) as StepOutcome<FixTasksOutput>;
```

  with `const errors = fixTaskErrors(deps, fixTasks);` in place of the second `validatePlan` call.

`server/orchestrator/run.ts`:

- Below `NO_GATES`:

```ts
/** A services plan deploys from roadmap R12.4 on; until then its runs end before Phase 5 with this reason. */
const SERVICES_DEPLOY_PENDING = 'deploying several services is not built yet (roadmap R12.4)';
```

- `phaseDeps()`, last entry:

```ts
      ...(this.plan && 'services' in this.plan ? { services: { plan: this.plan, repos: servicePlans(this.plan).map((view) => ({ ...view, ws: this.wsOf(view), firstSpec: this.firstSpecOf(view), gates: this.gatesFor(view) })) } } : {}),
```

- `postPhases()`: inside `if (p4.ok && this.deps.target)`, first `if (!singlePlan(this.plan)) { result = 'deploy-failed'; reason = SERVICES_DEPLOY_PENDING; } else {` around the existing deploy loop.
- `deployOnly()`: right after `this.plan = AnyPlan.parse(...)`, `if (!singlePlan(this.plan)) return this.finish('deploy-failed', SERVICES_DEPLOY_PENDING);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/orchestrator && npx tsc --noEmit`
Expected: PASS; the existing Phase 4 tests (`verify-delivery.test.ts`, `phases.test.ts`) pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases/shared.ts server/orchestrator/phases/index.ts server/orchestrator/phases/verify.ts server/orchestrator/steps.ts server/orchestrator/run.ts test/orchestrator/verify-services.test.ts test/orchestrator/run-services.test.ts
git commit -m "feat(verify): one verdict across every service repository; services wait for R12.4 to deploy"
```

### Task 5: Record R12.2

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R12.2)
- Modify: `docs/superpowers/plans/README.md` (row 61)
- Modify: this plan's status line

- [ ] **Step 1: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, with the test count of before plus the new tests.

- [ ] **Step 2: Mark R12.2 `done` in the roadmap**

What was built, the test files, the whole-suite count, and what stays open: a services run cannot resume correctly until reconciliation works per repository (R12.3), and a services plan from the agent arrives with R12.6.

- [ ] **Step 3: Add row 61 to `plans/README.md`, update this status line and commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-11-teams-ai-61-run-per-service.md
git commit -m "docs(roadmap): R12.2 done, runs go through service views"
```
