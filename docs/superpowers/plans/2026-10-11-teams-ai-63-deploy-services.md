# Plan 63 - Platform and deploy of several services (roadmap R12.4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: done, 2026-10-11: whole suite 1491 passed and 4 skipped, type check clean. Roadmap item R12.4, stage 12 (plan 60).

**Goal:** A services run deploys the shared platform the docs declare (a NATS broker, a shared database) and then every service of the plan, each in its own compose project on the project's shared network, proves each service with its smoke and e2e suites while they can reach the other services and the platform, and rolls every applied service back when one fails.

**Architecture:** `project.json` gets `platform`, a list of containers teams-ai renders into a compose file and runs first, on the network `teams-ai-<projectId>_net`. Each service deploys as the compose project `teams-ai-<projectId>--<service>` with an extra compose file teams-ai writes: it joins only the service's main container to the shared network, under the service's name, and leaves the service's own containers (its database) on its private network. Phase 5 for a services plan applies the services one by one, then runs each service's smoke and e2e suites with `SERVICE_URL` for itself and `SERVICE_URL_<SERVICE>` for the others, each suite answering for the criteria its service's tasks deliver. The verified event keeps the fields of one primary service so Phase 6 and the validation page keep working, and lists every service for R12.5.

**Tech Stack:** TypeScript on Node (ES modules), zod 4, vitest, `docker compose` (JSON compose files, which are YAML).

**Spec:** `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (sections "Design" and "Slices", item R12.4).

## Global Constraints

- A single-repository plan deploys exactly as today: same compose project `teams-ai-<projectId>`, same arguments, same journal events, same port registry key; every existing test passes unchanged.
- No technology is fixed in code: platform images, commands and healthchecks come from `project.json`; teams-ai only renders and runs them.
- A platform image must be pinned: a tag other than `latest`, or a digest.
- Names cannot collide with another project: a slug never holds `--` or `_`, so `teams-ai-<projectId>--<service>`, `teams-ai-<projectId>_platform` and `teams-ai-<projectId>_net` are unique.
- Code follows `QUALITY_RULES` (`server/agents/registry.ts`): one-sentence comments, smallest working solution, no duplicated logic.
- Focused test: `npx vitest run <file>`; whole suite: `npx vitest run`; types: `npx tsc --noEmit`.
- Out of scope: the report and screens listing every service (R12.5); the agent writing `platform`, `services` and services plans, and a port per service in Phase 2 (R12.6).

## Review Focus

1. Two services whose compose files both name a container `db` must not see each other's database: only each service's main container joins the shared network (Task 2).
2. A failure in the second service's e2e suite rolls back the first service too, and the deploy-fix task lands in the failing service (Task 5).
3. A platform that does not start ends the deploy without a fix task, since the platform comes from the docs and not from the code (Task 5).
4. Two services of one project never get the same host port, and deleting the project frees both (Task 3).
5. The verified event of a services run keeps `url`, `port`, `smoke` and `healthcheck`, so the validation page renders (Task 5).

## Where the code stands

- `server/deploy/docker-local.ts`: one compose project per project (`composeProject`), the app container found by the project id, gates on `<compose project>_default`.
- `server/deploy/target.ts`: `DeploymentIntent` has no service or network.
- `server/deploy/port-registry.ts`: the port registry keeps one port per project; `releaseDeployPort` frees that one key.
- `server/exec/smoke.ts`, `server/exec/e2e.ts`: the gate gets only `SERVICE_URL`, and judges every criterion of the spec it is given.
- `server/orchestrator/phases/deploy.ts`: Phase 5 deploys one plan; `server/orchestrator/run.ts` ends a services run before it with `SERVICES_DEPLOY_PENDING`.
- `server/api/run-routes.ts:262`: deleting a project takes down `teams-ai-<projectId>` only.

---

### Task 1: The platform contract and the names of a project's compose projects

**Files:**
- Modify: `server/contracts/project.ts` (`PlatformService`, `Project.platform`)
- Modify: `server/deploy/docker-local.ts` (names, `renderPlatform`)
- Modify: `test/contracts/services.test.ts`
- Create: `test/deploy/platform.test.ts`

**Interfaces:**
- Produces: `PlatformService` (`name`, `image`, `command?`, `environment?`, `healthcheck?`) and `Project.platform?: PlatformService[]`; `serviceComposeProject(projectId, service)`, `platformComposeProject(projectId)`, `sharedNetwork(projectId)` and `renderPlatform(platform: readonly PlatformService[], network: string): string` exported from `docker-local.ts`.

- [ ] **Step 1: Write the failing tests**

`test/contracts/services.test.ts`, inside `describe('Project.services', ...)`:

```ts
  it('declares platform containers with a pinned image and unique names', () => {
    const nats = { name: 'nats', image: 'nats:2.10.22-alpine', command: ['-js', '-m', '8222'] };
    expect(makeProject({ platform: [nats] }).platform).toEqual([nats]);
    expect(() => makeProject({ platform: [{ name: 'nats', image: 'nats:latest' }] })).toThrow('pin the image');
    expect(() => makeProject({ platform: [{ name: 'nats', image: 'nats' }] })).toThrow('pin the image');
    expect(() => makeProject({ platform: [nats, nats] })).toThrow('platform names must be unique');
  });
