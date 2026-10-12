# Plan 60 - Any architecture: one repository per service, one spec across several services

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: slice R12.1 done (2026-10-11): whole suite 1454 passed and 4 skipped (baseline 1438), type check clean; slices R12.2 to R12.7 open. Roadmap stage 12.

**Goal:** teams-ai delivers whatever architecture the five project docs describe: one application in one repository, as today, or a system of services with one repository per service, shared infrastructure such as a NATS broker, and specs that change several services in one run.

**Architecture:** A plan has two shapes: today's single-repository plan, and a services plan whose tasks each name a service and whose `services` map holds today's per-repository settings for each service. `servicePlans()` turns either shape into single-repository views, so the existing pipeline runs once per service without knowing about services, while the task graph, criteria coverage and e2e exemptions stay plan-wide.

**Tech Stack:** TypeScript on Node (ES modules), zod 4, vitest.

**Spec:** this document, sections "Human decisions" and "Design"; roadmap stage 12 in `docs/superpowers/ROADMAP.md`.

## Global Constraints

- A project without `services` in `project.json` behaves exactly as today, and every existing test passes unchanged.
- No technology is fixed in code: stacks, images, brokers and service names come from the docs and the plan.
- Error messages that exist today keep their exact wording, because agents read them as feedback.
- Code follows `QUALITY_RULES` (`server/agents/registry.ts`): one-sentence comments, smallest working solution, no duplicated logic.
- Focused test: `npx vitest run <file>`; whole suite: `npx vitest run`; types: `npx tsc --noEmit`.

## Review Focus

1. A criterion delivered only by another service must not be reported as uncovered (Task 3).
2. A task that depends on a task of another service must be accepted, and a dependency cycle that crosses services must still be reported (Task 3).
3. Two services that publish the same host port must be rejected (Task 3).
4. e2e exemptions must be checked once for the whole plan, never once per service (Task 3).
5. A single-repository task that names a service must be rejected, because the agent's output schema now offers the field (Task 1).

---

## Human decisions (2026-10-11)

- teams-ai is never tied to one technology or one architecture: the five docs (project, briefing, stack, flow, design) decide whether the software is one application or a system of services, which services exist, their stacks and the shared infrastructure.
- Each service has its own repository.
- One spec can change several services: one run plans, builds, verifies and deploys all of them.
- The five docs, specs, plans, reports and decision records live only in the project repository; a service repository holds only that service's code.
- Shared infrastructure (a message broker such as NATS, a shared database) is declared in the docs; teams-ai starts it before the services, and the services reach it by name.

This replaces the rule of R10.3 (plan 49), where the SM always chose one edge service because the pipeline could ship nothing else.

## Where the single-repository assumption lives today

- Plan contract, `server/contracts/plan.ts`: one `deploy`, one `delivery`, one `commands`, one `gateImage`, one `junitPath` and one `lockfilePath`; a `PlanTask` does not say which repository it changes.
- Validation, `server/validators/plan.ts`: `validatePlan` mixes plan-wide checks (task graph, criteria) with per-repository checks (gates, image, port, scaffold, delivery); the scaffold task is the single id `T0-scaffold`.
- Workspace, `server/orchestrator/workspace.ts`: one clone per project at `workspaces/<projectId>/repo`, used for docs and code alike (about 70 uses of `ws.repo` in 15 files).
- Repository creation, `server/orchestrator/phases/bootstrap.ts`: one GitHub repository named after the project.
- Tasks, `server/orchestrator/task-runner.ts` and `server/pipeline/run-state.ts`: one repository, one gate image, one set of frozen paths; the scaffold is recognized by its id.
- Verification, `server/orchestrator/phases/verify.ts`: delivery files and criteria evidence on one main branch.
- Deploy, `server/orchestrator/phases/deploy.ts` and `server/deploy/docker-local.ts`: one compose project `teams-ai-<projectId>`, one host port, one `SERVICE_URL`, gates on the `<compose project>_default` network.
- Publication, `server/deploy/service-links.ts`, `server/orchestrator/phases/report.ts` and `web/src/pages/Validation.tsx`: one service card.
- Agents: `.claude/agents/sm.md:48-50` (the one-service rule), `.claude/agents/devops.md:16-17`, `.claude/agents/test.md:29`, `server/decide/decisions/question-routing.ts:13` and the plan rules in `server/orchestrator/steps.ts:177-228`.
- Shared infrastructure: none; the only container teams-ai manages is the test database, fixed to `postgres:16` (`server/orchestrator/test-database.ts`).

