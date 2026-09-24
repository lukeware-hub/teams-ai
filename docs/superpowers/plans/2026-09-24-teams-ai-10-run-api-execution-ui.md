# teams-ai Plan 10 — Run API and Execution UI Implementation Plan

**Status: not started**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start, resume, stop and watch orchestrator runs from the browser: a Projects screen over registered project directories and an Execution screen that streams one run's journal.

**Architecture:** The UI server (`teams-ai ui`) gains run routes that read project directories and `~/.teams-ai/runs/<runId>/` (never a `Run` object), spawn `teams-ai run|resume` as a detached child, and stream `events.ndjson` over SSE with `Last-Event-ID` replay. The browser reduces the same events with `server/pipeline/run-state.ts` through a Vite alias, so task state is computed by one reducer everywhere. Graceful stop is a new journal event (`RUN_STOP_REQUESTED`) that the run loop already treats as draining.

**Tech Stack:** Node 22, TypeScript, zod 4, the hand-rolled `node:http` router in `server/api/server.ts`, Vitest; React 19 + react-router 7 + Vite 8 + Testing Library in `web/`.

**Spec:** `docs/superpowers/specs/2026-09-24-run-api-execution-ui-design.md`

## Global Constraints

- The UI process never holds a `Run`; it only reads journal files and spawns/signals the CLI (spec §2).
- The journal's single-writer lock stays with the child; the UI reads `events.ndjson` with `loadEvents` and never opens an `EventStore` on it (spec §2).
- Every id used in a filesystem path matches `^[A-Za-z0-9_.-]+$` before joining (spec §4).
- Host check unchanged: only `localhost` / `127.0.0.1` / `[::1]` (spec §7).
- `ui.log` (child stdio) is never served; step files are served only from `runs/<runId>/steps/<stepId>/` (spec §7).
- Browser task state comes from `reduceEvents` in `server/pipeline/run-state.ts`, not a copy (spec §2, §6.2).
- Config keys the UI writes go through `server/onboarding/config-store.ts` (validate with `loadConfig`, write tmp + rename) as `setGithubOwner` does.
- Commit after every task; commit messages in English, conventional style.
- Run `npm run typecheck && npm run lint && npm run format:check && npm test` (root) and `npm run test:web` before each commit that touches the respective tree.

## Review Focus

1. A run started by the CLI (no `pid` file) must list, stream and offer Resume when paused, but never offer Stop — test in Task 4 (`stoppable: false`) and Task 5 (`POST /stop` → 409).
2. A `pid` file whose process died before `RUN_FINISHED` must show `interrupted` and offer Resume, and the stale `pid` file must be removed — test in Task 4.
3. SSE reconnect with `Last-Event-ID` must never resend or skip an event; the browser reducer must drop a seq it has already applied (EventSource retries send the last id) — tests in Task 6 (replay from id) and Task 9 (duplicate seq ignored).
4. A signal during an in-flight step must let the step finish and end the run as `drained` (exit 3), never a torn journal — test in Task 1 (`Run.requestStop` while a dev step is pending).
5. A project directory without `docs/project.json`, or with an invalid one, must be refused with 400 and must not be written to the registry — test in Task 4.

---

### Task 1: Graceful stop — `RUN_STOP_REQUESTED`, `Run.requestStop()`, CLI signal handlers and `--run-id`

