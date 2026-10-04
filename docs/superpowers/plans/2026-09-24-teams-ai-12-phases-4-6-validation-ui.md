# teams-ai Plan 12 — Phases 4–6 and Validation UI Implementation Plan

**Status: partially implemented — tasks 1–10 done, live check pending (see Findings)**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a run from "every task merged" through integrated verification on `main`, deploy with rollback, and a report the human validates in the browser; "Report problem" reopens refinement, "Complete spec" marks the spec `done` on `main`.

**Architecture:** Three new phase modules (`verify.ts`, `deploy.ts`, `report.ts`) run after the Phase 3 loop returns `complete`; every side effect stays intent → effect → confirm in the run journal. A new smoke gate reuses the Docker gate runner with `SERVICE_URL` injected like a secret. The UI reads the report from `REPORT_READY` in the journal; lifecycle actions go through block B's refine session ("Report problem") or a journaled child CLI (`teams-ai spec complete`).

**Tech Stack:** Node 22, TypeScript, zod 4, Vitest; existing `runGates`/`runDeployment`/`MergeQueue`; React 19 + react-router 7 in `web/`.

**Spec:** `docs/superpowers/specs/2026-09-24-phases-4-6-validation-ui-design.md` (block C). Depends on block A (`2026-09-24-run-api-execution-ui-design.md`, on main) and block B (`2026-09-24-refinement-ui-design.md`, plan 11, in flight in a sibling worktree).

## Global Constraints