## Design

**Services registry.** `project.json` gets `services`, the names the docs split the system into, written during refinement. Without it the project repository holds the code, exactly as today. With it the project repository holds only the docs, and each service has the repository `<owner>/<projectId>-<service>`.

**Two plan shapes.** `Plan` stays the single-repository plan. `ServicesPlan` holds the spec identity (`specId`, `specHash`, `adrRefs`, `e2eExemptions`), the `tasks` (each names its `service`) and `services`, a map from service name to `ServicePlan`, which is `Plan` without the spec identity and the tasks. `AnyPlan` accepts both shapes. A project with services gets only services plans; a project without gets only single-repository plans.

**Service views.** `servicePlans(plan)` returns one single-repository plan per service: that service's settings, its tasks, and only the dependencies inside the service. Every per-repository step (gates, worktrees, delivery files, workflows, the deploy of one service) runs on a view without knowing about services. The plan-wide parts read the whole plan: the task graph and the scheduler (a dependency may cross services), criteria coverage, e2e exemptions and the union of the criteria evidence.

**Validation.** `validatePlan` is split into plan-wide checks and repository checks. A single-repository plan runs both on itself. `validateServicesPlan` runs the plan-wide checks once, then the service checks (known service, at least one task, distinct ports) and the repository checks on each view, each error prefixed with its service. A service with no repository yet needs its own scaffold task, `T0-scaffold-<service>`.

**Workspace and repositories (R12.2, R12.3).** Each service gets `workspaces/<projectId>/services/<service>/` with its own `repo`, `worktrees` and `graph`; secrets, runs and the knowledge index stay per project. The docs phases (0 publish docs, 1 technical spec, 2 plan, 6 report) use the project repository; the code phases (workflows, 3 tasks, 4 verification, 5 deploy) use each service's workspace. Phase 0 creates and clones a missing service repository.

**Platform and deploy (R12.4).** `project.json` gets `platform`, a list of shared containers (name, pinned image, command, environment, healthcheck) taken from `stack.md`. Before the services, teams-ai renders it into a compose file and runs it as the compose project `teams-ai-<projectId>_platform` on the network `teams-ai-<projectId>_net`. Each touched service deploys as its own compose project `teams-ai-<projectId>--<service>` on that network (a project id never holds `--` or `_`, so no other project can take these names), with its own host port. Smoke and e2e run per service once every service is up; each suite gets `SERVICE_URL` for itself and `SERVICE_URL_<NAME>` for the others, and reaches the platform by name (for example `nats:4222`). A failure rolls back every service the run applied.

**Agents (R12.6).** Refinement writes `services` and `platform` into `project.json` from the docs; the SM writes a services plan when the project has services; devops compose files join the shared network and never declare platform containers; Test writes one e2e suite per service. The one-service rule in `sm.md` is replaced by "the docs decide".

## Slices (roadmap stage 12)

Each slice gets its own detailed plan when the one before it lands. Agent prompts come last on purpose: an agent that writes a services plan before the run can execute one would break live runs.