```

`test/deploy/platform.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { platformComposeProject, renderPlatform, serviceComposeProject, sharedNetwork } from '../../server/deploy/docker-local.js';

describe('names of a project of services', () => {
  it('gives every service, the platform and the network a name no other project can take', () => {
    expect(serviceComposeProject('shop', 'orders')).toBe('teams-ai-shop--orders');
    expect(platformComposeProject('shop')).toBe('teams-ai-shop_platform');
    expect(sharedNetwork('shop')).toBe('teams-ai-shop_net');
  });
});

describe('renderPlatform', () => {
  it('renders each container on the shared network under its own name, with its healthcheck', () => {
    const file = JSON.parse(renderPlatform([{ name: 'nats', image: 'nats:2.10.22-alpine', command: ['-js', '-m', '8222'], healthcheck: ['CMD', 'wget', '-q', '--spider', 'http://localhost:8222/healthz'] }], 'teams-ai-shop_net'));
    expect(file).toEqual({
      services: {
        nats: {
          image: 'nats:2.10.22-alpine',
          command: ['-js', '-m', '8222'],
          healthcheck: { test: ['CMD', 'wget', '-q', '--spider', 'http://localhost:8222/healthz'], interval: '2s', timeout: '5s', retries: 30 },
          restart: 'unless-stopped',
          networks: { shared: { aliases: ['nats'] } },
        },
      },
      networks: { shared: { name: 'teams-ai-shop_net', external: true } },
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/contracts/services.test.ts test/deploy/platform.test.ts`
Expected: FAIL; `platform` is stripped by the schema and the helpers are not exported.

- [ ] **Step 3: Write the implementation**

`server/contracts/project.ts`, below `ServiceName`:

```ts
/** A shared container the docs declare for every service (a message broker, a shared database), reached on the project's network by its name. */
export const PlatformService = z.object({
  name: ServiceName,
  image: z.string().min(1).refine((image) => /[:@]/.test(image.split('/').at(-1) ?? '') && !/:latest$/.test(image), { message: 'pin the image to a version: a tag other than latest, or a digest' }),
  command: z.array(z.string()).optional(),
  environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).optional(),
  /** A compose healthcheck test, e.g. ["CMD", "wget", "-q", "--spider", "http://localhost:8222/healthz"]. */
  healthcheck: z.array(z.string().min(1)).min(1).optional(),
});
export type PlatformService = z.infer<typeof PlatformService>;
```

and as the last field of `Project`:

```ts
  /** The shared containers every service reaches by name; absent when the services need none. */
  platform: z.array(PlatformService).refine((list) => new Set(list.map((p) => p.name)).size === list.length, { message: 'platform names must be unique' }).optional(),
```

`server/deploy/docker-local.ts`, import `type PlatformService` from `../contracts/project.js`, and below `composeProject`:

```ts
/** A service's own compose project; a slug never holds `--`, so no other project can take the name. */
export const serviceComposeProject = (projectId: string, service: string) => `${composeProject(projectId)}--${service}`;
/** The compose project of the platform containers; a slug never holds `_`. */
export const platformComposeProject = (projectId: string) => `${composeProject(projectId)}_platform`;
/** The network a project's services and platform containers share. */
export const sharedNetwork = (projectId: string) => `${composeProject(projectId)}_net`;

/** The platform containers as a compose file on the shared network, each under its own name (JSON is YAML). */
export function renderPlatform(platform: readonly PlatformService[], network: string): string {
  const services = Object.fromEntries(platform.map((p) => [p.name, {
    image: p.image,
    ...(p.command ? { command: p.command } : {}),
    ...(p.environment ? { environment: p.environment } : {}),
    ...(p.healthcheck ? { healthcheck: { test: p.healthcheck, interval: '2s', timeout: '5s', retries: 30 } } : {}),
    restart: 'unless-stopped',
    networks: { shared: { aliases: [p.name] } },
  }]));
  return JSON.stringify({ services, networks: { shared: { name: network, external: true } } }, null, 2);
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/contracts test/deploy/platform.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/contracts/project.ts server/deploy/docker-local.ts test/contracts/services.test.ts test/deploy/platform.test.ts
git commit -m "feat(deploy): platform containers in project.json and names no other project can take"
```

### Task 2: The Docker target runs the platform, a service on the shared network, and the teardown

**Files:**
- Modify: `server/deploy/target.ts` (`DeploymentIntent.shared`, `DeployTarget.startPlatform`)
- Modify: `server/deploy/docker-local.ts`
- Modify: `server/api/run-routes.ts` (project delete)
- Modify: `test/deploy/docker-compose.test.ts`

**Interfaces:**
- Consumes: the names and `renderPlatform` (Task 1).
- Produces: `DeploymentIntent.shared?: { composeProject: string; network: string; alias: string }`; `DeployTarget.startPlatform?(projectId: string, platform: readonly PlatformService[]): Promise<{ ok: boolean; detail: string }>`; `teardownProject(exec: Exec, projectId: string, services: readonly string[]): Promise<void>` exported from `docker-local.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `test/deploy/docker-compose.test.ts` (it already builds the target from a `FakeExec`; import `promises as fs` from `node:fs`, and `teardownProject` with the target):

```ts
describe('a service of a system of services', () => {
  const shared = { composeProject: 'teams-ai-shop--orders', network: 'teams-ai-shop_net', alias: 'orders' };
  const intent = { projectId: 'shop', image: 'orders', tag: 't1', port: 20001, healthcheckPath: '/health', manifests: [], secretNames: [], contextDir: '/ws/orders', compose: 'docker-compose.yml', shared };

  it("runs in its own compose project and joins only its main container to the shared network, under the service's name", async () => {
    // The main container is the compose service named like the service (the devops rule of R12.6); its database stays private.
    const fake = new FakeExec().on((s) => s.args.includes('--services'), () => ({ stdout: 'orders\ndb\n' }));
    const target = new DockerLocalTarget({ exec: fake.exec, get: async () => ({ status: 200 }), secrets: {} });
    await target.apply(intent);
    const up = fake.calls.find((c) => c.args.includes('up'))!;
    const file = up.args[up.args.lastIndexOf('-f') + 1]!;
    expect(up.args.slice(0, 3)).toEqual(['compose', '-p', 'teams-ai-shop--orders']);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      services: { orders: { networks: { default: {}, shared: { aliases: ['orders'] } } } },
      networks: { shared: { name: 'teams-ai-shop_net', external: true } },
    });
    expect(target.gateNetwork(intent)).toBe('teams-ai-shop_net');
    expect(await target.gateServiceUrl(intent)).toBe('http://orders:20001');
  });

  it('creates the shared network when it is missing and starts the platform before the services', async () => {
    const fake = new FakeExec().onArgs('docker', ['network', 'inspect'], () => ({ exitCode: 1 }));
    const target = new DockerLocalTarget({ exec: fake.exec, get: async () => ({ status: 200 }), secrets: {} });
    expect(await target.startPlatform('shop', [{ name: 'nats', image: 'nats:2.10.22-alpine' }])).toEqual({ ok: true, detail: 'platform up' });
    const lines = fake.lines('docker');
    expect(lines[1]).toBe('network create teams-ai-shop_net');
    expect(lines[2]).toMatch(/^compose -p teams-ai-shop_platform -f \S+ up -d --wait$/);
  });

  it('takes down every compose project and the network of a project of services, and only its own project otherwise', async () => {
    const fake = new FakeExec();
    await teardownProject(fake.exec, 'shop', ['orders', 'inventory']);
    expect(fake.lines('docker')).toEqual([
      'compose -p teams-ai-shop down -v',
      'compose -p teams-ai-shop--orders down -v',
      'compose -p teams-ai-shop--inventory down -v',
      'compose -p teams-ai-shop_platform down -v',
      'network rm teams-ai-shop_net',
    ]);
    const single = new FakeExec();
    await teardownProject(single.exec, 'todo-api', []);
    expect(single.lines('docker')).toEqual(['compose -p teams-ai-todo-api down -v']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/deploy/docker-compose.test.ts`
Expected: FAIL; the compose project is `teams-ai-shop`, `startPlatform` and `teardownProject` do not exist.

- [ ] **Step 3: Write the implementation**

`server/deploy/target.ts`: import `type PlatformService` from `../contracts/project.js`; add to `DeploymentIntent`:

```ts
  /** A service of a system of services: its own compose project, its main container on the project's network under `alias`. */
  shared?: { composeProject: string; network: string; alias: string };
```

and to `DeployTarget`:

```ts
  /** Creates the project's shared network and starts the platform containers the docs declare. */
  startPlatform?(projectId: string, platform: readonly PlatformService[]): Promise<{ ok: boolean; detail: string }>;
```

`server/deploy/docker-local.ts`: import `promises as fs` from `node:fs`, `os` from `node:os` and `path` from `node:path`; then:

- `project(intent)` returns `intent.shared?.composeProject ?? composeProject(intent.projectId)`.
- `service(intent)` prefers `intent.shared?.alias ?? intent.projectId` where it prefers the project id today, and reads the services with the base file only.
- `compose(intent, args, image, timeoutMs, shared = true)` becomes `async`, and when `shared` and `intent.shared` are set it adds `-f <file>` after the base `-f`, the file written by:

```ts
  /** The extra compose file that joins only the main container to the shared network, under the service's name. */
  private async sharedFile(intent: DeploymentIntent): Promise<string> {
    const shared = intent.shared!;
    const file = path.join(os.tmpdir(), `${shared.composeProject}.shared.json`);
    const override = { services: { [await this.service(intent)]: { networks: { default: {}, shared: { aliases: [shared.alias] } } } }, networks: { shared: { name: shared.network, external: true } } };
    await fs.writeFile(file, JSON.stringify(override, null, 2));
    return file;
  }
```

  `service(intent)` calls `this.compose(intent, ['config', '--services'], imageRef(intent), 60_000, false)`, so it never needs the file it helps write.
- `gateNetwork(intent)` returns `intent.shared?.network` first, then today's value.
- `gateServiceUrl(intent)` uses `intent.shared.alias` instead of the compose service name when `intent.shared` is set.
- New method:

```ts
  async startPlatform(projectId: string, platform: readonly PlatformService[]): Promise<{ ok: boolean; detail: string }> {
    const network = sharedNetwork(projectId);
    if ((await this.docker(['network', 'inspect', network], undefined, 30_000)).exitCode !== 0) {
      const created = await this.docker(['network', 'create', network], undefined, 30_000);
      if (created.exitCode !== 0) return { ok: false, detail: `docker network create failed: ${created.stderr.slice(-1000)}` };
    }
    if (platform.length === 0) return { ok: true, detail: 'no platform' };
    const file = path.join(os.tmpdir(), `${platformComposeProject(projectId)}.json`);
    await fs.writeFile(file, renderPlatform(platform, network));
    const up = await this.docker(['compose', '-p', platformComposeProject(projectId), '-f', file, 'up', '-d', '--wait'], undefined, TIMEOUT);
    return up.exitCode === 0 ? { ok: true, detail: 'platform up' } : { ok: false, detail: `docker compose up failed: ${up.stderr.slice(-2000)}` };
  }
```

- New export, below `renderPlatform`:

```ts
/** Takes down what a project deployed: its own compose project and, for a system of services, each service's, the platform's and the shared network. */
export async function teardownProject(exec: Exec, projectId: string, services: readonly string[]): Promise<void> {
  const down = (project: string) => exec({ bin: 'docker', args: ['compose', '-p', project, 'down', '-v'], timeoutMs: 120_000 }).catch(() => undefined);
  await down(composeProject(projectId));
  if (services.length === 0) return;
  for (const service of services) await down(serviceComposeProject(projectId, service));
  await down(platformComposeProject(projectId));
  await exec({ bin: 'docker', args: ['network', 'rm', sharedNetwork(projectId)], timeoutMs: 30_000 }).catch(() => undefined);
}
```

`server/api/run-routes.ts`, project delete: collect `read.project.services ?? []` into a `services` array inside the loop that reads each project, and replace the `docker compose ... down -v` call with `await teardownProject(execCommand, projectId, [...new Set(services)]);` (import `teardownProject` beside `composeProject`, which stays imported only if still used).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/deploy && npx tsc --noEmit`
Expected: PASS; the existing compose tests keep their exact argument strings.

- [ ] **Step 5: Commit**

```bash
git add server/deploy/target.ts server/deploy/docker-local.ts server/api/run-routes.ts test/deploy/docker-compose.test.ts
git commit -m "feat(deploy): the platform and each service on the project's shared network, and their teardown"
```

### Task 3: One host port per service

**Files:**
- Modify: `server/deploy/port-registry.ts` (`portKey`, `releaseDeployPort`)
- Modify: `test/deploy/service-links.test.ts`

**Interfaces:**
- Produces: `portKey(projectId: string, service: string | null): string` (`<projectId>` or `<projectId>/<service>`); `releaseDeployPort` frees the project's key and every key of its services.

- [ ] **Step 1: Write the failing test**

Add to the `assignDeployPort` describe of `test/deploy/service-links.test.ts` (import `portKey` from `../../server/deploy/port-registry.js`):

```ts
  it('gives each service of a project its own port and frees them all with the project', async () => {
    const dir = await root();
    const orders = await assignDeployPort(dir, portKey('shop', 'orders'), docker());
    const inventory = await assignDeployPort(dir, portKey('shop', 'inventory'), docker());
    expect(orders.port).not.toBe(inventory.port);
    expect(inventory.taken).toContain(orders.port);
    await releaseDeployPort(dir, 'shop');
    expect(JSON.parse(await fs.readFile(path.join(dir, '.ports.json'), 'utf8'))).toEqual({});
    await fs.rm(dir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/deploy/service-links.test.ts`
Expected: FAIL; `portKey` is not exported.

- [ ] **Step 3: Write the implementation**

`server/deploy/port-registry.ts`:

```ts
/** The registry key of a project's port, or of one of its services' ports. */
export const portKey = (projectId: string, service: string | null): string => (service === null ? projectId : `${projectId}/${service}`);

/** Gives back the ports of the project and of its services; called when the project is deleted. */
export const releaseDeployPort = (workspacesRoot: string, projectId: string): Promise<void> =>
  updateRegistry(workspacesRoot, (registry) => Object.fromEntries(Object.entries(registry).filter(([key]) => key !== projectId && !key.startsWith(`${projectId}/`))));
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/deploy/service-links.test.ts && npx tsc --noEmit`
Expected: PASS; the existing registry tests pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/deploy/port-registry.ts test/deploy/service-links.test.ts
git commit -m "feat(deploy): one host port per service, freed with the project"
```

### Task 4: Smoke and e2e suites reach the other services and answer for their service's criteria

**Files:**
- Modify: `server/contracts/spec.ts` (`specShare`)
- Modify: `server/validators/plan.ts` (use `specShare`)
- Modify: `server/exec/smoke.ts` (`serviceUrlEnv`, `urls` parameter)
- Modify: `server/exec/e2e.ts` (`urls` parameter)
- Modify: `test/exec/e2e.test.ts`, `test/exec/smoke.test.ts`

**Interfaces:**
- Produces: `specShare(spec: Spec, tasks: readonly Pick<PlanTask, 'criteriaRefs'>[]): Spec`; `serviceUrlEnv(service: string): string` (`SERVICE_URL_<SERVICE>`, dashes as underscores); `runSmoke(..., deps, urls = {})` and `runE2e(..., deps, urls = {})` pass every `urls` entry to the gate like `SERVICE_URL`.

- [ ] **Step 1: Write the failing tests**

`test/exec/smoke.test.ts` (import `serviceUrlEnv`):

```ts
describe('serviceUrlEnv', () => {
  it('names the variable that carries another service address', () => {
    expect(serviceUrlEnv('orders')).toBe('SERVICE_URL_ORDERS');
    expect(serviceUrlEnv('stock-ledger')).toBe('SERVICE_URL_STOCK_LEDGER');
  });
});
```

`test/exec/e2e.test.ts`, inside `describe('runE2e', ...)`:

```ts
  it("passes the other services' addresses to the suite like SERVICE_URL", async () => {
    const exec = new FakeExec();
    await runE2e(plan, spec, ctx, 'http://inventory:3000', deps(exec, junit(ok('AC-001') + ok('AC-002'))), { SERVICE_URL_ORDERS: 'http://orders:3000' });
    const call = exec.calls[0]!;
    expect(call.env).toMatchObject({ SERVICE_URL: 'http://inventory:3000', SERVICE_URL_ORDERS: 'http://orders:3000' });
    expect(call.args.join(' ')).toContain('-e SERVICE_URL_ORDERS');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/exec/smoke.test.ts test/exec/e2e.test.ts`
Expected: FAIL; `serviceUrlEnv` is not exported and the suite gets no `SERVICE_URL_ORDERS`.

- [ ] **Step 3: Write the implementation**

`server/contracts/spec.ts`, below `Spec` (import `type PlanTask` from `./plan.js`):

```ts
/** The part of a spec some tasks deliver: the criteria they reference. */
export const specShare = (spec: Spec, tasks: readonly Pick<PlanTask, 'criteriaRefs'>[]): Spec => {
  const delivered = new Set(tasks.flatMap((t) => t.criteriaRefs));
  return { ...spec, acceptanceCriteria: spec.acceptanceCriteria.filter((ac) => delivered.has(ac.id)) };
};
```

`server/validators/plan.ts`, in `validateServicesPlan`: replace the two lines that build `delivered` and `share` with `const share = specShare(spec, view.tasks);` (import `specShare` from `../contracts/spec.js`, keeping the comment above it).

`server/exec/smoke.ts`:

```ts
/** The variable a suite reads another service's address from. */
export const serviceUrlEnv = (service: string): string => `SERVICE_URL_${service.toUpperCase().replace(/-/g, '_')}`;
```

and `runSmoke(plan, spec, ctx, serviceUrl, deps, urls: Readonly<Record<string, string>> = {})` runs the gate with `{ ...gate, secrets: [...gate.secrets, ...Object.keys(urls)] }` and `secrets: { ...ctx.secrets, SERVICE_URL: serviceUrl, ...urls }`. `server/exec/e2e.ts`: the same parameter and the same two changes in `runE2e`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/exec test/validators && npx tsc --noEmit`
Expected: PASS; the existing smoke, e2e and services-plan tests pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/contracts/spec.ts server/validators/plan.ts server/exec/smoke.ts server/exec/e2e.ts test/exec/smoke.test.ts test/exec/e2e.test.ts
git commit -m "feat(exec): smoke and e2e suites get the other services' addresses"
```

### Task 5: Phase 5 deploys every service of a services plan

**Files:**
- Modify: `server/orchestrator/phases/shared.ts` (`PhaseDeps.smoke` and `e2e` take a scope)
- Modify: `server/orchestrator/phases/deploy.ts` (`runServicesPhase5`, a port per service)
- Modify: `server/orchestrator/phases/index.ts` (export)
- Modify: `server/orchestrator/run.ts` (smoke and e2e scope; `postPhases` and `deployOnly`; remove `SERVICES_DEPLOY_PENDING`)
- Create: `test/orchestrator/phase5-services.test.ts`
- Modify: `test/orchestrator/run-services.test.ts` (the `deployOnly` test)

**Interfaces:**
- Consumes: `DeploymentIntent.shared`, `startPlatform`, the names (Tasks 1-2); `portKey` (Task 3); `specShare`, `serviceUrlEnv`, the `urls` parameter (Task 4); `PhaseDeps.services` (plan 61).
- Produces: `interface GateScope { service: string; plan: Plan; spec: Spec; urls: Record<string, string> }` and an optional fifth `scope?: GateScope` argument of `PhaseDeps.smoke` and `PhaseDeps.e2e` in `shared.ts`; `runServicesPhase5(deps: PhaseDeps, attempt: 1 | 2 | 3, opts?: { fixTasks?: boolean }): Promise<{ ok: true } | { ok: false; reason: string; fixTask?: PlanTask }>` in `deploy.ts`.

- [ ] **Step 1: Write the failing tests**

`test/orchestrator/phase5-services.test.ts`:

```ts
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { servicePlans, type ServicesPlan } from '../../server/contracts/plan.js';
import type { DeploymentIntent } from '../../server/deploy/target.js';
import { execCommand } from '../../server/exec/command.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runServicesPhase5 } from '../../server/orchestrator/phases/deploy.js';
import type { GateScope, PhaseDeps, ServiceRepo } from '../../server/orchestrator/phases/shared.js';
import { makeFrozenSpec, makeProject, makeServicesPlan } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const plan: ServicesPlan = makeServicesPlan(spec);
let remotes: Remote[] = [];
let journal: Journal;
afterEach(async () => {
  await journal.close();
  for (const r of remotes) await r.cleanup();
  remotes = [];
});

/** A target that records what it does; `fail` names the step that fails, as `<action>:<service>`. */
function target(log: string[], fail?: string) {
  const step = (action: string, i: DeploymentIntent) => {
    log.push(`${action}:${i.shared?.alias ?? '-'}`);
    return fail === `${action}:${i.shared?.alias}`;
  };
  return {
    name: 'docker-local' as const,
    validate: async () => [],
    build: async () => undefined,
    apply: async (i: DeploymentIntent) => { if (step('apply', i)) throw new Error('apply failed'); return { previous: null }; },
    verify: async () => ({ healthy: true, detail: 'HTTP 200' }),
    currentImage: async () => null,
    rollback: async (i: DeploymentIntent) => { step('rollback', i); },
    destroy: async (i: DeploymentIntent) => { step('destroy', i); },
    serviceUrl: (i: DeploymentIntent) => `http://127.0.0.1:${i.port}`,
    gateServiceUrl: (i: DeploymentIntent) => `http://${i.shared!.alias}:${i.port}`,
    gateNetwork: (i: DeploymentIntent) => i.shared!.network,
    startPlatform: async () => { log.push('platform'); return fail === 'platform' ? { ok: false, detail: 'nats did not start' } : { ok: true, detail: 'platform up' }; },
  };
}

async function setup(log: string[], opts: { fail?: string; e2eFails?: string } = {}): Promise<{ deps: PhaseDeps; scopes: GateScope[] }> {
  const repos: ServiceRepo[] = [];
  for (const view of servicePlans(plan)) {
    const remote = await makeRemote({ 'README.md': '#\n' });
    remotes.push(remote);
    repos.push({ ...view, ws: { repo: remote.repo } as ServiceRepo['ws'], firstSpec: false, gates: async () => ({ results: [], blockingFailure: null }) });
  }
  journal = await Journal.open({ file: path.join(remotes[0]!.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
  const scopes: GateScope[] = [];
  const gate = (kind: string) => async (_dir: string, _url: string, _gate?: string, _net?: string, scope?: GateScope) => {
    scopes.push(scope!);
    log.push(`${kind}:${scope!.service}`);
    const ok = opts.e2eFails !== `${kind}:${scope!.service}`;
    return { ok, rows: [], detail: ok ? 'passed' : `${kind} failed` };
  };
  const deps = {
    journal, ws: { repo: remotes[0]!.repo, projectId: 'shop' }, spec, project: makeProject({ projectId: 'shop', services: ['orders', 'inventory'], platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] }),
    exec: new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s)).exec,
    target: target(log, opts.fail), smoke: gate('smoke'), e2e: gate('e2e'), requireE2e: true,
    services: { plan, repos },
  } as unknown as PhaseDeps;
  return { deps, scopes };
}

describe('Phase 5 with several services', () => {
  it('starts the platform, deploys every service, then proves each one with the addresses of the others', async () => {
    const log: string[] = [];
    const { deps, scopes } = await setup(log);
    expect(await runServicesPhase5(deps, 1)).toEqual({ ok: true });
    expect(log).toEqual(['platform', 'apply:orders', 'apply:inventory', 'smoke:orders', 'e2e:orders', 'smoke:inventory', 'e2e:inventory']);
    expect(scopes.find((s) => s.service === 'inventory')!.urls).toEqual({ SERVICE_URL_ORDERS: 'http://orders:3000' });
    expect(scopes.find((s) => s.service === 'orders')!.spec.acceptanceCriteria.map((ac) => ac.id)).toEqual(['AC-001']);
    const verified = journal.events.find((e) => e.type === OrchEvent.DeployVerified)!.data;
    expect(verified).toMatchObject({ attempt: 1, url: 'http://127.0.0.1:3000', port: 3000, smoke: [] });
    expect((verified.services as Array<{ service: string }>).map((s) => s.service)).toEqual(['orders', 'inventory']);
  });

  it('rolls back every applied service when one fails, and plans the fix in the failing service', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { e2eFails: 'e2e:inventory' });
    const res = await runServicesPhase5(deps, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(log.slice(-2)).toEqual(['destroy:inventory', 'destroy:orders']);
    expect(res.fixTask).toMatchObject({ service: 'inventory', owner: 'dev', origin: 'deploy-fix' });
    expect(journal.events.find((e) => e.type === OrchEvent.DeployFailed)!.data).toMatchObject({ attempt: 1, stage: 'e2e', service: 'inventory' });
  });

  it('ends without a fix task when the platform does not start', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { fail: 'platform' });
    const res = await runServicesPhase5(deps, 1);
    expect(res).toEqual({ ok: false, reason: 'deploy failed on attempt 1 at platform: nats did not start' });
    expect(log).toEqual(['platform']);
  });
});
```

In `test/orchestrator/run-services.test.ts`, replace the test "ends a deploy of a services plan before Phase 5, which only knows one service until R12.4" with:

```ts
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
```

The fake `docker run` of this file passes every smoke and e2e gate with the JUnit it writes.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/phase5-services.test.ts test/orchestrator/run-services.test.ts`
Expected: FAIL; `runServicesPhase5` is not exported, and `deployOnly` ends with `SERVICES_DEPLOY_PENDING`.

- [ ] **Step 3: Write the implementation**

`server/orchestrator/phases/shared.ts`: import `type Plan`'s neighbors as needed and add:

```ts
/** What a services run's smoke or e2e suite runs with: its service's plan, the criteria it answers for, the other services' addresses. */
export interface GateScope {
  service: string;
  plan: Plan;
  spec: Spec;
  urls: Record<string, string>;
}
```

and a fifth parameter `scope?: GateScope` on the `smoke` and `e2e` function types of `PhaseDeps`.

`server/orchestrator/phases/deploy.ts`:

- `reassignPort(deps, from, service: string | null = null)` passes `portKey(deps.project.projectId, service)` to `assignDeployPort` and journals `DeployPortReassigned` with `...(service ? { service } : {})`.
- Below `deployIntent`:

```ts
/** A service's port: the plan's, unless a failed deploy of that service moved it. */
const servicePort = (deps: PhaseDeps, repo: ServiceRepo) => Number([...deps.journal.events].reverse().find((e) => e.type === OrchEvent.DeployPortReassigned && e.data.service === repo.service)?.data.to ?? repo.plan.deploy.port);

/** A service deploys like a single plan, as its own compose project on the project's shared network. */
function serviceIntent(deps: PhaseDeps, repo: ServiceRepo, tag: string): DeploymentIntent {
  const service = repo.service!;
  return { ...deployIntent({ ...deps, plan: repo.plan, ws: repo.ws }, tag), port: servicePort(deps, repo), shared: { composeProject: serviceComposeProject(deps.project.projectId, service), network: sharedNetwork(deps.project.projectId), alias: service } };
}
```

- Below `runPhase5`:

```ts
/**
 * R12.4: the platform first, then every service on the shared network, then each service's smoke and e2e suites with the
 * other services' addresses. A failure rolls back every service this attempt applied; the fix goes to the failing service.
 */
export async function runServicesPhase5(deps: PhaseDeps, attempt: 1 | 2 | 3, opts: { fixTasks?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: string; fixTask?: PlanTask }> {
  const { journal, target, services } = deps;
  if (!services || !target || !deps.smoke) throw new Error('Phase 5 needs the services, target and smoke');
  if (journal.events.some((e) => e.type === OrchEvent.DeployVerified && e.data.attempt === attempt)) return { ok: true };
  if (!journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 5)) await journal.fact(OrchEvent.PhaseStarted, { phase: 5 });
  const applied: Array<{ repo: ServiceRepo; intent: DeploymentIntent; previous: string | null; healthcheck: string }> = [];
  const failed = async (stage: DeployStage | 'platform', detail: string, repo: ServiceRepo | null, newPort: number | null = null) => {
    // Every applied service goes back to its previous image, or away when this was its first deploy.
    for (const a of [...applied].reverse()) await (a.previous ? target.rollback(a.intent, a.previous) : target.destroy(a.intent)).catch(() => undefined);
    await journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail, rolledBack: applied.length > 0, rollbackHealthy: null, ...(repo ? { service: repo.service } : {}) });
    // The platform comes from the docs, never from the code: no task could fix it.
    if (!repo || attempt >= 3 || opts.fixTasks === false) return { ok: false as const, reason: `deploy failed on attempt ${attempt} at ${stage}${repo ? ` (${repo.service})` : ''}: ${detail}` };
    const task = { ...fixTask({ ...deps, plan: repo.plan }, attempt, stage as DeployStage, detail, newPort), service: repo.service! };
    await journal.fact(RunEvent.FixTasksPlanned, { tasks: [task] });
    return { ok: false as const, reason: `deploy failed at ${stage} (${repo.service}); deploy-fix task planned`, fixTask: task };
  };
  const platform = target.startPlatform ? await target.startPlatform(deps.project.projectId, deps.project.platform ?? []) : { ok: true, detail: '' };
  if (!platform.ok) return failed('platform', platform.detail, null);
  for (const repo of services.repos) {
    const tag = await checkoutMain({ ...deps, ws: repo.ws });
    const intent = serviceIntent(deps, repo, tag);
    const key = `deploy-${repo.service}-${attempt}`;
    let previous: string | null = null;
    if (journal.isConfirmed(Intent.DeployApply, key)) {
      previous = ([...journal.events].reverse().find((e) => e.kind === 'confirm' && e.intentId === `${Intent.DeployApply}:${key}`)?.data.previous as string | null | undefined) ?? null;
    } else {
      await journal.intent(Intent.DeployApply, key, { attempt, service: repo.service, image: intent.image, tag, intent });
      const r = await runDeployment(target, intent, { smoke: async () => ({ ok: true, detail: 'journaled separately' }), baseUrl: '' });
      if (!r.ok) return failed(r.stage, r.detail, repo, r.stage === 'apply' && PORT_TAKEN.test(r.detail) ? await reassignPort(deps, intent.port, repo.service) : null);
      previous = r.previous;
      await journal.confirm(Intent.DeployApply, key, { previous });
      await journal.fact(OrchEvent.DeployApplied, { attempt, service: repo.service, previous, tag });
    }
    applied.push({ repo, intent, previous, healthcheck: (await target.verify(intent)).detail });
  }
  const addresses = await Promise.all(applied.map(async (a) => ({ ...a, url: await target.serviceUrl!(a.intent), gateUrl: await target.gateServiceUrl!(a.intent), network: target.gateNetwork?.(a.intent) })));
  const smoke: SmokeRow[] = [];
  const e2e: E2eRow[] = [];
  for (const a of addresses) {
    const urls = Object.fromEntries(addresses.filter((o) => o !== a).map((o) => [serviceUrlEnv(o.repo.service!), o.gateUrl]));
    const scope: GateScope = { service: a.repo.service!, plan: a.repo.plan, spec: specShare(deps.spec, a.repo.plan.tasks), urls };
    const s = await deps.smoke(a.repo.ws.repo, a.url, a.gateUrl, a.network, scope);
    if (!s.ok) return failed('smoke', s.detail, a.repo);
    smoke.push(...s.rows);
    if (deps.e2e && (e2eCommand(a.repo.plan) || deps.requireE2e)) {
      const e = await deps.e2e(a.repo.ws.repo, a.url, a.gateUrl, a.network, scope);
      if (!e.ok) return failed('e2e', e.detail, a.repo);
      e2e.push(...e.rows);
    }
  }
  // The first service stands in the fields Phase 6 and the validation page read; R12.5 shows every service.
  const [first] = addresses;
  const card = (a: (typeof addresses)[number]) => ({ service: a.repo.service, url: a.url, port: a.intent.port, healthcheck: a.healthcheck, healthcheckPath: a.intent.healthcheckPath, ...(a.repo.plan.deploy.kind ? { kind: a.repo.plan.deploy.kind } : {}), ...(a.repo.plan.deploy.docsPath ? { docsPath: a.repo.plan.deploy.docsPath } : {}) });
  const { service: _primary, ...primary } = card(first!);
  await journal.fact(OrchEvent.DeployVerified, { attempt, ...primary, smoke, ...(e2e.length ? { e2e } : {}), services: addresses.map(card) });
  return { ok: true };
}
```

  with imports `serviceComposeProject` and `sharedNetwork` from `../../deploy/docker-local.js`, `portKey` from `../../deploy/port-registry.js`, `specShare` from `../../contracts/spec.js`, `serviceUrlEnv` from `../../exec/smoke.js`, and `type GateScope`, `type ServiceRepo` from `./shared.js`.

`server/orchestrator/phases/index.ts`: export `runServicesPhase5` beside `runPhase5`, and `type GateScope` beside `type ServiceRepo`.

`server/orchestrator/run.ts`:

- Delete `SERVICES_DEPLOY_PENDING` and both guards that use it.
- `postPhases`: `const p5 = singlePlan(this.plan) ? await runPhase5(this.phaseDeps(), attempt) : await runServicesPhase5(this.phaseDeps(), attempt);` inside the existing loop.
- `deployOnly`: `const p5 = singlePlan(this.plan) ? await runPhase5(this.phaseDeps(), 1, { fixTasks: false }) : await runServicesPhase5(this.phaseDeps(), 1, { fixTasks: false });`.
- `smoke` and `e2e` in `phaseDeps()` take the fifth `scope` argument: `const p = scope?.plan ?? singlePlan(this.plan)!;`, the spec passed is `scope?.spec ?? this.deps.spec`, the container name ends with `-${scope.service}` when there is a scope, and `scope?.urls` is the last argument of `runSmoke` and `runE2e`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/orchestrator test/deploy test/exec && npx tsc --noEmit`
Expected: PASS; the existing Phase 5 tests (`phase5.test.ts`, `phase5-e2e.test.ts`, `deploy-port.test.ts`) pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases/shared.ts server/orchestrator/phases/deploy.ts server/orchestrator/phases/index.ts server/orchestrator/run.ts test/orchestrator/phase5-services.test.ts test/orchestrator/run-services.test.ts
git commit -m "feat(deploy): Phase 5 deploys every service of a services plan"
```

### Task 6: Record R12.4

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R12.4)
- Modify: `docs/superpowers/plans/README.md` (row 63)
- Modify: this plan's status line

- [ ] **Step 1: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, with the test count of before plus the new tests.

- [ ] **Step 2: Mark R12.4 `done`**

What was built, the tests, the whole-suite count, and what stays open: the report and screens show only the first service (R12.5); the agent writes `platform` and services plans with a port per service (R12.6); a live run with NATS (R12.7).

- [ ] **Step 3: Add row 63 to `plans/README.md`, update this status line and commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-11-teams-ai-63-deploy-services.md
git commit -m "docs(roadmap): R12.4 done, platform and deploy of several services"
```