- No new npm dependency (spec §2).
- Every git/GitHub/docker/kubectl effect is intent → effect → confirm in the run journal; the UI process never runs them (spec §2, §9).
- **Shared files with plan 11 (another session, in flight): `server/orchestrator/run.ts`, `server/orchestrator/events.ts`, `server/agents/outputs.ts`, `server/cli.ts`, `server/orchestrator/reconcile.ts`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/pages/Projects.tsx`. In these files this plan only APPENDS: new constants at the end of an object literal, new `case` arms at the end of a `switch` before `default`, new routes/exports at the end of an array, new functions after the last existing one. Never reorder, rename or reformat existing lines.** Plan 11 inserts Phase 0 at the top of `Run.execute()`; this plan changes only the last statement of `execute()` (`return this.loop();`).
- Task ids must match `ID_PATTERNS.TASK_ID` (`^T\d+(?:-[a-z0-9]+)*$`, `server/core/ids.ts`). The spec's `fix-<n>` / `deploy-fix-<n>` do not; this plan uses `T900-fix-<n>` and `T950-deploy-fix-<n>` (ruling recorded in §"Spec gaps" below).
- `RunFinished.result` values are exactly: `complete | blocked | deadlocked | drained | phase-failed | awaiting-validation | verification-failed | deploy-failed | done` (spec §7). CLI exit codes: `awaiting-validation` and `done` → 0, `drained` → 3, everything else → 2.
- Phase 4 has one fix round; Phase 5 has at most 3 deploy attempts (spec §1.2).
- Secrets never reach a journal event, a report, or a PR body: every agent/gate text goes through `redactSecrets` as today.

## Review Focus

1. A run whose Phase 3 ended `blocked` must still not enter Phase 4 (spec §3 "every task merged"); the Execution page must show `blocked`, not a half-run report. Pinned in Task 6 (`run.test.ts`: blocked run finishes `blocked`, no `PHASE_STARTED {4}`).
2. Smoke ACs with no `commands.smoke` in an *existing* plan on `main` (planned before this change): Phase 5 must fail with `DEPLOY_FAILED {stage: 'smoke', detail: 'plan.commands.smoke missing'}` rather than throw. Pinned in Task 2 (`smoke.test.ts`).
3. `kubectl get svc` returning no NodePort (ClusterIP service) → `DEPLOY_FAILED {stage: 'verify'}` with the jsonpath output in `detail`, not an unhandled rejection. Pinned in Task 3 (`deploy.test.ts`).
4. Resume after a crash between `DEPLOY_APPLIED` and `DEPLOY_VERIFIED`: the run must re-run the smoke gate, never re-`apply`. Pinned in Task 5 (`phase5.test.ts` kill/resume case).
5. "Complete spec" clicked twice: the second request must 409 while the first child runs (the `<specId>-complete-r1` journal claims the spec), and the Projects list must show the spec `done` only after `main` carries it. Pinned in Task 8 (`run-api.test.ts`).

## Spec gaps (rulings made while planning)

- Task ids: `T900-fix-<n>` / `T950-deploy-fix-<n>` instead of `fix-<n>` / `deploy-fix-<n>` (contract constraint; the `origin` field carries the meaning the id was meant to).
- `kubectl get svc` needs a Service name: this plan uses `intent.projectId` (the same name `KindTarget.verify` probes in-cluster).
- `DeployTarget.serviceUrl` is async (kind runs `kubectl`).
- `RUN_PAUSED`/`REPORT_READY` sizes: the report is journaled in full (evidence rows and script are small); step prompts stay in `steps/`.

---

### Task 1: Contracts, step kinds and journal events

**Files:**
- Modify: `server/contracts/plan.ts` (`Commands.smoke`, `PlanTask.origin`)
- Modify: `server/validators/plan.ts` (smoke command required)
- Modify: `server/agents/outputs.ts` (append `'fix-tasks'` to `STEP_KINDS`, `FixTasksOutput`, `OUTPUT_SCHEMAS['fix-tasks']`)
- Modify: `server/orchestrator/events.ts` (append to `OrchEvent`, `Intent`, `RunResult`, `REDUCED`)
- Modify: `server/pipeline/run-state.ts` (append `RunEvent.FixTasksPlanned` + reducer case)
- Modify: `server/cli.ts` (`exitCode`)
- Test: `test/contracts/contracts.test.ts` (add cases), `test/validators/plan.test.ts` (add case), `test/agents/outputs.test.ts` (add case), `test/pipeline/run-state.test.ts` (add case), `test/cli.test.ts` (add case)

**Interfaces:**
- Produces: `Commands.smoke?: string`; `PlanTask.origin?: 'plan' | 'fix' | 'deploy-fix'` (zod default `'plan'`).
- Produces: `FixTasksOutput = z.object({ specHash, tasks: z.array(PlanTask).min(1).max(3) })`, `OutputOf<'fix-tasks'>`.
- Produces: `OrchEvent.VerificationPassed = 'VERIFICATION_PASSED'`, `VerificationFailed = 'VERIFICATION_FAILED'`, `DeployApplied = 'DEPLOY_APPLIED'`, `DeployFailed = 'DEPLOY_FAILED'`, `RollbackDone = 'ROLLBACK_DONE'`, `DeployVerified = 'DEPLOY_VERIFIED'`, `ReportReady = 'REPORT_READY'`; `Intent.DeployApply = 'DEPLOY_APPLY'`; `RunEvent.FixTasksPlanned = 'FIX_TASKS_PLANNED'` (reduced like `TASK_PLANNED`).
- Produces: `RunResult` union extended with `'awaiting-validation' | 'verification-failed' | 'deploy-failed' | 'done'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/validators/plan.test.ts`:

```ts
it('requires commands.smoke when an acceptance criterion is a smoke test', () => {
  const smokeSpec = makeFrozenSpec({ acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true }] });
  const plan = makePlan(smokeSpec, { tasks: [makePlanTask({ id: 'T0-scaffold', affectedPaths: ['package.json'] }), makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], dependsOn: ['T0-scaffold'], affectedPaths: ['src/**'] }), makePlanTask({ id: 'T3-deploy', dependsOn: ['T0-scaffold'], affectedPaths: ['deploy/**'], owner: 'devops' })] });
  expect(validatePlan(plan, smokeSpec, { firstSpec: true })).toContain('commands.smoke is required: AC-001 is a smoke criterion');
  const withSmoke = { ...plan, commands: { ...plan.commands, smoke: 'npm run smoke' } };
  expect(validatePlan(withSmoke, smokeSpec, { firstSpec: true })).toEqual([]);
});
```

Append to `test/contracts/contracts.test.ts` (inside the existing `describe('plan')` or as a new describe):

```ts
it('PlanTask.origin defaults to plan and accepts fix and deploy-fix', () => {
  expect(PlanTask.parse({ id: 'T1', title: 't', description: 'd', criteriaRefs: [], dependsOn: [], affectedPaths: ['src'], owner: 'dev' }).origin).toBe('plan');
  expect(PlanTask.parse({ id: 'T900-fix-1', title: 't', description: 'd', criteriaRefs: [], dependsOn: [], affectedPaths: ['src'], owner: 'dev', origin: 'fix' }).origin).toBe('fix');
  expect(() => PlanTask.parse({ id: 'T1', title: 't', description: 'd', criteriaRefs: [], dependsOn: [], affectedPaths: ['src'], owner: 'dev', origin: 'hotfix' })).toThrow();
});
```

Append to `test/agents/outputs.test.ts`:

```ts
it('fix-tasks output carries 1..3 plan tasks', () => {
  const task = { id: 'T900-fix-1', title: 't', description: 'd', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: ['src/**'], owner: 'dev' };
  expect(OUTPUT_SCHEMAS['fix-tasks'].parse({ specHash: HASH, tasks: [task] })).toMatchObject({ tasks: [{ id: 'T900-fix-1', origin: 'plan' }] });
  expect(() => OUTPUT_SCHEMAS['fix-tasks'].parse({ specHash: HASH, tasks: [] })).toThrow();
  expect(STEP_KINDS).toContain('fix-tasks');
});
```

Append to `test/pipeline/run-state.test.ts`:

```ts
it('FIX_TASKS_PLANNED adds tasks like TASK_PLANNED, keeping their origin', () => {
  const state = reduceEvents([
    { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1' }) } },
    { type: 'FIX_TASKS_PLANNED', data: { tasks: [makePlanTask({ id: 'T900-fix-1', origin: 'fix' })] } },
  ]);
  expect(state.order).toEqual(['T1', 'T900-fix-1']);
  expect(state.tasks.get('T900-fix-1')).toMatchObject({ state: 'planned', def: { origin: 'fix' } });
});
```

Append to `test/cli.test.ts`:

```ts
it('exit codes: awaiting-validation and done are success, verification/deploy failures are 2', () => {
  expect(exitCode('awaiting-validation')).toBe(0);
  expect(exitCode('done')).toBe(0);
  expect(exitCode('verification-failed')).toBe(2);
  expect(exitCode('deploy-failed')).toBe(2);
});
```

(Import `exitCode` from `../../server/cli.js` and `makePlanTask`, `PlanTask`, `OUTPUT_SCHEMAS`, `STEP_KINDS`, `reduceEvents` where the file lacks them.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/validators/plan.test.ts test/contracts/contracts.test.ts test/agents/outputs.test.ts test/pipeline/run-state.test.ts test/cli.test.ts`
Expected: FAIL — `origin` undefined, `'fix-tasks'` not in `OUTPUT_SCHEMAS`, `FIX_TASKS_PLANNED` ignored (order has one id), smoke message missing, `exitCode('done')` returns 2.

- [ ] **Step 3: Contracts**

In `server/contracts/plan.ts`, `Commands` gains, after `healthcheck`:

```ts
  /** Runs against SERVICE_URL after deploy and must write JUnit to junitPath (spec Phase 5). */
  smoke: z.string().min(1).optional(),
```

`PlanTask` gains, after `owner`:

```ts
  /** Set by the orchestrator, never by the SM: plan task, Phase 4 fix task, Phase 5 deploy-fix task. */
  origin: z.enum(['plan', 'fix', 'deploy-fix']).default('plan'),
```

In `server/validators/plan.ts`, before `return errors;`:

```ts
  const smokeAcs = spec.acceptanceCriteria.filter((ac) => ac.smoke).map((ac) => ac.id);
  if (smokeAcs.length > 0 && !plan.commands.smoke) errors.push(`commands.smoke is required: ${smokeAcs.join(', ')} ${smokeAcs.length === 1 ? 'is a smoke criterion' : 'are smoke criteria'}`);
```

- [ ] **Step 4: Step kind and output**

In `server/agents/outputs.ts`, `STEP_KINDS` becomes:

```ts
export const STEP_KINDS = ['refine', 'tech-spec', 'coverage', 'plan', 'dev', 'review', 'deployment', 'report', 'decide', 'spec-gap', 'replan', 'fix-tasks'] as const;
```

After `ReplanOutput` (append):

```ts
/** Spec (phases 4-6) §3: SM plans one round of fix tasks from failed tests and uncovered criteria. */
export const FixTasksOutput = z.object({ specHash, tasks: z.array(PlanTask).min(1).max(3) });
export type FixTasksOutput = z.infer<typeof FixTasksOutput>;
```

In `OUTPUT_SCHEMAS`, append `'fix-tasks': FixTasksOutput,` as the last entry.

- [ ] **Step 5: Events and results**

In `server/orchestrator/events.ts`, append to `OrchEvent` after `Feedback`:

```ts
  VerificationPassed: 'VERIFICATION_PASSED',
  VerificationFailed: 'VERIFICATION_FAILED',
  DeployApplied: 'DEPLOY_APPLIED',
  DeployFailed: 'DEPLOY_FAILED',
  RollbackDone: 'ROLLBACK_DONE',
  DeployVerified: 'DEPLOY_VERIFIED',
  ReportReady: 'REPORT_READY',
```

Append to `Intent` after `WorktreeRemove`: `DeployApply: 'DEPLOY_APPLY',`.

Replace the `RunResult` line:

```ts
export type RunResult = 'complete' | 'blocked' | 'deadlocked' | 'drained' | 'phase-failed' | 'awaiting-validation' | 'verification-failed' | 'deploy-failed' | 'done';
```

Append `'FIX_TASKS_PLANNED',` as the last entry of `REDUCED`.

In `server/pipeline/run-state.ts`, append to `RunEvent`: `FixTasksPlanned: 'FIX_TASKS_PLANNED',`. After `PausedData` add:

```ts
const FixTasksData = z.object({ tasks: z.array(PlanTask).min(1) });
```

In `applyEvent`, add a case before `default`:

```ts
    case RunEvent.FixTasksPlanned: {
      const { tasks } = FixTasksData.parse(event.data);
      for (const def of tasks) addTask(state, def, false);
      return;
    }
```

In `server/cli.ts`, `exitCode` becomes:

```ts
export function exitCode(result: ExecuteResult): number {
  if (result === 'complete' || result === 'awaiting-validation' || result === 'done') return 0;
  if (result === 'drained') return 3;
  return 2;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/validators test/contracts test/agents test/pipeline test/cli.test.ts && npx tsc --noEmit -p .`
Expected: PASS; tsc clean (existing `PlanTask` literals in tests parse through zod, so `origin` is filled).

- [ ] **Step 7: Commit**

```bash
git add server/contracts/plan.ts server/validators/plan.ts server/agents/outputs.ts server/orchestrator/events.ts server/pipeline/run-state.ts server/cli.ts test/validators/plan.test.ts test/contracts/contracts.test.ts test/agents/outputs.test.ts test/pipeline/run-state.test.ts test/cli.test.ts
git commit -m "feat(contracts): smoke command, task origin, fix-tasks output and the phase 4-6 journal events"
```

---

### Task 2: Smoke gate

**Files:**
- Create: `server/exec/smoke.ts`
- Test: `test/exec/smoke.test.ts`

**Interfaces:**
- Consumes: `runGate`, `GateContext`, `GateResult` from `server/exec/gate-runner.ts`; `Plan`, `Spec`; `TestResult` (`id`, `status`, `acIds`).
- Produces:

```ts
export interface SmokeRow { acId: string; testId: string | null; status: 'passed' | 'failed' | 'missing' }
export function smokeGate(plan: Plan): Gate | null            // null when plan.commands.smoke is absent
export function evaluateSmoke(spec: Spec, junit: readonly TestResult[] | null): { ok: boolean; rows: SmokeRow[]; detail: string }
export async function runSmoke(plan: Plan, spec: Spec, ctx: Omit<GateContext, 'secrets'> & { secrets: Record<string, string> }, serviceUrl: string, deps: GateDeps): Promise<{ ok: boolean; rows: SmokeRow[]; detail: string; result: GateResult | null }>
```

`runSmoke` returns `{ ok: true, rows: [], detail: 'no smoke criteria', result: null }` when the spec has no smoke AC; `{ ok: false, detail: 'plan.commands.smoke missing' }` when a smoke AC exists but the plan has no command.

- [ ] **Step 1: Write the failing test**

`test/exec/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateSmoke, runSmoke, smokeGate } from '../../server/exec/smoke.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const spec = makeFrozenSpec({
  acceptanceCriteria: [
    { id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true },
    { id: 'AC-002', given: 'g', when: 'w', then: 't', smoke: false },
  ],
});
const plan = makePlan(spec, { commands: { ...makePlan(spec).commands, smoke: 'npm run smoke' } });
const t = (id: string, status: 'passed' | 'failed', acIds: string[]) => ({ id, name: id, classname: 'smoke', status, acIds, durationMs: 1 });
const ctx = { worktree: '/w', image: 'node:22', junitPath: 'reports/junit.xml', cpus: 1, memory: '1g', timeoutMs: 1000, secrets: { API_KEY: 'k' }, containerName: 'c' };

describe('smokeGate', () => {
  it('is an egress gate running commands.smoke with SERVICE_URL declared as its only extra variable', () => {
    expect(smokeGate(plan)).toEqual({ name: 'smoke', command: 'npm run smoke', blocking: true, network: 'egress', secrets: ['SERVICE_URL'] });
    expect(smokeGate(makePlan(spec))).toBeNull();
  });
});

describe('evaluateSmoke', () => {
  it('needs one passed test per smoke criterion and ignores non-smoke criteria', () => {
    expect(evaluateSmoke(spec, [t('s::[AC-001] home', 'passed', ['AC-001']), t('s::[AC-002] x', 'failed', ['AC-002'])])).toEqual({ ok: true, rows: [{ acId: 'AC-001', testId: 's::[AC-001] home', status: 'passed' }], detail: '1/1 smoke criteria passed' });
  });
  it('a failed or missing smoke test fails with the criterion named', () => {
    expect(evaluateSmoke(spec, [t('s::[AC-001] home', 'failed', ['AC-001'])])).toMatchObject({ ok: false, rows: [{ acId: 'AC-001', status: 'failed' }], detail: 'AC-001: failed' });
    expect(evaluateSmoke(spec, null)).toMatchObject({ ok: false, rows: [{ acId: 'AC-001', testId: null, status: 'missing' }], detail: 'AC-001: no smoke test' });
  });
});

describe('runSmoke', () => {
  it('passes SERVICE_URL through the environment, never on argv, and reads the report', async () => {
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 0 }));
    const files = new Map<string, string>([['/w/reports/junit.xml', '<testsuite name="s"><testcase classname="s" name="[AC-001] home"/></testsuite>']]);
    const r = await runSmoke(plan, spec, ctx, 'http://127.0.0.1:3000', { exec: fake.exec, readFile: async (p) => files.get(p.replace(/\\/g, '/')) ?? null, removeFile: async () => {} });
    expect(r).toMatchObject({ ok: true, rows: [{ acId: 'AC-001', status: 'passed' }] });
    const run = fake.calls.find((c) => c.args[0] === 'run')!;
    expect(run.args).toEqual(expect.arrayContaining(['-e', 'SERVICE_URL', '--network', 'bridge']));
    expect(run.args.join(' ')).not.toContain('127.0.0.1:3000');
    expect(run.env).toEqual({ SERVICE_URL: 'http://127.0.0.1:3000' });
  });
  it('no smoke criteria → ok without running docker; smoke criteria without a command → not ok', async () => {
    const fake = new FakeExec();
    const deps = { exec: fake.exec, readFile: async () => null, removeFile: async () => {} };
    expect(await runSmoke(plan, makeFrozenSpec(), ctx, 'http://x', deps)).toEqual({ ok: true, rows: [], detail: 'no smoke criteria', result: null });
    expect(await runSmoke(makePlan(spec), spec, ctx, 'http://x', deps)).toMatchObject({ ok: false, detail: 'plan.commands.smoke missing', result: null });
    expect(fake.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/exec/smoke.test.ts`
Expected: FAIL — cannot resolve `server/exec/smoke.js`.

- [ ] **Step 3: Implement `server/exec/smoke.ts`**

```ts
import type { Gate, Plan } from '../contracts/plan.js';
import type { Spec } from '../contracts/spec.js';
import type { TestResult } from '../evidence/junit.js';
import { runGate, type GateContext, type GateDeps, type GateResult } from './gate-runner.js';

export interface SmokeRow {
  acId: string;
  testId: string | null;
  status: 'passed' | 'failed' | 'missing';
}

/** Spec Phase 5 step 2: the smoke command is an egress gate; SERVICE_URL rides the secret path so it never lands on argv. */
export function smokeGate(plan: Plan): Gate | null {
  if (!plan.commands.smoke) return null;
  return { name: 'smoke', command: plan.commands.smoke, blocking: true, network: 'egress', secrets: ['SERVICE_URL'] };
}

export function evaluateSmoke(spec: Spec, junit: readonly TestResult[] | null): { ok: boolean; rows: SmokeRow[]; detail: string } {
  const rows: SmokeRow[] = spec.acceptanceCriteria
    .filter((ac) => ac.smoke)
    .map((ac) => {
      const tests = (junit ?? []).filter((t) => t.acIds.includes(ac.id) && t.status !== 'skipped');
      const failed = tests.find((t) => t.status === 'failed');
      if (failed) return { acId: ac.id, testId: failed.id, status: 'failed' };
      const passed = tests.find((t) => t.status === 'passed');
      return passed ? { acId: ac.id, testId: passed.id, status: 'passed' } : { acId: ac.id, testId: null, status: 'missing' };
    });
  const bad = rows.filter((r) => r.status !== 'passed');
  if (bad.length === 0) return { ok: true, rows, detail: `${rows.length}/${rows.length} smoke criteria passed` };
  return { ok: false, rows, detail: bad.map((r) => `${r.acId}: ${r.status === 'failed' ? 'failed' : 'no smoke test'}`).join('; ') };
}

export async function runSmoke(
  plan: Plan,
  spec: Spec,
  ctx: GateContext,
  serviceUrl: string,
  deps: GateDeps,
): Promise<{ ok: boolean; rows: SmokeRow[]; detail: string; result: GateResult | null }> {
  if (!spec.acceptanceCriteria.some((ac) => ac.smoke)) return { ok: true, rows: [], detail: 'no smoke criteria', result: null };
  const gate = smokeGate(plan);
  if (!gate) return { ok: false, rows: evaluateSmoke(spec, null).rows, detail: 'plan.commands.smoke missing', result: null };
  const result = await runGate(gate, { ...ctx, secrets: { ...ctx.secrets, SERVICE_URL: serviceUrl } }, deps);
  const evaluated = evaluateSmoke(spec, result.junit);
  if (!result.passed && evaluated.ok) return { ok: false, rows: evaluated.rows, detail: `smoke command exited ${result.exitCode ?? 'null'}${result.timedOut ? ' (timeout)' : ''}`, result };
  return { ...evaluated, result };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/exec/smoke.test.ts test/exec/gate-runner.test.ts`
Expected: PASS (5 new + existing).

- [ ] **Step 5: Commit**

```bash
git add server/exec/smoke.ts test/exec/smoke.test.ts
git commit -m "feat(exec): smoke gate runs commands.smoke against SERVICE_URL and grades smoke criteria"
```

---

### Task 3: `serviceUrl` on the deploy targets

**Files:**
- Modify: `server/deploy/target.ts` (interface + `DeployStage` unchanged)
- Modify: `server/deploy/docker-local.ts`, `server/deploy/kind.ts`
- Test: `test/deploy/deploy.test.ts` (add cases)

**Interfaces:**
- Produces: `DeployTarget.serviceUrl(intent: DeploymentIntent): Promise<string>` — docker-local returns `http://127.0.0.1:<port>`; kind runs `kubectl get svc <projectId> -o jsonpath={.spec.ports[0].nodePort}` and returns `http://localhost:<nodePort>`, throwing `Error('service <projectId> has no NodePort: <stdout|stderr>')` otherwise.

- [ ] **Step 1: Write the failing tests**

Append to `test/deploy/deploy.test.ts`:

```ts
describe('serviceUrl', () => {
  it('docker-local is the bound localhost port', async () => {
    const t = new DockerLocalTarget({ exec: new FakeExec().exec, get: okGet, secrets });
    expect(await t.serviceUrl(intent)).toBe('http://127.0.0.1:3000');
  });
  it('kind reads the NodePort of the project Service and fails loudly without one', async () => {
    const fake = new FakeExec().onArgs('kubectl', ['get', 'svc'], () => ({ stdout: '30080' }));
    const t = new KindTarget({ exec: fake.exec, secrets, cluster: 'teams-ai', readFile: async () => '' });
    expect(await t.serviceUrl(intent)).toBe('http://localhost:30080');
    expect(fake.lines('kubectl').at(-1)).toContain('get svc todo-api -o jsonpath={.spec.ports[0].nodePort}');
    const none = new KindTarget({ exec: new FakeExec().onArgs('kubectl', ['get', 'svc'], () => ({ stdout: '' })).exec, secrets, cluster: 'teams-ai', readFile: async () => '' });
    await expect(none.serviceUrl(intent)).rejects.toThrow(/service todo-api has no NodePort/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/deploy/deploy.test.ts`
Expected: FAIL — `serviceUrl is not a function`.

- [ ] **Step 3: Implement**

`server/deploy/target.ts`, in `DeployTarget` after `destroy`:

```ts
  /** Where the smoke gate reaches the service from the host (spec Phase 5). */
  serviceUrl(intent: DeploymentIntent): Promise<string>;
```

`server/deploy/docker-local.ts`, after `verify`:

```ts
  async serviceUrl(intent: DeploymentIntent): Promise<string> {
    return this.baseUrl(intent);
  }
```

`server/deploy/kind.ts`, after `verify`:

```ts
  async serviceUrl(intent: DeploymentIntent): Promise<string> {
    const r = await this.kubectl(['get', 'svc', intent.projectId, '-o', 'jsonpath={.spec.ports[0].nodePort}']);
    const port = Number(r.stdout.trim());
    if (r.exitCode !== 0 || !Number.isInteger(port) || port <= 0) throw new Error(`service ${intent.projectId} has no NodePort: ${(r.stdout || r.stderr).trim().slice(0, 200)}`);
    return `http://localhost:${port}`;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/deploy && npx tsc --noEmit -p .`
Expected: PASS; tsc flags any other `DeployTarget` implementation (test fakes) missing `serviceUrl` — add `serviceUrl: async () => 'http://x'` there.

- [ ] **Step 5: Commit**

```bash
git add server/deploy test/deploy/deploy.test.ts
git commit -m "feat(deploy): targets expose the service URL the smoke gate calls"
```

---

### Task 4: Phase 4 — integrated verification

**Files:**
- Create: `server/orchestrator/phases/verify.ts`
- Modify: `server/orchestrator/phases/index.ts` (append export)
- Modify: `server/orchestrator/steps.ts` (append `fixTasksPack`)
- Modify: `server/orchestrator/phases/shared.ts` (append optional `PhaseDeps` fields, `checkoutMain`)
- Test: `test/orchestrator/phase4.test.ts`

**Interfaces:**
- Consumes: `runGates` result shape, `buildEvidenceMatrix`, `readyForValidation`, `validatePlan`, `triageGateFailure`, `RunEvent.FixTasksPlanned`, `FixTasksOutput` (Task 1).
- Produces (appended to `PhaseDeps`):

```ts
  plan?: Plan;
  gates?: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
  tasks?: () => Iterable<EvidenceTask>;
  decider?: Pick<Decider, 'decide'>;
  confidential?: boolean;
  boundaries?: () => Promise<readonly string[]>;
```

- Produces: `runPhase4(deps: PhaseDeps, round: 1 | 2): Promise<Phase4Result>` with `Phase4Result = { ok: true; matrix: EvidenceRow[] } | { ok: false; reason: string; fixTasks?: PlanTask[] }` — `fixTasks` present means "go back to Phase 3 with these, then call again with `round: 2`"; absent means `verification-failed`.
- Produces: `fixTasksPack(base, opts: { failedTests; tails; uncoveredAcs; plan; boundaries; feedback })` (`kind: 'fix-tasks'`, role `sm`).
- Produces: `checkoutMain(deps: PhaseDeps): Promise<string>` — `git fetch` + `git checkout -q --detach origin/main` in `deps.ws.repo`, returns the short sha.

- [ ] **Step 1: Write the failing test**

`test/orchestrator/phase4.test.ts`:

```ts
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase4, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec, { tasks: [makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src/a'] }), makePlanTask({ id: 'T2', criteriaRefs: ['AC-002'], affectedPaths: ['src/b'] })] });
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary });
type Agent = (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>;
const test = (id: string, status: 'passed' | 'failed', acIds: string[]) => ({ id, name: id, classname: 'u', status, acIds, durationMs: 1 });
const gate = (name: string, passed: boolean, junit: ReturnType<typeof test>[] | null): GateResult => ({ name, blocking: true, passed, exitCode: passed ? 0 : 1, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: passed ? '' : 'FAIL', junit, failure: passed ? null : 'code' });

let remote: Remote;
let journal: Journal;
let calls: AgentStepRequest<any>[];
beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec), 'docs/specs/spec-001/plan.json': JSON.stringify(plan) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  calls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(agent: Agent, gates: PhaseDeps['gates']): PhaseDeps {
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', runs: remote.root };
  return {
    journal, ws, spec, project, specHash: HASH, firstSpec: false, exec: execCommand,
    runAgent: (async (req) => { calls.push(req); return agent(req); }) as PhaseDeps['runAgent'],
    mergeQueue: new MergeQueue(),
    mergeDeps: { journal, ws, exec: execCommand, ghExec: new FakeExec().exec, gates: async () => ({ results: [], blockingFailure: null }), graphify: null, secretValues: () => [], handoffs: [], clock: () => new Date() },
    packBase: () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 }),
    godNodes: async () => [],
    plan, gates,
    tasks: () => plan.tasks.map((def) => ({ def, state: 'merged' as const })),
    decider: { decide: async () => ({ answered: false, reason: 'disabled' }) },
    boundaries: async () => ['src/a', 'src/b'],
  };
}
const allGreen: PhaseDeps['gates'] = async () => ({ results: [gate('unit-test', true, [test('u::[AC-001] a', 'passed', ['AC-001']), test('u::[AC-002] b', 'passed', ['AC-002'])])], blockingFailure: null });
const ac2Fails: PhaseDeps['gates'] = async () => {
  const g = gate('unit-test', false, [test('u::[AC-001] a', 'passed', ['AC-001']), test('u::[AC-002] b', 'failed', ['AC-002'])]);
  return { results: [g], blockingFailure: g };
};
const fixTasks: Agent = async (req) => {
  if (req.kind !== 'fix-tasks') throw new Error(req.kind);
  return ok({ specHash: HASH, tasks: [{ id: 'T1', title: 'fix b', description: 'repair AC-002', criteriaRefs: ['AC-002'], dependsOn: [], affectedPaths: ['src/b'], owner: 'dev' }] });
};

describe('Phase 4', () => {
  it('all green: checks out origin/main, runs the gates there and journals the matrix', async () => {
    const r = await runPhase4(deps(async () => { throw new Error('no agent'); }, allGreen), 1);
    expect(r).toMatchObject({ ok: true, matrix: [{ criterion: 'AC-001', status: 'passed' }, { criterion: 'AC-002', status: 'passed' }] });
    expect(journal.events.map((e) => e.type)).toEqual([OrchEvent.PhaseStarted, OrchEvent.GatePassed, OrchEvent.VerificationPassed]);
    expect(journal.events[0]!.data).toEqual({ phase: 4, round: 1 });
    expect(calls).toHaveLength(0);
  });

  it('round 1 failure plans fix tasks with rewritten ids and origin fix, journals them, and returns them', async () => {
    const r = await runPhase4(deps(fixTasks, ac2Fails), 1);
    expect(r).toMatchObject({ ok: false, fixTasks: [{ id: 'T900-fix-1', origin: 'fix', criteriaRefs: ['AC-002'] }] });
    const failed = journal.events.find((e) => e.type === OrchEvent.VerificationFailed)!;
    expect(failed.data).toMatchObject({ round: 1, failedTests: ['u::[AC-002] b'], uncoveredAcs: [] });
    expect(journal.state.tasks.get('T900-fix-1')).toMatchObject({ state: 'planned', def: { origin: 'fix' } });
    expect(calls[0]!.kind).toBe('fix-tasks');
    expect(calls[0]!.pack.feedback).toContain('u::[AC-002] b');
  });

  it('round 2 failure or an SM that keeps returning an invalid plan ends as verification-failed', async () => {
    expect(await runPhase4(deps(fixTasks, ac2Fails), 2)).toMatchObject({ ok: false, reason: expect.stringContaining('round 2') });
    expect(journal.events.filter((e) => e.type === OrchEvent.VerificationFailed)).toHaveLength(1);
    const bad: Agent = async () => ok({ specHash: HASH, tasks: [{ id: 'T1', title: 'x', description: 'y', criteriaRefs: ['AC-001'], dependsOn: ['T77'], affectedPaths: ['src'], owner: 'dev' }] });
    const r = await runPhase4(deps(bad, ac2Fails), 1);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('fix-tasks') });
    expect('fixTasks' in r).toBe(false);
  });

  it('is idempotent on resume: a round already journaled as passed is not rerun', async () => {
    await runPhase4(deps(async () => { throw new Error('x'); }, allGreen), 1);
    const n = journal.events.length;
    let gatesRan = 0;
    await runPhase4(deps(async () => { throw new Error('x'); }, async () => { gatesRan++; return allGreen('', ''); }), 1);
    expect(gatesRan).toBe(0);
    expect(journal.events).toHaveLength(n);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/orchestrator/phase4.test.ts`
Expected: FAIL — `runPhase4` is not exported from `phases/index.js`.

- [ ] **Step 3: `PhaseDeps` additions, `checkoutMain`, `fixTasksPack`**

`server/orchestrator/phases/shared.ts` — add imports `import type { Decider } from '../../decide/decider.js'; import type { EvidenceTask } from '../../evidence/matrix.js'; import type { GateResult } from '../../exec/gate-runner.js';`, append to `PhaseDeps` after `pause?`:

```ts
  /** Phase 4/5: the frozen plan, the run's blocking gates, the live task set (evidence), decisions and boundaries. */
  plan?: Plan;
  gates?: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
  tasks?: () => Iterable<EvidenceTask>;
  decider?: Pick<Decider, 'decide'>;
  confidential?: boolean;
  boundaries?: () => Promise<readonly string[]>;
```

and append after `readInWorktree`:

```ts
/** Phase 4/5 work on a detached checkout of origin/main in the shared repo. */
export async function checkoutMain(deps: PhaseDeps): Promise<string> {
  await gitFetch(deps.ws.repo, deps.exec);
  await git(deps.ws.repo, ['checkout', '-q', '--detach', 'origin/main'], deps.exec);
  return (await git(deps.ws.repo, ['rev-parse', '--short', 'HEAD'], deps.exec)).trim();
}
```

`server/orchestrator/steps.ts` — add `import type { Plan, PlanTask } from '../contracts/plan.js';` (replacing the `PlanTask`-only type import) and append after `replanPack`:

```ts
export function fixTasksPack(base: PackBase, opts: { failedTests: readonly string[]; tails: string; uncoveredAcs: readonly string[]; plan: Plan; boundaries: readonly string[]; feedback: string | null }): ContextPackInput {
  const feedback = [
    'Integrated verification on main failed. Plan 1 to 3 fix tasks. Ids are assigned by the orchestrator; dependsOn may name existing plan tasks or be empty.',
    `Failed tests:\n${opts.failedTests.map((t) => `- ${t}`).join('\n') || '- none'}`,
    `Criteria without passed evidence:\n${opts.uncoveredAcs.map((a) => `- ${a}`).join('\n') || '- none'}`,
    `Gate output (tail):\n${opts.tails}`,
    `Existing tasks:\n${opts.plan.tasks.map((t) => `- ${t.id}: ${t.title} [${t.criteriaRefs.join(', ')}] paths ${t.affectedPaths.join(', ')}`).join('\n')}`,
    `Module boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}`,
    opts.feedback ? `Previous answer was rejected:\n${opts.feedback}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n\n');
  return { ...common(base, 'fix-tasks', 'sm'), criteria: base.spec.acceptanceCriteria, feedback };
}
```

- [ ] **Step 4: Implement `server/orchestrator/phases/verify.ts`**

```ts
import type { OutputOf } from '../../agents/outputs.js';
import type { Plan, PlanTask } from '../../contracts/plan.js';
import { triageGateFailure } from '../../decide/decisions/gate-triage.js';
import type { TestResult } from '../../evidence/junit.js';
import { buildEvidenceMatrix, readyForValidation, type EvidenceRow } from '../../evidence/matrix.js';
import type { GateResult } from '../../exec/gate-runner.js';
import { RunEvent } from '../../pipeline/run-state.js';
import type { StepOutcome } from '../../runner/step.js';
import { validatePlan } from '../../validators/plan.js';
import { OrchEvent } from '../events.js';
import { fixTasksPack } from '../steps.js';
import { PAUSED_AUTH, checkoutMain, pauseForFailure, type PhaseDeps } from './shared.js';