- **R12.1 Contracts and validation (this plan).** `Project.services`, `PlanTask.service`, `ServicePlan`, `ServicesPlan`, `AnyPlan`, `servicePlans`, `scaffoldId` and `validateServicesPlan`. Nothing at run time changes.
- **R12.2 Runs go through service views (plan 61).** The run reads a plan of either shape from main, runs and merges each task in its service's repository, and Phase 4 gives one verdict across every repository; with one view the journal and the behavior stay identical. Validating a services plan the agent writes comes with R12.6.
- **R12.3 Service repositories (plan 62).** Phase 0 creates or clones each service's repository `<projectId>-<service>`, every new service gets its workflows, and a resumed run reconciles each merge step in its own repository. Per-service workspaces, the scaffold rule and merges per repository came with R12.2.
- **R12.4 Platform and deploy of several services (plan 63).** The platform the docs declare runs on the project's shared network, every service deploys as its own compose project with its own host port, each service's smoke and e2e suites get the other services' addresses, a failure rolls back every applied service, and deleting the project tears everything down.
- **R12.5 Report and screens (plan 64).** The report, the service check, the validation page and the run page show every service, and the project page lists the services with their repositories and the platform.
- **R12.6 Agents (plan 65).** Refinement derives the services and the platform from the docs; Phase 2 asks for a services plan with a scaffold and a host port per service; each task's agent knows its service and its settings; the SM, devops, Test and PO prompts, question routing and the pre-plan delivery contract let the docs decide.
- **R12.7 Live check.** Two services in different stacks plus NATS, and one spec that crosses both, taken to `awaiting-validation`.

## Risks and open points

- Host ports: each deployed service needs one from the range every project shares, 20000 to 20099 (`PUBLISHED_PORTS` in `server/deploy/service-links.ts`), and the port registry keeps one port per project; R12.4 keys it per service.
- A run that merges into one service and then blocks in another leaves the first service changed on main, the same as a blocked task today; merges are never rolled back across repositories.
- Phase 3 gates do not reach the broker: unit tests use adapters, and the e2e suites prove the real broker after deploy.
- `server/orchestrator/test-database.ts` fixes `postgres:16`, against the "no fixed technology" decision; the platform of R12.4 can replace it.

---

## Slice R12.1 tasks

### Task 1: Services registry and services plan contracts

**Files:**
- Modify: `server/contracts/project.ts`
- Modify: `server/contracts/plan.ts`
- Modify: `server/validators/plan.ts` (single-repository guard only)
- Modify: `test/fixtures/contracts.ts`
- Create: `test/contracts/services.test.ts`
- Modify: `test/validators/plan.test.ts`

**Interfaces:**
- Produces: `ServiceName` (zod string, lowercase slug, at most 40 characters) and `Project.services?: string[]` (unique names) in `server/contracts/project.ts`.
- Produces: `PlanTask.service?: string`, `ServicePlan`, `ServicesPlan`, `AnyPlan`, `interface ServiceView { service: string | null; plan: Plan }` and `servicePlans(plan: AnyPlan): ServiceView[]` in `server/contracts/plan.ts`.
- Produces: fixture `makeServicesPlan(spec: Spec, overrides?: Partial<ServicesPlan>): ServicesPlan` with services `orders` (existing repository, port 3000) and `inventory` (new repository, port 3001).

- [ ] **Step 1: Write the failing tests**

`test/contracts/services.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AnyPlan, servicePlans } from '../../server/contracts/plan.js';
import { makeFrozenSpec, makePlan, makeProject, makeServicesPlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();

describe('Project.services', () => {
  it('is optional and holds unique lowercase names', () => {
    expect(makeProject().services).toBeUndefined();
    expect(makeProject({ services: ['orders', 'inventory'] }).services).toEqual(['orders', 'inventory']);
    expect(() => makeProject({ services: ['orders', 'orders'] })).toThrow('service names must be unique');
    expect(() => makeProject({ services: ['Orders'] })).toThrow();
  });
});

describe('ServicesPlan', () => {
  it('needs at least one service', () => {
    expect(() => makeServicesPlan(spec, { services: {} })).toThrow('a services plan needs at least one service');
  });

  it('is told apart from a single-repository plan by AnyPlan', () => {
    expect('services' in AnyPlan.parse(makePlan(spec))).toBe(false);
    const parsed = AnyPlan.parse(makeServicesPlan(spec));
    expect('services' in parsed && Object.keys(parsed.services)).toEqual(['orders', 'inventory']);
  });
});

describe('servicePlans', () => {
  it('gives a single-repository plan as the one view of the project repository', () => {
    const plan = makePlan(spec);
    expect(servicePlans(plan)).toEqual([{ service: null, plan }]);
  });

  it('gives each service its settings, its tasks and only the dependencies inside it', () => {
    const plan = makeServicesPlan(spec);
    const [orders, inventory] = servicePlans(plan);
    expect(orders!.service).toBe('orders');
    expect(orders!.plan.deploy.image).toBe('orders');
    expect(orders!.plan.tasks.map((t) => t.id)).toEqual(['T1-publish-order']);
    expect(inventory!.plan.deploy.port).toBe(3001);
    expect(inventory!.plan.specHash).toBe(plan.specHash);
    expect(inventory!.plan.tasks.find((t) => t.id === 'T2-reserve-stock')!.dependsOn).toEqual(['T0-scaffold-inventory']);
  });
});
```