**Files:**
- Modify: `server/pipeline/run-state.ts:30-40` (RunEvent), `:96-107` (reducer cases)
- Modify: `server/orchestrator/run.ts:114-121` (`create` takes an optional run id), `:339-359` (`until` on quota pause), add `requestStop()` next to `execute()`
- Modify: `server/cli.ts:26-30` (usage), `:129-130` (factory), `:167-176` (signal handlers)
- Test: `test/pipeline/run-state.test.ts` (existing file; add cases), `test/orchestrator/run.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: `RunEvent.RunStopRequested = 'RUN_STOP_REQUESTED'` (data `{}`), reduced to `status: 'draining'`.
- Produces: `Run.requestStop(): Promise<void>` — journals the event once; a second call is a no-op.
- Produces: `Run.create(deps, runId?: string)` — when `runId` is given it is used verbatim instead of `nextRunId`.
- Produces: `RUN_PAUSED` data gains optional `until: string` (ISO) for `reason: 'quota'`.
- Produces: CLI flag `--run-id <id>` on `run`; `SIGTERM`/`SIGINT` on `run`/`resume` call `requestStop()`.

- [ ] **Step 1: Write the failing reducer test**

Append to `test/pipeline/run-state.test.ts` (inside its top-level `describe`; the file already imports `RunEvent`, `reduceEvents` and `runtime`/`runState` fixtures — add whichever import is missing):

```ts
  it('RUN_STOP_REQUESTED drains and a later pause or resume cannot undo it', () => {
    const s = reduceEvents([
      { type: RunEvent.TaskPlanned, data: { task: makePlanTask({ id: 'T1' }) } },
      { type: RunEvent.RunStopRequested, data: {} },
      { type: RunEvent.RunPaused, data: { reason: 'quota', until: '2026-09-24T10:05:00.000Z' } },
      { type: RunEvent.RunResumed, data: {} },
    ]);
    expect(s.status).toBe('draining');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/pipeline/run-state.test.ts -t "RUN_STOP_REQUESTED"`
Expected: FAIL — `RunEvent.RunStopRequested` is undefined (type error or `status` is `running`).

- [ ] **Step 3: Add the event and reducer case**

In `server/pipeline/run-state.ts`, add to `RunEvent`:

```ts
  RunStopRequested: 'RUN_STOP_REQUESTED',
```

Change `PausedData` to accept the optional timestamp:

```ts
const PausedData = z.object({ reason: z.enum(['quota', 'auth']), until: z.string().optional() });
```

Add the reducer case before `default`:

```ts
    case RunEvent.RunStopRequested: {
      state.status = 'draining';
      return;
    }
```

- [ ] **Step 4: Run the reducer test**

Run: `npx vitest run test/pipeline/run-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Run test**

Append to `describe('Run', ...)` in `test/orchestrator/run.test.ts`:

```ts
  it('requestStop lets the in-flight step finish and ends the run drained', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let devStarted: () => void = () => {};
    const started = new Promise<void>((r) => (devStarted = r));
    const script: Script = async (req) => {
      if (req.kind === 'dev') {
        devStarted();
        await gate;
      }
      return happy(req);
    };
    const run = await Run.create(await withAgents(deps(script, { maxParallel: 1 })));
    const done = run.execute();
    await started;
    await run.requestStop();
    await run.requestStop(); // idempotent
    release();
    expect(await done).toBe('drained');
    const types = run.journal.events.map((e) => e.type);
    expect(types.filter((t) => t === 'RUN_STOP_REQUESTED')).toHaveLength(1);
    const states = [...run.journal.state.tasks.values()].map((t) => t.state);
    expect(states).toContain('merged');
    expect(states).toContain('ready');
    await run.close();
  }, 30_000);

  it('create accepts an explicit run id', async () => {
    const run = await Run.create(await withAgents(deps(happy)), 'spec-001-r7');
    expect(run.runId).toBe('spec-001-r7');
    expect(run.journal.events[0]!.data).toMatchObject({ runId: 'spec-001-r7' });
    await run.close();
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/run.test.ts -t "requestStop|explicit run id"`
Expected: FAIL — `run.requestStop is not a function`; `create` ignores the second argument.

- [ ] **Step 7: Implement `requestStop`, the run id argument and `until`**

In `server/orchestrator/run.ts`, change `create`:

```ts
  static async create(deps: RunDeps, runId?: string): Promise<Run> {
    const id = runId ?? (await nextRunId(deps.ws, deps.spec.specId));
    await fs.mkdir(runDir(deps.ws, id), { recursive: true });
    const journal = await Run.openJournal(deps, id);
    await journal.fact(OrchEvent.RunStarted, { runId: id, specId: deps.spec.specId, projectId: deps.project.projectId });
    return new Run(id, journal, deps);
  }
```

Add after `execute()`:

```ts
  /** Spec (run API) §5: a signal drains — in-flight steps finish, nothing new starts. Idempotent. */
  async requestStop(): Promise<void> {
    if (this.journal.state.status === 'draining') return;
    await this.journal.fact(RunEvent.RunStopRequested, {});
  }
```

In `loop()` and `waitWhilePaused()`, replace the two `RunPaused` quota facts so the UI can show the resume time:

```ts
        if (state.status === 'running') await this.journal.fact(RunEvent.RunPaused, { reason: 'quota', until: this.pauseUntil() });
```

```ts
      if (this.journal.state.status === 'running') await this.journal.fact(RunEvent.RunPaused, { reason: 'quota', until: this.pauseUntil() });
```

and add the helper next to `waitWhilePaused`:

```ts
  private pauseUntil(): string {
    const b = this.breaker.state();
    return (b.status === 'paused' ? b.until : new Date(this.clock().getTime() + 60_000)).toISOString();
  }
```

Note: `loop()` returns `finish('drained')` only when `inflight.size === 0`; after `requestStop` the `Promise.race` wakes on the dev step's completion, the task runner continues to merged through the `draining` branch, and the never-started task stays `ready`. No change to the loop is needed.

- [ ] **Step 8: Run the Run tests**

Run: `npx vitest run test/orchestrator/run.test.ts`
Expected: PASS (the budget-drain test still passes: `RunBudgetExhausted` is untouched).

- [ ] **Step 9: Write the failing CLI test**

Append to `describe('teams-ai cli', ...)` in `test/cli.test.ts`:

```ts
  it('run passes --run-id to the factory and a SIGTERM requests a stop', async () => {
    const seen: Array<string | undefined> = [];
    let stops = 0;
    let resolveRun: (r: 'drained') => void = () => {};
    const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001', '--run-id', 'spec-001-r9']);
    const code = main(
      a.io,
      async (_deps, runId, explicitId) => {
        seen.push(runId, explicitId);
        return {
          runId: explicitId ?? 'x',
          execute: () => new Promise<'drained'>((r) => (resolveRun = r)),
          requestStop: async () => { stops += 1; },
          close: async () => {},
          journal: { state: { tasks: new Map() } },
          accounting: { total: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }) },
        } as never;
      },
      { signals: (cb) => { setTimeout(() => cb(), 5); return () => {}; } },
    );
    await new Promise((r) => setTimeout(r, 20));
    resolveRun('drained');
    expect(await code).toBe(3);
    expect(seen).toEqual([undefined, 'spec-001-r9']);
    expect(stops).toBe(1);
  });
```

- [ ] **Step 10: Run it to verify it fails**

Run: `npx vitest run test/cli.test.ts -t "run-id"`
Expected: FAIL — factory receives no third argument; `hooks.signals` is unknown; `stops` is 0.

- [ ] **Step 11: Implement the flag and the signal hook**

In `server/cli.ts`:

Usage line:

```ts
  teams-ai run    --project <dir> [--spec <id>] [--run-id <id>] [--max-parallel N] [--dry-run]
```

`UiHooks` gains a signal seam (default installs real handlers and returns the remover):

```ts
export interface UiHooks {
  startUi?: (port: number) => Promise<{ port: number; close(): Promise<void> }>;
  waitForSignal?: () => Promise<void>;
  /** Called with the stop callback; returns a function that removes the handlers. */
  signals?: (onStop: () => void) => () => void;
}

function realSignals(onStop: () => void): () => void {
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  return () => {
    process.off('SIGTERM', onStop);
    process.off('SIGINT', onStop);
  };
}
```

Factory signature and default:

```ts
type Factory = (deps: RunDeps, runId?: string, explicitId?: string) => Promise<Run>;
const defaultFactory: Factory = (deps, runId, explicitId) => (runId ? Run.resume(deps, runId) : Run.create(deps, explicitId));

export async function main(io: CliIo, factory: Factory = defaultFactory, hooks: UiHooks = {}): Promise<number> {
```

In the `run`/`resume` branch, replace the three lines from `const run = await factory(...)` through `await run.close()` with:

```ts
    const explicitId = typeof f['run-id'] === 'string' ? f['run-id'] : undefined;
    if (explicitId !== undefined && !/^[A-Za-z0-9_.-]+$/.test(explicitId)) throw new Error('--run-id must match ^[A-Za-z0-9_.-]+$');
    const run = await factory(deps, command === 'resume' ? String(f.run) : undefined, explicitId);
    io.stderr(`run ${run.runId} started`);
    const off = (hooks.signals ?? realSignals)(() => {
      io.stderr('stop requested: draining');
      void run.requestStop();
    });
    let result: ExecuteResult;
    try {
      result = await run.execute();
    } finally {
      off();
      await run.close();
    }
```

- [ ] **Step 12: Run the CLI tests and the whole suite**

Run: `npx vitest run test/cli.test.ts && npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: all PASS. The existing "maps run results to exit codes" test still passes because its fake `Run` has no `requestStop` and no signal fires (the default `realSignals` only registers handlers).

- [ ] **Step 13: Commit**

```bash
git add server/pipeline/run-state.ts server/orchestrator/run.ts server/cli.ts test/pipeline/run-state.test.ts test/orchestrator/run.test.ts test/cli.test.ts
git commit -m "feat(orchestrator): graceful stop on SIGTERM drains the run; run ids can be given up front"
```

---

### Task 2: Browser-safe contracts, `config.projects` and route parameters

**Files:**
- Create: `server/contracts/patterns.ts`
- Modify: `server/contracts/hash.ts:3` (import `HASH_PATTERN` from patterns and re-export), `server/contracts/spec.ts:3-5`, `server/contracts/plan.ts:3-4`
- Modify: `server/config/config.ts:96-104` (projects), `server/onboarding/config-store.ts` (`addProject`)
- Modify: `server/api/server.ts:11-23` (RouteContext, Route), `:88-92` (matching)
- Test: `test/contracts/contracts.test.ts`, `test/onboarding/config-store.test.ts`, `test/api/server-routes.test.ts` (new)

**Interfaces:**
- Produces: `server/contracts/patterns.ts` exporting `HASH_PATTERN` and `AC_ID`; `hash.ts` and `spec.ts` re-export them so existing imports keep working; `plan.ts` imports from `patterns.ts` so `run-state.ts` no longer reaches `node:crypto`.
- Produces: `Config.projects: Array<{ dir: string }>` (default `[]`).
- Produces: `addProject(dir: string, home?: string): Promise<Config>` in `config-store.ts` — idempotent by `dir`.
- Produces: `Route.path` may contain `:name` segments; handlers receive `ctx.params: Record<string, string>` (URL-decoded).

- [ ] **Step 1: Write the failing tests**

Append to `test/contracts/contracts.test.ts`:

```ts
  it('run-state and plan contracts import nothing from node: (browser reducer)', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const out = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', "import('./server/pipeline/run-state.ts').then(() => console.log('ok'))"], { env: { ...process.env, NODE_OPTIONS: '--import tsx' } });
    expect(out.stdout.trim()).toBe('ok');
    const src = await (await import('node:fs/promises')).readFile('server/contracts/plan.ts', 'utf8');
    expect(src).not.toContain("from './hash.js'");
    expect(src).not.toContain("from './spec.js'");
  });
```

Append to `test/onboarding/config-store.test.ts` (it already has a temporary `home` and imports from `config-store.js`; add `addProject` to the import):

```ts
  it('addProject appends once by dir and validates the whole config', async () => {
    await addProject('/home/u/proj', home);
    const twice = await addProject('/home/u/proj', home);
    expect(twice.projects).toEqual([{ dir: '/home/u/proj' }]);
    const raw = JSON.parse(await fs.readFile(userConfigFile(home), 'utf8'));
    expect(raw.projects).toEqual([{ dir: '/home/u/proj' }]);
  });
```

Create `test/api/server-routes.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { matchRoute, startApi, type Route } from '../../server/api/server.js';

const routes: Route[] = [
  { method: 'GET', path: '/api/runs/:runId', handler: async ({ json, params }) => json(200, { runId: params.runId }) },
  { method: 'GET', path: '/api/runs/:runId/steps/:stepId', handler: async ({ json, params }) => json(200, params) },
  { method: 'GET', path: '/api/runs', handler: async ({ json }) => json(200, []) },
];

let api: { port: number; close(): Promise<void> } | null = null;
afterEach(async () => { await api?.close(); api = null; });

describe('route parameters', () => {
  it('matches literal and :param segments and decodes them', () => {
    expect(matchRoute(routes, 'GET', '/api/runs')!.params).toEqual({});
    expect(matchRoute(routes, 'GET', '/api/runs/spec-001-r1')!.params).toEqual({ runId: 'spec-001-r1' });
    expect(matchRoute(routes, 'GET', '/api/runs/a%20b/steps/s00001')!.params).toEqual({ runId: 'a b', stepId: 's00001' });
    expect(matchRoute(routes, 'GET', '/api/runs/x/steps')).toBeNull();
    expect(matchRoute(routes, 'POST', '/api/runs/x')).toBeNull();
  });
  it('hands params to the handler over HTTP', async () => {
    api = await startApi({ routes }, 0);
    const r = await fetch(`http://127.0.0.1:${api.port}/api/runs/spec-001-r1/steps/s00002`);
    expect(await r.json()).toEqual({ runId: 'spec-001-r1', stepId: 's00002' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/contracts/contracts.test.ts test/onboarding/config-store.test.ts test/api/server-routes.test.ts`
Expected: FAIL — `plan.ts` still imports `./hash.js`; `addProject`/`matchRoute` do not exist; `params` undefined.

- [ ] **Step 3: Split the patterns**

Create `server/contracts/patterns.ts`:

```ts
/** Regexes shared by contracts that must also load in the browser (no node: imports here). */
export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const AC_ID = /^AC-\d{3}$/;
```

In `server/contracts/hash.ts` replace the `HASH_PATTERN` line with:

```ts
export { HASH_PATTERN } from './patterns.js';
```

In `server/contracts/spec.ts` replace lines 3–5 with:

```ts
import { canonicalJson, sha256 } from './hash.js';
import { AC_ID, HASH_PATTERN } from './patterns.js';

export { AC_ID };
```

In `server/contracts/plan.ts` replace lines 3–4 with:

```ts
import { AC_ID, HASH_PATTERN } from './patterns.js';
```

- [ ] **Step 4: Add `projects` to the config and `addProject` to the store**

In `server/config/config.ts`, after the `github:` line:

```ts
  /** Directories holding docs/project.json, registered from the UI (spec run API §2). */
  projects: z.array(z.object({ dir: z.string().min(1) })).default([]),
```

In `server/onboarding/config-store.ts`, factor the write out of `setGithubOwner` and add `addProject`:

```ts
async function writeUserConfig(next: Record<string, unknown>, home?: string): Promise<Config> {
  const cfg = loadConfig(next); // validate before writing
  const file = userConfigFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await fs.rename(tmp, file);
  return cfg;
}

export async function setGithubOwner(owner: string, home?: string): Promise<Config> {
  if (!GITHUB_OWNER.test(owner)) throw new RangeError(`not a GitHub login: ${JSON.stringify(owner)}`);
  const { raw } = await readUserConfig(home);
  const github = typeof raw.github === 'object' && raw.github !== null ? (raw.github as Record<string, unknown>) : {};
  return writeUserConfig({ ...raw, github: { ...github, owner } }, home);
}

export async function addProject(dir: string, home?: string): Promise<Config> {
  const { raw, cfg } = await readUserConfig(home);
  if (cfg.projects.some((p) => p.dir === dir)) return cfg;
  return writeUserConfig({ ...raw, projects: [...cfg.projects, { dir }] }, home);
}
```

- [ ] **Step 5: Add route parameters to the server**

In `server/api/server.ts`, extend the context and route types:

```ts
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: () => Promise<unknown>;
  json: (status: number, value: unknown) => void;
  sse: () => SseWriter;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT';
  /** Literal segments or `:name` parameters, e.g. `/api/runs/:runId/events`. */
  path: string;
  handler: (ctx: RouteContext) => Promise<void>;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/');
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split('/');
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i]!;
      const v = parts[i]!;
      if (p.startsWith(':')) {
        if (v === '') { ok = false; break; }
        try { params[p.slice(1)] = decodeURIComponent(v); } catch { ok = false; break; }
      } else if (p !== v) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}
```

Replace the lookup in `startApi`:

```ts
    const match = matchRoute(deps.routes, req.method ?? 'GET', url.pathname);
    if (!match) {
      if (req.method === 'GET' && deps.staticDir && (await serveStatic(deps.staticDir, url.pathname, res))) return done(200);
      return json(404, { error: 'not found' });
    }
```

and pass `params: match.params` in the handler call:

```ts
      await match.route.handler({ req, res, params: match.params, body: () => readBody(req), json, sse });
```

- [ ] **Step 6: Run the tests and the whole suite**

Run: `npx vitest run test/contracts test/onboarding test/api && npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS. `test/config/decisions.test.ts` and `DEFAULT_CONFIG` snapshots still pass (`projects` defaults to `[]`; if a test compares the whole default config, add `projects: []` to its expectation).

- [ ] **Step 7: Commit**

```bash
git add server/contracts/patterns.ts server/contracts/hash.ts server/contracts/spec.ts server/contracts/plan.ts server/config/config.ts server/onboarding/config-store.ts server/api/server.ts test/contracts/contracts.test.ts test/onboarding/config-store.test.ts test/api/server-routes.test.ts
git commit -m "feat(api): route parameters, project registry in config, browser-safe contract patterns"
```

---

### Task 3: Process control — `spawnRun`, `isAlive`, `stop`

**Files:**
- Create: `server/api/run-control.ts`
- Test: `test/api/run-control.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SpawnArgs { bin: string; args: string[]; cwd: string; logFile: string }
export interface RunControlDeps {
  spawn: (a: SpawnArgs) => { pid: number };           // default: detached child_process.spawn, stdio → logFile
  kill: (pid: number, signal: NodeJS.Signals | 0) => boolean; // default: process.kill on the group (-pid), false when ESRCH
  sleep: (ms: number) => Promise<void>;
  cliEntry: () => { bin: string; prefix: string[] };  // default: node + tsx cli + server/cli.ts
  repoRoot: string;
}
export function runCommand(deps, o: { projectDir; specId; runId; mode: 'run' | 'resume' }): SpawnArgs
export function spawnRun(deps, o): { pid: number }
export function isAlive(deps, pid: number): boolean
export async function stop(deps, pid: number, timeoutMs = 15_000): Promise<'terminated' | 'killed' | 'gone'>
export function defaultRunControl(repoRoot: string): RunControlDeps
```

- [ ] **Step 1: Write the failing tests**

Create `test/api/run-control.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isAlive, runCommand, spawnRun, stop, type RunControlDeps } from '../../server/api/run-control.js';

function fake(alive: Set<number>, over: Partial<RunControlDeps> = {}) {
  const spawns: Array<{ bin: string; args: string[]; cwd: string; logFile: string }> = [];
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const sleeps: number[] = [];
  const deps: RunControlDeps = {
    spawn: (a) => { spawns.push(a); alive.add(4242); return { pid: 4242 }; },
    kill: (pid, sig) => { signals.push([pid, sig]); if (!alive.has(Math.abs(pid))) return false; if (sig === 'SIGKILL') alive.delete(Math.abs(pid)); return true; },
    sleep: async (ms) => { sleeps.push(ms); },
    cliEntry: () => ({ bin: '/usr/bin/node', prefix: ['/repo/node_modules/tsx/dist/cli.mjs', '/repo/server/cli.ts'] }),
    repoRoot: '/repo',
    ...over,
  };
  return { deps, spawns, signals, sleeps };
}

describe('run control', () => {
  it('builds the run and resume command lines with the explicit run id', () => {
    const { deps } = fake(new Set());
    expect(runCommand(deps, { projectDir: '/p', specId: 'hello-001', runId: 'hello-001-r2', mode: 'run' })).toEqual({
      bin: '/usr/bin/node',
      args: ['/repo/node_modules/tsx/dist/cli.mjs', '/repo/server/cli.ts', 'run', '--project', '/p', '--spec', 'hello-001', '--run-id', 'hello-001-r2'],
      cwd: '/repo',
      logFile: 'ui.log',
    });
    expect(runCommand(deps, { projectDir: '/p', specId: 'hello-001', runId: 'hello-001-r2', mode: 'resume' }).args.slice(2)).toEqual(['resume', '--project', '/p', '--run', 'hello-001-r2']);
  });
  it('spawnRun returns the pid and isAlive probes with signal 0', () => {
    const alive = new Set<number>();
    const { deps, spawns, signals } = fake(alive);
    expect(spawnRun(deps, { projectDir: '/p', specId: 's', runId: 's-r1', mode: 'run' })).toEqual({ pid: 4242 });
    expect(spawns).toHaveLength(1);
    expect(isAlive(deps, 4242)).toBe(true);
    expect(isAlive(deps, 1)).toBe(false);
    expect(signals).toEqual([[4242, 0], [1, 0]]);
  });
  it('stop sends SIGTERM to the group, polls, and escalates to SIGKILL after the timeout', async () => {
    const alive = new Set([4242]);
    const { deps, signals, sleeps } = fake(alive);
    expect(await stop(deps, 4242, 1000)).toBe('killed');
    expect(signals[0]).toEqual([-4242, 'SIGTERM']);
    expect(sleeps.length).toBe(4); // 1000 / 250
    expect(signals.at(-1)).toEqual([-4242, 'SIGKILL']);
  });
  it('stop reports terminated when the process exits during the poll and gone when it never existed', async () => {
    const alive = new Set([4242]);
    let polls = 0;
    const { deps } = fake(alive, { sleep: async () => { if (++polls === 2) alive.delete(4242); } });
    expect(await stop(deps, 4242, 1000)).toBe('terminated');
    expect(await stop(fake(new Set()).deps, 99, 1000)).toBe('gone');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/api/run-control.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/api/run-control.ts`:

```ts
import { spawn as nodeSpawn } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';

export interface SpawnArgs {
  bin: string;
  args: string[];
  cwd: string;
  logFile: string;
}

export interface RunControlDeps {
  spawn: (a: SpawnArgs) => { pid: number };
  /** `process.kill` semantics: false when the process does not exist. Negative pid = process group. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  sleep: (ms: number) => Promise<void>;
  cliEntry: () => { bin: string; prefix: string[] };
  repoRoot: string;
}

export interface RunTarget {
  projectDir: string;
  specId: string;
  runId: string;
  mode: 'run' | 'resume';
  /** Where ui.log goes; the caller passes the run directory once it exists. */
  logFile?: string;
}

const POLL_MS = 250;

export function runCommand(deps: RunControlDeps, o: RunTarget): SpawnArgs {
  const { bin, prefix } = deps.cliEntry();
  const args = o.mode === 'run' ? ['run', '--project', o.projectDir, '--spec', o.specId, '--run-id', o.runId] : ['resume', '--project', o.projectDir, '--run', o.runId];
  return { bin, args: [...prefix, ...args], cwd: deps.repoRoot, logFile: o.logFile ?? 'ui.log' };
}

export function spawnRun(deps: RunControlDeps, o: RunTarget): { pid: number } {
  return deps.spawn(runCommand(deps, o));
}

export function isAlive(deps: RunControlDeps, pid: number): boolean {
  return deps.kill(pid, 0);
}

/** Spec (run API) §5: SIGTERM to the group, poll, then SIGKILL. */
export async function stop(deps: RunControlDeps, pid: number, timeoutMs = 15_000): Promise<'terminated' | 'killed' | 'gone'> {
  if (!deps.kill(-pid, 'SIGTERM')) return 'gone';
  for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
    await deps.sleep(POLL_MS);
    if (!isAlive(deps, pid)) return 'terminated';
  }
  deps.kill(-pid, 'SIGKILL');
  return 'killed';
}

export function defaultRunControl(repoRoot: string): RunControlDeps {
  return {
    spawn: (a) => {
      const log = openSync(a.logFile, 'a');
      const child = nodeSpawn(a.bin, a.args, { cwd: a.cwd, detached: true, stdio: ['ignore', log, log] });
      child.unref();
      if (child.pid === undefined) throw new Error('spawn returned no pid');
      return { pid: child.pid };
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw err;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    cliEntry: () => ({ bin: process.execPath, prefix: [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repoRoot, 'server', 'cli.ts')] }),
    repoRoot,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/api/run-control.test.ts && npm run typecheck && npm run lint && npm run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/run-control.ts test/api/run-control.test.ts
git commit -m "feat(api): detached run process control with graceful stop"
```

---

### Task 4: Run index — projects, specs and runs from the filesystem; `GET/POST /api/projects`, `GET /api/projects/:projectId/runs`

**Files:**
- Create: `server/api/run-index.ts`, `server/api/run-routes.ts`
- Create: `test/fixtures/runs/write-run.ts` (helper to lay down a fake run directory)
- Test: `test/api/run-index.test.ts`, `test/api/run-api.test.ts`

**Interfaces:**
- Produces (`run-index.ts`):

```ts
export const SAFE_ID = /^[A-Za-z0-9_.-]+$/;
export type RunListStatus = 'running' | 'paused:quota' | 'paused:auth' | 'draining' | 'complete' | 'blocked' | 'deadlocked' | 'drained' | 'phase-failed' | 'interrupted' | 'unknown';
export interface RunRow { runId: string; specId: string; projectId: string; status: RunListStatus; at: string | null; tokens: number; cost: number; stoppable: boolean }
export interface SpecRow { specId: string; status: string; activeRunId: string | null }
export interface ProjectRow { projectId: string; dir: string; specs: SpecRow[] }
export interface IndexDeps { cfg: Config; home?: string; isAlive: (pid: number) => boolean }
export async function readProject(dir: string): Promise<{ project: Project; specs: Spec[] }>   // throws on missing/invalid
export async function listRuns(deps: IndexDeps, projectId: string): Promise<RunRow[]>          // newest first
export async function listProjects(deps: IndexDeps): Promise<ProjectRow[]>
export async function readPid(runsDir: string, runId: string): Promise<number | null>
export async function writePid(runsDir: string, runId: string, pid: number): Promise<void>
export async function clearPid(runsDir: string, runId: string): Promise<void>
```

- Produces (`run-routes.ts`): `runRoutes(deps: RunRoutesDeps): Route[]` with `RunRoutesDeps = { cfg: () => Promise<Config>; home?: string; control: RunControlDeps; log?: (l: string) => void }`. `cfg` is a function so a project added at runtime is visible without restart.
- Produces (`test/fixtures/runs/write-run.ts`): `writeRun(runsDir, runId, events: Array<{type; data; kind?}>, state?: object | null, pid?: number)` that writes `events.ndjson` (seq/at/runId/specHash filled in) and `state.json`.

- [ ] **Step 1: Write the fixture helper**

Create `test/fixtures/runs/write-run.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface FixtureEvent { type: string; data?: Record<string, unknown>; kind?: 'fact' | 'intent' | 'confirm'; intentId?: string }

const HASH = 'sha256:' + 'a'.repeat(64);

export function eventLines(runId: string, events: FixtureEvent[], startSeq = 1, at = '2026-09-24T10:00:00.000Z'): string {
  return events
    .map((e, i) => JSON.stringify({ seq: startSeq + i, at, runId, specHash: HASH, type: e.type, kind: e.kind ?? 'fact', ...(e.intentId ? { intentId: e.intentId } : {}), data: e.data ?? {} }))
    .join('\n');
}

export async function writeRun(runsDir: string, runId: string, events: FixtureEvent[], state: Record<string, unknown> | null = null, pid?: number): Promise<string> {
  const dir = path.join(runsDir, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'events.ndjson'), events.length ? `${eventLines(runId, events)}\n` : '');
  if (state) await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  if (pid !== undefined) await fs.writeFile(path.join(dir, 'pid'), String(pid));
  return dir;
}

export async function appendEvents(runsDir: string, runId: string, events: FixtureEvent[], startSeq: number): Promise<void> {
  await fs.appendFile(path.join(runsDir, runId, 'events.ndjson'), `${eventLines(runId, events, startSeq)}\n`);
}
```

- [ ] **Step 2: Write the failing index tests**

Create `test/api/run-index.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { listProjects, listRuns, readProject, SAFE_ID } from '../../server/api/run-index.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
let runs = '';
const alive = new Set<number>();
const deps = () => ({ cfg: loadConfig({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }), home, isAlive: (pid: number) => alive.has(pid) });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-idx-'));
  runs = path.join(home, 'runs');
  alive.clear();
});
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

const started = (runId: string) => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
const state = (status: string) => ({ runId: 'x', at: '2026-09-24T10:01:00.000Z', status, tasks: [], tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25, steps: 2 } });

describe('run index', () => {
  it('readProject parses project.json and every spec', async () => {
    const { project, specs } = await readProject(HELLO);
    expect(project.projectId).toBe('hello-app');
    expect(specs.map((s) => [s.specId, s.status])).toEqual([['hello-001', 'running']]);
    await expect(readProject(home)).rejects.toThrow(/project\.json/);
  });

  it('lists runs newest first with status from state.json, pid liveness and stoppable', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2')], state('paused:auth'));
    await writeRun(runs, 'hello-001-r3', [started('hello-001-r3')], state('running'), 777);
    await writeRun(runs, 'hello-001-r4', [started('hello-001-r4')], state('running'), 778);
    alive.add(778);
    await writeRun(runs, 'other-r1', [{ type: 'RUN_STARTED', data: { runId: 'other-r1', specId: 'o', projectId: 'other' } }], state('running'));
    await fs.mkdir(path.join(runs, 'hello-001-r5'), { recursive: true });
    const rows = await listRuns(deps(), 'hello-app');
    expect(rows.map((r) => [r.runId, r.status, r.stoppable])).toEqual([
      ['hello-001-r5', 'unknown', false],
      ['hello-001-r4', 'running', true],
      ['hello-001-r3', 'interrupted', false],
      ['hello-001-r2', 'paused:auth', false],
      ['hello-001-r1', 'complete', false],
    ]);
    expect(rows[1]).toMatchObject({ specId: 'hello-001', projectId: 'hello-app', tokens: 150, cost: 0.25, at: '2026-09-24T10:01:00.000Z' });
    // the dead pid file is gone after the listing
    await expect(fs.access(path.join(runs, 'hello-001-r3', 'pid'))).rejects.toThrow();
  });

  it('listProjects reports specs with their active run and skips unreadable dirs', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('paused:quota'), 1);
    const d = deps();
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), projects: [{ dir: HELLO }, { dir: path.join(home, 'missing') }] });
    const rows = await listProjects(d);
    expect(rows).toEqual([{ projectId: 'hello-app', dir: HELLO, specs: [{ specId: 'hello-001', status: 'running', activeRunId: 'hello-001-r1' }] }]);
  });

  it('SAFE_ID rejects path tricks', () => {
    expect(SAFE_ID.test('hello-001-r1')).toBe(true);
    expect(SAFE_ID.test('../x')).toBe(false);
    expect(SAFE_ID.test('a/b')).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/api/run-index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `run-index.ts`**

Create `server/api/run-index.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { Project } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';
import { expandHome } from '../orchestrator/workspace.js';
import { loadEvents } from '../store/event-store.js';

export const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

export type RunListStatus = 'running' | 'paused:quota' | 'paused:auth' | 'draining' | 'complete' | 'blocked' | 'deadlocked' | 'drained' | 'phase-failed' | 'interrupted' | 'unknown';
const ACTIVE: ReadonlySet<string> = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);

export interface RunRow { runId: string; specId: string; projectId: string; status: RunListStatus; at: string | null; tokens: number; cost: number; stoppable: boolean }
export interface SpecRow { specId: string; status: string; activeRunId: string | null }
export interface ProjectRow { projectId: string; dir: string; specs: SpecRow[] }
export interface IndexDeps { cfg: Config; home?: string; isAlive: (pid: number) => boolean }

export function runsDir(deps: IndexDeps): string {
  return expandHome(deps.cfg.paths.runs, deps.home);
}

export async function readProject(dir: string): Promise<{ project: Project; specs: Spec[] }> {
  const project = Project.parse(JSON.parse(await fs.readFile(path.join(dir, 'docs', 'project.json'), 'utf8')));
  const specsDir = path.join(dir, 'docs', 'specs');
  const ids = await fs.readdir(specsDir).catch(() => [] as string[]);
  const specs: Spec[] = [];
  for (const id of ids.sort()) {
    const text = await fs.readFile(path.join(specsDir, id, 'spec.json'), 'utf8').catch(() => null);
    if (text !== null) specs.push(Spec.parse(JSON.parse(text)));
  }
  return { project, specs };
}

const pidFile = (runs: string, runId: string) => path.join(runs, runId, 'pid');
export async function readPid(runs: string, runId: string): Promise<number | null> {
  const t = await fs.readFile(pidFile(runs, runId), 'utf8').catch(() => null);
  const n = t === null ? NaN : Number(t.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
export async function writePid(runs: string, runId: string, pid: number): Promise<void> {
  await fs.writeFile(pidFile(runs, runId), String(pid));
}
export async function clearPid(runs: string, runId: string): Promise<void> {
  await fs.rm(pidFile(runs, runId), { force: true });
}

interface StateFile { at?: string; status?: string; tokens?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }

async function runRow(deps: IndexDeps, runId: string): Promise<RunRow | null> {
  const runs = runsDir(deps);
  const events = await loadEvents(path.join(runs, runId, 'events.ndjson')).catch(() => []);
  const startedAt = events.find((e) => e.type === 'RUN_STARTED');
  const specId = String(startedAt?.data.specId ?? runId.replace(/-r\d+$/, ''));
  const projectId = startedAt ? String(startedAt.data.projectId) : null;
  const finished = [...events].reverse().find((e) => e.type === 'RUN_FINISHED');
  const state: StateFile | null = await fs.readFile(path.join(runs, runId, 'state.json'), 'utf8').then((t) => JSON.parse(t) as StateFile).catch(() => null);
  const pid = await readPid(runs, runId);
  const alive = pid !== null && deps.isAlive(pid);
  if (pid !== null && !alive) await clearPid(runs, runId);
  let status: RunListStatus;
  if (finished) status = String(finished.data.result) as RunListStatus;
  else if (!state?.status) status = 'unknown';
  else if (pid !== null && !alive) status = 'interrupted';
  else status = state.status as RunListStatus;
  const tokens = (state?.tokens?.inputTokens ?? 0) + (state?.tokens?.outputTokens ?? 0);
  return { runId, specId, projectId: projectId ?? '', status, at: state?.at ?? finished?.at ?? null, tokens, cost: state?.tokens?.costUsd ?? 0, stoppable: alive && ACTIVE.has(status) };
}

export async function listRuns(deps: IndexDeps, projectId: string): Promise<RunRow[]> {
  const runs = runsDir(deps);
  const names = (await fs.readdir(runs).catch(() => [] as string[])).filter((n) => SAFE_ID.test(n));
  const rows: RunRow[] = [];
  for (const runId of names) {
    const row = await runRow(deps, runId);
    if (row && row.projectId === projectId) rows.push(row);
  }
  // newest first: by state timestamp, then by the numeric suffix
  return rows.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || Number(/-r(\d+)$/.exec(b.runId)?.[1] ?? 0) - Number(/-r(\d+)$/.exec(a.runId)?.[1] ?? 0));
}

export async function listProjects(deps: IndexDeps): Promise<ProjectRow[]> {
  const out: ProjectRow[] = [];
  for (const { dir } of deps.cfg.projects) {
    const read = await readProject(dir).catch(() => null);
    if (!read) continue;
    const runs = await listRuns(deps, read.project.projectId);
    out.push({
      projectId: read.project.projectId,
      dir,
      specs: read.specs.map((s) => ({ specId: s.specId, status: s.status, activeRunId: runs.find((r) => r.specId === s.specId && ACTIVE.has(r.status))?.runId ?? null })),
    });
  }
  return out;
}
```

Note on ordering in the test: `hello-001-r5` has no `state.json`, so `at` is `null`; `''.localeCompare('2026…')` is negative, which puts null-dated rows first — that is the documented "newest first, unknown on top" order the UI shows so a just-started run is visible immediately.

- [ ] **Step 5: Run the index tests**

Run: `npx vitest run test/api/run-index.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing route tests**

Create `test/api/run-api.test.ts` (Tasks 5 and 6 append to this file):

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRoutes } from '../../server/api/run-routes.js';
import { startApi } from '../../server/api/server.js';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
let runs = '';
let api: { port: number; close(): Promise<void> };
const alive = new Set<number>();
let spawns: Array<{ args: string[]; logFile: string }>;
let signals: Array<[number, string | number]>;
let onSpawn: (runId: string) => Promise<void>;
const base = () => `http://127.0.0.1:${api.port}`;
const post = (p: string, body?: unknown) => fetch(`${base()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runapi-'));
  runs = path.join(home, 'runs');
  await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
  await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }));
  alive.clear();
  spawns = [];
  signals = [];
  onSpawn = async () => {};
  const control: RunControlDeps = {
    spawn: (a) => {
      spawns.push({ args: a.args, logFile: a.logFile });
      const runId = a.args[a.args.indexOf('--run-id') + 1] ?? a.args[a.args.indexOf('--run') + 1]!;
      alive.add(5000 + spawns.length);
      void onSpawn(runId);
      return { pid: 5000 + spawns.length };
    },
    kill: (pid, sig) => { signals.push([pid, sig]); const p = Math.abs(pid); if (!alive.has(p)) return false; if (sig === 'SIGTERM' || sig === 'SIGKILL') alive.delete(p); return true; },
    sleep: async () => {},
    cliEntry: () => ({ bin: 'node', prefix: ['cli'] }),
    repoRoot: '/repo',
  };
  api = await startApi({ routes: runRoutes({ cfg: async () => (await readUserConfig(home)).cfg, home, control }) }, 0);
});
afterEach(async () => {
  await api.close();
  await fs.rm(home, { recursive: true, force: true });
});

const started = (runId: string) => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
const state = (status: string) => ({ runId: 'x', at: '2026-09-24T10:01:00.000Z', status, tasks: [], tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, steps: 1 } });

describe('projects', () => {
  it('lists registered projects with specs and runs', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 1);
    const projects = await (await fetch(`${base()}/api/projects`)).json();
    expect(projects).toEqual([{ projectId: 'hello-app', dir: HELLO, specs: [{ specId: 'hello-001', status: 'running', activeRunId: null }] }]);
    const rows = await (await fetch(`${base()}/api/projects/hello-app/runs`)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: 'hello-001-r1', status: 'interrupted', stoppable: false });
  });

  it('registers a project once and refuses a directory without a valid project.json', async () => {
    const other = path.join(home, 'proj');
    await fs.mkdir(path.join(other, 'docs', 'specs'), { recursive: true });
    await fs.writeFile(path.join(other, 'docs', 'project.json'), await fs.readFile(path.join(HELLO, 'docs', 'project.json'), 'utf8'));
    const ok = await post('/api/projects', { dir: other });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ projectId: 'hello-app', dir: other, specs: [] });
    expect((await post('/api/projects', { dir: other })).status).toBe(200);
    expect((await readUserConfig(home)).cfg.projects).toEqual([{ dir: HELLO }, { dir: other }]);
    const bad = await post('/api/projects', { dir: path.join(home, 'nope') });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/project\.json/);
    expect((await post('/api/projects', { dir: 42 })).status).toBe(400);
    expect((await readUserConfig(home)).cfg.projects).toHaveLength(2);
    expect((await fetch(`${base()}/api/projects/nobody/runs`)).status).toBe(404);
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npx vitest run test/api/run-api.test.ts`
Expected: FAIL — `run-routes.js` not found.

- [ ] **Step 8: Implement the first routes**

Create `server/api/run-routes.ts`:

```ts
import path from 'node:path';
import type { Config } from '../config/config.js';
import { addProject } from '../onboarding/config-store.js';
import { isAlive, type RunControlDeps } from './run-control.js';
import { listProjects, listRuns, readProject, type IndexDeps } from './run-index.js';
import { HttpError, type Route } from './server.js';

export interface RunRoutesDeps {
  cfg: () => Promise<Config>;
  home?: string;
  control: RunControlDeps;
  log?: (line: string) => void;
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>)[field] !== 'string') throw new HttpError(400, `${field} must be a string`);
  return (v as Record<string, string>)[field]!;
};

export function runRoutes(deps: RunRoutesDeps): Route[] {
  const index = async (): Promise<IndexDeps> => ({ cfg: await deps.cfg(), home: deps.home, isAlive: (pid) => isAlive(deps.control, pid) });
  const projectDir = async (idx: IndexDeps, projectId: string): Promise<string> => {
    for (const { dir } of idx.cfg.projects) {
      const read = await readProject(dir).catch(() => null);
      if (read?.project.projectId === projectId) return dir;
    }
    throw new HttpError(404, `unknown project ${projectId}`);
  };
  const P = '/api';
  return [
    { method: 'GET', path: `${P}/projects`, handler: async ({ json }) => json(200, await listProjects(await index())) },
    {
      method: 'POST',
      path: `${P}/projects`,
      handler: async ({ body, json }) => {
        const dir = path.resolve(str(await body(), 'dir'));
        const read = await readProject(dir).catch((err: Error) => { throw new HttpError(400, `not a project directory: ${err.message.includes('ENOENT') ? 'docs/project.json is missing' : err.message}`); });
        await addProject(dir, deps.home);
        const idx = await index();
        const rows = await listProjects(idx);
        json(200, rows.find((r) => r.dir === dir) ?? { projectId: read.project.projectId, dir, specs: [] });
      },
    },
    {
      method: 'GET',
      path: `${P}/projects/:projectId/runs`,
      handler: async ({ params, json }) => {
        const idx = await index();
        await projectDir(idx, params.projectId!);
        json(200, await listRuns(idx, params.projectId!));
      },
    },
  ];
}
```

- [ ] **Step 9: Run the route tests and the suite**

Run: `npx vitest run test/api && npm run typecheck && npm run lint && npm run format:check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/api/run-index.ts server/api/run-routes.ts test/fixtures/runs/write-run.ts test/api/run-index.test.ts test/api/run-api.test.ts
git commit -m "feat(api): project registry and run listing from the filesystem"
```

---

### Task 5: Start, resume and stop routes

**Files:**
- Modify: `server/api/run-routes.ts`
- Test: `test/api/run-api.test.ts`

**Interfaces:**
- Consumes: `spawnRun`, `stop`, `isAlive` (Task 3); `readPid/writePid/clearPid`, `listRuns`, `runsDir` (Task 4); `nextRunId` from `server/orchestrator/workspace.ts`.
- Produces: `POST /api/projects/:projectId/specs/:specId/runs` → `{ runId }`; `POST /api/runs/:runId/resume` → `{ runId }`; `POST /api/runs/:runId/stop` → `{ stopped: true, how: 'terminated' | 'killed' }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/api/run-api.test.ts`:

```ts
describe('start, resume, stop', () => {
  it('starts a run: computes the next id, spawns the CLI, waits for the journal, writes the pid', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    onSpawn = async (runId) => { await writeRun(runs, runId, [started(runId)], state('running')); };
    const r = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ runId: 'hello-001-r2' });
    expect(spawns[0]!.args).toEqual(['cli', 'run', '--project', HELLO, '--spec', 'hello-001', '--run-id', 'hello-001-r2']);
    expect(spawns[0]!.logFile).toBe(path.join(runs, 'hello-001-r2', 'ui.log'));
    expect(await fs.readFile(path.join(runs, 'hello-001-r2', 'pid'), 'utf8')).toBe('5001');
    const rows = await (await fetch(`${base()}/api/projects/hello-app/runs`)).json();
    expect(rows[0]).toMatchObject({ runId: 'hello-001-r2', status: 'running', stoppable: true });
  });

  it('refuses to start while the spec has an active run, or for an unknown spec', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 900);
    alive.add(900);
    expect((await post('/api/projects/hello-app/specs/hello-001/runs')).status).toBe(409);
    expect((await post('/api/projects/hello-app/specs/nope/runs')).status).toBe(404);
    expect(spawns).toHaveLength(0);
  });

  it('reports 500 with the log tail when the child never writes a journal', async () => {
    onSpawn = async (runId) => { await fs.mkdir(path.join(runs, runId), { recursive: true }); await fs.writeFile(path.join(runs, runId, 'ui.log'), 'preconditions failed:\n- claude is not logged in\n'); alive.clear(); };
    const r = await post('/api/projects/hello-app/specs/hello-001/runs');
    expect(r.status).toBe(500);
    expect((await r.json()).error).toContain('claude is not logged in');
  }, 15_000);

  it('resume is allowed only for paused:auth or interrupted runs', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('paused:auth'));
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'));
    await writeRun(runs, 'hello-001-r3', [started('hello-001-r3')], state('running'), 901);
    onSpawn = async () => {};
    const ok = await post('/api/runs/hello-001-r1/resume');
    expect(ok.status).toBe(200);
    expect(spawns[0]!.args).toEqual(['cli', 'resume', '--project', HELLO, '--run', 'hello-001-r1']);
    expect(await fs.readFile(path.join(runs, 'hello-001-r1', 'pid'), 'utf8')).toBe('5001');
    expect((await post('/api/runs/hello-001-r2/resume')).status).toBe(409);
    const interrupted = await post('/api/runs/hello-001-r3/resume'); // pid 901 is dead
    expect(interrupted.status).toBe(200);
    expect((await post('/api/runs/missing/resume')).status).toBe(404);
    expect((await post('/api/runs/..%2Fx/resume')).status).toBe(400);
  });

  it('stop signals the group and removes the pid; 409 without a live pid', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 950);
    alive.add(950);
    const r = await post('/api/runs/hello-001-r1/stop');
    expect(await r.json()).toEqual({ stopped: true, how: 'terminated' });
    expect(signals[0]).toEqual([-950, 'SIGTERM']);
    await expect(fs.access(path.join(runs, 'hello-001-r1', 'pid'))).rejects.toThrow();
    expect((await post('/api/runs/hello-001-r1/stop')).status).toBe(409);
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2')], state('running'));
    expect((await post('/api/runs/hello-001-r2/stop')).status).toBe(409);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/api/run-api.test.ts -t "start, resume, stop"`
Expected: FAIL — 404 for every route.

- [ ] **Step 3: Implement**

In `server/api/run-routes.ts`, add imports:

```ts
import { promises as fs } from 'node:fs';
import { nextRunId } from '../orchestrator/workspace.js';
import { spawnRun, stop } from './run-control.js';
import { clearPid, readPid, runsDir, SAFE_ID, writePid, type RunRow } from './run-index.js';
```

Add helpers inside `runRoutes` after `projectDir`:

```ts
  const safe = (id: string): string => {
    if (!SAFE_ID.test(id)) throw new HttpError(400, `invalid id ${JSON.stringify(id)}`);
    return id;
  };
  const findRun = async (idx: IndexDeps, runId: string): Promise<{ row: RunRow; dir: string }> => {
    const runs = runsDir(idx);
    await fs.access(path.join(runs, runId, 'events.ndjson')).catch(() => { throw new HttpError(404, `unknown run ${runId}`); });
    const events = await import('../store/event-store.js').then((m) => m.loadEvents(path.join(runs, runId, 'events.ndjson')));
    const projectId = String(events.find((e) => e.type === 'RUN_STARTED')?.data.projectId ?? '');
    const row = (await listRuns(idx, projectId)).find((r) => r.runId === runId);
    if (!row) throw new HttpError(404, `unknown run ${runId}`);
    return { row, dir: await projectDir(idx, projectId) };
  };
  const waitForJournal = async (runs: string, runId: string, pid: number, timeoutMs = 10_000): Promise<void> => {
    const file = path.join(runs, runId, 'events.ndjson');
    for (let waited = 0; waited < timeoutMs; waited += 200) {
      if (await fs.access(file).then(() => true, () => false)) return;
      if (!isAlive(deps.control, pid)) break;
      await deps.control.sleep(200);
    }
    const log = await fs.readFile(path.join(runs, runId, 'ui.log'), 'utf8').catch(() => '');
    throw new HttpError(500, `run ${runId} did not start: ${log.slice(-500) || 'no output'}`);
  };
  const launch = async (idx: IndexDeps, o: { projectDir: string; specId: string; runId: string; mode: 'run' | 'resume' }): Promise<void> => {
    const runs = runsDir(idx);
    await fs.mkdir(path.join(runs, o.runId), { recursive: true });
    const { pid } = spawnRun(deps.control, { ...o, logFile: path.join(runs, o.runId, 'ui.log') });
    await waitForJournal(runs, o.runId, pid);
    await writePid(runs, o.runId, pid);
    deps.log?.(`run ${o.runId} ${o.mode} pid ${pid}`);
  };
```

Note: `waitForJournal` polls with `deps.control.sleep`, so the test's no-op sleep makes the 10 s timeout a tight loop of at most 50 iterations; the 500 test's `alive.clear()` breaks it at once.

Append routes to the returned array:

```ts
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs/:specId/runs`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const dir = await projectDir(idx, params.projectId!);
        const specId = safe(params.specId!);
        const { specs } = await readProject(dir);
        if (!specs.some((s) => s.specId === specId)) throw new HttpError(404, `unknown spec ${specId}`);
        const rows = await listRuns(idx, params.projectId!);
        const active = rows.find((r) => r.specId === specId && ['running', 'paused:quota', 'paused:auth', 'draining'].includes(r.status));
        if (active) throw new HttpError(409, `spec ${specId} already has run ${active.runId} (${active.status})`);
        const runId = await nextRunId({ runs: runsDir(idx) } as Parameters<typeof nextRunId>[0], specId);
        await launch(idx, { projectDir: dir, specId, runId, mode: 'run' });
        json(200, { runId });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/resume`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const { row, dir } = await findRun(idx, runId);
        if (row.status !== 'paused:auth' && row.status !== 'interrupted') throw new HttpError(409, `run ${runId} is ${row.status}; only paused:auth or interrupted runs resume`);
        await launch(idx, { projectDir: dir, specId: row.specId, runId, mode: 'resume' });
        json(200, { runId });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/stop`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        await findRun(idx, runId);
        const runs = runsDir(idx);
        const pid = await readPid(runs, runId);
        if (pid === null || !isAlive(deps.control, pid)) throw new HttpError(409, `run ${runId} has no live process started from the UI`);
        const how = await stop(deps.control, pid);
        await clearPid(runs, runId);
        json(200, { stopped: true, how: how === 'gone' ? 'terminated' : how });
      },
    },
```

`nextRunId` only reads `ws.runs`, hence the narrowed object; if the cast reads badly, change `nextRunId`'s parameter type to `Pick<Workspace, 'runs'>` in `server/orchestrator/workspace.ts` (no behaviour change).

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run test/api && npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/run-routes.ts server/orchestrator/workspace.ts test/api/run-api.test.ts
git commit -m "feat(api): start, resume and stop runs as detached CLI processes"
```

---

### Task 6: Run detail, SSE replay/tail, step artifacts

**Files:**
- Modify: `server/api/run-routes.ts`
- Create: `server/api/journal-tail.ts`
- Test: `test/api/journal-tail.test.ts`, `test/api/run-api.test.ts`

**Interfaces:**
- Produces (`journal-tail.ts`): `tailJournal(file, afterSeq, onEvent: (e: StoredEvent) => void, opts: { pollMs?: number; sleep? }): { close(): void }` — reads lines beyond the bytes already consumed, parses complete lines only, calls `onEvent` for `seq > afterSeq`, stops when closed.
- Produces: `GET /api/runs/:runId` → `{ runId, specId, projectId, status, state: { status, order, tasks: TaskRuntime[] }, finished: data | null, tokens: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, steps }, acceptanceCriteria: [{ id, given, when, then, smoke }] }`.
- Produces: `GET /api/runs/:runId/events` (SSE, `event: journal`, `id: <seq>`, then `event: end`), `GET /api/runs/:runId/steps/:stepId` → `{ prompt: string, output: unknown }`.

- [ ] **Step 1: Write the failing tail test**

Create `test/api/journal-tail.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tailJournal } from '../../server/api/journal-tail.js';
import type { StoredEvent } from '../../server/store/event-store.js';
import { appendEvents, writeRun } from '../fixtures/runs/write-run.js';

describe('tailJournal', () => {
  it('delivers only events after the given seq, tolerates a torn last line, and stops on close', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-tail-'));
    await writeRun(home, 'r1', [{ type: 'A' }, { type: 'B' }]);
    const file = path.join(home, 'r1', 'events.ndjson');
    const seen: StoredEvent[] = [];
    let wake: () => void = () => {};
    const sleep = () => new Promise<void>((r) => (wake = r));
    const t = tailJournal(file, 1, (e) => seen.push(e), { sleep });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((e) => e.type)).toEqual(['B']);
    await appendEvents(home, 'r1', [{ type: 'C' }], 3);
    await fs.appendFile(file, '{"seq":4,"type":"D"'); // torn
    wake();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((e) => e.type)).toEqual(['B', 'C']);
    await fs.appendFile(file, ',"at":"x","runId":"r1","specHash":"h","kind":"fact","data":{}}\n');
    wake();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((e) => e.type)).toEqual(['B', 'C', 'D']);
    t.close();
    wake();
    await appendEvents(home, 'r1', [{ type: 'E' }], 5);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(3);
    await fs.rm(home, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/api/journal-tail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tail**

Create `server/api/journal-tail.ts`:

```ts
import { promises as fs } from 'node:fs';
import type { StoredEvent } from '../store/event-store.js';

export interface TailOpts {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Spec (run API) §4: after replay, follow events.ndjson. Only complete lines (ending in '\n') are
 * parsed, so a line the writer is still appending is picked up on the next poll. fs.watch is not
 * used: it is unreliable for appends on some WSL filesystems and the poll is cheap.
 */
export function tailJournal(file: string, afterSeq: number, onEvent: (e: StoredEvent) => void, opts: TailOpts = {}): { close(): void } {
  const pollMs = opts.pollMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let closed = false;
  let offset = 0;
  let last = afterSeq;
  const tick = async (): Promise<void> => {
    const handle = await fs.open(file, 'r').catch(() => null);
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return;
      offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
      for (const line of text.slice(0, end).split('\n')) {
        if (line.trim() === '') continue;
        let e: StoredEvent;
        try {
          e = JSON.parse(line) as StoredEvent;
        } catch {
          continue;
        }
        if (typeof e.seq === 'number' && e.seq > last) {
          last = e.seq;
          if (!closed) onEvent(e);
        }
      }
    } finally {
      await handle.close();
    }
  };
  void (async () => {
    while (!closed) {
      await tick();
      if (closed) break;
      await sleep(pollMs);
    }
  })();
  return { close: () => { closed = true; } };
}
```

- [ ] **Step 4: Run the tail test**

Run: `npx vitest run test/api/journal-tail.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

Append to `test/api/run-api.test.ts`:

```ts
import { eventLines } from '../fixtures/runs/write-run.js'; // move to the top imports

const task = (id: string) => ({ id, title: id, description: 'd', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: [`src/${id}/**`], owner: 'dev' });

async function readSse(url: string, lastId: string | null, until: (events: Array<{ event: string; id: string | null; data: string }>) => boolean, timeoutMs = 5000) {
  const res = await fetch(url, { headers: lastId === null ? {} : { 'last-event-id': lastId } });
  if (!res.ok) return { status: res.status, events: [] as Array<{ event: string; id: string | null; data: string }> };
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: Array<{ event: string; id: string | null; data: string }> = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 300))]);
    if (value) buf += dec.decode(value);
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i < 0) break;
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const get = (k: string) => block.split('\n').find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2) ?? null;
      events.push({ event: get('event') ?? 'message', id: get('id'), data: get('data') ?? '' });
    }
    if (until(events) || done) break;
  }
  await reader.cancel().catch(() => {});
  return { status: res.status, events };
}

describe('run detail, events and steps', () => {
  it('detail computes state and tokens from the journal and carries the acceptance criteria', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      { type: 'TASK_PLANNED', data: { task: task('T1') } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'ready' } },
      { type: 'STEP_STARTED', data: { stepId: 's00001', kind: 'dev', role: 'dev', taskId: 'T1', attempt: 1, tokens: 10, dropped: [] } },
      { type: 'STEP_FINISHED', data: { stepId: 's00001', kind: 'dev', taskId: 'T1', attempt: 1, ok: true, failure: null, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 }, costUsd: 0.5, durationMs: 10, numTurns: 1 } },
      { type: 'RUN_PAUSED', data: { reason: 'quota', until: '2026-09-24T10:30:00.000Z' } },
    ], state('running'));
    const r = await fetch(`${base()}/api/runs/hello-001-r1`);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d).toMatchObject({ runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'paused:quota', finished: null });
    expect(d.state.order).toEqual(['T1']);
    expect(d.state.tasks[0]).toMatchObject({ state: 'ready', attempts: 0, def: { id: 'T1' } });
    expect(d.tokens).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd: 0.5, steps: 1 });
    expect(d.acceptanceCriteria.map((a: { id: string }) => a.id)).toEqual(['AC-001', 'AC-002', 'AC-003']);
    expect((await fetch(`${base()}/api/runs/nope`)).status).toBe(404);
  });

  it('events replays from Last-Event-ID, tails appended lines and ends after RUN_FINISHED', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'PHASE_STARTED', data: { phase: 1 } }, { type: 'PHASE_STARTED', data: { phase: 2 } }], state('running'));
    const first = await readSse(`${base()}/api/runs/hello-001-r1/events`, null, (ev) => ev.length >= 3);
    expect(first.events.map((e) => [e.event, e.id])).toEqual([['journal', '1'], ['journal', '2'], ['journal', '3']]);
    expect(JSON.parse(first.events[2]!.data)).toMatchObject({ seq: 3, type: 'PHASE_STARTED' });
    const later = readSse(`${base()}/api/runs/hello-001-r1/events`, '2', (ev) => ev.some((e) => e.event === 'end'));
    await new Promise((r) => setTimeout(r, 50));
    await appendEvents(runs, 'hello-001-r1', [{ type: 'RUN_FINISHED', data: { result: 'complete', merged: [], blocked: [], tokens: {} } }], 4);
    const { events } = await later;
    expect(events.map((e) => [e.event, e.id])).toEqual([['journal', '3'], ['journal', '4'], ['end', null]]);
    expect((await readSse(`${base()}/api/runs/nope/events`, null, () => true)).status).toBe(404);
  });

  it('a corrupt journal is reported as 500 on detail and events', async () => {
    const dir = await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'));
    await fs.appendFile(path.join(dir, 'events.ndjson'), 'not json\n' + eventLines('hello-001-r1', [{ type: 'X' }], 3) + '\n');
    const r = await fetch(`${base()}/api/runs/hello-001-r1`);
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/corrupt/);
  });

  it('serves step artifacts from the run directory only', async () => {
    const dir = await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'));
    await fs.mkdir(path.join(dir, 'steps', 's00001'), { recursive: true });
    await fs.writeFile(path.join(dir, 'steps', 's00001', 'prompt.md'), '# prompt');
    await fs.writeFile(path.join(dir, 'steps', 's00001', 'output.json'), JSON.stringify({ ok: true, value: { summary: 'x' } }));
    expect(await (await fetch(`${base()}/api/runs/hello-001-r1/steps/s00001`)).json()).toEqual({ prompt: '# prompt', output: { ok: true, value: { summary: 'x' } } });
    expect((await fetch(`${base()}/api/runs/hello-001-r1/steps/s00002`)).status).toBe(404);
    expect((await fetch(`${base()}/api/runs/hello-001-r1/steps/..%2Fui.log`)).status).toBe(400);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run test/api/run-api.test.ts -t "detail, events and steps"`
Expected: FAIL — 404 on the new routes.

- [ ] **Step 7: Implement the routes**

In `server/api/run-routes.ts`, add imports:

```ts
import { Accounting } from '../budget/accounting.js';
import type { Role } from '../config/config.js';
import type { StepKind } from '../agents/outputs.js';
import { reduceEvents } from '../pipeline/run-state.js';
import { EventLogCorruptError, loadEvents, type StoredEvent } from '../store/event-store.js';
import { tailJournal } from './journal-tail.js';
```

Replace the dynamic import in `findRun` with a plain `loadEvents(...)` call now that it is imported, wrapped so corruption maps to 500:

```ts
  const events = async (runs: string, runId: string): Promise<StoredEvent[]> => {
    const file = path.join(runs, runId, 'events.ndjson');
    await fs.access(file).catch(() => { throw new HttpError(404, `unknown run ${runId}`); });
    try {
      return await loadEvents(file);
    } catch (err) {
      if (err instanceof EventLogCorruptError) throw new HttpError(500, 'journal corrupt; run teams-ai status --repair');
      throw err;
    }
  };
```

(and use `events(runs, runId)` inside `findRun`).

Add the token rebuild, the mirror of `Run.rebuildAccounting`:

```ts
  const tokensOf = (evs: StoredEvent[]) => {
    const acc = new Accounting();
    const started = new Map<string, Record<string, unknown>>();
    for (const e of evs) {
      if (e.type === 'STEP_STARTED') started.set(String(e.data.stepId), e.data);
      if (e.type !== 'STEP_FINISHED') continue;
      const s = started.get(String(e.data.stepId));
      const usage = e.data.usage as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
      if (!s || !usage) continue;
      acc.record({ role: s.role as Role, phase: e.data.taskId ? 'phase3' : 'phase', taskId: (e.data.taskId as string | null) ?? null, attempt: Number(e.data.attempt ?? 0), stepKind: e.data.kind as StepKind, provider: 'claude', model: 'unknown', usage, costUsd: (e.data.costUsd as number | null) ?? null, durationMs: Number(e.data.durationMs ?? 0), numTurns: Number(e.data.numTurns ?? 0), at: e.at });
    }
    return acc.total();
  };
```

Append routes:

```ts
    {
      method: 'GET',
      path: `${P}/runs/:runId`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const runs = runsDir(idx);
        const evs = await events(runs, runId);
        const startedEv = evs.find((e) => e.type === 'RUN_STARTED');
        const specId = String(startedEv?.data.specId ?? '');
        const projectId = String(startedEv?.data.projectId ?? '');
        const finished = [...evs].reverse().find((e) => e.type === 'RUN_FINISHED') ?? null;
        const state = reduceEvents(evs);
        const spec = await projectDir(idx, projectId).then(readProject).then((p) => p.specs.find((s) => s.specId === specId) ?? null).catch(() => null);
        json(200, {
          runId,
          specId,
          projectId,
          status: finished ? String(finished.data.result) : state.status,
          state: { status: state.status, order: state.order, tasks: state.order.map((id) => state.tasks.get(id)) },
          finished: finished?.data ?? null,
          tokens: tokensOf(evs),
          acceptanceCriteria: spec?.acceptanceCriteria ?? [],
        });
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/events`,
      handler: async ({ req, params, sse }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const runs = runsDir(idx);
        const file = path.join(runs, runId, 'events.ndjson');
        const evs = await events(runs, runId);
        const header = req.headers['last-event-id'];
        const after = Number(Array.isArray(header) ? header[0] : header ?? 0) || 0;
        const w = sse();
        let last = after;
        const send = (e: StoredEvent) => {
          last = e.seq;
          w.send('journal', e, String(e.seq));
          if (e.type === 'RUN_FINISHED') {
            w.send('end', {});
            tail?.close();
            w.close();
          }
        };
        let tail: { close(): void } | null = null;
        for (const e of evs) if (e.seq > after) send(e);
        if (evs.some((e) => e.type === 'RUN_FINISHED')) return;
        tail = tailJournal(file, last, send);
        w.onClose(() => tail?.close());
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/steps/:stepId`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const stepId = safe(params.stepId!);
        const dir = path.join(runsDir(idx), runId, 'steps', stepId);
        const prompt = await fs.readFile(path.join(dir, 'prompt.md'), 'utf8').catch(() => null);
        if (prompt === null) throw new HttpError(404, `no step ${stepId} in run ${runId}`);
        const output = await fs.readFile(path.join(dir, 'output.json'), 'utf8').then((t) => JSON.parse(t) as unknown).catch(() => null);
        json(200, { prompt, output });
      },
    },
```

`SseWriter.send` must carry the id. In `server/api/server.ts` change the interface and implementation:

```ts
export interface SseWriter {
  send(event: string, data: unknown, id?: string): void;
  close(): void;
  onClose(cb: () => void): void;
}
```

```ts
        send: (event, data, id) => void res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
```

- [ ] **Step 8: Run the tests and the suite**

Run: `npx vitest run test/api && npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS. The onboarding SSE test still passes (no id when omitted).

- [ ] **Step 9: Commit**

```bash
git add server/api/journal-tail.ts server/api/run-routes.ts server/api/server.ts test/api/journal-tail.test.ts test/api/run-api.test.ts
git commit -m "feat(api): run detail, journal SSE with Last-Event-ID replay, step artifacts"
```

---

### Task 7: Wire the routes into `teams-ai ui`; web API client, generic SSE hook, Projects page

**Files:**
- Modify: `server/cli.ts:37-47` (`startUiReal`)
- Modify: `web/src/api.ts`, `web/src/useSse.ts`, `web/src/App.tsx`, `web/src/styles.css`
- Create: `web/src/pages/Projects.tsx`, `web/src/pages/Projects.test.tsx`
- Modify: `web/vite.config.ts` (`test.include` to also match `.test.ts`), `web/package.json` (add `zod` — needed by Task 8's reducer import)

**Interfaces:**
- Produces (`web/src/api.ts`): types `ProjectRow`, `SpecRow`, `RunRow`, `RunDetail`, `StoredEvent`; `api.projects()`, `api.addProject(dir)`, `api.runs(projectId)`, `api.startRun(projectId, specId)`, `api.resumeRun(runId)`, `api.stopRun(runId)`, `api.run(runId)`, `api.step(runId, stepId)`, `api.runEvents(runId)` (URL).
- Produces (`web/src/useSse.ts`): keeps `useSse` for onboarding; adds `useJournal(url: string | null): { events: StoredEvent[]; ended: boolean; error: string | null }` that appends `journal` events, ignores a seq already present, sets `ended` on `end`.
- Produces: page `Projects` at `/projects`; `ProjectsView` (pure, props) for tests.

- [ ] **Step 1: Wire the routes**

In `server/cli.ts` `startUiReal`, add imports `import { runRoutes } from './api/run-routes.js';`, `import { defaultRunControl } from './api/run-control.js';`, `import { readUserConfig } from './onboarding/config-store.js';` and change the `startApi` call:

```ts
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  return startApi(
    {
      routes: [
        ...onboardingRoutes({ exec: execCommand, fetch: globalThis.fetch, hostEnv: io.env, secretsDir: expandHome(cfg.paths.secrets), spawn: spawnScriptPty, log: io.stderr }),
        ...runRoutes({ cfg: async () => (await readUserConfig()).cfg, control: defaultRunControl(repoRoot), log: io.stderr }),
      ],
      staticDir: hasDist ? staticDir : null,
      log: io.stderr,
    },
    port,
  );
```

Run: `npm run typecheck && npx vitest run test/cli.test.ts` — Expected: PASS.

- [ ] **Step 2: Write the failing Projects test**

Create `web/src/pages/Projects.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ProjectsView } from './Projects.js';

const projects = [{ projectId: 'hello-app', dir: '/p/hello', specs: [{ specId: 'hello-001', status: 'running', activeRunId: null }, { specId: 'hello-002', status: 'running', activeRunId: 'hello-002-r1' }, { specId: 'hello-000', status: 'done', activeRunId: null }] }];
const runs = {
  'hello-app': [
    { runId: 'hello-002-r1', specId: 'hello-002', projectId: 'hello-app', status: 'running', at: '2026-09-24T10:00:00.000Z', tokens: 1500, cost: 0.25, stoppable: true },
    { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'paused:auth', at: '2026-09-24T09:00:00.000Z', tokens: 100, cost: 0.01, stoppable: false },
    { runId: 'hello-000-r1', specId: 'hello-000', projectId: 'hello-app', status: 'complete', at: '2026-09-23T09:00:00.000Z', tokens: 9000, cost: 3.33, stoppable: false },
  ],
};

describe('ProjectsView', () => {
  it('shows one action per spec status and per run status', () => {
    const on = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), add: vi.fn() };
    render(<MemoryRouter><ProjectsView projects={projects} runs={runs} error={null} onStart={on.start} onResume={on.resume} onStop={on.stop} onAdd={on.add} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('start-hello-001'));
    expect(on.start).toHaveBeenCalledWith('hello-app', 'hello-001');
    expect(screen.getByTestId('open-hello-002').getAttribute('href')).toBe('/runs/hello-002-r1');
    expect(screen.queryByTestId('start-hello-000')).toBeNull();
    fireEvent.click(screen.getByTestId('resume-hello-001-r1'));
    expect(on.resume).toHaveBeenCalledWith('hello-001-r1');
    fireEvent.click(screen.getByTestId('stop-hello-002-r1'));
    expect(on.stop).toHaveBeenCalledWith('hello-002-r1');
    expect(screen.queryByTestId('stop-hello-001-r1')).toBeNull();
    expect(screen.getByText('$3.33')).toBeTruthy();
  });
  it('submits a directory to add and shows the error', () => {
    const onAdd = vi.fn();
    render(<MemoryRouter><ProjectsView projects={[]} runs={{}} error="not a project directory" onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={onAdd} /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), { target: { value: '/x' } });
    fireEvent.click(screen.getByText('Add project'));
    expect(onAdd).toHaveBeenCalledWith('/x');
    expect(screen.getByText('not a project directory')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:web`
Expected: FAIL — `./Projects.js` not found.

- [ ] **Step 4: Implement the API client, the hook and the page**

Append to `web/src/api.ts`:

```ts
export interface SpecRow { specId: string; status: string; activeRunId: string | null }
export interface ProjectRow { projectId: string; dir: string; specs: SpecRow[] }
export interface RunRow { runId: string; specId: string; projectId: string; status: string; at: string | null; tokens: number; cost: number; stoppable: boolean }
export interface StoredEvent { seq: number; at: string; runId: string; specHash: string; type: string; kind: 'fact' | 'intent' | 'confirm'; intentId?: string; data: Record<string, unknown> }
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; steps: number }
export interface AcceptanceCriterion { id: string; given: string; when: string; then: string; smoke: boolean }
export interface TaskRow { def: { id: string; title: string; owner: string; dependsOn: string[]; criteriaRefs: string[] }; state: string; attempts: number; replanned: boolean; replacedBy: string[] }
export interface RunDetail { runId: string; specId: string; projectId: string; status: string; state: { status: string; order: string[]; tasks: TaskRow[] }; finished: Record<string, unknown> | null; tokens: Usage; acceptanceCriteria: AcceptanceCriterion[] }

const R = '/api';
const jsonPost = (p: string, body?: unknown) => fetch(`${R}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
export const runApi = {
  projects: () => fetch(`${R}/projects`).then((r) => json<ProjectRow[]>(r)),
  addProject: (dir: string) => jsonPost('/projects', { dir }).then((r) => json<ProjectRow>(r)),
  runs: (projectId: string) => fetch(`${R}/projects/${encodeURIComponent(projectId)}/runs`).then((r) => json<RunRow[]>(r)),
  startRun: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/runs`).then((r) => json<{ runId: string }>(r)),
  resumeRun: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/resume`).then((r) => json<{ runId: string }>(r)),
  stopRun: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/stop`).then((r) => json<{ stopped: boolean }>(r)),
  run: (runId: string) => fetch(`${R}/runs/${encodeURIComponent(runId)}`).then((r) => json<RunDetail>(r)),
  step: (runId: string, stepId: string) => fetch(`${R}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`).then((r) => json<{ prompt: string; output: unknown }>(r)),
  runEvents: (runId: string) => `${R}/runs/${encodeURIComponent(runId)}/events`,
};
```

Append to `web/src/useSse.ts`:

```ts
import type { StoredEvent } from './api.js';

/** Spec (run API) §8: EventSource reconnects with Last-Event-ID; a seq already applied is dropped. */
export function useJournal(url: string | null) {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    setEvents([]);
    setEnded(false);
    const es = new EventSource(url);
    es.addEventListener('journal', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as StoredEvent;
      setEvents((list) => (list.some((x) => x.seq === ev.seq) ? list : [...list, ev]));
    });
    es.addEventListener('end', () => { setEnded(true); es.close(); });
    es.onerror = () => setError('connection lost; retrying');
    es.onopen = () => setError(null);
    return () => es.close();
  }, [url]);
  return { events, ended, error };
}
```

Create `web/src/pages/Projects.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { runApi, type ProjectRow, type RunRow } from '../api.js';