export type Phase4Result = { ok: true; matrix: EvidenceRow[] } | { ok: false; reason: string; fixTasks?: PlanTask[] };

const MAX_INFRA_RERUNS = 3;
const TAIL = 2000;
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);
const OFF_DECIDER = { decide: async () => ({ answered: false as const, reason: 'disabled' as const }) };

function required(deps: PhaseDeps): { plan: Plan; gates: NonNullable<PhaseDeps['gates']>; tasks: NonNullable<PhaseDeps['tasks']> } {
  if (!deps.plan || !deps.gates || !deps.tasks) throw new Error('Phase 4 needs plan, gates and tasks in PhaseDeps');
  return { plan: deps.plan, gates: deps.gates, tasks: deps.tasks };
}

/** Spec (phases 4-6) §3. Idempotent per round through the journal. */
export async function runPhase4(deps: PhaseDeps, round: 1 | 2): Promise<Phase4Result> {
  const { plan, gates, tasks } = required(deps);
  const done = deps.journal.events.find((e) => e.type === OrchEvent.VerificationPassed && e.data.round === round);
  if (done) return { ok: true, matrix: done.data.matrix as EvidenceRow[] };
  if (!deps.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 4 && e.data.round === round)) {
    await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 4, round });
  }
  await checkoutMain(deps);

  let results: GateResult[] = [];
  let blocking: GateResult | null = null;
  for (let rerun = 0; rerun <= MAX_INFRA_RERUNS; rerun++) {
    ({ results, blockingFailure: blocking } = await gates(deps.ws.repo, 'main'));
    for (const r of results) {
      await deps.journal.fact(r.passed ? OrchEvent.GatePassed : OrchEvent.GateFailed, {
        taskId: null,
        phase: 4,
        round,
        gate: r.name,
        failure: r.failure,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        junit: (r.junit ?? []).map((t) => ({ id: t.id, name: t.name, classname: t.classname, status: t.status, acIds: t.acIds })),
      });
    }
    if (!blocking) break;
    const gateDef = plan.gates.find((g) => g.name === blocking.name) ?? { name: blocking.name, command: '', blocking: true, network: 'none' as const, secrets: [] };
    const triage = await triageGateFailure(gateDef, blocking, deps.decider ?? OFF_DECIDER, { confidential: deps.confidential ?? false });
    if (triage.kind !== 'infra' && triage.kind !== 'environment' && triage.kind !== 'flaky-test') break;
  }

  const junit: TestResult[] = [...new Map(results.flatMap((r) => r.junit ?? []).map((t) => [t.id, t])).values()];
  const matrix = buildEvidenceMatrix(deps.spec, tasks(), junit);
  const failedTests = junit.filter((t) => t.status === 'failed').map((t) => t.id);
  const uncoveredAcs = matrix.filter((r) => r.status === 'missing').map((r) => r.criterion);
  if (!blocking && readyForValidation(matrix)) {
    await deps.journal.fact(OrchEvent.VerificationPassed, { round, matrix });
    return { ok: true, matrix };
  }
  await deps.journal.fact(OrchEvent.VerificationFailed, { round, failedTests, uncoveredAcs, matrix, gate: blocking?.name ?? null });
  if (round === 2) return { ok: false, reason: `verification failed in round 2: ${failedTests.length} failing tests, ${uncoveredAcs.length} uncovered criteria` };

  const tails = tail(results.map((r) => `${r.name}: ${r.stderrTail || r.stdoutTail}`).join('\n'));
  let feedback: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out: StepOutcome<OutputOf<'fix-tasks'>> = await deps.runAgent<'fix-tasks'>({
      kind: 'fix-tasks',
      role: 'sm',
      pack: fixTasksPack(deps.packBase(), { failedTests, tails, uncoveredAcs, plan, boundaries: deps.boundaries ? await deps.boundaries() : [], feedback }),
      cwd: deps.ws.repo,
      phase: 'phase4',
      taskId: null,
      attempt,
    });
    if (!out.ok) {
      if (out.failure === 'quota' || out.failure === 'auth') {
        if (await pauseForFailure(deps, out.failure)) return { ok: false, reason: PAUSED_AUTH };
        attempt -= 1;
        continue;
      }
      feedback = out.errors.join('\n');
      continue;
    }
    const fixTasks: PlanTask[] = out.value.tasks.map((t, i) => ({ ...t, id: `T900-fix-${i + 1}`, origin: 'fix' as const }));
    // Coverage is already satisfied by the original plan; the combined plan is checked for ids, dependencies, cycles and gates.
    const errors = validatePlan({ ...plan, tasks: [...plan.tasks, ...fixTasks] }, deps.spec, { firstSpec: deps.firstSpec }).filter((e) => !e.startsWith('acceptance criterion'));
    if (errors.length > 0) {
      feedback = errors.join('\n');
      continue;
    }
    await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: fixTasks });
    return { ok: false, reason: 'verification failed; fix tasks planned', fixTasks };
  }
  return { ok: false, reason: `fix-tasks rejected twice: ${feedback ?? 'no answer'}` };
}
```

`server/orchestrator/phases/index.ts` — append `export { runPhase4, type Phase4Result } from './verify.js';` and add `checkoutMain` to the `./shared.js` export list.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/orchestrator/phase4.test.ts test/orchestrator/phases.test.ts && npx tsc --noEmit -p .`
Expected: PASS (4 new, Phase 1/2 untouched); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/phases/verify.ts server/orchestrator/phases/index.ts server/orchestrator/phases/shared.ts server/orchestrator/steps.ts test/orchestrator/phase4.test.ts
git commit -m "feat(orchestrator): phase 4 verifies main, builds the evidence matrix and plans one round of fix tasks"
```

---

### Task 5: Phase 5 — deploy with rollback, smoke and deploy-fix tasks

**Files:**
- Create: `server/orchestrator/phases/deploy.ts`
- Modify: `server/orchestrator/phases/index.ts` (append export), `server/orchestrator/phases/shared.ts` (append `PhaseDeps.target`, `PhaseDeps.smoke`, `PhaseDeps.secrets`)
- Modify: `server/orchestrator/reconcile.ts` (append `case Intent.DeployApply` before `default`)
- Test: `test/orchestrator/phase5.test.ts`, `test/orchestrator/reconcile.test.ts` (add one case)

**Interfaces:**
- Consumes: `runDeployment`, `DeployTarget` (+ `serviceUrl`, Task 3), `runSmoke` (Task 2), `Intent.DeployApply`, `OrchEvent.Deploy*` (Task 1), `checkoutMain` (Task 4).
- Produces (appended to `PhaseDeps`):

```ts
  target?: DeployTarget;
  /** Smoke gate bound to the run's gate context; injected so tests skip Docker. */
  smoke?: (contextDir: string, serviceUrl: string) => Promise<{ ok: boolean; rows: SmokeRow[]; detail: string }>;
  secretNames?: () => string[];
```

- Produces: `runPhase5(deps: PhaseDeps, attempt: 1 | 2 | 3): Promise<Phase5Result>` with `Phase5Result = { ok: true; url: string; smoke: SmokeRow[]; healthcheck: string } | { ok: false; reason: string; fixTask?: PlanTask }` — `fixTask` present means "run this `T950-deploy-fix-<attempt>` task through Phase 3, then call again with `attempt + 1`".
- Produces: `deployIntent(deps: PhaseDeps, tag: string): DeploymentIntent` = `{ projectId, image: plan.deploy.image, tag, port, healthcheckPath, manifests, secretNames: union of spec.externalDependencies[].secretNames, contextDir: deps.ws.repo }`.
- Produces (`reconcile.ts`): `ReconcileDeps.currentImage?: (intent: DeploymentIntent) => Promise<string | null>`; an unconfirmed `DEPLOY_APPLY` whose `image:tag` equals `currentImage(intent)` is confirmed with `{ previous: null, reconciled: true }`, otherwise redone.

Algorithm per attempt (spec §4): `PHASE_STARTED {phase: 5}` once; tag = `checkoutMain` short sha; intent key `deploy-<attempt>`; if `DEPLOY_VERIFIED` already journaled for this attempt → ok. If `DEPLOY_APPLY` for this attempt is confirmed (or reconciled) skip to health+smoke; else `intent DEPLOY_APPLY {attempt, image, tag}` → `runDeployment(target, intent, { smoke: () => ({ ok: true }), baseUrl: '' })` (the smoke step runs separately below so the gate can be journaled) → on `ok` confirm `DEPLOY_APPLY {previous}` + fact `DEPLOY_APPLIED {attempt, previous, tag}`; on failure fact `DEPLOY_FAILED {attempt, stage, detail, rolledBack, rollbackHealthy}` (+ `ROLLBACK_DONE {attempt, previous}` when `rolledBack`). Then `url = await target.serviceUrl(intent)` (throws → `DEPLOY_FAILED {stage: 'verify'}`), `smoke = await deps.smoke(repo, url)`; failure → rollback via `target.rollback(intent, previous)` when `previous` (fact `ROLLBACK_DONE`) + `DEPLOY_FAILED {stage: 'smoke'}`; success → `DEPLOY_VERIFIED {attempt, url, smoke: rows, healthcheck}` and return. After any failure with `attempt < 3`: synthesize `fixTask = { id: 'T950-deploy-fix-<attempt>', title: 'Fix deployment (<stage>)', description: '<detail>' , criteriaRefs: [], dependsOn: [], affectedPaths: [...plan.deploy.manifests, 'Dockerfile'], owner: 'devops', origin: 'deploy-fix' }`, journal `FIX_TASKS_PLANNED {tasks: [fixTask]}` and return it. Attempt 3 failure → `{ ok: false, reason }`.

- [ ] **Step 1: Write the failing tests**

`test/orchestrator/phase5.test.ts`:

```ts
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeploymentIntent, DeployTarget } from '../../server/deploy/target.js';
import { execCommand } from '../../server/exec/command.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Intent, Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase5, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { makeFrozenSpec, makePlan, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec({ acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true }, { id: 'AC-002', given: 'g', when: 'w', then: 't', smoke: false }] });
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec, { commands: { ...makePlan(spec).commands, smoke: 'npm run smoke' } });