Add to `test/validators/plan.test.ts`, inside `describe('validatePlan', ...)`:

```ts
  it('rejects a task that names a service in a single-repository plan', () => {
    const base = makePlan(spec);
    const tasks = base.tasks.map((t, i) => (i === 1 ? { ...t, service: 'orders' } : t));
    expect(validatePlan({ ...base, tasks }, spec, { firstSpec: true })).toContain(
      `task ${tasks[1]!.id} names service orders, but this project keeps its code in the project repository; remove service`,
    );
  });
```

Add to `test/fixtures/contracts.ts` (import `ServicePlan` and `ServicesPlan` from `../../server/contracts/plan.js`):

```ts
/** Two services: `orders` already has its repository, `inventory` is new and needs its scaffold. */
export function makeServicesPlan(spec: Spec, overrides: Partial<ServicesPlan> = {}): ServicesPlan {
  const settings = ServicePlan.parse(makePlan(spec));
  const service = (image: string, port: number) => ({ ...settings, deploy: { ...settings.deploy, image, port } });
  return ServicesPlan.parse({
    specId: spec.specId,
    specHash: spec.specHash,
    adrRefs: ['ADR-001'],
    tasks: [
      makePlanTask({ id: 'T1-publish-order', service: 'orders', criteriaRefs: ['AC-001'], affectedPaths: ['src/orders/**'] }),
      makePlanTask({ id: 'T0-scaffold-inventory', service: 'inventory', affectedPaths: ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'src/index.ts'] }),
      makePlanTask({ id: 'T2-reserve-stock', service: 'inventory', criteriaRefs: ['AC-002'], dependsOn: ['T0-scaffold-inventory', 'T1-publish-order'], affectedPaths: ['src/stock/**'] }),
      makePlanTask({ id: 'T3-inventory-deploy', service: 'inventory', dependsOn: ['T0-scaffold-inventory'], affectedPaths: ['Dockerfile', 'deploy/**'], owner: 'devops' }),
    ],
    services: { orders: service('orders', 3000), inventory: service('inventory', 3001) },
    ...overrides,
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/contracts/services.test.ts test/validators/plan.test.ts`
Expected: FAIL; `ServicePlan`, `ServicesPlan`, `AnyPlan` and `servicePlans` are not exported, and the new `validatePlan` test finds no error.

- [ ] **Step 3: Write the implementation**

`server/contracts/project.ts`, above `Project`:

```ts
/** A service of a system split into services; its repository is `<projectId>-<name>`. */
export const ServiceName = z.string().regex(ID_PATTERNS.SLUG).max(40);
```

and as the last field of `Project`:

```ts
  /** The services the docs split the system into, one repository each; absent when the project repository holds the code. */
  services: z.array(ServiceName).refine((names) => new Set(names).size === names.length, { message: 'service names must be unique' }).optional(),
```

`server/contracts/plan.ts`: import `ServiceName` from `./project.js`; add as the last field of `PlanTask`:

```ts
  /** The service whose repository the task changes; only in a services plan. */
  service: ServiceName.optional(),
```

and after `export type Plan`:

```ts
/** One service's settings in a services plan: a single-repository plan without the spec identity and the tasks. */
export const ServicePlan = Plan.omit({ specId: true, specHash: true, adrRefs: true, tasks: true, e2eExemptions: true });
export type ServicePlan = z.infer<typeof ServicePlan>;

/** A plan that changes several services in one run: the spec identity and the task graph are plan-wide, every task names its service. */
export const ServicesPlan = Plan.pick({ specId: true, specHash: true, adrRefs: true, e2eExemptions: true }).extend({
  tasks: z.array(PlanTask).min(1),
  services: z.record(ServiceName, ServicePlan).refine((s) => Object.keys(s).length > 0, { message: 'a services plan needs at least one service' }),
});
export type ServicesPlan = z.infer<typeof ServicesPlan>;

/** Either plan shape; the project decides which one it gets. */
export const AnyPlan = z.union([ServicesPlan, Plan]);
export type AnyPlan = z.infer<typeof AnyPlan>;

/** One repository's share of a plan; `service` is null for the project repository. */
export interface ServiceView {
  service: string | null;
  plan: Plan;
}

/** The single-repository plans the pipeline runs: one per service, with its own tasks and only the dependencies inside it. */
export function servicePlans(plan: AnyPlan): ServiceView[] {
  if (!('services' in plan)) return [{ service: null, plan }];
  const { services, tasks, ...shared } = plan;
  return Object.entries(services).map(([service, settings]) => {
    const own = tasks.filter((t) => t.service === service);
    const ids = new Set(own.map((t) => t.id));
    return { service, plan: { ...shared, ...settings, tasks: own.map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => ids.has(d)) })) } };
  });
}
```

`server/validators/plan.ts`, first lines of `validatePlan`:

```ts
  // `service` belongs to a services plan; a run of this project would never find the repository it names.
  for (const task of plan.tasks) {
    if (task.service !== undefined) errors.push(`task ${task.id} names service ${task.service}, but this project keeps its code in the project repository; remove service`);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/contracts test/validators && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/contracts/project.ts server/contracts/plan.ts server/validators/plan.ts test/fixtures/contracts.ts test/contracts/services.test.ts test/validators/plan.test.ts
git commit -m "feat(plan): services registry and services plan contracts"
```

### Task 2: Split plan validation into plan-wide and repository checks

**Files:**
- Modify: `server/validators/plan.ts` (`validatePlan` and two new private functions)
- Modify: `server/validators/e2e.ts` (`validateE2e` without `spec`, `validateE2eExemptions` exported)
- Modify: `test/validators/plan-e2e.test.ts`

**Interfaces:**
- Consumes: `PlanTask.service` (Task 1).
- Produces: `planWideErrors(plan: Pick<Plan, 'specId' | 'specHash' | 'tasks' | 'e2eExemptions'>, spec: Spec, opts: Pick<PlanCheckOptions, 'requireE2e'>): string[]` and `repositoryErrors(plan: Plan, spec: Spec, opts: PlanCheckOptions, scaffold = SCAFFOLD_TASK_ID): string[]`, both private to `server/validators/plan.ts`; `validateE2e(plan: Plan): string[]` and `validateE2eExemptions(plan: Pick<Plan, 'e2eExemptions'>, spec: Spec): string[]` in `server/validators/e2e.ts`.

The only change of behavior: a plan with no e2e command now also gets its e2e exemptions checked, because exemptions become a plan-wide check.

- [ ] **Step 1: Write the failing test**

Add to `describe('validatePlan e2eExemptions', ...)` in `test/validators/plan-e2e.test.ts`:

```ts
  it('checks the exemptions of a plan that has no e2e command yet', () => {
    const errors = check(plan({ e2e: undefined }, { e2eExemptions: [{ acId: 'AC-009', reason: 'long enough reason' }] }));
    expect(errors).toContain('e2eExemptions: AC-009 is not a criterion of the spec');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/validators/plan-e2e.test.ts`
Expected: FAIL; `validateE2e` returns before the exemptions when the command is missing.

- [ ] **Step 3: Write the implementation**

`server/validators/e2e.ts`: `validateE2e(plan: Plan)` drops the `spec` parameter and its last line `errors.push(...validateE2eExemptions(plan, spec));`; `validateE2eExemptions` becomes `export function validateE2eExemptions(plan: Pick<Plan, 'e2eExemptions'>, spec: Spec): string[]` with its body unchanged.