const ACTIVE = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);
const money = (n: number) => `$${n.toFixed(2)}`;

export function ProjectsView(p: { projects: ProjectRow[]; runs: Record<string, RunRow[]>; error: string | null; onStart: (projectId: string, specId: string) => void; onResume: (runId: string) => void; onStop: (runId: string) => void; onAdd: (dir: string) => void }) {
  const [dir, setDir] = useState('');
  return (
    <main>
      <h1>Projects</h1>
      <form onSubmit={(e) => { e.preventDefault(); p.onAdd(dir); }}>
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/path/to/project" />
        <button type="submit" disabled={dir.trim() === ''}>Add project</button>
      </form>
      {p.error ? <p className="error">{p.error}</p> : null}
      {p.projects.map((pr) => (
        <section className="card" key={pr.projectId}>
          <header><h2>{pr.projectId}</h2><code className="hint">{pr.dir}</code></header>
          <table>
            <thead><tr><th>Spec</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {pr.specs.map((s) => (
                <tr key={s.specId}>
                  <td>{s.specId}</td><td>{s.status}</td>
                  <td>
                    {s.activeRunId ? <Link data-testid={`open-${s.specId}`} to={`/runs/${s.activeRunId}`}>Open run</Link>
                      : s.status === 'done' ? null
                      : <button data-testid={`start-${s.specId}`} onClick={() => p.onStart(pr.projectId, s.specId)}>Start run</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table>
            <thead><tr><th>Run</th><th>Spec</th><th>Status</th><th>Tokens</th><th>Cost</th><th></th></tr></thead>
            <tbody>
              {(p.runs[pr.projectId] ?? []).map((r) => (
                <tr key={r.runId}>
                  <td><Link to={`/runs/${r.runId}`}>{r.runId}</Link></td><td>{r.specId}</td><td>{r.status}</td><td>{r.tokens}</td><td>{money(r.cost)}</td>
                  <td className="controls">
                    {r.status === 'paused:auth' || r.status === 'interrupted' ? <button data-testid={`resume-${r.runId}`} onClick={() => p.onResume(r.runId)}>Resume</button> : null}
                    {r.stoppable && ACTIVE.has(r.status) ? <button data-testid={`stop-${r.runId}`} onClick={() => p.onStop(r.runId)}>Stop</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [runs, setRuns] = useState<Record<string, RunRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const list = await runApi.projects();
      setProjects(list);
      const all: Record<string, RunRow[]> = {};
      for (const p of list) all[p.projectId] = await runApi.runs(p.projectId);
      setRuns(all);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    return () => clearInterval(id);
  }, [refresh]);
  const act = (fn: () => Promise<unknown>) => async () => { setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } await refresh(); };
  return <ProjectsView projects={projects} runs={runs} error={error} onStart={(p, s) => void act(() => runApi.startRun(p, s))()} onResume={(r) => void act(() => runApi.resumeRun(r))()} onStop={(r) => void act(() => runApi.stopRun(r))()} onAdd={(d) => void act(() => runApi.addProject(d))()} />;
}
```

Add to `web/src/App.tsx` the import and route:

```tsx
import { Projects } from './pages/Projects.js';
// inside <Routes>:
        <Route path="/projects" element={<Projects />} />
```

Append to `web/src/styles.css`:

```css
table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.3rem 0.4rem; border-bottom: 1px solid #eee; vertical-align: top; }
```

In `web/vite.config.ts` set `test.include: ['src/**/*.test.{ts,tsx}']`. In `web/package.json` add `"zod": "4.6.5"` to `dependencies` and run `npm run web:install`.

- [ ] **Step 5: Run the web tests and build**

Run: `npm run test:web && npm run web:build`
Expected: PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add server/cli.ts web/src/api.ts web/src/useSse.ts web/src/App.tsx web/src/styles.css web/src/pages/Projects.tsx web/src/pages/Projects.test.tsx web/vite.config.ts web/package.json web/package-lock.json
git commit -m "feat(web): projects screen with start, resume and stop; run routes served by teams-ai ui"
```

---

### Task 8: Run selectors in the browser against a recorded journal fixture

**Files:**
- Create: `test/fixtures/runs/hello-run.ndjson`, `web/src/run/selectors.ts`, `web/src/run/selectors.test.ts`
- Modify: `web/vite.config.ts` (alias `@server` → `../server`), `web/tsconfig.json` (`paths`, `include`)

**Interfaces:**
- Produces (`web/src/run/selectors.ts`), all pure over `StoredEvent[]`:

```ts
export function runState(events): { status: string; order: string[]; tasks: Map<string, TaskRuntime> }   // reduceEvents from @server/pipeline/run-state
export function phases(events): Array<{ phase: number; startedAt: string; endedAt: string | null; result: 'done' | 'failed' | 'running'; reason: string | null }>
export function pausedUntil(events): string | null       // ISO from the last RUN_PAUSED{quota} not followed by RUN_RESUMED
export function taskDetail(events, taskId): { attempts: Array<{ attempt: number; steps: StepRow[]; gates: GateRow[]; review: ReviewRow | null }>; pr: { number: number; url: string } | null; merged: boolean; blockedReason: string | null; lockHeld: boolean }
export function tokens(events): { byPhase: Record<string, Usage>; byRole: Record<string, Usage>; total: Usage }   // STEP_FINISHED usage; DECISION_MADE usage as role system1
export function evidence(events, criteria: string[]): Array<{ acId: string; tests: Array<{ id: string; status: string; taskId: string }> }>
```

with `StepRow = { stepId; kind; role; attempt; ok: boolean | null; failure: string | null; usage: Usage | null; durationMs: number | null; tier: string | null }`, `GateRow = { attempt; gate; passed; failedTests: string[] }`, `ReviewRow = { profile; risk; drift; findings: unknown[] }`.

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/runs/hello-run.ndjson` (every line has `seq`, `at`, `runId: "hello-001-r1"`, `specHash: "sha256:aaaa…"` (64 a's), `kind: "fact"`; only `type` and `data` vary — write the file with the helper below, run once, and commit the output):

```ts
// scratch: node --import tsx -e "..." — or add a tiny script test/fixtures/runs/make-hello-run.ts:
import { writeFileSync } from 'node:fs';
import { eventLines } from './write-run.js';
const task = (id: string, deps: string[] = []) => ({ id, title: `Task ${id}`, description: 'd', criteriaRefs: ['AC-001'], dependsOn: deps, affectedPaths: [`src/${id.toLowerCase()}/**`], owner: 'dev' });
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: 0, cacheWriteTokens: 0 });
writeFileSync(new URL('./hello-run.ndjson', import.meta.url), eventLines('hello-001-r1', [
  { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
  { type: 'PHASE_STARTED', data: { phase: 1 } },
  { type: 'STEP_STARTED', data: { stepId: 's00001', kind: 'tech-spec', role: 'sm', taskId: null, attempt: 1, tokens: 900, dropped: [] } },
  { type: 'STEP_FINISHED', data: { stepId: 's00001', kind: 'tech-spec', taskId: null, attempt: 1, ok: true, failure: null, usage: usage(1000, 200), costUsd: 0.1, durationMs: 1000, numTurns: 3 } },
  { type: 'TECH_SPEC_WRITTEN', data: { path: 'docs/specs/hello-001/tech-spec.md', adrs: [], stack: 'node', attempt: 1 } },
  { type: 'DOCS_MERGED', data: { phase: 1, pr: 1, branch: 'docs/hello-001-tech-spec' } },
  { type: 'PHASE_STARTED', data: { phase: 2 } },
  { type: 'STEP_STARTED', data: { stepId: 's00002', kind: 'plan', role: 'sm', taskId: null, attempt: 1, tokens: 900, dropped: [] } },
  { type: 'STEP_FINISHED', data: { stepId: 's00002', kind: 'plan', taskId: null, attempt: 1, ok: true, failure: null, usage: usage(800, 300), costUsd: 0.1, durationMs: 1000, numTurns: 2 } },
  { type: 'TASK_PLANNED', data: { task: task('T1') } },
  { type: 'TASK_PLANNED', data: { task: task('T2', ['T1']) } },
  { type: 'DOCS_MERGED', data: { phase: 2, pr: 2, branch: 'docs/hello-001-plan' } },
  { type: 'PHASE_STARTED', data: { phase: 3 } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'ready' } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'implementing' } },
  { type: 'STEP_STARTED', data: { stepId: 's00003', kind: 'dev', role: 'dev', taskId: 'T1', attempt: 1, tokens: 1200, dropped: [] } },
  { type: 'DECISION_MADE', data: { record: { decisionId: 'model-tier', backend: 'jev', model: 'typesafe/jev-1.13', escalated: false, answers: { tier: { type: 'choice', value: 'small', probabilities: { small: 0.9, medium: 0.1, large: 0 }, confidence: 0.9 } }, attempts: [{ backend: 'jev', outcome: 'answered', confidence: 0.9, model: 'typesafe/jev-1.13', usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.00001 }, message: null }], usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.00001 }, stateChars: 400, stateTruncated: false, durationMs: 300, at: '2026-09-24T10:00:00.000Z' } } },
  { type: 'STEP_FINISHED', data: { stepId: 's00003', kind: 'dev', taskId: 'T1', attempt: 1, ok: true, failure: null, usage: usage(2000, 500), costUsd: 0.3, durationMs: 2000, numTurns: 5 } },
  { type: 'DEV_COMMITTED', data: { taskId: 'T1', sha: 'abc', changedFiles: ['src/t1/index.ts'], summary: 'did T1' } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'validating' } },
  { type: 'GATE_PASSED', data: { taskId: 'T1', gate: 'unit-test', failure: null, exitCode: 0, durationMs: 100, junit: [{ id: 'sum::[AC-001] adds', name: '[AC-001] adds', classname: 'sum', status: 'passed', acIds: ['AC-001'] }] } },
  { type: 'GATE_FAILED', data: { taskId: 'T1', gate: 'lint', failure: 'code', exitCode: 1, durationMs: 50, junit: [] } },
  { type: 'ATTEMPT_CONSUMED', data: { taskId: 'T1' } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'implementing' } },
  { type: 'STEP_STARTED', data: { stepId: 's00004', kind: 'dev', role: 'dev', taskId: 'T1', attempt: 2, tokens: 1300, dropped: [] } },
  { type: 'STEP_FINISHED', data: { stepId: 's00004', kind: 'dev', taskId: 'T1', attempt: 2, ok: true, failure: null, usage: usage(2100, 400), costUsd: 0.3, durationMs: 1500, numTurns: 4 } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'validating' } },
  { type: 'GATE_PASSED', data: { taskId: 'T1', gate: 'unit-test', failure: null, exitCode: 0, durationMs: 100, junit: [{ id: 'sum::[AC-001] adds', name: '[AC-001] adds', classname: 'sum', status: 'passed', acIds: ['AC-001'] }] } },
  { type: 'GATE_PASSED', data: { taskId: 'T1', gate: 'lint', failure: null, exitCode: 0, durationMs: 50, junit: [] } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'reviewing' } },
  { type: 'SCOPE_DRIFT_SCORED', data: { taskId: 'T1', drift: 'none', unrequired: [], source: 'jev' } },
  { type: 'REVIEW_PROFILE_CHOSEN', data: { taskId: 'T1', risk: 'low', profile: 'standard', source: 'jev', forcedBy: null } },
  { type: 'STEP_STARTED', data: { stepId: 's00005', kind: 'review', role: 'test', taskId: 'T1', attempt: 2, tokens: 1500, dropped: [] } },
  { type: 'STEP_FINISHED', data: { stepId: 's00005', kind: 'review', taskId: 'T1', attempt: 2, ok: true, failure: null, usage: usage(1800, 200), costUsd: 0.2, durationMs: 900, numTurns: 2 } },
  { type: 'REVIEW_APPROVED', data: { taskId: 'T1', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }] } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'merging' } },
  { type: 'MERGE_LOCK_ACQUIRED', data: { taskId: 'T1' } },
  { type: 'PR_CREATED', data: { branch: 'task/hello-001/T1', number: 3, url: 'https://github.com/o/r/pull/3', created: true } },
  { type: 'PR_MERGED', data: { taskId: 'T1', pr: 3, sha: 'def', already: false, warning: null, handoff: null } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1', to: 'merged' } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: 'T2', to: 'ready' } },
  { type: 'RUN_PAUSED', data: { reason: 'quota', until: '2026-09-24T10:30:00.000Z' } },
]) + '\n');
```

Check the task-state transitions used above against `server/pipeline/task-state.ts` (`ready → implementing → validating → implementing` on a failed gate, `validating → reviewing → merging → merged`); if a transition is not allowed there, use the one the runner uses (read `TaskRunner.fail` and `transition` in `server/orchestrator/task-runner.ts`) — the reducer throws on an illegal transition and the selectors test will show it.

- [ ] **Step 2: Write the failing selectors test**

Create `web/src/run/selectors.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../api.js';
import { evidence, pausedUntil, phases, runState, taskDetail, tokens } from './selectors.js';

