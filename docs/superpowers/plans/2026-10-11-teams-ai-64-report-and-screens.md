# Plan 64 - The report and the screens list every service (roadmap R12.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: done, 2026-10-11: whole suite 1508 passed and 4 skipped, web 170 passed, both type checks clean. Roadmap item R12.5, stage 12 (plan 60).

**Goal:** A run of a services plan shows every service, not only the first: the report carries each service's address, the service check answers for each service, the validation page lists each service with its state and its link, the run page shows the plan with each task's service, and the project page lists the services with their repositories and the platform.

**Architecture:** Phase 5 already journals `DEPLOY_VERIFIED.services`, one card per service (plan 63). The report copies that list into `Report.services`; the service route probes each card's health address; the web reads both. The project list adds `services` and `platform` from `project.json`, each service with the GitHub page of its clone. The run route parses the plan as `AnyPlan`, so a services plan reaches the run page. A single-repository run keeps every field and every screen exactly as today.

**Tech Stack:** TypeScript on Node (ES modules), zod 4, vitest, React with Testing Library (`web/`).

**Spec:** `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (sections "Design" and "Slices", item R12.5).

## Global Constraints

- A single-repository run, report and project answer and render exactly as today: same fields, same test ids, same texts; every existing test passes unchanged.
- The SM never sees an internal address: the report pack names only host addresses (`serviceLinks(...).appUrl`).
- Screen texts are Portuguese (Brazil), short and plain, like the rest of the UI.
- Code follows `QUALITY_RULES` (`server/agents/registry.ts`): one-sentence comments, smallest working solution, no duplicated logic.
- Focused server test: `npx vitest run <file>`; web test: `cd web && npx vitest run <file>`; types: `npx tsc --noEmit` and `cd web && npx tsc --noEmit -p .`.
- Out of scope: the agents writing `services`, `platform` and services plans (R12.6); a live run (R12.7).

## Review Focus

1. A service whose port is outside the published range is still listed, with no open link (Task 3).
2. The service check of a single-repository run keeps its exact answer, with no `services` field (Task 2).
3. A project without services shows no services panel, and its GitHub link stays as it is (Task 4).
4. The report pack of a services run names only host addresses, never `http://<service>:<port>` or `http://dind:...` (Task 1).
5. The run page of a single-repository plan renders as before: the stack line and no service tag (Task 5).

## Where the code stands

- `server/orchestrator/phases/report.ts`: `Report.service` is built from the last `DEPLOY_VERIFIED`; its `services` list is dropped; the pack gets one `hostUrl`.
- `server/api/run-routes.ts`: `GET /runs/:runId/service` probes `DEPLOY_VERIFIED.url`; `GET /runs/:runId` parses the plan with `Plan.safeParse`, so a services plan arrives as `null`; `GET /projects` adds `repoUrl` of the project clone.
- `server/api/run-index.ts`: `ProjectRow` has no `services` or `platform`.
- `web/src/pages/Validation.tsx`: `ServiceControls` shows one service; `web/src/pages/Run.tsx`: `PlanCard` shows `plan.stack` and the tasks; `web/src/pages/ProjectHub.tsx`: header, stats, specs, runs.

---

### Task 1: The report lists every service

**Files:**
- Modify: `server/orchestrator/phases/report.ts`
- Modify: `test/orchestrator/phase6-docs.test.ts`

**Interfaces:**
- Produces: `interface ReportService { service: string; url: string; healthcheck: string; port?: number; healthcheckPath?: string; kind?: 'api' | 'front'; docsPath?: string }` and `Report.services?: ReportService[]`, exported from `report.ts`.

- [ ] **Step 1: Write the failing test**

In `test/orchestrator/phase6-docs.test.ts`, below "puts the deploy port, health path, kind and docs path into report.service":