`server/validators/plan.ts`: `validatePlan` keeps its signature and becomes:

```ts
export function validatePlan(plan: Plan, spec: Spec, opts: PlanCheckOptions): string[] {
  // `service` belongs to a services plan; a run of this project would never find the repository it names.
  const named = plan.tasks.filter((t) => t.service !== undefined).map((t) => `task ${t.id} names service ${t.service}, but this project keeps its code in the project repository; remove service`);
  return [...named, ...planWideErrors(plan, spec, opts), ...repositoryErrors(plan, spec, opts)];
}
```

Move today's checks, with their comments and exact messages, into the two functions:

- `planWideErrors`: spec frozen, `specHash` and `specId`; duplicate task ids; a task depending on itself or on an unknown task; unknown criterion references and the "not covered by any task" loop; the rule that a criterion covered only by devops tasks must be a smoke criterion; the dependency cycle (only without duplicates); and, new, `if (opts.requireE2e) errors.push(...validateE2eExemptions(plan, spec));`.
- `repositoryErrors`: the two `gateImage` checks; `takenPorts`; `gateFileErrors` when `repoFiles` is given; `gateTerminationErrors`; the JUnit path in `affectedPaths`; moving references and tool floors; `commands.smoke` when the spec has smoke criteria; `devopsOwnerErrors(plan.tasks, plan.deploy.manifests)`; the scaffold rules; the required blocking gates and `typecheck`; `validateSecurityGates`, `validateE2e(plan)` and `validateCoverage` behind their options; `delivery` and `lockfilePath`.

Both read the smoke criteria through one helper:

```ts
const smokeCriteria = (spec: Spec): string[] => spec.acceptanceCriteria.filter((ac) => ac.smoke).map((ac) => ac.id);
```

The scaffold rules use the `scaffold` parameter wherever they used `SCAFFOLD_TASK_ID`, and the task variable is renamed `scaffoldTask`:

```ts
  const scaffoldTask = plan.tasks.find((t) => t.id === scaffold);
  if (opts.firstSpec) {
    if (!scaffoldTask) errors.push(`first spec requires task ${scaffold}`);
    else {
      if (scaffoldTask.dependsOn.length > 0) errors.push(`${scaffold} must not depend on other tasks`);
      const byId = new Map(plan.tasks.map((t) => [t.id, t]));
      for (const task of plan.tasks) {
        if (task.id === scaffold) continue;
        if (!reaches(task.id, scaffold, byId)) {
          errors.push(`task ${task.id} must depend on ${scaffold}`);
        }
      }
    }
    if (!plan.tasks.some((t) => t.owner === 'devops')) {
      errors.push('first spec requires a deploy-infrastructure task owned by devops');
    }
  } else if (scaffoldTask) {
    errors.push(`${scaffold} is only allowed on the first spec`);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/validators test/orchestrator && npx tsc --noEmit`
Expected: PASS; every existing `validatePlan` test passes with the same messages.

- [ ] **Step 5: Commit**

```bash
git add server/validators/plan.ts server/validators/e2e.ts test/validators/plan-e2e.test.ts
git commit -m "refactor(plan): split validation into plan-wide and repository checks"
```

### Task 3: Validate a services plan

**Files:**
- Modify: `server/validators/plan.ts`
- Create: `test/validators/plan-services.test.ts`

**Interfaces:**
- Consumes: `ServicesPlan`, `servicePlans` (Task 1); `planWideErrors`, `repositoryErrors` (Task 2); fixture `makeServicesPlan`.
- Produces: `scaffoldId(service: string | null): string`, `interface ServicesPlanCheckOptions` and `validateServicesPlan(plan: ServicesPlan, spec: Spec, opts: ServicesPlanCheckOptions): string[]` in `server/validators/plan.ts`.

- [ ] **Step 1: Write the failing tests**