const events: StoredEvent[] = readFileSync(new URL('../../../test/fixtures/runs/hello-run.ndjson', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('run selectors', () => {
  it('reduces task state with the orchestrator reducer', () => {
    const s = runState(events);
    expect(s.status).toBe('paused:quota');
    expect(s.order).toEqual(['T1', 'T2']);
    expect(s.tasks.get('T1')).toMatchObject({ state: 'merged', attempts: 1 });
    expect(s.tasks.get('T2')).toMatchObject({ state: 'ready', attempts: 0 });
  });
  it('phases 1 and 2 are done, 3 is running', () => {
    expect(phases(events).map((p) => [p.phase, p.result])).toEqual([[1, 'done'], [2, 'done'], [3, 'running']]);
  });
  it('paused until comes from the last quota pause', () => {
    expect(pausedUntil(events)).toBe('2026-09-24T10:30:00.000Z');
    expect(pausedUntil([...events, { ...events[0]!, seq: 999, type: 'RUN_RESUMED', data: {} }])).toBeNull();
  });
  it('task detail groups steps, gates and review by attempt and finds the PR', () => {
    const d = taskDetail(events, 'T1');
    expect(d.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(d.attempts[0]!.steps.map((s) => [s.stepId, s.kind, s.ok, s.tier])).toEqual([['s00003', 'dev', true, 'small']]);
    expect(d.attempts[0]!.gates.map((g) => [g.gate, g.passed])).toEqual([['unit-test', true], ['lint', false]]);
    expect(d.attempts[1]!.review).toEqual({ profile: 'standard', risk: 'low', drift: 'none', findings: [] });
    expect(d.pr).toEqual({ number: 3, url: 'https://github.com/o/r/pull/3' });
    expect(d.merged).toBe(true);
    expect(d.blockedReason).toBeNull();
    expect(taskDetail(events, 'T2').attempts).toEqual([]);
  });
  it('tokens by phase, by role, with system1 from decisions', () => {
    const t = tokens(events);
    expect(t.byRole.dev).toMatchObject({ inputTokens: 4100, outputTokens: 900, costUsd: 0.6, steps: 2 });
    expect(t.byRole.system1).toMatchObject({ inputTokens: 50, outputTokens: 5, steps: 1 });
    expect(t.byPhase.phase3.steps).toBe(4);
    expect(t.byPhase.phase.steps).toBe(2);
    expect(t.total.costUsd).toBeCloseTo(1.00001, 5);
  });
  it('evidence takes the latest gate round per task', () => {
    expect(evidence(events, ['AC-001', 'AC-002'])).toEqual([
      { acId: 'AC-001', tests: [{ id: 'sum::[AC-001] adds', status: 'passed', taskId: 'T1' }] },
      { acId: 'AC-002', tests: [] },
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:web`
Expected: FAIL — `./selectors.js` not found (and, until Step 4, the alias is missing).

- [ ] **Step 4: Alias the server reducer and implement the selectors**

`web/vite.config.ts`:

```ts
import path from 'node:path';
// in defineConfig:
  resolve: { alias: { '@server': path.resolve(__dirname, '../server') } },
```

`web/tsconfig.json` `compilerOptions` gains:

```json
    "baseUrl": ".",
    "paths": { "@server/*": ["../server/*"] },
    "allowImportingTsExtensions": false
```

Create `web/src/run/selectors.ts`:

```ts
import { reduceEvents, type TaskRuntime } from '@server/pipeline/run-state.js';
import type { StoredEvent, Usage } from '../api.js';

export type { TaskRuntime };
export interface StepRow { stepId: string; kind: string; role: string; attempt: number; ok: boolean | null; failure: string | null; usage: Usage | null; durationMs: number | null; tier: string | null }
export interface GateRow { attempt: number; gate: string; passed: boolean; failedTests: string[] }
export interface ReviewRow { profile: string; risk: string; drift: string | null; findings: unknown[] }

const zero = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 });
const add = (a: Usage, u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }, cost: number | null): Usage => ({
  inputTokens: a.inputTokens + u.inputTokens,
  outputTokens: a.outputTokens + u.outputTokens,
  cacheReadTokens: a.cacheReadTokens + (u.cacheReadTokens ?? 0),
  cacheWriteTokens: a.cacheWriteTokens + (u.cacheWriteTokens ?? 0),
  costUsd: Math.round((a.costUsd + (cost ?? 0)) * 1e8) / 1e8,
  steps: a.steps + 1,
});

export function runState(events: StoredEvent[]) {
  return reduceEvents(events);
}

export function phases(events: StoredEvent[]) {
  const out: Array<{ phase: number; startedAt: string; endedAt: string | null; result: 'done' | 'failed' | 'running'; reason: string | null }> = [];
  for (const e of events) {
    if (e.type === 'PHASE_STARTED') out.push({ phase: Number(e.data.phase), startedAt: e.at, endedAt: null, result: 'running', reason: null });
    const cur = out.at(-1);
    if (!cur) continue;
    if (e.type === 'DOCS_MERGED' && Number(e.data.phase) === cur.phase) Object.assign(cur, { endedAt: e.at, result: 'done' });
    if (e.type === 'PHASE_FAILED' && Number(e.data.phase) === cur.phase) Object.assign(cur, { endedAt: e.at, result: 'failed', reason: String(e.data.reason ?? '') });
    if (e.type === 'RUN_FINISHED' && cur.result === 'running') Object.assign(cur, { endedAt: e.at, result: e.data.result === 'complete' ? 'done' : 'failed', reason: e.data.reason ? String(e.data.reason) : null });
  }
  return out;
}

export function pausedUntil(events: StoredEvent[]): string | null {
  let until: string | null = null;
  for (const e of events) {
    if (e.type === 'RUN_PAUSED') until = e.data.reason === 'quota' ? String(e.data.until ?? '') || null : null;
    if (e.type === 'RUN_RESUMED' || e.type === 'RUN_FINISHED') until = null;
  }
  return until;
}

export function taskDetail(events: StoredEvent[], taskId: string) {
  const attempts = new Map<number, { attempt: number; steps: StepRow[]; gates: GateRow[]; review: ReviewRow | null }>();
  const at = (n: number) => { let a = attempts.get(n); if (!a) { a = { attempt: n, steps: [], gates: [], review: null }; attempts.set(n, a); } return a; };
  let pr: { number: number; url: string } | null = null;
  let merged = false;
  let blockedReason: string | null = null;
  let lockHeld = false;
  let current = 0;
  let pendingTier: string | null = null;
  let pendingReview: Partial<ReviewRow> = {};
  for (const e of events) {
    const d = e.data;
    if (d.taskId !== taskId && e.type !== 'DECISION_MADE' && e.type !== 'PR_CREATED') continue;
    switch (e.type) {
      case 'DECISION_MADE': {
        const r = d.record as { decisionId?: string; answers?: Record<string, { value?: unknown }> } | undefined;
        if (r?.decisionId === 'model-tier') pendingTier = String(r.answers?.tier?.value ?? '') || null;
        break;
      }
      case 'STEP_STARTED': {
        current = Number(d.attempt);
        at(current).steps.push({ stepId: String(d.stepId), kind: String(d.kind), role: String(d.role), attempt: current, ok: null, failure: null, usage: null, durationMs: null, tier: d.kind === 'dev' ? pendingTier : null });
        pendingTier = null;
        break;
      }
      case 'STEP_FINISHED': {
        const s = at(Number(d.attempt)).steps.find((x) => x.stepId === d.stepId);
        if (s) Object.assign(s, { ok: Boolean(d.ok), failure: (d.failure as string | null) ?? null, usage: d.usage ? add(zero(), d.usage as Usage, (d.costUsd as number | null) ?? null) : null, durationMs: Number(d.durationMs ?? 0) });
        break;
      }
      case 'GATE_PASSED':
      case 'GATE_FAILED': {
        const junit = (d.junit as Array<{ id: string; status: string }> | undefined) ?? [];
        at(current).gates.push({ attempt: current, gate: String(d.gate), passed: e.type === 'GATE_PASSED', failedTests: junit.filter((t) => t.status === 'failed').map((t) => t.id) });
        break;
      }
      case 'SCOPE_DRIFT_SCORED': pendingReview.drift = String(d.drift); break;
      case 'REVIEW_PROFILE_CHOSEN': pendingReview = { ...pendingReview, profile: String(d.profile), risk: String(d.risk) }; break;
      case 'REVIEW_APPROVED':
      case 'REVIEW_CHANGES':
        at(current).review = { profile: pendingReview.profile ?? 'standard', risk: pendingReview.risk ?? 'medium', drift: pendingReview.drift ?? null, findings: (d.findings as unknown[] | undefined) ?? [] };
        pendingReview = {};
        break;
      case 'MERGE_LOCK_ACQUIRED': lockHeld = true; break;
      case 'PR_CREATED': if (String(d.branch).endsWith(`/${taskId}`)) pr = { number: Number(d.number), url: String(d.url) }; break;
      case 'PR_MERGED': merged = true; lockHeld = false; break;
      case 'TASK_BLOCKED': blockedReason = String(d.reason); break;
      default: break;
    }
  }
  // steps that never finished in an attempt that was consumed still belong to it; attempt numbers start at 1
  return { attempts: [...attempts.values()].sort((a, b) => a.attempt - b.attempt), pr, merged, blockedReason, lockHeld };
}

export function tokens(events: StoredEvent[]) {
  const byPhase: Record<string, Usage> = {};
  const byRole: Record<string, Usage> = {};
  let total = zero();
  const started = new Map<string, Record<string, unknown>>();
  const book = (phase: string, role: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }, cost: number | null) => {
    byPhase[phase] = add(byPhase[phase] ?? zero(), u, cost);
    byRole[role] = add(byRole[role] ?? zero(), u, cost);
    total = add(total, u, cost);
  };
  for (const e of events) {
    if (e.type === 'STEP_STARTED') started.set(String(e.data.stepId), e.data);
    if (e.type === 'STEP_FINISHED') {
      const s = started.get(String(e.data.stepId));
      const u = e.data.usage as Usage | undefined;
      if (s && u) book(e.data.taskId ? 'phase3' : 'phase', String(s.role), u, (e.data.costUsd as number | null) ?? null);
    }
    if (e.type === 'DECISION_MADE') {
      const r = e.data.record as { usage?: { inputTokens: number; outputTokens: number; costUsd: number | null } } | undefined;
      if (r?.usage) book('decide', 'system1', r.usage, r.usage.costUsd);
    }
  }
  return { byPhase, byRole, total };
}

export function evidence(events: StoredEvent[], criteria: string[]) {
  // latest gate round per task and gate: the same test id from a later event replaces the earlier one
  const latest = new Map<string, Map<string, { id: string; status: string; acIds: string[] }>>();
  for (const e of events) {
    if (e.type !== 'GATE_PASSED' && e.type !== 'GATE_FAILED') continue;
    const key = `${String(e.data.taskId)}::${String(e.data.gate)}`;
    const tests = new Map<string, { id: string; status: string; acIds: string[] }>();
    for (const t of (e.data.junit as Array<{ id: string; status: string; acIds: string[] }> | undefined) ?? []) tests.set(t.id, t);
    latest.set(key, tests);
  }
  return criteria.map((acId) => {
    const tests: Array<{ id: string; status: string; taskId: string }> = [];
    const seen = new Set<string>();
    for (const [key, byId] of latest) for (const t of byId.values()) if (t.acIds.includes(acId) && !seen.has(t.id)) { seen.add(t.id); tests.push({ id: t.id, status: t.status, taskId: key.split('::')[0]! }); }
    return { acId, tests };
  });
}
```

- [ ] **Step 5: Run the web tests and the build**

Run: `npm run test:web && npm run web:build`
Expected: PASS. If the build fails on a `node:` import reachable from `@server/pipeline/run-state.js`, the Task 2 split missed a path — fix the import chain there, not with a shim.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/runs/hello-run.ndjson test/fixtures/runs/make-hello-run.ts web/src/run/selectors.ts web/src/run/selectors.test.ts web/vite.config.ts web/tsconfig.json
git commit -m "feat(web): run selectors over the journal, sharing the orchestrator reducer"
```

---

### Task 9: Execution page

**Files:**
- Create: `web/src/pages/Run.tsx`, `web/src/pages/Run.test.tsx`, `web/src/components/TaskDetail.tsx`
- Modify: `web/src/App.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: `runApi.run`, `runApi.step`, `runApi.runEvents`, `useJournal` (Task 7); selectors (Task 8).
- Produces: `RunView(props)` pure component; `RunPage` route component at `/runs/:runId`.

- [ ] **Step 1: Write the failing page test**

Create `web/src/pages/Run.test.tsx`:

```tsx
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunDetail, StoredEvent } from '../api.js';
import { RunView } from './Run.js';

const events: StoredEvent[] = readFileSync(new URL('../../../test/fixtures/runs/hello-run.ndjson', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const detail: RunDetail = { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'paused:quota', state: { status: 'paused:quota', order: [], tasks: [] }, finished: null, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }, acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true }, { id: 'AC-002', given: 'g', when: 'w', then: 't', smoke: false }] };

describe('RunView', () => {
  it('renders header, phases, tasks grouped by state, tokens and evidence from the journal', () => {
    render(<RunView detail={detail} events={events} ended={false} error={null} loadStep={vi.fn(async () => ({ prompt: '# p', output: { ok: true } }))} />);
    expect(screen.getByTestId('status').textContent).toContain('paused:quota');
    expect(screen.getByTestId('paused-until').textContent).toMatch(/until \d{2}:\d{2}/);
    expect(screen.getAllByTestId('phase').map((p) => p.textContent)).toEqual(['1 done', '2 done', '3 running']);
    expect(screen.getByTestId('group-merged').textContent).toContain('T1');
    expect(screen.getByTestId('group-ready').textContent).toContain('T2');
    expect(screen.getByTestId('tokens-dev').textContent).toContain('4100');
    expect(screen.getByTestId('evidence-AC-001').textContent).toContain('sum::[AC-001] adds');
    expect(screen.getByTestId('evidence-AC-002').textContent).toContain('no test');
  });
  it('selecting a task shows attempts, gates, review and the PR; a step expands to its artifacts', async () => {
    const loadStep = vi.fn(async () => ({ prompt: '# the prompt', output: { ok: true, value: { summary: 'did T1' } } }));
    render(<RunView detail={detail} events={events} ended={false} error={null} loadStep={loadStep} />);
    fireEvent.click(screen.getByTestId('task-T1'));
    expect(screen.getByTestId('attempt-1').textContent).toContain('lint');
    expect(screen.getByTestId('attempt-2').textContent).toContain('standard');
    expect(screen.getByText('PR #3').getAttribute('href')).toBe('https://github.com/o/r/pull/3');
    fireEvent.click(screen.getByTestId('step-s00003'));
    await screen.findByText('# the prompt');
    expect(loadStep).toHaveBeenCalledWith('s00003');
  });
  it('ignores a duplicate seq and shows the end state', () => {
    const dup = [...events, { ...events[3]! }];
    render(<RunView detail={{ ...detail, status: 'complete' }} events={dup} ended={true} error={null} loadStep={vi.fn()} />);
    expect(screen.getByTestId('tokens-sm').textContent).toContain('1800'); // 1000 + 800, the duplicate STEP_FINISHED not double counted
    expect(screen.getByTestId('status').textContent).toContain('complete');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:web`
Expected: FAIL — `./Run.js` not found.

- [ ] **Step 3: Implement the page**

Create `web/src/components/TaskDetail.tsx`:

```tsx
import { useState } from 'react';
import type { StoredEvent } from '../api.js';
import { taskDetail } from '../run/selectors.js';

export function TaskDetail({ events, taskId, loadStep }: { events: StoredEvent[]; taskId: string; loadStep: (stepId: string) => Promise<{ prompt: string; output: unknown }> }) {
  const d = taskDetail(events, taskId);
  const [open, setOpen] = useState<Record<string, { prompt: string; output: unknown } | 'loading'>>({});
  const toggle = async (stepId: string) => {
    if (open[stepId]) return setOpen((o) => { const n = { ...o }; delete n[stepId]; return n; });
    setOpen((o) => ({ ...o, [stepId]: 'loading' }));
    const art = await loadStep(stepId);
    setOpen((o) => ({ ...o, [stepId]: art }));
  };
  return (
    <section className="card" data-testid={`detail-${taskId}`}>
      <header><h2>{taskId}</h2>{d.pr ? <a href={d.pr.url} target="_blank" rel="noreferrer">PR #{d.pr.number}</a> : null}{d.lockHeld ? <span className="hint">holds merge lock</span> : null}</header>
      {d.blockedReason ? <p className="error">Blocked: {d.blockedReason}</p> : null}
      {d.attempts.map((a) => (
        <div key={a.attempt} data-testid={`attempt-${a.attempt}`}>
          <h3>Attempt {a.attempt}</h3>
          <ul>
            {a.steps.map((s) => (
              <li key={s.stepId}>
                <button data-testid={`step-${s.stepId}`} onClick={() => void toggle(s.stepId)}>{s.stepId}</button> {s.kind} · {s.role}{s.tier ? ` · ${s.tier}` : ''} · {s.ok === null ? 'running' : s.ok ? 'ok' : `failed (${s.failure})`}{s.usage ? ` · ${s.usage.inputTokens + s.usage.outputTokens} tokens` : ''}
                {open[s.stepId] && open[s.stepId] !== 'loading' ? <pre className="output">{(open[s.stepId] as { prompt: string }).prompt}{'\n---\n'}{JSON.stringify((open[s.stepId] as { output: unknown }).output, null, 2)}</pre> : null}
              </li>
            ))}
          </ul>
          {a.gates.length ? <p>Gates: {a.gates.map((g) => `${g.gate} ${g.passed ? 'passed' : 'failed'}${g.failedTests.length ? ` (${g.failedTests.join(', ')})` : ''}`).join(' · ')}</p> : null}
          {a.review ? <p>Review: {a.review.profile} profile, risk {a.review.risk}{a.review.drift ? `, drift ${a.review.drift}` : ''}{a.review.findings.length ? `, ${a.review.findings.length} finding(s)` : ', approved'}</p> : null}
        </div>
      ))}
    </section>
  );
}
```

Create `web/src/pages/Run.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { runApi, type RunDetail, type StoredEvent } from '../api.js';
import { TaskDetail } from '../components/TaskDetail.js';
import { evidence, pausedUntil, phases, runState, tokens } from '../run/selectors.js';
import { useJournal } from '../useSse.js';

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const ORDER = ['implementing', 'validating', 'reviewing', 'merging', 'ready', 'planned', 'merged', 'blocked', 'superseded'];

export function RunView({ detail, events, ended, error, loadStep }: { detail: RunDetail; events: StoredEvent[]; ended: boolean; error: string | null; loadStep: (stepId: string) => Promise<{ prompt: string; output: unknown }> }) {
  const unique = events.filter((e, i) => events.findIndex((x) => x.seq === e.seq) === i);
  const state = runState(unique);
  const finished = [...unique].reverse().find((e) => e.type === 'RUN_FINISHED');
  const status = finished ? String(finished.data.result) : state.status;
  const until = pausedUntil(unique);
  const t = tokens(unique);
  const [selected, setSelected] = useState<string | null>(null);
  const groups = ORDER.map((s) => [s, state.order.filter((id) => state.tasks.get(id)!.state === s)] as const).filter(([, ids]) => ids.length);
  return (
    <main>
      <p><Link to="/projects">← Projects</Link></p>
      <h1>{detail.runId} <small className="hint">{detail.projectId} / {detail.specId}</small></h1>
      <p data-testid="status">Status: <strong>{status}</strong>{ended ? ' (ended)' : ''}{until ? <span data-testid="paused-until"> — paused until {hhmm(until)}</span> : null}</p>
      {error ? <p className="error">{error}</p> : null}
      <section className="card"><h2>Phases</h2><p>{phases(unique).map((p) => <span key={p.phase} data-testid="phase" className={`phase phase-${p.result}`}>{p.phase} {p.result}</span>)}</p></section>
      <section className="card">
        <h2>Tasks</h2>
        {groups.map(([s, ids]) => (
          <div key={s} data-testid={`group-${s}`}>
            <h3>{s}</h3>
            <ul>{ids.map((id) => { const tk = state.tasks.get(id)!; return <li key={id}><button data-testid={`task-${id}`} onClick={() => setSelected(id)}>{id}</button> {tk.def.title} · attempts {tk.attempts}{tk.replanned ? ' · replanned' : ''}</li>; })}</ul>
          </div>
        ))}
      </section>
      {selected ? <TaskDetail events={unique} taskId={selected} loadStep={loadStep} /> : null}
      <section className="card">
        <h2>Tokens</h2>
        <table><thead><tr><th>Role</th><th>In</th><th>Out</th><th>Cost</th><th>Steps</th></tr></thead>
          <tbody>{Object.entries(t.byRole).map(([r, u]) => <tr key={r} data-testid={`tokens-${r}`}><td>{r}</td><td>{u.inputTokens}</td><td>{u.outputTokens}</td><td>${u.costUsd.toFixed(4)}</td><td>{u.steps}</td></tr>)}</tbody></table>
        <table><thead><tr><th>Phase</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
          <tbody>{Object.entries(t.byPhase).map(([p, u]) => <tr key={p}><td>{p}</td><td>{u.inputTokens}</td><td>{u.outputTokens}</td><td>${u.costUsd.toFixed(4)}</td></tr>)}</tbody></table>
        <p>Total ${t.total.costUsd.toFixed(4)} over {t.total.steps} steps</p>
      </section>
      <section className="card">
        <h2>Evidence</h2>
        <table><thead><tr><th>AC</th><th>Tests</th></tr></thead>
          <tbody>{evidence(unique, detail.acceptanceCriteria.map((a) => a.id)).map((row) => <tr key={row.acId} data-testid={`evidence-${row.acId}`}><td>{row.acId}</td><td>{row.tests.length ? row.tests.map((x) => <span key={x.id} className={`test test-${x.status}`}>{x.id} ({x.status}, {x.taskId})</span>) : <span className="hint">no test</span>}</td></tr>)}</tbody></table>
      </section>
    </main>
  );
}

export function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => { if (runId) runApi.run(runId).then(setDetail).catch((e: Error) => setLoadError(e.message)); }, [runId]);
  const { events, ended, error } = useJournal(runId && detail ? runApi.runEvents(runId) : null);
  if (loadError) return <main><p className="error">{loadError}</p></main>;
  if (!detail || !runId) return <main><p>Loading…</p></main>;
  return <RunView detail={detail} events={events} ended={ended} error={error} loadStep={(stepId) => runApi.step(runId, stepId)} />;
}
```

Add to `web/src/App.tsx`:

```tsx
import { RunPage } from './pages/Run.js';
// inside <Routes>:
        <Route path="/runs/:runId" element={<RunPage />} />
```

Append to `web/src/styles.css`:

```css
.phase { display: inline-block; margin-right: 0.5rem; padding: 0.2rem 0.5rem; border-radius: 4px; background: #eee; }
.phase-done { background: #d8f3e0; } .phase-failed { background: #f8d7d7; } .phase-running { background: #fff3cd; }
.test { display: inline-block; margin-right: 0.5rem; }
.test-passed { color: #2e9e4f; } .test-failed { color: #b00; }
h3 { font-size: 1rem; margin: 0.6rem 0 0.2rem; }
```

- [ ] **Step 4: Run the web tests and the build**

Run: `npm run test:web && npm run web:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Run.tsx web/src/pages/Run.test.tsx web/src/components/TaskDetail.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat(web): execution screen streaming a run's journal"
```

---

### Task 10: Navigation, docs status, live check

**Files:**
- Modify: `web/src/App.tsx`, `web/src/pages/Onboarding.tsx:24-28`, `server/cli.ts:146` (the "Open …" line)
- Modify: `docs/superpowers/plans/README.md`, this plan's status line, `docs/superpowers/plans/2026-09-24-teams-ai-10-run-api-execution-ui.md` (Findings)
- Test: `web/src/App.test.tsx` (new)

- [ ] **Step 1: Write the failing navigation test**

Create `web/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Home } from './App.js';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

afterEach(() => vi.restoreAllMocks());

describe('Home', () => {
  it('goes to /projects when a project is registered, else to /onboarding', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([{ projectId: 'p', dir: '/p', specs: [] }]), { status: 200 }));
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<Home />} /><Route path="/projects" element={<p>projects page</p>} /><Route path="/onboarding" element={<p>onboarding page</p>} /></Routes></MemoryRouter>);
    expect(await screen.findByText('projects page')).toBeTruthy();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<Home />} /><Route path="/projects" element={<p>projects page</p>} /><Route path="/onboarding" element={<p>onboarding page</p>} /></Routes></MemoryRouter>);
    expect(await screen.findByText('onboarding page')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:web`
Expected: FAIL — `Home` is not exported.

- [ ] **Step 3: Implement**

`web/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { runApi } from './api.js';
import { Onboarding } from './pages/Onboarding.js';
import { Projects } from './pages/Projects.js';
import { RunPage } from './pages/Run.js';
import { StatusPage } from './pages/StatusPage.js';

export function Home() {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => { runApi.projects().then((p) => setTo(p.length ? '/projects' : '/onboarding')).catch(() => setTo('/onboarding')); }, []);
  return to ? <Navigate to={to} replace /> : <p>Loading…</p>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/runs/:runId" element={<RunPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

In `web/src/pages/Onboarding.tsx` change the all-ok line to link to Projects:

```tsx
          Everything is set. <Link to="/projects">Go to projects</Link>
```

In `server/cli.ts` change the printed URL to `http://localhost:${server.port}/` and update the `test/cli.test.ts` expectation (`toContain('http://localhost:45678/')`).

- [ ] **Step 4: Run everything**

Run: `npm run test:web && npm run web:build && npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: all PASS.

- [ ] **Step 5: Docs**

In `docs/superpowers/plans/README.md` add a row `| 10 | [\`2026-09-24-teams-ai-10-run-api-execution-ui.md\`](2026-09-24-teams-ai-10-run-api-execution-ui.md) | Implemented and merged to main — run API, SSE journal stream, Projects and Execution screens; graceful stop on SIGTERM. |` and, under Outstanding work, replace the block-A part of the web UI gap with the remaining blocks B (refinement) and C (validation). Change this plan's status line to `**Status: implemented — live check recorded in Findings**` after Step 6.

- [ ] **Step 6: Live check (WSL) and Findings**

Run in WSL from the repo: `npm run web:build && setsid npm run ui -- --port 8787 > /tmp/ui.log 2>&1 &`, open `http://localhost:8787/` in the Windows browser, then:

1. Add the `teams-ai-hello-app` checkout directory as a project; it must list `hello-001` with its previous runs (`hello-001-r1` complete).
2. Start a run from the browser (the hello-app spec is frozen; a full run costs about $3 — acceptable, or first set `roles` to a cheap model in `~/.teams-ai/config.json`). The Execution page must stream phases and tasks live.
3. Click Stop during phase 3; the run must end `drained` (check `ui.log` in the run directory and the journal's `RUN_STOP_REQUESTED`).
4. Reload the Execution page: full replay, same panels.
5. Resume the drained run is not offered (it is terminal); start another run and let it finish, or stop it again.

Append a `## Findings (live run, <date>)` section to this plan with what happened, in the style of plan 8: one numbered item per surprise, each with the fix made. Verify the two open items from the spec §10: whether SIGTERM reached the orchestrator through `tsx` (if the journal shows no `RUN_STOP_REQUESTED` and the process died, switch `cliEntry` to spawn `node --import tsx server/cli.ts` or forward the signal) and whether the 500 ms poll kept up.

- [ ] **Step 7: Commit**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/src/pages/Onboarding.tsx server/cli.ts test/cli.test.ts docs/superpowers/plans/README.md docs/superpowers/plans/2026-09-24-teams-ai-10-run-api-execution-ui.md
git commit -m "feat(web): home routes to projects; plan 10 findings from the live run"
```

---

## Self-review

**Spec coverage.** §1.1 success criteria: registration and listing (Task 4), start and streaming (Tasks 5–7, 9), UI restart independence (detached spawn, Task 3; replay, Task 6), resume/stop (Task 5, Task 1 for the graceful path), Execution panels (Tasks 8–9), one reducer (Task 2 split + Task 8 alias). §3 data sources: all read in `run-index.ts` and the routes. §4 API: every row has a route and a test; `--run-id` in Task 1. §5 process control: Task 3 plus the `RUN_STOP_REQUESTED` addition in Task 1. §6 web: Projects (Task 7), Execution (Task 9), navigation (Task 10). §7 security: `SAFE_ID` checks in every parameterised route (Tasks 5–6), step files only under `steps/`, `ui.log` never served (no route). §8 errors: spawn failure 500 with log tail (Task 5), 404 SSE (Task 6), corrupt journal 500 (Task 6), duplicate seq ignored (Tasks 7 and 9). §9 tests: mapped one to one; the live check is Task 10 Step 6. §10 open items: verified in Task 10 Step 6.

**Placeholders.** None; every step carries its code. The fixture in Task 8 is generated by a committed script so its lines are reproducible.

**Type consistency.** `RunControlDeps`, `spawnRun`, `stop`, `isAlive` (Task 3) are used with the same signatures in Task 5; `IndexDeps`, `listRuns`, `readProject`, `runsDir`, `readPid/writePid/clearPid`, `SAFE_ID` (Task 4) in Tasks 5–6; `SseWriter.send(event, data, id?)` (Task 6) matches the onboarding use; `StoredEvent` in `web/src/api.ts` mirrors `server/store/event-store.ts`; `Usage` matches `Accounting.total()`; `useJournal` (Task 7) is what `RunPage` (Task 9) calls; `Home` (Task 10) is the route element `App.tsx` exports.

**Review Focus.** Each of the five lines names its owning task and test; all are present above.