```ts
  it('lists every service of a services run and gives the SM only their host addresses', async () => {
    const card = (service: string, port: number) => ({ service, url: `http://127.0.0.1:${port}`, port, healthcheck: 'HTTP 200', healthcheckPath: '/health' });
    await journal.fact(OrchEvent.DeployVerified, { attempt: 1, ...card('orders', 20001), smoke: [], services: [card('orders', 20001), { ...card('inventory', 20002), kind: 'api', docsPath: '/docs' }] });
    const r = await p6(async () => report(GOOD));
    expect(r.report.services!.map((s) => [s.service, s.port])).toEqual([['orders', 20001], ['inventory', 20002]]);
    const pack = JSON.stringify(calls[0]!.pack);
    expect(pack).toContain('http://localhost:20001 (orders), http://localhost:20002 (inventory)');
    expect(pack).not.toContain('http://inventory:');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/orchestrator/phase6-docs.test.ts`
Expected: FAIL; `report.services` is undefined.

- [ ] **Step 3: Write the implementation**

`server/orchestrator/phases/report.ts`, above `Report`:

```ts
/** One service of a services run, as Phase 5 verified it. */
export interface ReportService { service: string; url: string; healthcheck: string; port?: number; healthcheckPath?: string; kind?: 'api' | 'front'; docsPath?: string }
```

add `services?: ReportService[];` to `Report` right after `service`, and below `tokensOf`:

```ts
/** Where the human opens what was deployed: the service, or each published service with its name. */
function hostUrl(r: Pick<Report, 'service' | 'services'>): string | null {
  if (!r.services) return r.service ? serviceLinks(r.service, 'localhost').appUrl : null;
  const urls = r.services.flatMap((s) => { const url = serviceLinks(s, 'localhost').appUrl; return url ? [`${url} (${s.service})`] : []; });
  return urls.length > 0 ? urls.join(', ') : null;
}
```

In `runPhase6`, `base` gets `...(Array.isArray(dv?.data.services) ? { services: dv!.data.services as ReportService[] } : {})` right after `service`, and the pack call passes `deploy: JSON.stringify(base.service ? { ...base.service, ...(base.services ? { services: base.services } : {}) } : base.deploy)` and `hostUrl: hostUrl(base)`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/orchestrator/phase6-docs.test.ts test/orchestrator/phase6.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases/report.ts test/orchestrator/phase6-docs.test.ts
git commit -m "feat(report): the report lists every service of a services run"
```

### Task 2: The service check answers for every service

**Files:**
- Modify: `server/api/run-routes.ts` (`GET /runs/:runId/service`)
- Modify: `test/api/run-api.test.ts`

**Interfaces:**
- Produces: the answer gains `services?: Array<{ service: string; online: boolean; status: number | null }>` for a services run; `online` is true when every service answers, `status` is the first service's.

- [ ] **Step 1: Write the failing test**

In `test/api/run-api.test.ts`, below "service status probes the deployed health url and says whether it answers":

```ts
  it('service status of a services run probes every service and is online only when all answer', async () => {
    const card = (service: string, port: number) => ({ service, url: `http://dind:${port}`, port, healthcheck: 'HTTP 200', healthcheckPath: '/health' });
    const deployed = { type: 'DEPLOY_VERIFIED', data: { attempt: 1, ...card('orders', 20001), smoke: [], services: [card('orders', 20001), card('inventory', 20002)] } };
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), deployed], state('running'));
    probe = async (u) => (u.includes('20001') ? { status: 200 } : null);
    expect(await (await fetch(base() + '/api/runs/hello-001-r1/service')).json()).toMatchObject({
      online: false,
      status: 200,
      services: [{ service: 'orders', online: true, status: 200 }, { service: 'inventory', online: false, status: null }],
    });
    expect(probed).toEqual(['http://dind:20001/health', 'http://dind:20002/health']);
  });
```

and in the single-run test above it add `expect((await (await fetch(base() + '/api/runs/hello-001-r1/service')).json()).services).toBeUndefined();` after its first assertion.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/api/run-api.test.ts -t "service status"`
Expected: FAIL; the answer has no `services` and probes one address.

- [ ] **Step 3: Write the implementation**

`server/api/run-routes.ts`, the handler body after `if (!deployed) ...`:

```ts
        // Reports from before the health path was recorded only prove the host answers: any HTTP status then means online.
        const probe = async (url: string, healthPath: unknown) => {
          const health = typeof healthPath === 'string' ? healthPath : null;
          const res = await (deps.httpGet ?? httpGet)(`${url}${health ?? '/'}`, 3000);
          return { online: res !== null && (health === null || (res.status >= 200 && res.status < 400)), status: res?.status ?? null };
        };
        const cards = Array.isArray(deployed.data.services) ? (deployed.data.services as Array<{ service: string; url: string; healthcheckPath?: string }>) : null;
        // A services run answers for each service, and is online only when every one answers.
        const checked = cards ? await Promise.all(cards.map(async (c) => ({ service: c.service, ...(await probe(c.url, c.healthcheckPath)) }))) : null;
        const own = checked?.[0] ?? (await probe(String(deployed.data.url), deployed.data.healthcheckPath));
        json(200, { online: checked ? checked.every((c) => c.online) : own.online, status: own.status, checkedAt: new Date().toISOString(), ...(checked ? { services: checked } : {}) });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/api/run-api.test.ts && npx tsc --noEmit`
Expected: PASS; the single-run tests keep their answers.

- [ ] **Step 5: Commit**

```bash
git add server/api/run-routes.ts test/api/run-api.test.ts
git commit -m "feat(api): the service check answers for every service of a run"
```

### Task 3: The validation page lists every service

**Files:**
- Modify: `web/src/api.ts` (`Report.services`, `ServiceStatus.services`)
- Modify: `web/src/pages/Validation.tsx`
- Modify: `web/src/pages/validation.css`
- Modify: `web/src/pages/Validation.test.tsx`

**Interfaces:**
- Consumes: `Report.services` (Task 1) and `ServiceStatus.services` (Task 2), mirrored in `web/src/api.ts`.

- [ ] **Step 1: Write the failing test**

In `web/src/pages/Validation.test.tsx`, inside the describe that holds "a port outside the published range gets no open button but says why":

```ts
  it('lists every service of a services run with its state and its link, and one start button for all', () => {
    const card = (service: string, port: number, extra = {}) => ({ service, url: `http://dind:${port}`, port, healthcheck: 'HTTP 200', healthcheckPath: '/health', ...extra });
    const services = [card('orders', 20001, { kind: 'api', docsPath: '/docs' }), card('inventory', 20002, { kind: 'front' }), card('ledger', 8080)];
    const status = { online: false, status: 200, checkedAt: '2026-10-06T10:00:00.000Z', services: [{ service: 'orders', online: true, status: 200 }, { service: 'inventory', online: false, status: null }, { service: 'ledger', online: true, status: 200 }] };
    view(detail({ report: { ...report, service: { ...report.service!, url: 'http://dind:20001', port: 20001 }, services } }), { serviceStatus: status });
    expect(screen.getByTestId('service-orders').textContent).toContain('No ar');
    expect(screen.getByTestId('open-orders').getAttribute('href')).toBe('http://localhost:20001/docs');
    expect(screen.getByTestId('service-inventory').textContent).toContain('Fora do ar');
    expect(screen.queryByTestId('open-inventory')).toBeNull();
    expect(screen.queryByTestId('open-ledger')).toBeNull();
    expect(screen.getAllByTestId('start-service')).toHaveLength(1);
    expect(screen.queryByTestId('service-online')).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/pages/Validation.test.tsx`
Expected: FAIL; there is no `service-orders`.

- [ ] **Step 3: Write the implementation**

`web/src/api.ts`: add to `ServiceStatus` `services?: Array<{ service: string; online: boolean; status: number | null }>;` and to `Report`, after `service`, `services?: Array<{ service: string; url: string; healthcheck: string; port?: number; healthcheckPath?: string; kind?: 'api' | 'front'; docsPath?: string }>;`.

`web/src/pages/Validation.tsx`: the pill, the open button and the start and recheck buttons become small helpers both views use:

```tsx
/** A service's state: still checking, answering or not. */
function StatePill({ checking, online, testId }: { checking: boolean; online: boolean; testId?: string }) {
  return <span data-testid={testId} className={`status-pill tone-${checking ? 'neutral' : online ? 'good' : 'bad'}`}>{checking ? 'Verificando' : online ? 'No ar' : 'Fora do ar'}</span>;
}