`test/validators/plan-services.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ServicesPlan } from '../../server/contracts/plan.js';
import { scaffoldId, validateServicesPlan, type ServicesPlanCheckOptions } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlanTask, makeServicesPlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const opts: ServicesPlanCheckOptions = { services: ['orders', 'inventory'], newServices: new Set(['inventory']) };
const check = (plan: ServicesPlan, over: Partial<ServicesPlanCheckOptions> = {}) => validateServicesPlan(plan, spec, { ...opts, ...over });
const withTasks = (edit: (tasks: ServicesPlan['tasks']) => ServicesPlan['tasks']) => {
  const plan = makeServicesPlan(spec);
  return { ...plan, tasks: edit(plan.tasks) };
};

describe('scaffoldId', () => {
  it('keeps T0-scaffold for the project repository and suffixes a service', () => {
    expect(scaffoldId(null)).toBe('T0-scaffold');
    expect(scaffoldId('inventory')).toBe('T0-scaffold-inventory');
  });
});

describe('validateServicesPlan', () => {
  it('accepts criteria each delivered by one service and a dependency across services', () => {
    expect(check(makeServicesPlan(spec))).toEqual([]);
  });

  it('reports a dependency cycle that crosses services', () => {
    const plan = withTasks((tasks) => tasks.map((t) => (t.id === 'T1-publish-order' ? { ...t, dependsOn: ['T2-reserve-stock'] } : t)));
    expect(check(plan).join()).toContain('dependency cycle');
  });

  it('rejects a service the project does not have, a task without a known service and a service without tasks', () => {
    const plan = makeServicesPlan(spec);
    expect(check(plan, { services: ['orders'] })).toContain("service inventory is not one of the project's services (project.json lists orders)");
    const orphan = withTasks((tasks) => [...tasks, makePlanTask({ id: 'T4-ghost', service: 'billing' }), makePlanTask({ id: 'T5-none' })]);
    expect(check(orphan)).toEqual(expect.arrayContaining([
      "task T4-ghost must name one of the plan's services (orders, inventory)",
      "task T5-none must name one of the plan's services (orders, inventory)",
    ]));
    const idle = { ...plan, services: { ...plan.services, billing: plan.services.orders! } };
    expect(check(idle, { services: ['orders', 'inventory', 'billing'] })).toContain('service billing has no task');
  });

  it('rejects two services on the same host port', () => {
    const plan = makeServicesPlan(spec);
    const inventory = { ...plan.services.inventory!, deploy: { ...plan.services.inventory!.deploy, port: 3000 } };
    expect(check({ ...plan, services: { ...plan.services, inventory } })).toContain('services orders and inventory both use deploy.port 3000');
  });

  it('prefixes a repository error with its service', () => {
    const plan = makeServicesPlan(spec);
    const inventory = { ...plan.services.inventory!, gates: plan.services.inventory!.gates.filter((g) => g.name !== 'secret-scan') };
    expect(check({ ...plan, services: { ...plan.services, inventory } })).toEqual(['service inventory: missing blocking gate secret-scan']);
  });

  it('asks each new service for its own scaffold, which every task of that service reaches', () => {
    expect(check(makeServicesPlan(spec), { newServices: new Set(['orders', 'inventory']) })).toEqual(expect.arrayContaining([
      'service orders: first spec requires task T0-scaffold-orders',
      'service orders: first spec requires a deploy-infrastructure task owned by devops',
    ]));
    const loose = withTasks((tasks) => tasks.map((t) => (t.id === 'T2-reserve-stock' ? { ...t, dependsOn: ['T1-publish-order'] } : t)));
    expect(check(loose)).toContain('service inventory: task T2-reserve-stock must depend on T0-scaffold-inventory');
  });

  it('asks for commands.smoke only in the service that delivers a smoke criterion', () => {
    const plan = makeServicesPlan(spec);
    const noSmoke = (name: 'orders' | 'inventory') => ({ ...plan.services[name]!, commands: { ...plan.services[name]!.commands, smoke: undefined } });
    expect(check({ ...plan, services: { ...plan.services, inventory: noSmoke('inventory') } })).toEqual([]);
    expect(check({ ...plan, services: { ...plan.services, orders: noSmoke('orders') } })).toEqual(['service orders: commands.smoke is required: AC-001 is a smoke criterion']);
  });

  it('checks e2e exemptions once for the whole plan', () => {
    const exemptions = [{ acId: 'AC-002', reason: 'long enough reason' }, { acId: 'AC-002', reason: 'long enough reason' }];
    const errors = check({ ...makeServicesPlan(spec), e2eExemptions: exemptions }, { requireE2e: true });
    expect(errors.filter((e) => e.includes('duplicate AC-002'))).toEqual(['e2eExemptions: duplicate AC-002']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/validators/plan-services.test.ts`