class FakeTarget implements DeployTarget {
  readonly name = 'docker-local' as const;
  calls: string[] = [];
  running: string | null = 'todo-api:old';
  failAt: 'apply' | 'verify' | null = null;
  async validate() { this.calls.push('validate'); return []; }
  async build() { this.calls.push('build'); }
  async apply(i: DeploymentIntent) { this.calls.push('apply'); if (this.failAt === 'apply') throw new Error('port busy'); const previous = this.running; this.running = `${i.image}:${i.tag}`; return { previous }; }
  async verify() { this.calls.push('verify'); return this.failAt === 'verify' ? { healthy: false, detail: 'HTTP 503' } : { healthy: true, detail: 'HTTP 200' }; }
  async currentImage() { return this.running; }
  async rollback(_i: DeploymentIntent, previous: string) { this.calls.push('rollback'); this.running = previous; }
  async destroy() {}
  async serviceUrl() { return 'http://127.0.0.1:3000'; }
}

let remote: Remote;
let journal: Journal;
let target: FakeTarget;
let smokeOk: boolean;
beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec), 'docs/specs/spec-001/plan.json': JSON.stringify(plan) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  target = new FakeTarget();
  smokeOk = true;
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(over: Partial<PhaseDeps> = {}): PhaseDeps {
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', runs: remote.root };
  return {
    journal, ws, spec, project, specHash: HASH, firstSpec: false, exec: execCommand,
    runAgent: (async () => { throw new Error('no agent in phase 5'); }) as PhaseDeps['runAgent'],
    mergeQueue: new MergeQueue(),
    mergeDeps: { journal, ws, exec: execCommand, ghExec: new FakeExec().exec, gates: async () => ({ results: [], blockingFailure: null }), graphify: null, secretValues: () => [], handoffs: [], clock: () => new Date() },
    packBase: () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 }),
    godNodes: async () => [],
    plan, target,
    smoke: async () => (smokeOk ? { ok: true, rows: [{ acId: 'AC-001', testId: 's::[AC-001] home', status: 'passed' as const }], detail: '1/1' } : { ok: false, rows: [{ acId: 'AC-001', testId: null, status: 'missing' as const }], detail: 'AC-001: no smoke test' }),
    secretNames: () => ['DATABASE_URL'],
    ...over,
  };
}
const types = () => journal.events.map((e) => `${e.kind}:${e.type}`);

describe('Phase 5', () => {
  it('success: intent → apply → confirm, smoke passes, DEPLOY_VERIFIED carries the url and rows', async () => {
    const r = await runPhase5(deps(), 1);
    expect(r).toMatchObject({ ok: true, url: 'http://127.0.0.1:3000', smoke: [{ acId: 'AC-001', status: 'passed' }], healthcheck: 'HTTP 200' });
    expect(types()).toEqual(['fact:PHASE_STARTED', 'intent:DEPLOY_APPLY', 'confirm:DEPLOY_APPLY', 'fact:DEPLOY_APPLIED', 'fact:DEPLOY_VERIFIED']);
    expect(journal.events[1]!.data).toMatchObject({ attempt: 1, image: 'todo-api' });
    expect(target.calls).toEqual(['validate', 'build', 'apply', 'verify']);
  });

  it('a failed apply on attempt 1 plans a devops deploy-fix task and returns it', async () => {
    target.failAt = 'apply';
    const r = await runPhase5(deps(), 1);
    expect(r).toMatchObject({ ok: false, fixTask: { id: 'T950-deploy-fix-1', owner: 'devops', origin: 'deploy-fix', affectedPaths: ['deploy/k8s.yaml', 'Dockerfile'] } });
    expect(journal.events.find((e) => e.type === OrchEvent.DeployFailed)!.data).toMatchObject({ attempt: 1, stage: 'apply', detail: 'port busy', rolledBack: false });
    expect(journal.state.tasks.get('T950-deploy-fix-1')).toMatchObject({ state: 'planned' });
  });

  it('smoke failure rolls back to the previous image and records it', async () => {
    smokeOk = false;
    const r = await runPhase5(deps(), 2);
    expect(r).toMatchObject({ ok: false, fixTask: { id: 'T950-deploy-fix-2' } });
    expect(target.running).toBe('todo-api:old');
    expect(types()).toContain('fact:ROLLBACK_DONE');
    expect(journal.events.find((e) => e.type === OrchEvent.DeployFailed)!.data).toMatchObject({ attempt: 2, stage: 'smoke', rolledBack: true, detail: 'AC-001: no smoke test' });
  });

  it('attempt 3 failure ends the phase without a fix task', async () => {
    target.failAt = 'verify';
    const r = await runPhase5(deps(), 3);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('attempt 3') });
    expect('fixTask' in r).toBe(false);
  });

  it('resume after a crash between apply and verify confirms the intent from currentImage and never re-applies', async () => {
    const first = deps({ journal });
    await runPhase5(first, 1);
    // Rewrite history: keep everything up to the intent, as if the process died right after apply.
    const kept = journal.events.slice(0, 2);
    await journal.close();
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(path.join(remote.root, 'events.ndjson'), `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`);
    journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
    target.calls = [];
    const r = await runPhase5(deps({ journal }), 1);
    expect(r).toMatchObject({ ok: true });
    expect(target.calls).not.toContain('apply');
    expect(journal.isConfirmed(Intent.DeployApply, 'deploy-1')).toBe(true);
  });
});
```

Append to `test/orchestrator/reconcile.test.ts` (using that file's existing `deps`/journal helpers; adapt names to the ones the file defines):

```ts
it('confirms an unconfirmed DEPLOY_APPLY when the target already runs image:tag, otherwise redoes it', async () => {
  await journal.intent(Intent.DeployApply, 'deploy-1', { attempt: 1, image: 'todo-api', tag: 'abc1234', intent: { projectId: 'shop', image: 'todo-api', tag: 'abc1234', port: 3000, healthcheckPath: '/health', manifests: [], secretNames: [], contextDir: '/r' } });
  const report = await reconcile({ ...baseDeps(), currentImage: async () => 'todo-api:abc1234' });
  expect(report.confirmed).toEqual(['DEPLOY_APPLY:deploy-1']);
  expect(journal.isConfirmed(Intent.DeployApply, 'deploy-1')).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/orchestrator/phase5.test.ts test/orchestrator/reconcile.test.ts`
Expected: FAIL — `runPhase5` not exported; reconcile leaves `DEPLOY_APPLY` in `redo`.

- [ ] **Step 3: `PhaseDeps` fields and reconcile**

`server/orchestrator/phases/shared.ts` — imports `import type { DeployTarget } from '../../deploy/target.js'; import type { SmokeRow } from '../../exec/smoke.js';`, append to `PhaseDeps`:

```ts
  target?: DeployTarget;
  smoke?: (contextDir: string, serviceUrl: string) => Promise<{ ok: boolean; rows: SmokeRow[]; detail: string }>;
  secretNames?: () => string[];
```

`server/orchestrator/reconcile.ts` — `ReconcileDeps` gains `currentImage?: (intent: DeploymentIntent) => Promise<string | null>;` (import `type DeploymentIntent` from `../deploy/target.js`); append before `default:` in the switch:

```ts
      case Intent.DeployApply: {
        const intent = e.data.intent as DeploymentIntent | undefined;
        const running = intent && deps.currentImage ? await deps.currentImage(intent) : null;
        running !== null && running === `${String(d.image)}:${String(d.tag)}` ? await confirm(e, { previous: null, reconciled: true }) : redo(e);
        break;
      }
```

- [ ] **Step 4: Implement `server/orchestrator/phases/deploy.ts`**

```ts
import type { PlanTask } from '../../contracts/plan.js';
import { runDeployment, type DeploymentIntent, type DeployStage } from '../../deploy/target.js';
import type { SmokeRow } from '../../exec/smoke.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { Intent, OrchEvent } from '../events.js';
import { checkoutMain, type PhaseDeps } from './shared.js';

export type Phase5Result = { ok: true; url: string; smoke: SmokeRow[]; healthcheck: string } | { ok: false; reason: string; fixTask?: PlanTask };

export const MAX_DEPLOY_ATTEMPTS = 3;

export function deployIntent(deps: PhaseDeps, tag: string): DeploymentIntent {
  const plan = deps.plan!;
  return {
    projectId: deps.project.projectId,
    image: plan.deploy.image,
    tag,
    port: plan.deploy.port,
    healthcheckPath: plan.deploy.healthcheckPath,
    manifests: [...plan.deploy.manifests],
    secretNames: deps.secretNames ? deps.secretNames() : [...new Set(deps.spec.externalDependencies.flatMap((d) => d.secretNames))],
    contextDir: deps.ws.repo,
  };
}

function fixTaskFor(deps: PhaseDeps, attempt: number, stage: DeployStage, detail: string): PlanTask {
  return {
    id: `T950-deploy-fix-${attempt}`,
    title: `Fix deployment (${stage})`,
    description: `Deploy attempt ${attempt} failed at ${stage}: ${detail}`,
    criteriaRefs: [],
    dependsOn: [],
    affectedPaths: [...deps.plan!.deploy.manifests, 'Dockerfile'],
    owner: 'devops',
    origin: 'deploy-fix',
  };
}

/** Spec (phases 4-6) §4. One attempt per call; the caller runs the deploy-fix task through Phase 3 between attempts. */
export async function runPhase5(deps: PhaseDeps, attempt: 1 | 2 | 3): Promise<Phase5Result> {
  const target = deps.target;
  const smoke = deps.smoke;
  if (!deps.plan || !target || !smoke) throw new Error('Phase 5 needs plan, target and smoke in PhaseDeps');
  const verified = deps.journal.events.find((e) => e.type === OrchEvent.DeployVerified && e.data.attempt === attempt);
  if (verified) return { ok: true, url: String(verified.data.url), smoke: verified.data.smoke as SmokeRow[], healthcheck: String(verified.data.healthcheck) };
  if (!deps.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 5)) await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 5 });
  const tag = await checkoutMain(deps);
  const intent = deployIntent(deps, tag);
  const key = `deploy-${attempt}`;

  const failed = async (stage: DeployStage, detail: string, rolledBack: boolean, rollbackHealthy: boolean | null, previous: string | null): Promise<Phase5Result> => {
    await deps.journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail, rolledBack, rollbackHealthy, tag });
    if (rolledBack) await deps.journal.fact(OrchEvent.RollbackDone, { attempt, previous });
    if (attempt >= MAX_DEPLOY_ATTEMPTS) return { ok: false, reason: `deploy failed on attempt ${attempt} at ${stage}: ${detail}` };
    const fixTask = fixTaskFor(deps, attempt, stage, detail);
    await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: [fixTask] });
    return { ok: false, reason: `deploy failed at ${stage}; deploy-fix task planned`, fixTask };
  };

  let previous: string | null = null;
  let healthcheck = '';
  if (deps.journal.isConfirmed(Intent.DeployApply, key)) {
    const confirm = [...deps.journal.events].reverse().find((e) => e.kind === 'confirm' && e.intentId === `${Intent.DeployApply}:${key}`);
    previous = (confirm?.data.previous as string | null | undefined) ?? null;
    const health = await target.verify(intent);
    if (!health.healthy) return failed('verify', health.detail, false, null, previous);
    healthcheck = health.detail;
  } else {
    await deps.journal.intent(Intent.DeployApply, key, { attempt, image: intent.image, tag, intent });
    const result = await runDeployment(target, intent, { smoke: async () => ({ ok: true, detail: 'smoke runs as a journaled gate' }), baseUrl: '' });
    if (!result.ok) return failed(result.stage, result.detail, result.rolledBack, result.rollbackHealthy, null);
    previous = result.previous;
    await deps.journal.confirm(Intent.DeployApply, key, { previous });
    await deps.journal.fact(OrchEvent.DeployApplied, { attempt, previous, tag });
    healthcheck = (await target.verify(intent)).detail;
  }

  let url: string;
  try {
    url = await target.serviceUrl(intent);
  } catch (err) {
    return failed('verify', (err as Error).message, false, null, previous);
  }
  const s = await smoke(deps.ws.repo, url);
  if (!s.ok) {
    let rolledBack = false;
    let healthy: boolean | null = null;
    if (previous) {
      await target.rollback(intent, previous);
      rolledBack = true;
      healthy = (await target.verify(intent)).healthy;
    }
    return failed('smoke', s.detail, rolledBack, healthy, previous);
  }
  await deps.journal.fact(OrchEvent.DeployVerified, { attempt, url, smoke: s.rows, healthcheck, tag });
  return { ok: true, url, smoke: s.rows, healthcheck };
}
```

`server/orchestrator/phases/index.ts` — append `export { runPhase5, deployIntent, MAX_DEPLOY_ATTEMPTS, type Phase5Result } from './deploy.js';`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/orchestrator/phase5.test.ts test/orchestrator/reconcile.test.ts && npx tsc --noEmit -p .`
Expected: PASS (5 + 1 new); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/phases/deploy.ts server/orchestrator/phases/index.ts server/orchestrator/phases/shared.ts server/orchestrator/reconcile.ts test/orchestrator/phase5.test.ts test/orchestrator/reconcile.test.ts
git commit -m "feat(orchestrator): phase 5 deploys with journaled apply, smoke gate, rollback and deploy-fix tasks"
```

---

### Task 6: Phase 6 report, run wiring and agent prompts

**Files:**
- Create: `server/orchestrator/phases/report.ts`
- Modify: `server/orchestrator/phases/index.ts` (append export), `server/orchestrator/phases/shared.ts` (`docsCommitKey` / `commitAndMergeDocs` accept phase `6`), `server/orchestrator/steps.ts` (append `reportPack`)
- Modify: `server/orchestrator/run.ts` (append fields to `phaseDeps()`, `loop(final)` flag, new `postPhases()`; `execute()` last statement)
- Modify: `server/cli.ts` (`loadRunDeps` builds the deploy target; appended lines only)
- Modify: `.claude/agents/sm.md`, `.claude/agents/devops.md` (append sections)
- Test: `test/orchestrator/phase6.test.ts`, `test/orchestrator/run.test.ts` (add cases)

**Interfaces:**
- Produces: `Report` type (spec §5) in `report.ts`:

```ts
export interface Report {
  runId: string; specId: string; specHash: string;
  result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed';
  service: { url: string; healthcheck: string; smoke: SmokeRow[] } | null;
  deploy: { attempts: number; lastFailure: { attempt: number; stage: string; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null } | null };
  evidence: EvidenceRow[];
  delivered: string[];
  blocked: Array<{ taskId: string; reason: string }>;
  assumptions: string[];
  exploratoryScript: Array<{ acId: string; steps: string[] }>;
  tokens: { byRole: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>; total: { inputTokens: number; outputTokens: number; costUsd: number } };
  summary: string;
}
```

- Produces: `runPhase6(deps: PhaseDeps & { runId: string; accounting: Accounting; result: Report['result'] }): Promise<{ ok: boolean; report: Report; reason?: string }>` — always journals `REPORT_READY {report}`; `ok: false` only when the docs PR could not merge (`PHASE_FAILED {phase: 6}`), in which case `spec.json` on `main` keeps `running`.
- Produces: `reportPack(base, opts: { delivered; blocked; evidence; assumptions; deploy: string; tokens: string })` (`kind: 'report'`, role `sm`).
- Produces (`run.ts`): `RunDeps.target?: DeployTarget` (built by `loadRunDeps` from `project.deploy.target`: `DockerLocalTarget({ exec, get: httpGet, secrets })` or `KindTarget({ exec, secrets, cluster: cfg.deploy?.kindCluster ?? 'teams-ai', readFile })` — check `config.ts` for an existing kind cluster setting; if none, use the literal `'teams-ai'` and note it in Findings). `Run.execute()` ends with `postPhases()`.

Phase 6 algorithm (spec §5): `PHASE_STARTED {6}`; assemble everything the orchestrator knows (delivered = merged tasks, blocked with reasons from `TASK_BLOCKED`, evidence from the last `VERIFICATION_PASSED|FAILED.matrix`, assumptions = `journal.assumptions()`, deploy from `DEPLOY_VERIFIED`/`DEPLOY_FAILED`, tokens from `accounting.total({ role })` per role) → `report` step (2 attempts; failure → `summary: 'report step failed: <reason>'`, `exploratoryScript: []`, the SM's `delivered/blocked/assumptions` ignored in favour of the orchestrator's) → write `docs/specs/<specId>/report.json` and, when `result === 'awaiting-validation'`, `spec.json` with `status: 'awaiting-validation'` on docs worktree `docs/<specId>-report` → `commitAndMergeDocs(deps, 6, branch, worktree, 'docs(<specId>): report')` → `REPORT_READY {report, pr}`.

- [ ] **Step 1: Write the failing tests**

`test/orchestrator/phase6.test.ts` (same scaffolding as `phase4.test.ts`: `makeRemote`, `Journal`, `FakeExec` with `FakeGh` installed, `deps()`; copy the imports and `beforeEach`/`afterEach` from that file and add `import { FakeGh } from '../fixtures/fake-gh.js'; import { Accounting } from '../../server/budget/accounting.js'; import { runPhase6 } from '../../server/orchestrator/phases/index.js';`):

```ts
const reportAgent: Agent = async (req) => {
  if (req.kind !== 'report') throw new Error(req.kind);
  return ok({ specHash: HASH, delivered: ['T1'], blocked: [], assumptions: ['none'], exploratoryScript: [{ acId: 'AC-001', steps: ['open /', 'see list'] }], summary: 'All good.' });
};
const failingAgent: Agent = async () => ({ ok: false, failure: 'schema', errors: ['bad json'], summary, sandboxDisabled: false } as StepOutcome<never>);