const openLink = (href: string, testId: string, text: string, primary: boolean) => (
  <a className={`${primary ? 'primary-button' : 'link-button'} run-action`} data-testid={testId} href={href} target="_blank" rel="noreferrer">
    {text}
    <Icon name="external" size={16} />
  </a>
);
```

`ServiceControls` uses `<StatePill checking={checking} online={online} testId="service-online" />` and `openLink` in place of its own markup (same test ids, classes and texts). Below it:

```tsx
/** A services run: one line per service with its state and its link, then one recheck and one start for them all. */
function ServiceList({ services, status, starting, canStart, onStart, onRecheck }: { services: NonNullable<Report['services']>; status: ServiceStatus | null; starting: boolean; canStart: boolean; onStart: () => void; onRecheck: () => void }) {
  const checking = status === null;
  const onlineOf = (service: string) => status?.services?.find((s) => s.service === service)?.online === true;
  return (
    <div className="service-controls">
      <ul className="service-list">
        {services.map((s) => {
          const links = serviceLinks(s, window.location.hostname);
          const href = links.docsUrl ?? links.appUrl;
          return (
            <li key={s.service} data-testid={`service-${s.service}`}>
              <strong className="task-id">{s.service}</strong>
              <StatePill checking={checking} online={onlineOf(s.service)} />
              {onlineOf(s.service) && href ? openLink(href, `open-${s.service}`, links.docsUrl ? 'Abrir Swagger' : s.kind === 'front' ? 'Abrir aplicação' : 'Abrir serviço', false) : null}
              {!links.appUrl ? <span className="hint">porta fora da faixa publicada</span> : null}
            </li>
          );
        })}
      </ul>
      <div className="service-actions">
        <button type="button" className="link-button" data-testid="recheck-service" onClick={onRecheck} disabled={checking}>
          <Icon name="refresh" size={14} />
          Verificar de novo
        </button>
        {!checking && services.some((s) => !onlineOf(s.service)) ? (
          <button type="button" className="primary-button" data-testid="start-service" disabled={starting || !canStart} onClick={onStart}>
            <Icon name="play" size={16} />
            {starting ? 'Subindo os serviços…' : 'Subir serviços'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

In `ValidationView`, where `ServiceControls` is rendered, render `ServiceList` with the same props when `report.services` is set, and `ServiceControls` otherwise; the heading says `Serviços publicados` for a services run. `web/src/pages/validation.css`:

```css
.service-list { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.service-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run src/pages/Validation.test.tsx && npx tsc --noEmit -p .`
Expected: PASS; every single-service test passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/pages/Validation.tsx web/src/pages/validation.css web/src/pages/Validation.test.tsx
git commit -m "feat(validation): a services run lists every service with its state and link"
```

### Task 4: The project page lists the services and the platform

**Files:**
- Modify: `server/api/run-index.ts` (`ProjectRow`, `listProjects`)
- Modify: `server/api/run-routes.ts` (`GET /projects`)
- Modify: `test/api/run-index.test.ts`
- Modify: `web/src/api.ts` (`ProjectRow`)
- Modify: `web/src/pages/ProjectHub.tsx`, `web/src/pages/project-hub.css`
- Modify: `web/src/pages/ProjectHub.test.tsx`

**Interfaces:**
- Produces: `ProjectRow.services?: string[]` and `ProjectRow.platform?: Array<{ name: string; image: string }>` in `run-index.ts`; the route answers `services?: Array<{ name: string; repoUrl: string | null }>`.

- [ ] **Step 1: Write the failing tests**

`test/api/run-index.test.ts` (the existing "listProjects reports specs with their active run and skips unreadable dirs" already pins that a project without services gets neither field, since it compares the whole row):

```ts
  it('listProjects carries the services and the platform of project.json', async () => {
    const dir = path.join(home, 'shop');
    await fs.cp(HELLO, dir, { recursive: true });
    const file = path.join(dir, 'docs', 'project.json');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), services: ['orders', 'inventory'], platform: [{ name: 'nats', image: 'nats:2.10.22-alpine', command: ['-js'] }] }));
    const d = deps();
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), projects: [{ dir }] });
    const [row] = await listProjects(d);
    expect(row!.services).toEqual(['orders', 'inventory']);
    expect(row!.platform).toEqual([{ name: 'nats', image: 'nats:2.10.22-alpine' }]);
  });