Expected: FAIL; `scaffoldId` and `validateServicesPlan` are not exported.

- [ ] **Step 3: Write the implementation**

In `server/validators/plan.ts`, import `servicePlans` and `ServicesPlan` from `../contracts/plan.js`, then add below `SCAFFOLD_TASK_ID`:

```ts
/** The scaffold task of a repository: `T0-scaffold` for the project repository, `T0-scaffold-<service>` for a service's. */
export const scaffoldId = (service: string | null): string => (service === null ? SCAFFOLD_TASK_ID : `${SCAFFOLD_TASK_ID}-${service}`);
```

below `PlanCheckOptions`:

```ts
export interface ServicesPlanCheckOptions extends Omit<PlanCheckOptions, 'firstSpec' | 'repoFiles'> {
  /** The project's services (`project.json`); the plan may name only these. */
  services: readonly string[];
  /** Services with no repository yet: each needs its own scaffold task. */
  newServices: ReadonlySet<string>;
  /** Files tracked on main of each service's repository, by service. */
  repoFiles?: Readonly<Record<string, ReadonlySet<string>>>;
}
```

and below `validatePlan`:

```ts
/** A services plan: plan-wide checks once, then each service's own checks, prefixed with its name. */
export function validateServicesPlan(plan: ServicesPlan, spec: Spec, opts: ServicesPlanCheckOptions): string[] {
  const errors = planWideErrors(plan, spec, opts);
  const names = Object.keys(plan.services);
  for (const task of plan.tasks) {
    if (task.service === undefined || !names.includes(task.service)) errors.push(`task ${task.id} must name one of the plan's services (${names.join(', ')})`);
  }
  const ports = new Map<number, string>();
  for (const { service, plan: view } of servicePlans(plan)) {
    const name = service!;
    if (!opts.services.includes(name)) errors.push(`service ${name} is not one of the project's services (project.json lists ${opts.services.join(', ') || 'none'})`);
    if (view.tasks.length === 0) {
      errors.push(`service ${name} has no task`);
      continue;
    }
    const other = ports.get(view.deploy.port);
    if (other !== undefined) errors.push(`services ${other} and ${name} both use deploy.port ${view.deploy.port}`);
    ports.set(view.deploy.port, name);
    // A service answers only for the criteria its own tasks deliver (a smoke criterion asks for its commands.smoke).
    const delivered = new Set(view.tasks.flatMap((t) => t.criteriaRefs));
    const share = { ...spec, acceptanceCriteria: spec.acceptanceCriteria.filter((ac) => delivered.has(ac.id)) };
    const own = { ...opts, firstSpec: opts.newServices.has(name), repoFiles: opts.repoFiles?.[name] };
    errors.push(...repositoryErrors(view, share, own, scaffoldId(name)).map((e) => `service ${name}: ${e}`));
  }
  return errors;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/validators test/contracts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/validators/plan.ts test/validators/plan-services.test.ts
git commit -m "feat(plan): validate a plan that changes several services"
```

### Task 4: Record stage 12 in the roadmap

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (new "Stage 12" section before "System 1 decisions")
- Modify: `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (status line)

- [ ] **Step 1: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, with the test count of the baseline plus the new tests.

- [ ] **Step 2: Add stage 12 to the roadmap**

One paragraph with the human decisions and a link to this plan, then one item per slice (R12.1 to R12.7) in the roadmap's usual form: R12.1 `done` with what was built, the others `todo` with one line each, and a note on R10.3 that its one-service rule is replaced in R12.6.

- [ ] **Step 3: Update the status line of this plan and commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/2026-10-11-teams-ai-60-services.md
git commit -m "docs(roadmap): stage 12, any architecture with one repository per service"
```
