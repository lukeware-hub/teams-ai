# Plan 67 - Deploy fixes remember (R11.5.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a deploy fix task knows every earlier deploy failure of its run and what the fixes before it changed, and it is told when the previous fix did not change the outcome, so the run stops spending its last attempts on a cause it already tried.

**Architecture:** `fixTask` in `server/orchestrator/phases/deploy.ts` builds the deploy fix task of both deploy paths (one repository, several services). It gains a history section read from the run's own journal: each earlier `DEPLOY_FAILED`, the fix task the following `FIX_TASKS_PLANNED` created for it, and that fix's state and last `DEV_COMMITTED` summary and files. No new event, no new state: the journal already holds every fact.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest.

**Spec:** plan 66 (`docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md`), section "Design", paragraph **R11.5.2 Deploy fixes remember**, and its "Where autonomy breaks today" bullet on deploy fixes; roadmap item R11.5 in `docs/superpowers/ROADMAP.md`.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- A first deploy attempt (no earlier failure) gets exactly today's fix task description.
- Agent prompts and task descriptions stay in English; everything a human reads stays in Brazilian Portuguese.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A resumed run whose journal holds two `DEPLOY_FAILED` facts for the same attempt (an attempt replayed after a crash): the history lists that attempt once, with its latest failure.
2. A failure detail of thousands of lines (a whole gate log): the history keeps only its first line, so each later fix task's prompt stays small.
3. An earlier fix that ended blocked, or never committed anything: the history says its state without a summary.
4. A run of services: an earlier failure of another service is listed with its service, and the repeated-failure note compares the same service only.
5. A fix task replanned into replacements (`T950-deploy-fix-1-r1`): its summary is the replacements' last commit, and a later fix id such as `T950-deploy-fix-10` never borrows it.

---

### Task 1: The deploy fix task carries the run's earlier deploy attempts

**Files:**
- Modify: `server/orchestrator/phases/deploy.ts` (`fixTask` around lines 53-73, its call in `runPhase5` around line 96 and in `runServicesPhase5` around line 158)
- Test: `test/orchestrator/phase5.test.ts`, `test/orchestrator/phase5-services.test.ts`

**Interfaces:**
- Consumes: the journal facts `DEPLOY_FAILED` (`{ attempt, stage, detail, service? }`), `FIX_TASKS_PLANNED` (`{ tasks: PlanTask[] }`), `DEV_COMMITTED` (`{ taskId, sha, changedFiles, summary }`) and `journal.state.tasks`.
- Produces: `fixTask(deps, attempt, stage, detail, newPort = null, service: string | null = null): PlanTask`, whose `description` ends with the history section when the run has an earlier failure.

- [ ] **Step 1: Write the failing tests**

In `test/orchestrator/phase5.test.ts`, add `makePlanTask` to the import from `../fixtures/contracts.js` and add `import { RunEvent } from '../../server/pipeline/run-state.js';`, then add inside the `describe('Phase 5', ...)` block:

```ts
  /** The run's earlier attempt: its failure, the fix task planned for it, and that fix's commit and final state. */
  async function earlierAttempt(attempt: number, stage: string, detail: string, fix: { id: string; state: 'merged' | 'blocked'; summary?: string; files?: string[] }, service?: string): Promise<void> {
    await journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail, rolledBack: false, rollbackHealthy: null, tag: 't', ...(service ? { service } : {}) });
    await journal.fact(RunEvent.FixTasksPlanned, { tasks: [makePlanTask({ id: fix.id, origin: 'deploy-fix', ...(service ? { service } : {}) })] });
    const states = fix.state === 'merged' ? ['ready', 'implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'merged'] : ['ready', 'implementing', 'blocked'];
    for (const to of states) await journal.fact(RunEvent.TaskStateChanged, { taskId: fix.id, to });
    if (fix.summary) await journal.fact(OrchEvent.DevCommitted, { taskId: fix.id, sha: 'abc', changedFiles: fix.files ?? [], summary: fix.summary });
  }

  it('a deploy fix lists every earlier failure of the run and what the fix after it changed', async () => {
    await earlierAttempt(1, 'smoke', 'AC-001: no smoke test\n' + 'gate log line\n'.repeat(2000), { id: 'T950-deploy-fix-1', state: 'merged', summary: 'added the smoke suite', files: ['smoke/smoke.test.mjs'] });
    const r = await runPhase5(deps('AC-002: smoke test failed'), 2);
    const task = r.ok ? null : r.fixTask;
    expect(task?.id).toBe('T950-deploy-fix-2');
    expect(task?.description).toContain('Earlier deploy attempts of this run:\n- attempt 1 failed at smoke: AC-001: no smoke test\n  then T950-deploy-fix-1 merged: added the smoke suite (files: smoke/smoke.test.mjs)');
    expect(task?.description).not.toContain('gate log line');
    expect(task?.description).not.toContain('did not change this failure');
  });

  it('says the previous fix did not change a failure that came back the same', async () => {
    await earlierAttempt(1, 'smoke', 'AC-001: no smoke test', { id: 'T950-deploy-fix-1', state: 'merged', summary: 'renamed the test', files: ['smoke/smoke.test.mjs'] });
    const r = await runPhase5(deps('AC-001: no smoke test'), 2);
    expect(r.ok ? null : r.fixTask?.description).toContain('The fix of attempt 1 (T950-deploy-fix-1) did not change this failure: look for another cause before changing the same lines again.');
  });

  it('lists an attempt replayed after a crash once, an earlier fix that ended blocked by its state, and nothing on a first attempt', async () => {
    await journal.fact(OrchEvent.DeployFailed, { attempt: 1, stage: 'verify', detail: 'unhealthy before the crash', rolledBack: false, rollbackHealthy: null, tag: 't' });
    await earlierAttempt(1, 'smoke', 'AC-001: no smoke test', { id: 'T950-deploy-fix-1', state: 'blocked' });
    const r = await runPhase5(deps('AC-002: smoke test failed'), 2);
    const description = r.ok ? '' : r.fixTask?.description ?? '';
    expect(description.match(/- attempt 1 failed/g)).toHaveLength(1);
    expect(description).toContain('- attempt 1 failed at smoke: AC-001: no smoke test\n  then T950-deploy-fix-1 blocked');
    expect(description).not.toContain('unhealthy before the crash');
  });

  it('a first deploy attempt gets today\'s fix task description, with no history', async () => {
    const r = await runPhase5(deps('AC-001: smoke test failed'), 1);
    expect(r.ok ? null : r.fixTask?.description).not.toContain('Earlier deploy attempts');
  });

  it('takes the summary of a replanned fix from its replacements, never from a fix whose id only starts the same', async () => {
    await earlierAttempt(1, 'smoke', 'AC-001: no smoke test', { id: 'T950-deploy-fix-1', state: 'blocked' });
    await journal.fact(OrchEvent.DevCommitted, { taskId: 'T950-deploy-fix-1-r1', sha: 'def', changedFiles: ['smoke/a.mjs'], summary: 'split the suite' });
    await journal.fact(OrchEvent.DevCommitted, { taskId: 'T950-deploy-fix-10', sha: 'fed', changedFiles: ['x'], summary: 'another fix' });
    const r = await runPhase5(deps('AC-002: smoke test failed'), 2);
    const description = r.ok ? '' : r.fixTask?.description ?? '';
    expect(description).toContain('then T950-deploy-fix-1 blocked: split the suite (files: smoke/a.mjs)');
    expect(description).not.toContain('another fix');
  });
```

In `test/orchestrator/phase5-services.test.ts`, add `makePlanTask` to the import from `../fixtures/contracts.js` and add `import { RunEvent } from '../../server/pipeline/run-state.js';`, then add inside `describe('Phase 5 with several services', ...)`:

```ts
  it('a services deploy fix lists earlier failures with their service and compares a repeat within the same service', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { e2eFails: 'e2e:inventory', detail: 'AC-002: failed' });
    await journal.fact(OrchEvent.DeployFailed, { attempt: 1, stage: 'e2e', detail: 'AC-002: failed', rolledBack: false, rollbackHealthy: null, service: 'inventory' });
    await journal.fact(RunEvent.FixTasksPlanned, { tasks: [makePlanTask({ id: 'T950-deploy-fix-1', origin: 'deploy-fix', service: 'inventory' })] });
    for (const to of ['ready', 'implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'merged']) await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T950-deploy-fix-1', to });
    const res = await runServicesPhase5(deps, 2);
    const description = res.ok ? '' : res.fixTask?.description ?? '';
    expect(description).toContain('- attempt 1 failed at e2e (service inventory): AC-002: failed');
    expect(description).toContain('The fix of attempt 1 (T950-deploy-fix-1) did not change this failure');
  });

  it('never calls a failure repeated when the earlier one was in another service', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { e2eFails: 'e2e:inventory', detail: 'AC-002: failed' });
    await journal.fact(OrchEvent.DeployFailed, { attempt: 1, stage: 'e2e', detail: 'AC-002: failed', rolledBack: false, rollbackHealthy: null, service: 'orders' });
    await journal.fact(RunEvent.FixTasksPlanned, { tasks: [makePlanTask({ id: 'T950-deploy-fix-1', origin: 'deploy-fix', service: 'orders' })] });
    for (const to of ['ready', 'implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'merged']) await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T950-deploy-fix-1', to });
    const res = await runServicesPhase5(deps, 2);
    const description = res.ok ? '' : res.fixTask?.description ?? '';
    expect(description).toContain('- attempt 1 failed at e2e (service orders): AC-002: failed');
    expect(description).not.toContain('did not change this failure');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/phase5.test.ts test/orchestrator/phase5-services.test.ts`
Expected: the six history cases FAIL (no "Earlier deploy attempts" in the description); the first-attempt case passes already, since it pins today's description; every existing case passes.

- [ ] **Step 3: Implement**

In `server/orchestrator/phases/deploy.ts`, add above `fixTask`:

```ts
/** First line of a deploy failure detail: the failing criteria or stage, without the gate output that follows it. */
const headline = (detail: string): string => detail.split('\n')[0]!.trim().slice(0, 300);

/**
 * Every earlier deploy failure of the run with the fix task planned after it and what that fix changed, so a fix task
 * builds on the ones before it; when the previous fix merged and the same failure came back, it says to look elsewhere.
 */
function deployHistory(deps: PhaseDeps, attempt: number, stage: DeployStage, detail: string, service: string | null): string {
  const failures = new Map<number, { stage: string; detail: string; service: string | null; fix: string | null }>();
  let last: number | null = null;
  for (const e of deps.journal.events) {
    if (e.type === OrchEvent.DeployFailed && Number(e.data.attempt) < attempt) {
      last = Number(e.data.attempt);
      failures.set(last, { stage: String(e.data.stage), detail: String(e.data.detail), service: (e.data.service as string | undefined) ?? null, fix: null });
    } else if (e.type === RunEvent.FixTasksPlanned && last !== null) {
      const fix = (e.data.tasks as PlanTask[]).find((t) => t.origin === 'deploy-fix');
      if (fix) failures.get(last)!.fix = fix.id;
    }
  }
  if (failures.size === 0) return '';
  // A replanned fix commits through its replacements (`<id>-r1`); `T950-deploy-fix-10` is another fix.
  const fixLine = (id: string): string => {
    const state = deps.journal.state.tasks.get(id)?.state ?? 'planned';
    const commit = [...deps.journal.events].reverse().find((e) => e.type === OrchEvent.DevCommitted && (e.data.taskId === id || String(e.data.taskId).startsWith(`${id}-r`)));
    return commit ? `${id} ${state}: ${String(commit.data.summary)} (files: ${(commit.data.changedFiles as string[]).join(', ')})` : `${id} ${state}`;
  };
  const lines = [...failures.entries()].sort(([a], [b]) => a - b).map(([n, f]) => `- attempt ${n} failed at ${f.stage}${f.service ? ` (service ${f.service})` : ''}: ${headline(f.detail)}${f.fix ? `\n  then ${fixLine(f.fix)}` : ''}`);
  const previous = failures.get(attempt - 1);
  const repeated = previous?.fix && deps.journal.state.tasks.get(previous.fix)?.state === 'merged' && previous.stage === stage && previous.service === service && headline(previous.detail) === headline(detail);
  const note = repeated ? `\nThe fix of attempt ${attempt - 1} (${previous!.fix}) did not change this failure: look for another cause before changing the same lines again.` : '';
  return `\n\nEarlier deploy attempts of this run:\n${lines.join('\n')}${note}`;
}
```

Change `fixTask` so each of its three descriptions ends with the history; its signature gains `service`:

```ts
const fixTask = (deps: PhaseDeps, attempt: number, stage: DeployStage, detail: string, newPort: number | null = null, service: string | null = null): PlanTask => {
  const base = { id: fixTaskId(deps), title: `Fix deployment (${stage})`, criteriaRefs: [], dependsOn: [], origin: 'deploy-fix' as const };
  const history = deployHistory(deps, attempt, stage, detail, service);
```

then append `${history}` at the end of each `description` template: after `Contract: ${SMOKE_CONTRACT}` in the smoke branch, after `Contract: ${E2E_CONTRACT}` in the e2e branch, and after `${portHint}` in the devops branch.

In `runServicesPhase5`, pass the service to `fixTask`:

```ts
    const task = { ...fixTask({ ...deps, plan: repo.plan }, attempt, stage as DeployStage, detail, newPort, repo.service!), service: repo.service! };
```

`PlanTask` and `RunEvent` are already imported by `deploy.ts`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/orchestrator/phase5.test.ts test/orchestrator/phase5-services.test.ts test/orchestrator/phase5-e2e.test.ts test/orchestrator/deploy-port.test.ts && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases/deploy.ts test/orchestrator/phase5.test.ts test/orchestrator/phase5-services.test.ts
git commit -m "fix(deploy): a deploy fix task knows the run's earlier deploy attempts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Record R11.5.2 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (section `### R11.5 Autonomy hardening`, after the R11.5.1 lines)
- Modify: `docs/superpowers/plans/README.md` (the table, after row 66)

- [ ] **Step 1: Update the roadmap**

Add after the `- Review of R11.5.1 ...` line:

```md
- Built R11.5.2 (plan 67): a deploy fix task lists every earlier deploy failure of the run, with its service and the first line of its detail, and the fix task planned after it with that fix's state, summary and files; when the previous fix merged and the same failure came back in the same stage and service, it says that fix did not change the outcome (`deployHistory` in `server/orchestrator/phases/deploy.ts`).
```

- [ ] **Step 2: Update the plans index**

Add after row 66 of `docs/superpowers/plans/README.md`:

```md
| 67 | [`2026-10-12-teams-ai-67-deploy-fixes-remember.md`](2026-10-12-teams-ai-67-deploy-fixes-remember.md) | Done — a deploy fix task knows the run's earlier deploy failures and fixes, and is told when the previous fix did not change the outcome; ROADMAP R11.5.2. |
```

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.5.2 deploy fixes remember

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
