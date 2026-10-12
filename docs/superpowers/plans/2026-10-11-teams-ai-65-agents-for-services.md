# Plan 65 - The agents plan and build a project of services (roadmap R12.6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: done, 2026-10-11: whole suite 1526 passed and 4 skipped, web 175 passed, both type checks clean. Roadmap item R12.6, stage 12 (plan 60).

**Goal:** The agents take a project of services from its docs to a services plan and its code: refinement writes `services` and `platform` into `project.json` from the docs, Phase 2 asks the SM for a services plan with a scaffold per new service and a host port per service, every task's agent knows its service and the settings of that service, and the prompts state that the docs decide between one application and several services.

**Architecture:** A new step kind `services-plan` carries the services plan schema, since the `plan` step's JSON schema is the single-repository plan. Phase 2 branches on `project.services`: it reads each service repository (its files, and whether its main holds code yet), assigns one registry port per service (`portKey`), asks for a `services-plan` and validates it with `validateServicesPlan`. The pack of every task names its service, and a service task's pack carries that service's settings, because the service repository holds no docs. Prompts and refinement texts drop the one-service rule of R10.3.

**Tech Stack:** TypeScript on Node (ES modules), zod 4, vitest; agent prompts in `.claude/agents/*.md`.

**Spec:** `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (sections "Design" > "Agents (R12.6)" and "Slices", item R12.6).

## Global Constraints

- A project without `services` plans and builds exactly as today: same step kind `plan`, same pack text, same validation; every existing test passes unchanged, except tests that pin the R10.3 sentences this plan replaces.
- The docs decide: an agent never splits a system the docs describe as one application, and never merges services the docs name; when the docs are ambiguous it asks in refinement.
- No technology is fixed: platform images, commands and healthchecks come from `stack.md` through `project.json`.
- Prompts and packs are English (the agents answer in Brazilian Portuguese by their own rule); comments and docs follow `QUALITY_RULES` (`server/agents/registry.ts`).
- Focused test: `npx vitest run <file>`; whole suite: `npx vitest run`; types: `npx tsc --noEmit`; web: `cd web && npx vitest run` and `npx tsc --noEmit -p .`.
- Out of scope: a live run (R12.7); labelling each gate's output with its service in the fix-tasks pack (needs the repository carried with every gate result).

## Review Focus

1. Two services of one project get two different ports, and the port check of the plan does not reject a service's own assigned port (Task 2).
2. A service whose repository holds only the empty first commit or only `.github` counts as new and needs `T0-scaffold-<service>`; a service with code on main must not get one (Task 2).
3. A single-repository project still calls the `plan` step with the old pack, and its plan alternatives are still ranked (Task 2).
4. A service task's agent learns its service's `delivery`, `deploy`, `commands` and `junitPath` from the pack, never from a `docs/specs` path its repository lacks (Task 3).
5. A refinement that changes only `stack.md` (where the platform lives) keeps the newly derived `platform` (Task 5).

## Where the code stands

- `server/agents/outputs.ts`: `OUTPUT_SCHEMAS.plan = PlanOutput`, the single-repository plan with named task ids and `alternatives`.
- `server/orchestrator/phases/plan.ts`: one `git ls-files`, one `assignDeployPort(projectId)`, `validatePlan` only.
- `server/orchestrator/steps.ts`: `planRules` and `planPack` know one service; `devPack` carries no plan settings; `fixTasksPack` lists tasks without their service.
- `server/knowledge/context-pack.ts`: the task section prints owner, dependsOn, affectedPaths and criteria.
- `.claude/agents/sm.md` "Service and bounded-context decomposition": one repository, one compose service, one `SERVICE_URL` per spec (R10.3); `devops.md`: one compose service named like the project id; `test.md`: one suite over `SERVICE_URL`; `po.md`: derive says nothing of services or platform.
- `server/refine/draft.ts` `keepBaseProject`: `project.json` changes only when `project.md` changed; `server/refine/backlog.ts`, `server/refine/detail-packs.ts`, `server/decide/decisions/question-routing.ts`: "one service per spec", "one compose stack serves the whole program".

---

### Task 1: The `services-plan` step

**Files:**
- Modify: `server/agents/outputs.ts` (`ServicesPlanOutput`, `STEP_KINDS`, `OUTPUT_SCHEMAS`)
- Modify: `server/runner/invocation.ts` (`SHORT_CACHE_KINDS`)
- Modify: `web/src/run/selectors.ts` (`STEP_DOING`)
- Modify: `test/agents/outputs.test.ts`

**Interfaces:**
- Produces: step kind `'services-plan'` whose output is `ServicesPlanOutput`: a `ServicesPlan` whose tasks carry a named id (`T<n>-<slug>`, so `T0-scaffold-inventory` passes) and a required `service`; no `alternatives`.

- [ ] **Step 1: Write the failing test**

`test/agents/outputs.test.ts` (import `ServicesPlanOutput`, and `makeServicesPlan`, `makeFrozenSpec` from the fixtures if not imported):

```ts
describe('ServicesPlanOutput', () => {
  it('is the services-plan step schema: every task names its service and a readable id', () => {
    const plan = makeServicesPlan(makeFrozenSpec());
    expect(OUTPUT_SCHEMAS['services-plan']).toBe(ServicesPlanOutput);
    expect(ServicesPlanOutput.parse(plan).tasks.map((t) => t.service)).toEqual(plan.tasks.map((t) => t.service));
    const { service: _, ...loose } = plan.tasks[0]!;
    expect(ServicesPlanOutput.safeParse({ ...plan, tasks: [loose, ...plan.tasks.slice(1)] }).success).toBe(false);
    expect(ServicesPlanOutput.safeParse({ ...plan, tasks: [{ ...plan.tasks[0]!, id: 'T1' }, ...plan.tasks.slice(1)] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/agents/outputs.test.ts`
Expected: FAIL; `ServicesPlanOutput` is not exported.

- [ ] **Step 3: Write the implementation**

`server/agents/outputs.ts`: add `'services-plan'` to `STEP_KINDS` right after `'plan'`; import `ServicesPlan` and `ServiceName` (`ServiceName` from `../contracts/project.js`); below `PlanOutput`:

```ts
/** R12.6: a project split into services gets a services plan; every task names its service. No alternatives: the ranking reads one stack. */
export const ServicesPlanOutput = ServicesPlan.extend({ tasks: z.array(PlanTask.extend({ id: z.string().regex(NAMED_TASK_ID), service: ServiceName })).min(1) });
```

and `'services-plan': ServicesPlanOutput,` in `OUTPUT_SCHEMAS` after `plan`. `server/runner/invocation.ts`: add `'services-plan'` to `SHORT_CACHE_KINDS` beside `'plan'`. `web/src/run/selectors.ts`: `'services-plan': 'montando o plano de tarefas dos serviços',` in `STEP_DOING` after `plan`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/agents test/runner && npx tsc --noEmit`, then `cd web && npx tsc --noEmit -p .`
Expected: PASS; the test that maps every kind to a schema passes with the new kind.

- [ ] **Step 5: Commit**

```bash
git add server/agents/outputs.ts server/runner/invocation.ts web/src/run/selectors.ts test/agents/outputs.test.ts
git commit -m "feat(agents): a services-plan step whose tasks each name their service"
```

### Task 2: Phase 2 plans a project of services

**Files:**
- Modify: `server/orchestrator/first-spec.ts` (`holdsOnlyDocs`)
- Modify: `server/orchestrator/steps.ts` (`planRules`, `servicesPlanRules`, `planPack`)
- Modify: `server/orchestrator/phases/plan.ts`
- Modify: `test/orchestrator/phases.test.ts`, `test/orchestrator/steps.test.ts`

**Interfaces:**
- Consumes: `ServicesPlanOutput` and the `services-plan` kind (Task 1); `portKey` (`server/deploy/port-registry.ts`); `serviceWorkspace` (`server/orchestrator/workspace.ts`); `validateServicesPlan`.
- Produces: `holdsOnlyDocs(repo: string, exec: Exec): Promise<boolean>`; `servicesPlanRules(opts: ServicesPack): string`; `planPack(..., { services?: ServicesPack })` with `interface ServicesPack { names: readonly string[]; newServices: ReadonlySet<string>; ports: Readonly<Record<string, number | null>>; platform: readonly PlatformService[] }`; `planRules(firstSpec: boolean | 'services', ...)`.

- [ ] **Step 1: Write the failing tests**

`test/orchestrator/steps.test.ts`:

```ts
describe('servicesPlanRules', () => {
  it('states the services plan shape, a scaffold per new service, a port per service and the platform', () => {
    const text = servicesPlanRules({ names: ['orders', 'inventory'], newServices: new Set(['inventory']), ports: { orders: 20011, inventory: 20012 }, platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] });
    expect(text).toContain('one repository each: orders, inventory');
    expect(text).toContain('new services (their main holds no code yet): inventory');
    expect(text).toContain('T0-scaffold-<service>');
    expect(text).toContain('existing services: orders');
    expect(text).toContain('services.inventory.deploy.port is exactly 20012');
    expect(text).toContain('SERVICE_URL_<SERVICE>');
    expect(text).toContain('nats (nats:2.10.22-alpine)');
    expect(planRules('services')).not.toContain('first spec of the project');
  });
});
```

`test/orchestrator/phases.test.ts`, inside `describe('Phase 2', ...)` (import `makeServicesPlan`, `servicePlans` is not needed; import `serviceWorkspace` from `../../server/orchestrator/workspace.js`):

```ts
  it('asks a project of services for a services plan with a scaffold per new service and a port per service', async () => {
    const services = ['orders', 'inventory'];
    const shop = makeProject({ projectId: 'shop', services, platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] });
    const ws = deps(async () => ok(null)).ws;
    // orders already has code on main; inventory holds only the empty first commit Phase 0 made.
    for (const [service, files] of [['orders', { 'src/index.ts': 'x' }], ['inventory', {}]] as const) {
      const origin = await makeRemote(files);
      const repo = serviceWorkspace(ws, service).repo;
      await fs.mkdir(path.dirname(repo), { recursive: true });
      await git(path.dirname(repo), ['clone', '-q', origin.origin, path.basename(repo)]);
    }
    const plan = makeServicesPlan(spec);
    const root = path.join(remote.root, 'workspaces');
    const r = await runPhase2({ ...deps(async () => ok(plan)), project: shop, workspacesRoot: root }, '# Tech spec');
    expect(r.ok).toBe(true);
    expect(calls[0]!.kind).toBe('services-plan');
    expect(calls[0]!.pack.feedback).toContain('new services (their main holds no code yet): inventory');
    const ports = JSON.parse(await fs.readFile(path.join(root, '.ports.json'), 'utf8')) as Record<string, number>;
    expect(Object.keys(ports).sort()).toEqual(['shop/inventory', 'shop/orders']);
    expect(ports['shop/orders']).not.toBe(ports['shop/inventory']);
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(Object.keys(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/plan.json'])).services)).toEqual(['orders', 'inventory']);
  });

  it('feeds a services plan error back: a new service without its scaffold', async () => {
    const shop = makeProject({ projectId: 'shop', services: ['orders', 'inventory'] });
    const plan = makeServicesPlan(spec);
    const noScaffold = { ...plan, tasks: plan.tasks.filter((t) => t.id !== 'T0-scaffold-inventory').map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== 'T0-scaffold-inventory') })) };
    const r = await runPhase2({ ...deps(async () => ok(noScaffold)), project: shop }, '# Tech spec');
    expect(r.ok).toBe(false);
    expect(calls[1]!.pack.feedback).toContain('service inventory');
  });
```

(`makeRemote({})` must accept an empty file map and give an origin whose main has one commit; if it needs a file, use `{ '.github/workflows/ci.yml': 'name: ci\n' }`, which counts as docs-only too.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/steps.test.ts test/orchestrator/phases.test.ts`
Expected: FAIL; `servicesPlanRules` is not exported and Phase 2 calls `plan`.

- [ ] **Step 3: Write the implementation**

`server/orchestrator/first-spec.ts`:

```ts
/** Does origin/main hold nothing but docs and workflows: a project, or a service, before its first code? */
export async function holdsOnlyDocs(repo: string, exec: Exec): Promise<boolean> {
  if (!(await fs.access(path.join(repo, '.git')).then(() => true, () => false))) return true;
  await gitFetch(repo, exec).catch(() => undefined);
  const top = await git(repo, ['ls-tree', '--name-only', 'origin/main'], exec).catch(() => null);
  if (top === null) return true;
  return top.split('\n').filter((f) => f !== '').every((f) => DOCS_ONLY.has(f));
}
```

and `isFirstSpec` becomes `return opts.specDirs.length === 1 || holdsOnlyDocs(opts.repo, opts.exec);` (its doc comment stays).

`server/orchestrator/steps.ts`: import `type PlatformService` from `../contracts/project.js`; `planRules(firstSpec: boolean | 'services', ...)` keeps its scaffold block under `if (firstSpec === true)` / `else if (firstSpec === false)` (a services plan states its scaffolds in `servicesPlanRules`); add:

```ts
export interface ServicesPack { names: readonly string[]; newServices: ReadonlySet<string>; ports: Readonly<Record<string, number | null>>; platform: readonly PlatformService[] }

/** What a services plan adds to the plan rules (R12.6): one repository and one port per service, a scaffold per new service. */
export function servicesPlanRules(opts: ServicesPack): string {
  const fresh = opts.names.filter((s) => opts.newServices.has(s));
  const existing = opts.names.filter((s) => !opts.newServices.has(s));
  return [
    `Services plan (project.json splits the system into services, one repository each: ${opts.names.join(', ')}):`,
    '- return specId, specHash, adrRefs and e2eExemptions at the top, `tasks` with each task naming its `service`, and `services`: a map from each service this spec changes to its settings (stack, commands, gateImage, junitPath, gates, frozenPaths, deploy, delivery, lockfilePath and the coverage fields), which follow every plan rule above as services.<name>.<field>; list only the services this spec changes, each with at least one task',
    "- a task changes only its own service's repository; dependsOn may name a task of another service; a service's smoke and e2e suites prove only the criteria its own tasks reference",
    fresh.length > 0 ? `- new services (their main holds no code yet): ${fresh.join(', ')}. Each gets a task with id T0-scaffold-<service> (owner dev, no dependsOn) that creates its skeleton, build, test and gate configuration, every other task of that service depends on it, and one deploy-infrastructure task owned by devops (Dockerfile, docker-compose.yml)` : '',
    existing.length > 0 ? `- existing services: ${existing.join(', ')}. Their code is on main: never give them a scaffold task` : '',
    ...opts.names.flatMap((s) => (opts.ports[s] ? [`- services.${s}.deploy.port is exactly ${opts.ports[s]}: the orchestrator assigned it so no two services share a host port; the service listens on PORT=${opts.ports[s]} and its docker-compose publishes "${opts.ports[s]}:${opts.ports[s]}"`] : [])),
    "- each service runs in its own compose project; teams-ai joins its main container (the compose service named exactly like the service) to the project's shared network under the service's name, so services call each other at http://<service>:<port>; a suite reads its own address from SERVICE_URL and each other service's from SERVICE_URL_<SERVICE> (upper case, dashes as underscores)",
    opts.platform.length > 0 ? `- platform containers teams-ai starts before the services, from project.json: ${opts.platform.map((p) => `${p.name} (${p.image})`).join(', ')}. Never plan, build or declare them in a compose file; services reach them by name on the shared network` : '- the project declares no platform containers',
    '- the services deploy in the order of the services map, each one healthy before the next: put first a service another one calls while it starts',
  ].filter((l) => l !== '').join('\n');
}
```

`planPack` opts gain `services?: ServicesPack`; its first part becomes `planRules(opts.services ? 'services' : opts.firstSpec ?? false, ...)`, followed by `opts.services ? servicesPlanRules(opts.services) : ''`; the single `deployPort` line stays for a single plan only (`!opts.services && opts.deployPort`); and it returns `...common(base, opts.services ? 'services-plan' : 'plan', 'sm')`.

`server/orchestrator/phases/plan.ts` (imports: `portKey` from `../../deploy/port-registry.js`, `holdsOnlyDocs` from `../first-spec.js`, `serviceWorkspace` from `../workspace.js`, `validateServicesPlan` and `type ServicesPlanCheckOptions` from `../../validators/plan.js`, `type ServicesPlan` from `../../contracts/plan.js`):

```ts
/** R12.6: what Phase 2 knows of each service: its files, whether its main holds code yet, and its host port. */
async function servicesContext(deps: PhaseDeps, names: readonly string[]) {
  const repoFiles: Record<string, Set<string>> = {};
  const newServices = new Set<string>();
  const ports: Record<string, number | null> = {};
  let takenPorts: number[] | null = null;
  for (const s of names) {
    const repo = serviceWorkspace(deps.ws, s).repo;
    if (await holdsOnlyDocs(repo, deps.exec)) newServices.add(s);
    repoFiles[s] = new Set((await git(repo, ['ls-tree', '-r', '--name-only', 'origin/main'], deps.exec).catch(() => '')).split('\n').filter((f) => f !== ''));
    const assigned = deps.workspacesRoot ? await assignDeployPort(deps.workspacesRoot, portKey(deps.ws.projectId, s), deps.exec) : { port: null, taken: [] };
    ports[s] = assigned.port;
    // Each list counts the sibling services' ports as taken; only a port every list holds belongs to someone else.
    takenPorts = takenPorts === null ? assigned.taken : takenPorts.filter((p) => assigned.taken.includes(p));
  }
  return { repoFiles, newServices, ports, takenPorts: takenPorts ?? [] };
}
```

In `runPhase2`, after the worktree: `const names = deps.project.services ?? []; const services = names.length > 0 ? await servicesContext(deps, names) : null;`. Compute the single `repoFiles` and `ports` only when `services` is null. In the attempt loop, when `services` is set, run:

```ts
      const check: ServicesPlanCheckOptions = { services: names, newServices: services.newServices, repoFiles: services.repoFiles, takenPorts: services.takenPorts, requireDelivery: deps.requireDelivery, requireSecurityTooling: deps.requireSecurityTooling, requireE2e: deps.requireE2e, requireCoverage: deps.requireCoverage };
      const out = await deps.runAgent<'services-plan'>({
        kind: 'services-plan',
        role: 'sm',
        pack: planPack(deps.packBase(), { techSpecText, preplan, godNodes: [], feedback, requireDelivery: deps.requireDelivery, requireSecurityTooling: deps.requireSecurityTooling, requireE2e: deps.requireE2e, requireCoverage: deps.requireCoverage, services: { names, newServices: services.newServices, ports: services.ports, platform: deps.project.platform ?? [] } }),
        cwd: worktree, phase: 'phase2', taskId: null, attempt,
        semantic: [((p: ServicesPlan) => validateServicesPlan(p, deps.spec, check)) as never],
      });
```

with the same quota, auth and feedback handling as the `plan` call, and on success `plan = out.value` (a services plan has no alternatives). The write, merge, pre-plan deviation and `journalTasks` code after the loop body takes the plan of either shape (`let plan: AnyPlan`). The `plan` branch keeps its code unchanged.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/orchestrator/steps.test.ts test/orchestrator/phases.test.ts test/orchestrator/first-spec.test.ts && npx tsc --noEmit`
Expected: PASS; the single-repository Phase 2 tests pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/first-spec.ts server/orchestrator/steps.ts server/orchestrator/phases/plan.ts test/orchestrator/phases.test.ts test/orchestrator/steps.test.ts
git commit -m "feat(plan): Phase 2 asks a project of services for a services plan, one port and one scaffold per service"
```

### Task 3: Every task's pack names its service and carries its settings

**Files:**
- Modify: `server/knowledge/context-pack.ts` (task section)
- Modify: `server/orchestrator/steps.ts` (`devPack`, `fixTasksPack`)
- Modify: `server/orchestrator/task-runner.ts` (`devPack` call)
- Modify: `test/orchestrator/steps.test.ts`, `test/knowledge/context-pack.test.ts`

**Interfaces:**
- Produces: `devPack(base, task, { ..., service?: { name: string; plan: Plan } }, role)`.

- [ ] **Step 1: Write the failing tests**

`test/knowledge/context-pack.test.ts`: a pack whose task has `service: 'orders'` renders `- service: orders` in the task section, and a task without one renders no service line.

`test/orchestrator/steps.test.ts`:

```ts
  it("gives a service task its service's settings, since its repository holds no docs", () => {
    const view = servicePlans(makeServicesPlan(spec)).find((v) => v.service === 'inventory')!;
    const task = view.plan.tasks[0]!;
    const pack = devPack(base, task, { code: { files: [], graph: [] } as never, handoffs: [], feedback: null, service: { name: 'inventory', plan: view.plan } });
    const rule = pack.principles!.find((p) => p.startsWith('This task changes the service inventory'))!;
    expect(rule).toContain(`"port":${view.plan.deploy.port}`);
    expect(rule).not.toContain('"tasks"');
    expect(devPack(base, task, { code: { files: [], graph: [] } as never, handoffs: [], feedback: null }).principles!.some((p) => p.startsWith('This task changes the service'))).toBe(false);
  });
```

(`base` is the pack base the file already builds; reuse its name.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/knowledge/context-pack.test.ts test/orchestrator/steps.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`server/knowledge/context-pack.ts`, the task section adds `${t.service ? `\n- service: ${t.service}` : ''}` right after the owner line.

`server/orchestrator/steps.ts`:

```ts
/** A service task works in a repository without docs: the settings its rules call plan.* come with the pack. */
const serviceRule = (name: string, plan: Plan, platform: readonly PlatformService[]) => {
  const { tasks: _tasks, ...settings } = plan;
  return `This task changes the service ${name}: its repository holds only that service's code, so every plan setting your rules name (plan.delivery, plan.deploy, plan.commands, plan.junitPath, plan.e2eExemptions) is this one, never a docs/specs file: ${JSON.stringify(settings)}. Other services answer at http://<service>:<port> on the project's shared network${platform.length > 0 ? `, and the platform containers by name (${platform.map((p) => p.name).join(', ')})` : ''}.`;
};
```

`devPack` opts gain `service?: { name: string; plan: Plan }`, and its principles append `serviceRule(opts.service.name, opts.service.plan, base.project.platform ?? [])` when set. `fixTasksPack` lists each existing task as `- ${t.id}${t.service ? ` (${t.service})` : ''}: ${t.title} [...]`.

`server/orchestrator/task-runner.ts`, the `devPack` call adds `...(task.def.service ? { service: { name: task.def.service, plan: this.deps.plan } } : {})` to its opts.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/knowledge test/orchestrator && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/knowledge/context-pack.ts server/orchestrator/steps.ts server/orchestrator/task-runner.ts test/orchestrator/steps.test.ts test/knowledge/context-pack.test.ts
git commit -m "feat(agents): each task's pack names its service and carries that service's settings"
```

### Task 4: The prompts let the docs decide

**Files:**
- Modify: `.claude/agents/sm.md`, `.claude/agents/devops.md`, `.claude/agents/test.md`, `.claude/agents/po.md`
- Modify: `server/orchestrator/steps.ts` (`SMOKE_CONTRACT`, `E2E_CONTRACT`, `e2eSuiteRules`)
- Modify: `test/agents/prompts.test.ts` (create it if no test reads the agent files) and the tests that pin the changed sentences

- [ ] **Step 1: Write the failing test**

A test that reads the four agent files and expects: `sm.md` holds "The docs decide" and "services-plan" and no longer holds "teams-ai has no multi-repo or multi-service delivery mechanism today" nor "one edge service"; `devops.md` holds "named exactly like the service" and "never declare the platform containers"; `test.md` holds "SERVICE_URL_<SERVICE>"; `po.md` holds "`services`" and "`platform`"; and `E2E_CONTRACT` holds "SERVICE_URL_<SERVICE>".

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL on every file.

- [ ] **Step 3: Write the text**

`.claude/agents/sm.md`:
- Under `## Planning (`plan` step)`, a new subsection `### A services plan (`services-plan` step)`: "When `project.json` lists `services`, the pack asks for a services plan: `specId`, `specHash`, `adrRefs` and `e2eExemptions` at the top; `tasks`, each naming its `service`; and `services`, the settings of each service this spec changes, each filled like a single plan (`delivery`, `deploy`, `commands`, gates, `lockfilePath`). A task changes only its service's repository and may depend on a task of another service. A new service gets `T0-scaffold-<service>` and one devops deploy-infrastructure task; an existing one gets neither. Each service has its own e2e suite at its `delivery.e2eSuite`, proving only the criteria its tasks reference, with `SERVICE_URL` for itself and `SERVICE_URL_<SERVICE>` for the others. The platform containers in `project.json` are started by teams-ai: never plan them. No `alternatives`."
- The replan paragraph adds: "A replacement stays in the task's service."
- `### Service and bounded-context decomposition` becomes: "The docs decide. When `project.json` lists `services`, the docs split the system into those services, one repository each, and the plan is a services plan; without `services` the system is one application in the project repository, with its bounded contexts as internal modules (hexagonal/ports-and-adapters). Never split what the docs describe as one application, never merge services they name, and never decide a split the docs leave open: ask it in refinement as a question for the human." (the two bullets about the default edge service and the delivery limitation are removed).
- The pre-plan bullets: "the parts of the one service the spec ships" becomes "the parts of the services the spec changes (the one application when the project has no services)", and "The FIRST spec also carries the walking skeleton" adds "(for a project of services, each new service's skeleton)".

`.claude/agents/devops.md`, the compose rule gets: "In a services plan the compose file is the service's own: its main service is named exactly like the service (not the project id), it reads its settings (`plan.delivery`, `plan.deploy`) from the service settings in your pack, never declare the platform containers `project.json` lists (reach them by name, for example `nats:4222`), and a datastore only this service uses stays in this file on its private network. Still no custom `networks:`: teams-ai joins the main container to the project's shared network."

`.claude/agents/test.md`, the e2e paragraph adds: "In a services plan each service has its own suite at its `delivery.e2eSuite`, covering only the criteria its own tasks reference; it reads its service's address from `SERVICE_URL`, each other service's from `SERVICE_URL_<SERVICE>` (upper case, dashes as underscores), and reaches the platform containers by name."

`.claude/agents/po.md`, the derive rule adds: "`project.services` lists the services the docs split the system into, one repository each; leave it out when the docs describe one application. `project.platform` lists the shared containers `stack.md` declares for every service (a message broker, a shared database), each with an image pinned to a version (never `latest`) and the command, environment and healthcheck `stack.md` gives. Invent neither."

`server/orchestrator/steps.ts`: `SMOKE_CONTRACT` and `E2E_CONTRACT` end with "; in a services plan each service's suite also reads SERVICE_URL_<SERVICE> for every other service (upper case, dashes as underscores) and reaches the platform containers by name", and `e2eSuiteRules` adds the same sentence.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/agents test/orchestrator test/validators && npx tsc --noEmit`
Expected: PASS; update every test that pinned the removed sentences.

- [ ] **Step 5: Commit**

```bash
git add .claude/agents/sm.md .claude/agents/devops.md .claude/agents/test.md .claude/agents/po.md server/orchestrator/steps.ts test/agents
git commit -m "feat(agents): the docs decide between one application and several services"
```

### Task 5: Refinement writes the services and the platform

**Files:**
- Modify: `server/refine/derive.ts` (rule text)
- Modify: `server/refine/draft.ts` (`keepBaseProject`)
- Modify: `server/refine/backlog.ts`, `server/refine/detail-packs.ts` (rule text)
- Modify: `server/decide/decisions/question-routing.ts` (`QUESTION_ROUTES.auto`)
- Modify: `test/refine/draft.test.ts`, `test/refine/detail-packs.test.ts` and the derive and backlog pack tests

- [ ] **Step 1: Write the failing tests**

`test/refine/draft.test.ts`, beside the `keepBaseProject` tests: an existing project whose `stack.md` changed and whose `project.md` did not keeps the newly derived `project.json` (for example a new `platform`); one where neither changed keeps the base. The derive pack test expects the rule "`services`: the services the docs split the system into"; the detail-packs test expects the new delivery-contract sentence and no "one compose stack serves the whole program".

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`server/refine/derive.ts`, the first feedback line adds: "In project.json, `services` lists the services the docs split the system into (one repository each) and stays out when they describe one application; `platform` lists the shared containers stack.md declares for every service, each with an image pinned to a version (never latest) and the command, environment and healthcheck stack.md gives. Invent neither."

`server/refine/draft.ts`:

```ts
/** In an existing project, project.json changes only when project.md or stack.md (where the platform lives) changed. */
export async function keepBaseProject(d: Draft, derived: Project): Promise<Project> {
  const [baseJson, baseMd, baseStack] = await Promise.all([readBase(d, 'project.json'), readBase(d, 'project.md'), readBase(d, 'stack.md')]);
  if (baseJson === null || baseMd === null) return derived;
  const [md, stack] = await Promise.all([fs.readFile(d.projectMd, 'utf8'), fs.readFile(d.stackMd, 'utf8').catch(() => null)]);
  return md === baseMd && stack === baseStack ? Project.parse(JSON.parse(baseJson)) : derived;
}
```

`server/refine/backlog.ts`: "(the delivery contract ships one service per spec, with bounded contexts as internal modules)" becomes "(one application with bounded contexts as internal modules, or the services the docs name, each in its own repository; a spec may change several of them)", and the last rule becomes "Also return `project`: the project.json derived from project.md and stack.md, exactly as in a normal derivation (with `services` and `platform` when the docs give them)."

`server/refine/detail-packs.ts`: the modules bullet reads "the parts of the services this spec changes (the one application when the project has no services) that the tasks touch"; the delivery-contract bullet reads "Delivery contract (teams-ai, fixed, not a choice to ask about): the application, or each service the project lists, is its own compose stack that is not torn down or recreated between specs, so a datastore a spec already added is still running and reachable by its compose service name; the platform containers project.json lists run on the project's shared network, reachable by name - plan to reuse them, never a task to stand them up again or to reset their data."

`server/decide/decisions/question-routing.ts`, `auto`: "teams-ai's own fixed delivery contract (one repository per service the docs declare, or the project repository when they declare none; each its own compose stack on the project's shared network; the platform containers from the docs; one e2e suite per service) or the documents already attached already answer this, without any product or technical judgement call."

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/refine test/decide && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/refine/derive.ts server/refine/draft.ts server/refine/backlog.ts server/refine/detail-packs.ts server/decide/decisions/question-routing.ts test/refine test/decide
git commit -m "feat(refine): refinement writes the services and the platform from the docs"
```

### Task 6: Record R12.6

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R12.6 `done`, R10.3 note), `docs/superpowers/plans/README.md` (row 65), `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (R12.6 slice), this plan's status line

- [ ] **Step 1: Run every suite and both type checks**

Run: `npx vitest run && npx tsc --noEmit`, then `cd web && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 2: Mark R12.6 `done`, add row 65, update the slice in plan 60 and this status line, and commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-11-teams-ai-60-services.md docs/superpowers/plans/2026-10-11-teams-ai-65-agents-for-services.md
git commit -m "docs(roadmap): R12.6 done, the agents plan and build a project of services"
```