async function seed() {
  await journal.fact(RunEvent.TaskPlanned, { task: plan.tasks[0] });
  await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
  for (const to of ['implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'merged'] as const) await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to });
  await journal.fact(OrchEvent.SpecGapAnswered, { taskId: 'T1', question: 'q', answer: 'a', assumption: 'T1: assumed X' });
  await journal.fact(OrchEvent.VerificationPassed, { round: 1, matrix: [{ criterion: 'AC-001', tasks: ['T1'], tests: ['u::[AC-001] a'], status: 'passed' }] });
  await journal.fact(OrchEvent.DeployVerified, { attempt: 1, url: 'http://127.0.0.1:3000', smoke: [], healthcheck: 'HTTP 200', tag: 'abc' });
}

describe('Phase 6', () => {
  it('assembles the report from the journal, merges report.json and the awaiting-validation status, journals REPORT_READY', async () => {
    await seed();
    const d = { ...deps(reportAgent, undefined), runId: 'r1', accounting: new Accounting(), result: 'awaiting-validation' as const };
    const r = await runPhase6(d);
    expect(r.ok).toBe(true);
    expect(r.report).toMatchObject({ result: 'awaiting-validation', delivered: ['T1'], blocked: [], assumptions: ['T1: assumed X'], service: { url: 'http://127.0.0.1:3000' }, evidence: [{ criterion: 'AC-001', status: 'passed' }], exploratoryScript: [{ acId: 'AC-001' }], summary: 'All good.' });
    expect(journal.events.at(-1)!.type).toBe(OrchEvent.ReportReady);
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/report.json'])).runId).toBe('r1');
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/spec.json'])).status).toBe('awaiting-validation');
    expect(gh.prs.at(-1)!.title).toBe('docs(spec-001): report');
  });

  it('a failing report step still produces a report with the orchestrator fields and a failure summary', async () => {
    await seed();
    const r = await runPhase6({ ...deps(failingAgent, undefined), runId: 'r1', accounting: new Accounting(), result: 'deploy-failed' });
    expect(r.ok).toBe(true);
    expect(r.report).toMatchObject({ result: 'deploy-failed', summary: expect.stringContaining('report step failed'), exploratoryScript: [], delivered: ['T1'] });
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/spec.json'])).status).toBe('running');
  });
});
```

Append to `test/orchestrator/run.test.ts` (uses that file's `deps`, `happy`, `withAgents`):

```ts
it('after every task merges the run verifies main, deploys, reports and finishes awaiting-validation', async () => {
  const script: Script = async (req) => (req.kind === 'report' ? { ok: true, value: { specHash: HASH, delivered: ['T1', 'T2'], blocked: [], assumptions: [], exploratoryScript: [{ acId: 'AC-001', steps: ['s'] }], summary: 'ok' }, summary: summary() } : happy(req));
  const target = { name: 'docker-local' as const, validate: async () => [], build: async () => {}, apply: async () => ({ previous: null }), verify: async () => ({ healthy: true, detail: 'HTTP 200' }), currentImage: async () => null, rollback: async () => {}, destroy: async () => {}, serviceUrl: async () => 'http://127.0.0.1:3000' };
  const run = await Run.create(await withAgents(deps(script, { target })));
  expect(await run.execute()).toBe('awaiting-validation');
  const types = run.journal.events.map((e) => e.type);
  expect(types.filter((t) => t === 'PHASE_STARTED').length).toBe(4);
  expect(types).toEqual(expect.arrayContaining(['VERIFICATION_PASSED', 'DEPLOY_VERIFIED', 'REPORT_READY']));
  expect(run.journal.events.at(-1)!.data).toMatchObject({ result: 'awaiting-validation' });
  await run.close();
}, 60_000);

it('a run that ends phase 3 with a blocked task finishes blocked and never enters phase 4', async () => {
  const script: Script = async (req) => (req.kind === 'dev' && req.taskId === 'T2' ? { ok: false, failure: 'code', errors: ['nope'], summary: summary({ isError: true }), sandboxDisabled: false } : happy(req));
  const run = await Run.create(await withAgents(deps(script)));
  expect(await run.execute()).toBe('blocked');
  expect(run.journal.events.some((e) => e.type === 'PHASE_STARTED' && e.data.phase === 4)).toBe(false);
  await run.close();
}, 60_000);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/orchestrator/phase6.test.ts test/orchestrator/run.test.ts`
Expected: FAIL — `runPhase6` not exported; the run finishes `complete` and has 3 `PHASE_STARTED`.

- [ ] **Step 3: `reportPack` and shared phase 6 keys**

`server/orchestrator/phases/shared.ts`: change the two signatures `docsCommitKey(deps, phase: 1 | 2)` and `commitAndMergeDocs(deps, phase: 1 | 2, …)` to `phase: 1 | 2 | 6` (plan 11 widens them to `0 | 1 | 2`; if that landed first, make it `0 | 1 | 2 | 6`).

`server/orchestrator/steps.ts` — append after `fixTasksPack`:

```ts
export function reportPack(base: PackBase, opts: { delivered: readonly string[]; blocked: ReadonlyArray<{ taskId: string; reason: string }>; evidence: string; assumptions: readonly string[]; deploy: string; tokens: string }): ContextPackInput {
  const feedback = [
    'Write the final report for the human validator. Every exploratoryScript entry must name an existing acceptance criterion and give concrete steps a person can follow against the service URL.',
    `Delivered tasks: ${opts.delivered.join(', ') || 'none'}`,
    `Blocked tasks:\n${opts.blocked.map((b) => `- ${b.taskId}: ${b.reason}`).join('\n') || '- none'}`,
    `Evidence matrix:\n${opts.evidence}`,
    `Assumptions made during the run:\n${opts.assumptions.map((a) => `- ${a}`).join('\n') || '- none'}`,
    `Deploy outcome: ${opts.deploy}`,
    `Token usage: ${opts.tokens}`,
  ].join('\n\n');
  return { ...common(base, 'report', 'sm'), criteria: base.spec.acceptanceCriteria, feedback };
}
```

- [ ] **Step 4: Implement `server/orchestrator/phases/report.ts`**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OutputOf } from '../../agents/outputs.js';
import type { Accounting } from '../../budget/accounting.js';
import type { EvidenceRow } from '../../evidence/matrix.js';
import type { SmokeRow } from '../../exec/smoke.js';
import type { StepOutcome } from '../../runner/step.js';
import { OrchEvent } from '../events.js';
import { reportPack } from '../steps.js';
import { PAUSED_AUTH, commitAndMergeDocs, docsWorktree, pauseForFailure, specDir, type PhaseDeps } from './shared.js';

export interface Report {
  runId: string;
  specId: string;
  specHash: string;
  result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed';
  service: { url: string; healthcheck: string; smoke: SmokeRow[] } | null;
  deploy: { attempts: number; lastFailure: { attempt: number; stage: string; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null } | null };
  evidence: EvidenceRow[];
  delivered: string[];
  blocked: Array<{ taskId: string; reason: string }>;
  assumptions: string[];
  exploratoryScript: Array<{ acId: string; steps: string[] }>;
  tokens: { byRole: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>; total: { inputTokens: number; outputTokens: number; costUsd: number } };
  summary: string;
}

export type Phase6Deps = PhaseDeps & { runId: string; accounting: Accounting; result: Report['result'] };

const ROLES = ['po', 'sm', 'dev', 'test', 'devops', 'system1'] as const;

function assemble(deps: Phase6Deps): Omit<Report, 'exploratoryScript' | 'summary'> {
  const events = deps.journal.events;
  const last = (type: string) => [...events].reverse().find((e) => e.type === type);
  const tasks = [...deps.journal.state.tasks.values()];
  const verified = last(OrchEvent.DeployVerified);
  const failures = events.filter((e) => e.type === OrchEvent.DeployFailed);
  const lastFailure = failures.at(-1);
  const matrixEvent = [...events].reverse().find((e) => e.type === OrchEvent.VerificationPassed || e.type === OrchEvent.VerificationFailed);
  const usage = (filter: { role?: string }) => {
    const t = deps.accounting.total(filter as never);
    return { inputTokens: t.inputTokens, outputTokens: t.outputTokens, costUsd: t.costUsd };
  };
  return {
    runId: deps.runId,
    specId: deps.spec.specId,
    specHash: deps.specHash,
    result: deps.result,
    service: verified ? { url: String(verified.data.url), healthcheck: String(verified.data.healthcheck), smoke: verified.data.smoke as SmokeRow[] } : null,
    deploy: {
      attempts: Math.max(failures.length, verified ? Number(verified.data.attempt) : 0),
      lastFailure: lastFailure && !verified ? { attempt: Number(lastFailure.data.attempt), stage: String(lastFailure.data.stage), detail: String(lastFailure.data.detail), rolledBack: Boolean(lastFailure.data.rolledBack), rollbackHealthy: (lastFailure.data.rollbackHealthy as boolean | null) ?? null } : null,
    },
    evidence: (matrixEvent?.data.matrix as EvidenceRow[] | undefined) ?? [],
    delivered: tasks.filter((t) => t.state === 'merged').map((t) => t.def.id),
    blocked: tasks.filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: String([...events].reverse().find((e) => e.type === OrchEvent.TaskBlocked && e.data.taskId === t.def.id)?.data.reason ?? 'blocked') })),
    assumptions: deps.journal.assumptions(),
    tokens: { byRole: Object.fromEntries(ROLES.map((r) => [r, usage({ role: r })])), total: usage({}) },
  };
}

/** Spec (phases 4-6) §5: every run ends with a report; the docs PR carries it and the awaiting-validation status. */
export async function runPhase6(deps: Phase6Deps): Promise<{ ok: boolean; report: Report; reason?: string }> {
  const ready = [...deps.journal.events].reverse().find((e) => e.type === OrchEvent.ReportReady);
  if (ready) return { ok: true, report: ready.data.report as Report };
  if (!deps.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 6)) await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 6 });
  const base = assemble(deps);
  let script: Report['exploratoryScript'] = [];
  let summary = '';
  let lastError = 'no answer';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out: StepOutcome<OutputOf<'report'>> = await deps.runAgent<'report'>({
      kind: 'report',
      role: 'sm',
      pack: reportPack(deps.packBase(), {
        delivered: base.delivered,
        blocked: base.blocked,
        evidence: base.evidence.map((r) => `${r.criterion}: ${r.status} (${r.tests.join(', ') || 'no tests'})`).join('\n') || 'none',
        assumptions: base.assumptions,
        deploy: base.service ? `deployed at ${base.service.url} (${base.service.healthcheck})` : base.deploy.lastFailure ? `failed at ${base.deploy.lastFailure.stage}: ${base.deploy.lastFailure.detail}` : 'not deployed',
        tokens: `total ${base.tokens.total.inputTokens} in / ${base.tokens.total.outputTokens} out, $${base.tokens.total.costUsd.toFixed(2)}`,
      }),
      cwd: deps.ws.repo,
      phase: 'phase6',
      taskId: null,
      attempt,
    });
    if (out.ok) {
      const known = new Set(deps.spec.acceptanceCriteria.map((c) => c.id));
      script = out.value.exploratoryScript.filter((s) => known.has(s.acId));
      summary = out.value.summary;
      lastError = '';
      break;
    }
    if (out.failure === 'quota' || out.failure === 'auth') {
      if (await pauseForFailure(deps, out.failure)) return { ok: false, report: { ...base, exploratoryScript: [], summary: PAUSED_AUTH }, reason: PAUSED_AUTH };
      attempt -= 1;
      continue;
    }
    lastError = out.errors.join('; ');
  }
  const report: Report = { ...base, exploratoryScript: script, summary: lastError ? `report step failed: ${lastError}` : summary };

  const branch = `docs/${deps.spec.specId}-report`;
  const worktree = await docsWorktree(deps, branch);
  const dir = path.join(worktree, specDir(deps.spec.specId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (deps.result === 'awaiting-validation') {
    const specFile = path.join(dir, 'spec.json');
    const current = JSON.parse(await fs.readFile(specFile, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(specFile, `${JSON.stringify({ ...current, status: 'awaiting-validation' }, null, 2)}\n`);
  }
  const merged = await commitAndMergeDocs(deps, 6, branch, worktree, `docs(${deps.spec.specId}): report`);
  await deps.journal.fact(OrchEvent.ReportReady, { report, merged: merged.ok });
  return merged.ok ? { ok: true, report } : { ok: false, report, reason: merged.reason };
}
```

`server/orchestrator/phases/index.ts` — append `export { runPhase6, type Phase6Deps, type Report } from './report.js';`.

- [ ] **Step 5: Wire the run**

`server/orchestrator/run.ts`:

1. `RunDeps` — append `target?: DeployTarget;` (import `type DeployTarget` from `../deploy/target.js`; `runSmoke` from `../exec/smoke.js`; `runPhase4, runPhase5, runPhase6, MAX_DEPLOY_ATTEMPTS` from `./phases/index.js`).
2. `phaseDeps()` — append to the returned object:

```ts
      plan: this.plan ?? undefined,
      gates: this.gates,
      tasks: () => [...this.journal.state.tasks.values()].map((t) => ({ def: t.def, state: t.state })),
      decider: this.runnerDeps().decider,
      confidential: this.deps.project.confidential,
      boundaries: this.runnerDeps().boundaries,
      target: this.deps.target,
      smoke: async (contextDir, url) => {
        const plan = this.plan!;
        const r = await runSmoke(plan, this.deps.spec, { worktree: contextDir, image: plan.gateImage, junitPath: plan.junitPath, cpus: 2, memory: '2g', timeoutMs: 15 * 60_000, secrets: this.deps.secrets, containerName: `teams-ai-${this.runId}-smoke`, user: containerUser() }, url, { exec: this.deps.exec, readFile: (p) => fs.readFile(p, 'utf8').catch(() => null), removeFile: (p) => fs.rm(p, { force: true }) });
        if (r.result) await this.journal.fact(r.result.passed ? OrchEvent.GatePassed : OrchEvent.GateFailed, { taskId: null, phase: 5, gate: 'smoke', failure: r.result.failure, exitCode: r.result.exitCode, durationMs: r.result.durationMs, junit: (r.result.junit ?? []).map((t) => ({ id: t.id, name: t.name, classname: t.classname, status: t.status, acIds: t.acIds })) });
        return { ok: r.ok, rows: r.rows, detail: r.detail };
      },
```

(`runnerDeps()` builds a decider each call; cache it once in a private field `private decider?: TaskRunnerDeps['decider']` set the first time `runnerDeps()` runs, and use it here — a small change inside `runnerDeps()`: `const decider = (this.decider ??= createDecider({...}))`.)

3. `loop()` takes `opts: { final: boolean } = { final: true }`. The two `return this.finish(...)` lines that fire on `progress === 'complete'` become: when `!opts.final && progress === 'complete' && this.inflight.size === 0`, `return 'complete'` **without** calling `finish`. Concretely, replace

```ts
      if (progress !== 'running' && this.inflight.size === 0) return this.finish(progress === 'complete' ? 'complete' : progress);
```

with

```ts
      if (progress !== 'running' && this.inflight.size === 0) {
        if (progress === 'complete' && !opts.final && ![...this.journal.state.tasks.values()].some((t) => t.state === 'blocked')) return 'complete';
        return this.finish(progress === 'complete' ? 'complete' : progress);
      }
```

4. `execute()` — its last statement `return this.loop();` becomes:

```ts
    const phase3 = await this.loop({ final: false });
    if (phase3 !== 'complete') return phase3;
    return this.postPhases();
```

5. Append the method after `requestStop()`:

```ts
  /** Spec (phases 4-6): verification → deploy → report; fix tasks go back through the Phase 3 loop. */
  private async postPhases(): Promise<ExecuteResult> {
    const runFix = async (tasks: PlanTask[]): Promise<ExecuteResult | 'merged'> => {
      for (const t of tasks) if (this.journal.state.tasks.get(t.id)?.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: t.id, to: 'ready' });
      const r = await this.loop({ final: false });
      if (r !== 'complete') return r;
      return tasks.every((t) => this.journal.state.tasks.get(t.id)?.state === 'merged') ? 'merged' : 'blocked';
    };
    let result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed' = 'awaiting-validation';
    let p4 = await runPhase4(this.phaseDeps(), 1);
    if (!p4.ok && p4.reason === PAUSED_AUTH) return 'paused:auth';
    if (!p4.ok && p4.fixTasks) {
      const back = await runFix(p4.fixTasks);
      if (back !== 'merged' && back !== 'blocked') return back;
      p4 = await runPhase4(this.phaseDeps(), 2);
      if (!p4.ok && p4.reason === PAUSED_AUTH) return 'paused:auth';
    }
    if (!p4.ok) result = 'verification-failed';
    if (p4.ok && this.deps.target) {
      for (let attempt = 1 as 1 | 2 | 3; attempt <= MAX_DEPLOY_ATTEMPTS; attempt = (attempt + 1) as 1 | 2 | 3) {
        const p5 = await runPhase5(this.phaseDeps(), attempt);
        if (p5.ok) break;
        if (!p5.fixTask) {
          result = 'deploy-failed';
          break;
        }
        const back = await runFix([p5.fixTask]);
        if (back !== 'merged' && back !== 'blocked') return back;
        if (back === 'blocked') {
          result = 'deploy-failed';
          break;
        }
      }
    }
    const p6 = await runPhase6({ ...this.phaseDeps(), runId: this.runId, accounting: this.accounting, result });
    if (!p6.ok && p6.reason === PAUSED_AUTH) return 'paused:auth';
    if (!p6.ok) return this.finish('phase-failed', p6.reason);
    return this.finish(result);
  }
```

`finish()` already accepts any `RunResult`; its `blocked` override only applies when `result === 'complete'`, so the new results pass through. Import `PlanTask` type and `PAUSED_AUTH` if not already imported.

6. `server/cli.ts`, inside `loadRunDeps` where the returned `RunDeps` object is built, append the field:

```ts
    target: project.deploy.target === 'kind' ? new KindTarget({ exec: execCommand, secrets, cluster: 'teams-ai', readFile: (p) => fs.readFile(p, 'utf8') }) : new DockerLocalTarget({ exec: execCommand, get: httpGet, secrets }),
```

with imports `import { DockerLocalTarget } from './deploy/docker-local.js'; import { KindTarget } from './deploy/kind.js'; import { httpGet } from './deploy/target.js';` appended after the existing import block. (`secrets` is the object `loadRunDeps` already loads; use its local name.)

- [ ] **Step 6: Agent prompts**

Append to `.claude/agents/sm.md`:

```md
## Planning fix tasks (`fix-tasks` step)

Integrated verification on `main` failed. From the failed tests, the uncovered criteria and the gate output, plan one to three small tasks that repair the failure. Reuse the existing module boundaries; never widen `affectedPaths` beyond what the failure touches. Do not choose ids: the orchestrator assigns them. `dependsOn` may name existing tasks or stay empty.

## Writing the report (`report` step)

You receive delivered and blocked tasks, the evidence matrix, the assumptions log, the deploy outcome and token usage. Write `summary` for a human validator (what was built, what is blocked and why, what to watch). `exploratoryScript` has one entry per acceptance criterion with concrete steps against the service URL. Copy `delivered`, `blocked` and `assumptions` from the input; do not invent entries.
```

Append to `.claude/agents/devops.md`:

```md
## Fixing a failed deployment (`dev` step on a `deploy-fix` task)

The orchestrator deployed `main` and it failed at the stage named in the task description (validate, build, apply, verify or smoke) with the detail and log tail provided. Change only the Dockerfile and the manifests the plan names so the next deploy attempt succeeds; the application code is out of scope for this task. Return the normal `dev` output with `status: done` and a commit message, or `spec-gap` when the failure needs a product decision.
```

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run test/orchestrator && npx tsc --noEmit -p . && npm run -s lint`
Expected: PASS (phase6 ×2, run ×2 new; every existing orchestrator test still green — the `happy` script has no `report` case, so tests that previously ended `complete` now need `target` absent: without `deps.target` Phase 5 is skipped and Phase 6 still runs, so extend `happy` with a `report` case returning the fixture output and update those assertions from `'complete'` to `'awaiting-validation'` where the run merges every task; record this in the ledger as a ruling); tsc and lint clean.

- [ ] **Step 8: Commit**

```bash
git add server/orchestrator/phases/report.ts server/orchestrator/phases/index.ts server/orchestrator/phases/shared.ts server/orchestrator/steps.ts server/orchestrator/run.ts server/cli.ts .claude/agents/sm.md .claude/agents/devops.md test/orchestrator/phase6.test.ts test/orchestrator/run.test.ts
git commit -m "feat(orchestrator): phases 4-6 run after the task loop; report merged with the awaiting-validation status"
```

---

### Task 7: `teams-ai spec complete`

**Files:**
- Modify: `server/orchestrator/run.ts` (append `completeSpec()`)
- Modify: `server/cli.ts` (usage line, `'spec'` command branch appended after the `status` branch)
- Test: `test/cli.test.ts` (add case), `test/orchestrator/run.test.ts` (add case)

**Interfaces:**
- Consumes: `docsWorktree`, `commitAndMergeDocs` (phase key `6` reused with branch `docs/<specId>-done`, commit key `<specId>-done`), `nextRunId`.
- Produces: `Run.completeSpec(): Promise<ExecuteResult>` — requires the spec on `main` to be `awaiting-validation` (else `phase-failed` with reason `spec <id> is <status>; only awaiting-validation specs complete`), writes `status: 'done'` into `docs/specs/<specId>/spec.json` on a docs worktree, merges `docs(<specId>): done`, journals `RUN_FINISHED {result: 'done'}`.
- Produces: CLI `teams-ai spec complete --project <dir> --spec <id> [--run-id <id>]` — loads deps like `run`, creates the run with id `--run-id` or `nextRunId(ws, '<specId>-complete')`, calls `completeSpec()`, exits with `exitCode(result)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/orchestrator/run.test.ts`:

```ts
it('completeSpec marks an awaiting-validation spec done on main through a docs PR and finishes done', async () => {
  const waiting = { ...spec, status: 'awaiting-validation' as const };
  await remote.commit({ 'docs/specs/spec-001/spec.json': JSON.stringify(waiting) }, 'docs: awaiting validation');
  const run = await Run.create(await withAgents(deps(happy, { spec: waiting })), 'spec-001-complete-r1');
  expect(await run.completeSpec()).toBe('done');
  await git(remote.repo, ['fetch', '-q', 'origin']);
  expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/spec.json'])).status).toBe('done');
  expect(run.journal.events.at(-1)!.data).toMatchObject({ result: 'done' });
  expect(gh.prs.at(-1)!.title).toBe('docs(spec-001): done');
  await run.close();
}, 30_000);

it('completeSpec refuses a spec that is still running', async () => {
  const run = await Run.create(await withAgents(deps(happy)), 'spec-001-complete-r1');
  expect(await run.completeSpec()).toBe('phase-failed');
  expect(run.journal.events.at(-1)!.data).toMatchObject({ result: 'phase-failed', reason: expect.stringContaining('only awaiting-validation') });
  await run.close();
});
```

(`remote.commit(files, message)` — if `test/fixtures/git-remote.ts` has no such helper, add `commit` there: write the files into a temp clone of the remote, commit and push to `main`; the helper mirrors what `makeRemote` does for the initial files.)

Append to `test/cli.test.ts` (this file drives `main` with a fake factory; mirror its existing `run` case):

```ts
it('spec complete creates a <specId>-complete run and calls completeSpec', async () => {
  const calls: string[] = [];
  const fake = { runId: 'hello-001-complete-r1', execute: async () => { calls.push('execute'); return 'complete' as const; }, completeSpec: async () => { calls.push('completeSpec'); return 'done' as const; }, requestStop: async () => {}, close: async () => {}, journal: { state: { tasks: new Map() } }, accounting: { total: () => ({ costUsd: 0 }) } };
  const code = await main({ argv: ['spec', 'complete', '--project', HELLO, '--spec', 'hello-001'], env: process.env, stdout: () => {}, stderr: () => {} }, async () => fake as never, { signals: () => () => {} });
  expect(code).toBe(0);
  expect(calls).toEqual(['completeSpec']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/cli.test.ts test/orchestrator/run.test.ts -t "complete"`
Expected: FAIL — `completeSpec is not a function`; CLI prints usage and returns 2 for `spec`.

- [ ] **Step 3: `Run.completeSpec()`**

Append to `server/orchestrator/run.ts` after `postPhases()`:

```ts
  /** Spec (phases 4-6) §6 "Complete spec": the only write is spec.json status → done, through the docs merge path. */
  async completeSpec(): Promise<ExecuteResult> {
    const specId = this.deps.spec.specId;
    const onMain = await git(this.deps.ws.repo, ['show', `origin/main:docs/specs/${specId}/spec.json`], this.deps.exec).catch(() => null);
    const status = onMain ? (JSON.parse(onMain) as { status?: string }).status : undefined;
    if (status !== 'awaiting-validation') return this.finish('phase-failed', `spec ${specId} is ${status ?? 'missing on main'}; only awaiting-validation specs complete`);
    const deps = { ...this.phaseDeps(), spec: { ...this.deps.spec, specId } };
    const branch = `docs/${specId}-done`;
    const worktree = await docsWorktree(deps, branch);
    const file = path.join(worktree, 'docs', 'specs', specId, 'spec.json');
    const current = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(file, `${JSON.stringify({ ...current, status: 'done' }, null, 2)}\n`);
    const merged = await commitAndMergeDocs({ ...deps, spec: { ...deps.spec, specId: `${specId}-done` } }, 6, branch, worktree, `docs(${specId}): done`);
    return merged.ok ? this.finish('done') : this.finish('phase-failed', merged.reason);
  }
```

(imports: `docsWorktree`, `commitAndMergeDocs` from `./phases/shared.js`; `git` is already imported. The `specId: '<id>-done'` override only changes the docs commit key so it does not collide with the report's `<specId>-6` key.)

- [ ] **Step 4: CLI**

`server/cli.ts` — `USAGE` gains the line `  teams-ai spec complete --project <dir> --spec <id> [--run-id <id>]`; the command guard becomes `['run', 'resume', 'status', 'ui', 'spec'].includes(command)`; after the `status` branch append:

```ts
    if (command === 'spec') {
      if (rest[0] !== 'complete' || typeof f.spec !== 'string') {
        io.stderr(USAGE);
        return 2;
      }
      const d = factory === defaultFactory ? await loadRunDeps(io, projectDir, f.spec, { dryRun: false }) : await loadRunDeps(io, projectDir, f.spec, { dryRun: false }).catch(() => null as unknown as RunDeps);
      const id = typeof f['run-id'] === 'string' ? f['run-id'] : d ? await nextRunId(d.ws, `${f.spec}-complete`) : `${f.spec}-complete-r1`;
      const run = await factory(d, undefined, id);
      const result = await run.completeSpec();
      await run.close();
      io.stderr(`spec ${f.spec}: ${result}`);
      return exitCode(result);
    }
```

(`nextRunId` imported from `./orchestrator/workspace.js`; `rest` is already the argv after the command, and `flags(rest)` ignores the bare `complete` token.) `loadRunDeps` must not require the spec to be `running`: if it does (check its precondition/`freeze` logic), pass through when `status === 'awaiting-validation'` — append the condition rather than restructuring.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/cli.test.ts test/orchestrator/run.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/run.ts server/cli.ts test/cli.test.ts test/orchestrator/run.test.ts test/fixtures/git-remote.ts
git commit -m "feat(cli): spec complete marks an awaiting-validation spec done through the docs merge path"
```

---

### Task 8: API — report and phase in run detail, complete endpoint, new statuses

**Files:**
- Modify: `server/api/run-control.ts` (`RunTarget.mode` gains `'complete'`; `runCommand` arm appended)
- Modify: `server/api/run-index.ts` (`RunListStatus` gains the four new results)
- Modify: `server/api/run-routes.ts` (run detail gains `report` and `phase`; append route `POST /projects/:projectId/specs/:specId/complete`)
- Test: `test/api/run-control.test.ts` (add case), `test/api/run-api.test.ts` (add cases)

**Interfaces:**
- Produces: `GET /runs/:runId` → `{ …, phase: number, report: Report | null }` — `phase` = the highest `PHASE_STARTED.phase` seen (0 when none), `report` = data of the last `REPORT_READY` or `null`.
- Produces: `POST /projects/:projectId/specs/:specId/complete` → `{ runId }`; 404 unknown spec; 409 unless the spec's `status` on disk is `awaiting-validation` or an active run claims the spec (`CLAIMS_SPEC`); spawns `spec complete --project <dir> --spec <id> --run-id <specId>-complete-r<N>` through `launch(...)` with `mode: 'complete'`.
- Produces: `runCommand(deps, { mode: 'complete', … })` → `['spec', 'complete', '--project', dir, '--spec', specId, '--run-id', runId]`.
- "Report problem" is **not** a new route: the Validation page calls plan 11's `POST /projects/:projectId/specs/:specId/continue { report }` (spec §6 named it `report-problem`; ruling: one route, owned by the refine registry, which already enforces the spec-status rule).

- [ ] **Step 1: Write the failing tests**

Append to `test/api/run-control.test.ts`:

```ts
it('complete mode runs the spec complete command with the run id', () => {
  expect(runCommand(deps, { projectDir: '/p', specId: 'hello-001', runId: 'hello-001-complete-r1', mode: 'complete' }).args).toEqual(['cli', 'spec', 'complete', '--project', '/p', '--spec', 'hello-001', '--run-id', 'hello-001-complete-r1']);
});
```

(`deps` = the file's fake `RunControlDeps` with `cliEntry: () => ({ bin: 'node', prefix: ['cli'] })`.)

Append to `test/api/run-api.test.ts` inside `describe('run detail, events and steps')`:

```ts
it('detail carries the current phase and the report once REPORT_READY is journaled', async () => {
  const report = { runId: 'hello-001-r1', specId: 'hello-001', result: 'awaiting-validation', service: { url: 'http://127.0.0.1:3000', healthcheck: 'HTTP 200', smoke: [] }, evidence: [], delivered: ['T1'], blocked: [], assumptions: [], exploratoryScript: [], tokens: { byRole: {}, total: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }, summary: 's', deploy: { attempts: 1, lastFailure: null }, specHash: 'x' };
  await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), { type: 'PHASE_STARTED', data: { phase: 3 } }, { type: 'PHASE_STARTED', data: { phase: 6 } }, { type: 'REPORT_READY', data: { report, merged: true } }, { type: 'RUN_FINISHED', data: { result: 'awaiting-validation', merged: ['T1'], blocked: [] } }], state('running'));
  const body = await (await fetch(`${base()}/api/runs/hello-001-r1`)).json();
  expect(body).toMatchObject({ phase: 6, status: 'awaiting-validation', report: { summary: 's', delivered: ['T1'] } });
  await writeRun(runs, 'hello-001-r2', [started('hello-001-r2')], state('running'));
  expect(await (await fetch(`${base()}/api/runs/hello-001-r2`)).json()).toMatchObject({ phase: 0, report: null });
});
```

and a new describe:

```ts
describe('complete spec', () => {
  const specFile = path.join(HELLO, 'docs', 'specs', 'hello-001', 'spec.json');
  let original = '';
  beforeEach(async () => { original = await fs.readFile(specFile, 'utf8'); });
  afterEach(async () => { await fs.writeFile(specFile, original); });

  it('spawns spec complete for an awaiting-validation spec and refuses otherwise or twice', async () => {
    expect((await post('/api/projects/hello-app/specs/hello-001/complete')).status).toBe(409);
    await fs.writeFile(specFile, JSON.stringify({ ...JSON.parse(original), status: 'awaiting-validation' }));
    onSpawn = async (runId) => { await writeRun(runs, runId, [{ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } }], state('running')); };
    const r = await post('/api/projects/hello-app/specs/hello-001/complete');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ runId: 'hello-001-complete-r1' });
    expect(spawns[0]!.args).toEqual(['cli', 'spec', 'complete', '--project', HELLO, '--spec', 'hello-001', '--run-id', 'hello-001-complete-r1']);
    expect((await post('/api/projects/hello-app/specs/hello-001/complete')).status).toBe(409);
    expect((await post('/api/projects/hello-app/specs/nope/complete')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/api/run-control.test.ts test/api/run-api.test.ts`
Expected: FAIL — `mode: 'complete'` rejected by the type / wrong args; `phase`/`report` undefined; `/complete` → 404.

- [ ] **Step 3: Implement**

`server/api/run-control.ts` — `RunTarget.mode: 'run' | 'resume' | 'complete'`; `runCommand` becomes:

```ts
export function runCommand(deps: RunControlDeps, o: RunTarget): SpawnArgs {
  const { bin, prefix } = deps.cliEntry();
  const args =
    o.mode === 'run'
      ? ['run', '--project', o.projectDir, '--spec', o.specId, '--run-id', o.runId]
      : o.mode === 'resume'
        ? ['resume', '--project', o.projectDir, '--run', o.runId]
        : ['spec', 'complete', '--project', o.projectDir, '--spec', o.specId, '--run-id', o.runId];
  return { bin, args: [...prefix, ...args], cwd: deps.repoRoot, logFile: o.logFile ?? 'ui.log' };
}
```

(If plan 11 already appended `--draft` handling for `mode === 'run'`, keep that arm intact and only add the `complete` arm.)

`server/api/run-index.ts` — `RunListStatus` union gains `| 'awaiting-validation' | 'verification-failed' | 'deploy-failed' | 'done'`; `runRow`'s `specId` fallback becomes `runId.replace(/(-complete)?-r\d+$/, '')` so a crashed complete-run still maps to its spec.

`server/api/run-routes.ts` — in the `GET /runs/:runId` handler, before `json(200, {…})` add:

```ts
        const phase = evs.reduce((max, e) => (e.type === 'PHASE_STARTED' ? Math.max(max, Number(e.data.phase)) : max), 0);
        const ready = [...evs].reverse().find((e) => e.type === 'REPORT_READY');
```

and append `phase, report: ready?.data.report ?? null,` to the object. Append the route at the end of the returned array:

```ts
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs/:specId/complete`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const dir = await projectDir(idx, params.projectId!);
        const specId = safe(params.specId!);
        const { specs } = await readProject(dir);
        const spec = specs.find((s) => s.specId === specId);
        if (!spec) throw new HttpError(404, `unknown spec ${specId}`);
        if (spec.status !== 'awaiting-validation') throw new HttpError(409, `spec ${specId} is ${spec.status}; only awaiting-validation specs complete`);
        const runId = await exclusive(`spec ${params.projectId}/${specId}`, async () => {
          const rows = await listRuns(idx, params.projectId!);
          const active = rows.find((r) => r.specId === specId && CLAIMS_SPEC.has(r.status));
          if (active) throw new HttpError(409, `spec ${specId} already has run ${active.runId} (${active.status})`);
          const id = await nextRunId({ runs: runsDir(idx) }, `${specId}-complete`);
          await launch(idx, { projectDir: dir, specId, runId: id, mode: 'complete' });
          return id;
        });
        json(200, { runId });
      },
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/api && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api/run-control.ts server/api/run-index.ts server/api/run-routes.ts test/api/run-control.test.ts test/api/run-api.test.ts
git commit -m "feat(api): run detail carries phase and report; complete endpoint spawns spec complete"
```

---

### Task 9: Web — Validation screen, Execution and Projects additions

**Files:**
- Modify: `web/src/api.ts` (append `Report` types, `RunDetail.phase/report`, `runApi.complete`, `runApi.reportProblem`)
- Modify: `web/src/run/selectors.ts` (`phases` ends phases 4/5/6 on their events; append `deployOutcome`)
- Create: `web/src/pages/Validation.tsx`, `web/src/pages/Validation.test.tsx`
- Modify: `web/src/pages/Run.tsx` (origin tag on task rows; "Validation" link in the header when `detail.report`)
- Modify: `web/src/pages/Projects.tsx` (append "Validate" link for `awaiting-validation` specs), `web/src/pages/Projects.test.tsx` (add case)
- Modify: `web/src/App.tsx` (append route `/runs/:runId/validation`)
- Modify: `web/src/run/selectors.test.ts` (add cases), `web/src/pages/Run.test.tsx` (add case)

**Interfaces:**
- Produces (`api.ts`):

```ts
export interface SmokeRow { acId: string; testId: string | null; status: 'passed' | 'failed' | 'missing' }
export interface EvidenceRow { criterion: string; tasks: string[]; tests: string[]; status: 'passed' | 'failed' | 'missing' | 'blocked' }
export interface Report { runId: string; specId: string; specHash: string; result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed'; service: { url: string; healthcheck: string; smoke: SmokeRow[] } | null; deploy: { attempts: number; lastFailure: { attempt: number; stage: string; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null } | null }; evidence: EvidenceRow[]; delivered: string[]; blocked: Array<{ taskId: string; reason: string }>; assumptions: string[]; exploratoryScript: Array<{ acId: string; steps: string[] }>; tokens: { byRole: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>; total: { inputTokens: number; outputTokens: number; costUsd: number } }; summary: string }
```

`RunDetail` gains `phase: number; report: Report | null;` and `TaskRow.def` gains `origin?: string`. `runApi.complete(projectId, specId)` → `POST …/complete`; `runApi.reportProblem(projectId, specId, report)` → `POST …/continue { report }` returning `{ sessionId: string }`; `runApi.projectsOnce()` is just `projects()`.
- Produces (`selectors.ts`): `phases()` marks phase 4 done on `VERIFICATION_PASSED`, failed on `VERIFICATION_FAILED` with `round: 2` (round 1 leaves it running until the next `PHASE_STARTED`), phase 5 done on `DEPLOY_VERIFIED`, failed on `DEPLOY_FAILED {attempt: 3}`, phase 6 done on `REPORT_READY`. `deployOutcome(events)` → `{ attempts: number; verified: { url: string } | null; lastFailure: { stage: string; detail: string } | null }`.
- Produces: `ValidationView({ detail, specStatus, onReport, onComplete })` (pure) and `ValidationPage` (route `/runs/:runId/validation`, loads `GET /runs/:runId` and `GET /projects` for the spec status, polls `/projects` every 5 s after "Complete spec" until the spec is `done`).

- [ ] **Step 1: Write the failing tests**

Append to `web/src/run/selectors.test.ts`:

```ts
it('phases 4-6 end on their own events', () => {
  const evs = (list: Array<[string, Record<string, unknown>]>) => list.map(([type, data], i) => ({ seq: i + 1, at: '2026-09-24T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact' as const, data }));
  const out = phases(evs([['PHASE_STARTED', { phase: 4, round: 1 }], ['VERIFICATION_FAILED', { round: 1 }], ['PHASE_STARTED', { phase: 4, round: 2 }], ['VERIFICATION_PASSED', { round: 2 }], ['PHASE_STARTED', { phase: 5 }], ['DEPLOY_FAILED', { attempt: 1, stage: 'apply' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }], ['PHASE_STARTED', { phase: 6 }], ['REPORT_READY', {}]]));
  expect(out.map((p) => [p.phase, p.result])).toEqual([[4, 'running'], [4, 'done'], [5, 'done'], [6, 'done']]);
  expect(deployOutcome(evs([['DEPLOY_FAILED', { attempt: 1, stage: 'apply', detail: 'busy' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }]]))).toEqual({ attempts: 2, verified: { url: 'http://x' }, lastFailure: null });
});
```

`web/src/pages/Validation.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Report, RunDetail } from '../api.js';
import { ValidationView } from './Validation.js';

const report: Report = {
  runId: 'hello-001-r1', specId: 'hello-001', specHash: 'h', result: 'awaiting-validation',
  service: { url: 'http://127.0.0.1:3000', healthcheck: 'HTTP 200 after 1 attempts', smoke: [{ acId: 'AC-001', testId: 's::[AC-001] home', status: 'passed' }] },
  deploy: { attempts: 1, lastFailure: null },
  evidence: [{ criterion: 'AC-001', tasks: ['T1'], tests: ['u::[AC-001] a'], status: 'passed' }, { criterion: 'AC-002', tasks: ['T2'], tests: [], status: 'blocked' }],
  delivered: ['T1'], blocked: [{ taskId: 'T2', reason: 'attempts exhausted' }], assumptions: ['T1: assumed X'],
  exploratoryScript: [{ acId: 'AC-001', steps: ['open /', 'see the list'] }],
  tokens: { byRole: {}, total: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } }, summary: 'All good.',
};
const detail = (over: Partial<RunDetail> = {}): RunDetail => ({ runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'awaiting-validation', phase: 6, report, state: { status: 'running', order: [], tasks: [] }, finished: null, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }, acceptanceCriteria: [], ...over });

describe('ValidationView', () => {
  it('shows service, script checkboxes, assumptions, blocked tasks and evidence; actions enabled when awaiting validation', () => {
    const on = { report: vi.fn(), complete: vi.fn() };
    render(<MemoryRouter><ValidationView detail={detail()} specStatus="awaiting-validation" onReport={on.report} onComplete={on.complete} /></MemoryRouter>);
    expect(screen.getByTestId('service-url').getAttribute('href')).toBe('http://127.0.0.1:3000');
    expect(screen.getByTestId('smoke-AC-001').textContent).toContain('passed');
    const step = screen.getByTestId('step-AC-001-0') as HTMLInputElement;
    fireEvent.click(step);
    expect(step.checked).toBe(true);
    expect(screen.getByTestId('assumptions').textContent).toContain('T1: assumed X');
    expect(screen.getByTestId('blocked-T2').textContent).toContain('attempts exhausted');
    expect(screen.getByTestId('evidence-AC-002').className).toContain('blocked');
    fireEvent.change(screen.getByTestId('problem-text'), { target: { value: 'GET / returns 500' } });
    fireEvent.click(screen.getByTestId('report-problem'));
    expect(on.report).toHaveBeenCalledWith('GET / returns 500');
    fireEvent.click(screen.getByTestId('complete-spec'));
    expect(on.complete).toHaveBeenCalled();
  });

  it('deploy-failed shows the failure and disables both actions with a reason', () => {
    const failed: Report = { ...report, result: 'deploy-failed', service: null, deploy: { attempts: 3, lastFailure: { attempt: 3, stage: 'smoke', detail: 'AC-001: no smoke test', rolledBack: true, rollbackHealthy: true } } };
    render(<MemoryRouter><ValidationView detail={detail({ status: 'deploy-failed', report: failed })} specStatus="running" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByTestId('deploy-failure').textContent).toContain('smoke');
    expect(screen.getByTestId('deploy-failure').textContent).toContain('rolled back');
    expect((screen.getByTestId('complete-spec') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('report-problem') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('actions-note').textContent).toContain('deploy-failed');
  });

  it('without a report yet it says so', () => {
    render(<MemoryRouter><ValidationView detail={detail({ report: null, status: 'running', phase: 3 })} specStatus="running" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(/no report yet/i)).toBeTruthy();
  });
});
```

Append to `web/src/pages/Projects.test.tsx` (extend the `projects` fixture with `{ specId: 'hello-003', status: 'awaiting-validation', activeRunId: null }` and `runs['hello-app']` with `{ runId: 'hello-003-r1', specId: 'hello-003', projectId: 'hello-app', status: 'awaiting-validation', at: '2026-09-24T11:00:00.000Z', tokens: 1, cost: 0, stoppable: false }`):

```ts
it('an awaiting-validation spec links to the validation page of its last run', () => {
  render(<MemoryRouter><ProjectsView projects={projects} runs={runs} error={null} onStart={vi.fn()} onResume={vi.fn()} onStop={vi.fn()} onAdd={vi.fn()} /></MemoryRouter>);
  expect(screen.getByTestId('validate-hello-003').getAttribute('href')).toBe('/runs/hello-003-r1/validation');
});
```

Append to `web/src/pages/Run.test.tsx`:

```ts
it('tags fix tasks with their origin and links to validation once a report exists', () => {
  const fix = [...events, { seq: 9999, at: '2026-09-24T12:00:00.000Z', runId: 'hello-001-r1', specHash: 'h', type: 'FIX_TASKS_PLANNED', kind: 'fact' as const, data: { tasks: [{ id: 'T900-fix-1', title: 'fix', description: 'd', criteriaRefs: [], dependsOn: [], affectedPaths: ['src'], owner: 'dev', origin: 'fix' }] } }];
  render(view({ events: fix, detail: { ...detail, phase: 6, report: { summary: 's' } as never } }));
  expect(screen.getByTestId('task-T900-fix-1').parentElement!.textContent).toContain('fix');
  expect(screen.getByTestId('validation-link').getAttribute('href')).toBe('/runs/hello-001-r1/validation');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run`
Expected: FAIL — `Validation.js` missing, `deployOutcome` not exported, `validate-hello-003` and `validation-link` not found, `phase`/`report` type errors.

- [ ] **Step 3: `api.ts` and selectors**

Append to `web/src/api.ts` the `SmokeRow`, `EvidenceRow`, `Report` interfaces from the Interfaces block; add `phase: number; report: Report | null;` to `RunDetail` and `origin?: string` to `TaskRow.def`; append to `runApi`:

```ts
  complete: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/complete`).then((r) => json<{ runId: string }>(r)),
  reportProblem: (projectId: string, specId: string, report: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/continue`, { report }).then((r) => json<{ sessionId: string }>(r)),
```

`web/src/run/selectors.ts` — inside the `for` loop of `phases()`, after the `PHASE_FAILED` line, append:

```ts
    if (e.type === 'VERIFICATION_PASSED' && cur.phase === 4) Object.assign(cur, { endedAt: e.at, result: 'done' });
    if (e.type === 'VERIFICATION_FAILED' && cur.phase === 4 && Number(e.data.round) === 2) Object.assign(cur, { endedAt: e.at, result: 'failed', reason: 'verification failed' });
    if (e.type === 'DEPLOY_VERIFIED' && cur.phase === 5) Object.assign(cur, { endedAt: e.at, result: 'done' });
    if (e.type === 'DEPLOY_FAILED' && cur.phase === 5 && Number(e.data.attempt) >= 3) Object.assign(cur, { endedAt: e.at, result: 'failed', reason: String(e.data.detail ?? '') });
    if (e.type === 'REPORT_READY' && cur.phase === 6) Object.assign(cur, { endedAt: e.at, result: 'done' });
```

and change the `RUN_FINISHED` line so `result === 'complete' || result === 'awaiting-validation' || result === 'done'` counts as `done`. Append:

```ts
export function deployOutcome(events: StoredEvent[]) {
  let attempts = 0;
  let verified: { url: string } | null = null;
  let lastFailure: { stage: string; detail: string } | null = null;
  for (const e of events) {
    if (e.type === 'DEPLOY_FAILED') {
      attempts = Math.max(attempts, Number(e.data.attempt));
      lastFailure = { stage: String(e.data.stage), detail: String(e.data.detail ?? '') };
    }
    if (e.type === 'DEPLOY_VERIFIED') {
      attempts = Math.max(attempts, Number(e.data.attempt));
      verified = { url: String(e.data.url) };
      lastFailure = null;
    }
  }
  return { attempts, verified, lastFailure };
}
```

- [ ] **Step 4: `Validation.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { runApi, type Report, type RunDetail } from '../api.js';

const key = (runId: string) => `teams-ai:validation:${runId}`;
function readChecks(runId: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key(runId)) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}
function writeChecks(runId: string, checks: Record<string, boolean>): void {
  try {
    localStorage.setItem(key(runId), JSON.stringify(checks));
  } catch {
    /* per-viewer convenience only */
  }
}

export function ValidationView({ detail, specStatus, onReport, onComplete }: { detail: RunDetail; specStatus: string; onReport: (text: string) => void; onComplete: () => void }) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => readChecks(detail.runId));
  const [text, setText] = useState('');
  const report: Report | null = detail.report;
  const toggle = (id: string) => {
    const next = { ...checks, [id]: !checks[id] };
    setChecks(next);
    writeChecks(detail.runId, next);
  };
  const enabled = specStatus === 'awaiting-validation' && report?.result === 'awaiting-validation';
  const note = enabled ? null : specStatus === 'done' ? 'This spec is already done.' : report ? `Actions are unavailable: the run ended ${report.result} and the spec is ${specStatus}.` : 'Actions are unavailable until the run produces a report.';
  return (
    <main>
      <p>
        <Link to={`/runs/${detail.runId}`}>← Execution</Link> · <Link to="/projects">Projects</Link>
      </p>
      <h1>
        Validation <small className="hint">{detail.runId}</small>
      </h1>
      {!report ? (
        <p>No report yet — the run is in phase {detail.phase} ({detail.status}).</p>
      ) : (
        <>
          <section className="card">
            <h2>Service</h2>
            {report.service ? (
              <>
                <p>
                  <a data-testid="service-url" href={report.service.url} target="_blank" rel="noreferrer">
                    {report.service.url}
                  </a>{' '}
                  <span className="hint">healthcheck: {report.service.healthcheck}</span>
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>AC</th>
                      <th>Smoke test</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.service.smoke.map((s) => (
                      <tr key={s.acId} data-testid={`smoke-${s.acId}`} className={`test test-${s.status}`}>
                        <td>{s.acId}</td>
                        <td>{s.testId ?? '—'}</td>
                        <td>{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p data-testid="deploy-failure" className="error">
                Not deployed{report.deploy.lastFailure ? `: attempt ${report.deploy.lastFailure.attempt} failed at ${report.deploy.lastFailure.stage} — ${report.deploy.lastFailure.detail}${report.deploy.lastFailure.rolledBack ? ' (rolled back' + (report.deploy.lastFailure.rollbackHealthy === false ? ', previous version unhealthy)' : ')') : ''}` : ''} · {report.deploy.attempts} attempts
              </p>
            )}
          </section>
          <section className="card">
            <h2>Exploratory script</h2>
            {report.exploratoryScript.length === 0 ? <p className="hint">none</p> : null}
            {report.exploratoryScript.map((block) => (
              <div key={block.acId}>
                <h3>{block.acId}</h3>
                <ul>
                  {block.steps.map((s, i) => {
                    const id = `${block.acId}-${i}`;
                    return (
                      <li key={id}>
                        <label>
                          <input type="checkbox" data-testid={`step-${id}`} checked={Boolean(checks[id])} onChange={() => toggle(id)} /> {s}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
          <section className="card">
            <h2>Assumptions</h2>
            <ul data-testid="assumptions">{report.assumptions.length ? report.assumptions.map((a, i) => <li key={i}>{a}</li>) : <li className="hint">none</li>}</ul>
          </section>
          <section className="card">
            <h2>Blocked tasks</h2>
            <ul>{report.blocked.length ? report.blocked.map((b) => <li key={b.taskId} data-testid={`blocked-${b.taskId}`}><strong>{b.taskId}</strong>: {b.reason}</li>) : <li className="hint">none</li>}</ul>
          </section>
          <section className="card">
            <h2>Evidence</h2>
            <table>
              <thead>
                <tr>
                  <th>AC</th>
                  <th>Tasks</th>
                  <th>Tests</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {report.evidence.map((r) => (
                  <tr key={r.criterion} data-testid={`evidence-${r.criterion}`} className={`test test-${r.status}`}>
                    <td>{r.criterion}</td>
                    <td>{r.tasks.join(', ')}</td>
                    <td>{r.tests.join(', ') || '—'}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card">
            <h2>Summary</h2>
            <p>{report.summary}</p>
            <p className="hint">
              ${report.tokens.total.costUsd.toFixed(2)} · {report.tokens.total.inputTokens} in / {report.tokens.total.outputTokens} out
            </p>
          </section>
        </>
      )}
      <section className="card">
        <h2>Actions</h2>
        {note ? <p data-testid="actions-note" className="hint">{note}</p> : null}
        <textarea data-testid="problem-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="What went wrong? This reopens refinement with your report." disabled={!enabled} />
        <p className="controls">
          <button data-testid="report-problem" disabled={!enabled || text.trim() === ''} onClick={() => onReport(text.trim())}>
            Report problem
          </button>
          <button data-testid="complete-spec" disabled={!enabled} onClick={onComplete}>
            Complete spec
          </button>
        </p>
      </section>
    </main>
  );
}

export function ValidationPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [specStatus, setSpecStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const load = async () => {
    if (!runId) return;
    const d = await runApi.run(runId);
    setDetail(d);
    const projects = await runApi.projects();
    setSpecStatus(projects.find((p) => p.projectId === d.projectId)?.specs.find((s) => s.specId === d.specId)?.status ?? '');
  };
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [runId]);
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => load().catch(() => undefined), 5000);
    return () => clearInterval(id);
  }, [polling]);
  useEffect(() => {
    if (specStatus === 'done') setPolling(false);
  }, [specStatus]);
  if (error) return <main><p className="error">{error}</p></main>;
  if (!detail) return <main><p>Loading…</p></main>;
  return (
    <ValidationView
      detail={detail}
      specStatus={specStatus}
      onReport={(text) => {
        runApi
          .reportProblem(detail.projectId, detail.specId, text)
          .then(() => navigate(`/refine/${detail.projectId}/${detail.specId}`))
          .catch((e: Error) => setError(e.message));
      }}
      onComplete={() => {
        runApi
          .complete(detail.projectId, detail.specId)
          .then(() => setPolling(true))
          .catch((e: Error) => setError(e.message));
      }}
    />
  );
}
```

(`/refine/:projectId/:specId` is plan 11's route; until it lands the navigation shows the router's no-match — acceptable, noted in Findings.)

- [ ] **Step 5: Execution, Projects, App**

`web/src/pages/Run.tsx` — in the task `<li>`, after `{tk.replanned ? ' · replanned' : ''}` append `{tk.def.origin && tk.def.origin !== 'plan' ? <span className={`tag tag-${tk.def.origin}`}> {tk.def.origin}</span> : null}` (with `tk` typed through the reducer's `PlanTask`, which now carries `origin`). In the header `<p data-testid="status">…</p>`, append after it:

```tsx
      {detail.report ? (
        <p>
          <Link data-testid="validation-link" to={`/runs/${detail.runId}/validation`}>
            Validation →
          </Link>
        </p>
      ) : null}
```

`web/src/pages/Projects.tsx` — in the spec row's action cell, extend the ternary: `s.activeRunId ? <Open run> : s.status === 'awaiting-validation' ? (<Link data-testid={`validate-${s.specId}`} to={`/runs/${lastRunOf(pr.projectId, s.specId)}/validation`}>Validate</Link>) : s.status === 'done' ? null : <Start run>` with, above the component: `const lastRunOf = (projectId: string, specId: string) => (p.runs[projectId] ?? []).find((r) => r.specId === specId && !r.runId.includes('-complete-'))?.runId ?? ''` (defined inside `ProjectsView` so it sees `p`).

`web/src/App.tsx` — import `ValidationPage` and append `<Route path="/runs/:runId/validation" element={<ValidationPage />} />` as the last route.

- [ ] **Step 6: Run to verify pass**

Run: `cd web && npx vitest run && npx tsc --noEmit -p . && npm run build`
Expected: PASS (3 Validation + 1 selectors + 1 Projects + 1 Run new); tsc and build clean.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/run/selectors.ts web/src/run/selectors.test.ts web/src/pages/Validation.tsx web/src/pages/Validation.test.tsx web/src/pages/Run.tsx web/src/pages/Run.test.tsx web/src/pages/Projects.tsx web/src/pages/Projects.test.tsx web/src/App.tsx
git commit -m "feat(web): validation screen with report, exploratory script and lifecycle actions; phase 4-6 timeline"
```

---

### Task 10: Docs, live check and findings

**Files:**
- Modify: `docs/superpowers/plans/README.md` (append the plan 12 row; move the "Decision 7" bullet under Outstanding work to "call site exists, decision not wired")
- Modify: this plan's `**Status**` line and a new `## Findings` section at the end
- Modify: `test/fixtures/hello-app/docs/specs/hello-001/spec.json` only if it lacks a `smoke: true` criterion needed by the live check (do not change ids)

- [ ] **Step 1: Full suite**

Run: `npx tsc --noEmit -p . && npm run -s lint && npm run -s format:check && npx vitest run && (cd web && npx vitest run && npm run build)`
Expected: everything green. Fix formatting with `npm run format` if `format:check` complains, and commit that separately as `style: format`.

- [ ] **Step 2: Live check (WSL, real Docker, hello-app)**

Preconditions: `teams-ai-hello-app` registered in the UI, its plan on `main` has `commands.smoke` (if the existing plan predates this change, the live run exercises the "smoke missing → deploy-failed → Validation shows the failure" path instead; record which). Then:

1. `npm run web:build && npm run ui -- --port 8787` (detached with `setsid` as plan 8 found).
2. Projects → "Start run" on a spec whose tasks are already merged (`resume` of the recorded `hello-001-r1` after deleting its `RUN_FINISHED` line in a copy is the cheap path: copy `~/.teams-ai/runs/hello-001-r1` to `hello-001-r9`, drop the last line, `Resume` it from the UI; the loop finds every task merged and enters Phase 4 without paying for Dev steps — only `fix-tasks`/`report` steps cost tokens, about $0.20).
3. Watch the Execution page: phases 4, 5, 6 appear; `docker ps` shows `teams-ai-hello-app`; `curl http://127.0.0.1:<port>/health`.
4. Open Validation: URL, smoke rows, script, evidence; tick a step, reload, it stays ticked.
5. "Complete spec": `hello-001-complete-r1` appears in the runs list; after it finishes, Projects shows `hello-001` as `done` and `main` carries `status: "done"`.
6. "Report problem" on a fresh `awaiting-validation` spec is only checkable once plan 11's `continue` route is on `main`; otherwise record "not checked — plan 11 pending".
7. `kind`: run the same on a project whose `deploy.target` is `kind` if the cluster exists; else record "docker-local only".

Record every observation, cost and fix in `## Findings (live run, <date>, <host>)`, like plan 8 and plan 10 did. If the live check cannot run from the executing host, write `## Findings` with "not run — needs a live WSL host with Docker" and list the exact commands above as the checklist.

- [ ] **Step 3: README and status**

Append to the plans table in `docs/superpowers/plans/README.md`:

```md
| 12 | [`2026-09-24-teams-ai-12-phases-4-6-validation-ui.md`](2026-09-24-teams-ai-12-phases-4-6-validation-ui.md) | <status from Findings> — phases 4 (verification + one fix round), 5 (deploy, rollback, smoke gate, deploy-fix tasks), 6 (report merged with awaiting-validation), `spec complete`, Validation screen. |
```

Under "Outstanding work", change the decision 7 bullet to: "**Decision 7 (validation report routing) — call site now exists** (Validation → `continue { report }`); the System 1 question that routes the text to PO or SM first is still unwired." Set this plan's status line to `**Status: implemented — see Findings**` (or `partially implemented — …` when the live check found open items).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/README.md docs/superpowers/plans/2026-09-24-teams-ai-12-phases-4-6-validation-ui.md
git commit -m "docs: plan 12 findings from the live run; plans index"
```

---

## Self-review

**Spec coverage.** §3 Phase 4 → Task 4 (+ Task 6 wiring of the fix round); §4 Phase 5 → Tasks 2, 3, 5, 6; §5 Phase 6 → Task 6; §6 lifecycle → Tasks 7, 8 (complete), 9 (report problem via plan 11's `continue`); §7 contracts → Task 1 (`Commands.smoke`, `origin`, events, results, `fix-tasks`), Task 6 (agent prompts); §8 API/UI → Tasks 8, 9; §9 security → smoke env path (Task 2), no UI git (Tasks 7–9); §10 error table → smoke missing (Task 2), manifests absent (existing `validate` stage, Task 5), NodePort (Task 3), rollback unhealthy (Task 5 + Validation copy), report step failure (Task 6), docs PR cannot merge (Task 6 `ok: false` → `phase-failed`, `REPORT_READY` still journaled), `spec complete` crash (block A's `interrupted` + Task 8 status union); §11 tests → one per bullet; §12 open items → Task 10 live check.

**Placeholder scan.** No TBD/TODO. Task 7 Step 4 names a conditional edit in `loadRunDeps` ("append the condition") because that function's current shape is plan 11's to change; the executor reads it and appends the `awaiting-validation` pass-through if a status check exists.

**Type consistency.** `Phase4Result.fixTasks: PlanTask[]`, `Phase5Result.fixTask: PlanTask`, `runFix(tasks: PlanTask[])` in Task 6 wraps the single task in an array. `SmokeRow` is defined once (Task 2) and re-exported through `Report` (Task 6) and mirrored in `web/src/api.ts` (Task 9). `RunResult`/`ExecuteResult` extended in Task 1 and consumed by `finish()` and `exitCode` unchanged in shape. `deployIntent` uses `deps.plan!` (guarded by the `required` check at the top of `runPhase5`). `commitAndMergeDocs(deps, 6, …)` requires the widened phase type from Task 6 Step 3, which Task 7 reuses with a distinct `specId` key.

**Review Focus.** Each of the five lines names its owning task and test; all five are present above.

## Findings

Not run — needs a live WSL host with Docker. Tasks 1–8 (server) were already on `main` from the orchestrator pipeline work (#8, #9); Task 9 (Validation screen, phase 4–6 timeline, `Projects`/`Run` links) was added on branch `feat/validation-ui` with 32/32 web tests, `tsc` and `vite build` green. Live-check checklist:

1. `npm run web:build && npm run ui -- --port 8787` (detached with `setsid`).
2. Copy `~/.teams-ai/runs/hello-001-r1` to `hello-001-r9`, drop the last line (`RUN_FINISHED`), and Resume it from Projects; the loop enters Phase 4 without Dev steps (about $0.20 for `fix-tasks`/`report`).
3. Execution page shows phases 4, 5, 6; `docker ps` shows `teams-ai-hello-app`; `curl http://127.0.0.1:<port>/health`.
4. Validation page: URL, smoke rows, script, evidence; tick a step, reload, it stays ticked.
5. "Complete spec": `hello-001-complete-r1` appears; Projects then shows `hello-001` as `done` and `main` carries `status: "done"`.
6. "Report problem" on an `awaiting-validation` spec navigates to `/refine/:projectId/:specId` (route exists on `main`) and opens the session with the report.
7. `kind` target if the cluster exists; else record "docker-local only".

Known gaps: Validation screen copy is in English while the rest of the UI is pt-BR; `lint` and `format:check` scripts do not exist in `package.json`, so only `tsc`, `vitest` and `vite build` gate the change.