```

`web/src/pages/ProjectHub.test.tsx`:

```tsx
  it('lists the services with their repositories and the platform, and nothing for a project without services', () => {
    const o = on();
    const hub = (extra: object) => (
      <MemoryRouter>
        <ProjectHubView project={{ ...project, ...extra }} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onRestart={o.restart} onDeleteDraft={o.deleteDraft} />
      </MemoryRouter>
    );
    const { rerender } = render(hub({ services: [{ name: 'orders', repoUrl: 'https://github.com/acme/shop-orders' }, { name: 'inventory', repoUrl: null }], platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] }));
    expect(screen.getByTestId('project-service-orders').querySelector('a')!.getAttribute('href')).toBe('https://github.com/acme/shop-orders');
    expect(screen.getByTestId('project-service-inventory').textContent).toContain('Repositório ainda não criado');
    expect(screen.getByTestId('project-platform').textContent).toContain('nats (nats:2.10.22-alpine)');
    rerender(hub({}));
    expect(screen.queryByTestId('project-services')).toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/api/run-index.test.ts` and `cd web && npx vitest run src/pages/ProjectHub.test.tsx`
Expected: FAIL; the rows carry no services and the page has no services panel.

- [ ] **Step 3: Write the implementation**

`server/api/run-index.ts`: `ProjectRow` gets `services?: string[]; platform?: Array<{ name: string; image: string }>;`, and `listProjects` pushes `...(read.project.services ? { services: read.project.services } : {}), ...(read.project.platform ? { platform: read.project.platform.map((p) => ({ name: p.name, image: p.image })) } : {})`.

`server/api/run-routes.ts`, `GET /projects` (import `serviceWorkspace` beside `workspacePaths`):

```ts
        json(200, await Promise.all(rows.map(async (r) => {
          const ws = workspacePaths(idx.cfg, r.projectId, deps.home);
          // Each service's GitHub page comes from its own clone; null until Phase 0 made it.
          const services = r.services ? await Promise.all(r.services.map(async (name) => ({ name, repoUrl: await repoUrlOf(serviceWorkspace(ws, name).repo) }))) : undefined;
          return { ...r, repoUrl: await repoUrlOf(ws.repo), ...(services ? { services } : {}) };
        })));
```

`web/src/api.ts` `ProjectRow`: `services?: Array<{ name: string; repoUrl: string | null }>; platform?: Array<{ name: string; image: string }>;`.

`web/src/pages/ProjectHub.tsx`, right after the stats `div`, a panel shown only when `pr.services?.length`, in the markup of the specs panel (`card project-panel`, `project-section`, `project-section-heading`, `project-section-title` with an icon, `<h3>Serviços</h3>` and an `InfoTip` whose text is "Cada serviço tem o seu repositório no GitHub. A plataforma são os contêineres que todos os serviços usam, como um broker de mensagens."), with `data-testid="project-services"`, a `ul.project-service-list` with one `li` per service (`data-testid="project-service-<name>"`: the name, then an "Abrir no GitHub" `link-button` to `repoUrl`, or the hint "Repositório ainda não criado"), and when `pr.platform?.length` a `p.hint` with `data-testid="project-platform"` reading `Plataforma: ` and each `name (image)` joined by `, `. `web/src/pages/project-hub.css`:

```css
.project-service-list { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.project-service-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/api && npx tsc --noEmit`, then `cd web && npx vitest run src/pages/ProjectHub.test.tsx && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/run-index.ts server/api/run-routes.ts test/api/run-index.test.ts web/src/api.ts web/src/pages/ProjectHub.tsx web/src/pages/project-hub.css web/src/pages/ProjectHub.test.tsx
git commit -m "feat(project): the project page lists the services and the platform"
```

### Task 5: The run page shows a services plan

**Files:**
- Modify: `server/api/run-routes.ts` (`GET /runs/:runId`: `AnyPlan.safeParse`)
- Modify: `web/src/api.ts` (`ServicesPlanArtifact`, `RunDetail.plan`, the task's `service`)
- Modify: `web/src/pages/Run.tsx` (`PlanCard`)
- Modify: `web/src/pages/Run.test.tsx`

**Interfaces:**
- Produces: `RunDetail.plan: PlanArtifact | ServicesPlanArtifact | null`, `ServicesPlanArtifact = { specId: string; specHash: string; adrRefs: string[]; tasks: PlanArtifact['tasks']; services: Record<string, { stack: string }> }`, each task with `service?: string`.

- [ ] **Step 1: Write the failing test**

`web/src/pages/Run.test.tsx`, inside `describe('RunView', ...)`:

```tsx
  it("shows a services plan with each service's stack and each task's service", () => {
    const tasks = [{ ...detail.plan!.tasks[0]!, id: 'T1', service: 'orders' }, { ...detail.plan!.tasks[0]!, id: 'T2', service: 'inventory' }];
    render(view({ detail: { ...detail, plan: { specId: 'hello-001', specHash: detail.plan!.specHash, adrRefs: [], tasks, services: { orders: { stack: 'node' }, inventory: { stack: 'go' } } } } }));
    expect(screen.getByTestId('plan-artifact').textContent).toContain('orders: node · inventory: go');
    expect(screen.getByTestId('plan-task-T2').textContent).toContain('inventory');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/pages/Run.test.tsx`
Expected: FAIL; the card reads `plan.stack`, which a services plan has not.

- [ ] **Step 3: Write the implementation**

`server/api/run-routes.ts`: the run detail parses `AnyPlan.safeParse(JSON.parse(text)).data ?? null` (import `AnyPlan` beside `Plan`, and drop `Plan` if nothing else uses it).

`web/src/api.ts`: the task type of `PlanArtifact.tasks` gets `service?: string`; add `export interface ServicesPlanArtifact { specId: string; specHash: string; adrRefs: string[]; tasks: PlanArtifact['tasks']; services: Record<string, { stack: string }> }` and type `RunDetail.plan` as `PlanArtifact | ServicesPlanArtifact | null`.

`web/src/pages/Run.tsx`, `PlanCard({ plan }: { plan: PlanArtifact | ServicesPlanArtifact })`: the stack `dd` reads `{'services' in plan ? Object.entries(plan.services).map(([name, s]) => `${name}: ${s.stack}`).join(' · ') : plan.stack}`, and the chips of a task start with `{task.service ? <span className="tag">{task.service}</span> : null}`.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run src/pages/Run.test.tsx && npx tsc --noEmit -p .`, then `npx vitest run test/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/run-routes.ts web/src/api.ts web/src/pages/Run.tsx web/src/pages/Run.test.tsx
git commit -m "feat(run): the run page shows a services plan with each task's service"
```

### Task 6: Record R12.5

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R12.5), `docs/superpowers/plans/README.md` (row 64), `docs/superpowers/plans/2026-10-11-teams-ai-60-services.md` (R12.5 slice), this plan's status line

- [ ] **Step 1: Run every suite and both type checks**

Run: `npx vitest run && npx tsc --noEmit`, then `cd web && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 2: Mark R12.5 `done`, add row 64, update the slice in plan 60 and this status line, and commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md docs/superpowers/plans/2026-10-11-teams-ai-60-services.md docs/superpowers/plans/2026-10-11-teams-ai-64-report-and-screens.md
git commit -m "docs(roadmap): R12.5 done, the report and the screens list every service"
```
