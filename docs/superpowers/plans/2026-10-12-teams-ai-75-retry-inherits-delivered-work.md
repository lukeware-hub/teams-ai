# Plan 75 - A run inherits only the work an earlier run delivered (R11.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a run of a new version of a spec does the work the new version asks for, instead of adopting every task whose id an earlier run merged.

**Architecture:** `mergedByPriorRuns` (`server/orchestrator/workspace.ts`) takes the tasks of the current plan and returns the ids it may adopt: a task is adopted only when an earlier run of the spec delivered it itself, through a merged pull request (`PR_MERGED`) or as work already on main (`TASK_ALREADY_ON_MAIN`), with the very same definition (`TASK_PLANNED`, compared as canonical JSON). A task an earlier run only adopted counts for nothing, so a wrong adoption never travels to the next run. A re-planned task the new version leaves unchanged in substance still costs one Dev step, and the existing `alreadyOnMain` rule adopts it when the Dev changes nothing.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** the R11.4 retry rule in `server/orchestrator/run.ts` ("one an earlier run of this spec already merged is adopted as 'merged' straight away instead of redone") and this live finding: run 3 of `loja-eventos/cancelar-pedido`, the first run of the spec's second version, re-planned its six tasks with new definitions under the same ids, adopted all six as merged at the start of Phase 3 because run 1 had merged those ids, changed no code, and still reached `awaiting-validation`, since the criteria already passed on the old code.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green.
- A retry of the same version keeps adopting what an earlier run merged, so no agent redoes it (R11.4).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A retry of the same version after a run merged some tasks and failed: those tasks are adopted and no agent runs them; checked on the real journals of `cancelar-pedido` run 1 and run 2, where the new rule adopts the same six tasks the old one did.
2. A new version whose tasks reuse delivered ids with new definitions: none is adopted, so each runs again; checked on run 3's journal, where the new rule adopts none.
3. A retry of a run that adopted tasks it never delivered (run 3 today): its adoptions count for nothing, so run 4 adopts none.
4. A replaced task: adopted only when every replacement merged in the same run, as before.
5. An earlier run that stopped without `RUN_FINISHED`: the pull requests it merged count, since they are on main.

## Limits

- A new version whose SM rewrites a task it does not change still costs one Dev step for that task.
- A re-planned task with nothing to change that has a glob path or no criteria still fails on its empty diff, as before (`alreadyOnMain`).

---

### Task 1: Inherit by delivery and definition

**Files:**
- Modify: `server/orchestrator/workspace.ts` (`mergedByPriorRuns`)
- Modify: `server/orchestrator/run.ts:634` (pass the plan's tasks)
- Test: `test/orchestrator/workspace.test.ts` (`describe('mergedByPriorRuns')`)
- Test: `test/orchestrator/run-retry.test.ts` (seed the prior run the way a real run journals it)
- Docs: `docs/superpowers/ROADMAP.md` (R11.5), `docs/superpowers/plans/README.md` (row 75)

**Interfaces:**
- Produces: `mergedByPriorRuns(ws: Workspace, specId: string, runId: string, tasks: readonly PlanTask[]): Promise<Set<string>>`, the ids of `tasks` an earlier run delivered with the same definition.

- [ ] **Step 1: Write the failing tests**

Add `import type { PlanTask } from '../../server/contracts/plan.js';` and replace the body of `describe('mergedByPriorRuns', ...)` in `test/orchestrator/workspace.test.ts` with:

```ts
describe('mergedByPriorRuns', () => {
  const task = (id: string, description = `do ${id}`): PlanTask => ({ id, title: id, description, owner: 'dev', origin: 'plan', criteriaRefs: ['AC-001'], affectedPaths: [`src/${id}.ts`], dependsOn: [] });
  const setup = async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    // A run as the orchestrator journals it: its plan, then what it merged, adopted or found on main.
    const run = async (id: string, o: { projectId?: string; planned: PlanTask[]; merged?: string[]; onMain?: string[]; adopted?: string[]; replanned?: { taskId: string; replacements: { id: string }[] }[]; finished?: boolean }) => {
      const s = await EventStore.open({ file: eventsFile(ws, id), runId: id, specHash: 'h' });
      await s.append({ type: 'RUN_STARTED', data: { runId: id, specId: 'a-001', projectId: o.projectId ?? 'shop' } });
      for (const t of o.planned) await s.append({ type: 'TASK_PLANNED', data: { task: t } });
      for (const r of o.replanned ?? []) await s.append({ type: 'TASK_REPLANNED', data: r });
      for (const taskId of o.merged ?? []) await s.append({ type: 'PR_MERGED', data: { taskId, pr: 1 } });
      for (const taskId of o.onMain ?? []) await s.append({ type: 'TASK_ALREADY_ON_MAIN', data: { taskId, paths: [], summary: '' } });
      const merged = [...(o.merged ?? []), ...(o.onMain ?? []), ...(o.adopted ?? [])];
      if (o.finished !== false) await s.append({ type: 'RUN_FINISHED', data: { result: 'verification-failed', reason: 'x', merged, blocked: [], tokens: {} } });
      await s.close();
    };
    return { ws, run };
  };

  it('adopts what earlier runs of the same spec in this project delivered, ignoring later and other-project runs', async () => {
    const { ws, run } = await setup();
    await run('a-001-r1', { planned: [task('T0-scaffold'), task('T1')], merged: ['T0-scaffold', 'T1'] });
    await run('a-001-r2', { planned: [task('T2')], merged: ['T2'] });
    // A later run (r4) and a run of another project sharing the spec id must not count.
    await run('a-001-r4', { planned: [task('T3')], merged: ['T3'] });
    await run('a-001-r5', { projectId: 'other-shop', planned: [task('T9')], merged: ['T9'] });
    const tasks = [task('T0-scaffold'), task('T1'), task('T2'), task('T3'), task('T9')];
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r3', tasks)).toEqual(new Set(['T0-scaffold', 'T1', 'T2']));
  });

  // Live finding (loja-eventos/cancelar-pedido run 3, 2026-10-12): the spec's second version re-planned its six
  // tasks with new definitions under the same ids; all six were adopted because run 1 merged those ids, and no code changed.
  it('does not adopt a task whose definition changed since an earlier run delivered it', async () => {
    const { ws, run } = await setup();
    await run('a-001-r1', { planned: [task('T1', 'create the route')], merged: ['T1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T1', 'create the route and document its 404')])).toEqual(new Set());
  });

  it('does not adopt a task an earlier run only adopted, so a wrong adoption never travels to the next run', async () => {
    const { ws, run } = await setup();
    await run('a-001-r1', { planned: [task('T1', 'old')], merged: ['T1'] });
    await run('a-001-r2', { planned: [task('T1', 'new')], adopted: ['T1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r3', [task('T1', 'new')])).toEqual(new Set());
  });

  it('adopts a task an earlier run found already on main', async () => {
    const { ws, run } = await setup();
    await run('a-001-r1', { planned: [task('T1')], onMain: ['T1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T1')])).toEqual(new Set(['T1']));
  });

  it('adopts what an earlier run merged even when it stopped before finishing', async () => {
    const { ws, run } = await setup();
    await run('a-001-r1', { planned: [task('T1'), task('T2')], merged: ['T1'], finished: false });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T1'), task('T2')])).toEqual(new Set(['T1']));
  });

  it('adopts a replaced task once every task that replaced it merged', async () => {
    const { ws, run } = await setup();
    await run('a-001-r1', {
      planned: [task('T0'), task('T1')],
      replanned: [{ taskId: 'T0', replacements: [{ id: 'T0-r1' }] }, { taskId: 'T1', replacements: [{ id: 'T1-r1' }, { id: 'T1-r2' }] }],
      merged: ['T0-r1', 'T1-r1'],
    });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T0'), task('T1')])).toEqual(new Set(['T0']));
  });

  it('is empty for a spec with no earlier runs', async () => {
    const { ws } = await setup();
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r1', [task('T1')])).toEqual(new Set());
  });

  // Live finding (R11.3/4 program run, r4-r7, 2026-10-07): T900-fix-1, planned by Phase 4 for a criterion a prior
  // run found uncovered, was inherited as already-merged by every retry. Once the criterion's own wording changed
  // (an owner correction to an unprovable AC), Phase 4 never got a fresh chance to plan a fix for it again: the old
  // fix task stayed adopted as done, silently answering for a criterion it was never re-checked against.
  it('never adopts a T900-fix-* task: a fix task answers one verification attempt, never carried into a retry', async () => {
    const { ws, run } = await setup();
    await run('a-001-r1', { planned: [task('T0-scaffold'), task('T900-fix-1')], merged: ['T0-scaffold', 'T900-fix-1'] });
    expect(await mergedByPriorRuns(ws, 'a-001', 'a-001-r2', [task('T0-scaffold'), task('T900-fix-1')])).toEqual(new Set(['T0-scaffold']));
  });
});
```

In `test/orchestrator/run-retry.test.ts`, import `parseAnyPlan` from `../../server/contracts/plan.js` and seed the prior run as a real run journals it, with the plan's tasks parsed the way Phase 2 reads `plan.json`:

```ts
    // A prior run (r1) merged every task of the plan, then the spec failed at verification (the scenario this fixes).
    const prior = await EventStore.open({ file: eventsFile(d.ws, 'hello-001-r1'), runId: 'hello-001-r1', specHash: spec.specHash! });
    await prior.append({ type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } });
    for (const task of parseAnyPlan(plan).tasks) await prior.append({ type: 'TASK_PLANNED', data: { task } });
    for (const t of plan.tasks) await prior.append({ type: 'PR_MERGED', data: { taskId: t.id, pr: 1 } });
    await prior.append({ type: 'RUN_FINISHED', data: { result: 'verification-failed', reason: 'AC-003 missing', merged: plan.tasks.map((t) => t.id), blocked: [], tokens: {} } });
    await prior.close();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/orchestrator/workspace.test.ts test/orchestrator/run-retry.test.ts`
Expected: FAIL. The definition, adoption-only and replaced-task tests fail because the current function ignores definitions and returns every merged id; the others may pass.

- [ ] **Step 3: Implement**

In `server/orchestrator/workspace.ts`, replace `mergedByPriorRuns` with:

```ts
/** The ids of `tasks` an earlier run of this spec delivered itself, a merged pull request or work already on main, with the same definition. */
export async function mergedByPriorRuns(ws: Workspace, specId: string, runId: string, tasks: readonly PlanTask[]): Promise<Set<string>> {
  const delivered = new Set<string>();
  for (const events of await priorRunEvents(ws, specId, runId)) {
    const planned = new Map(events.filter((e) => e.type === RunEvent.TaskPlanned).map((e) => [(e.data.task as PlanTask).id, e.data.task]));
    // An adopted task is not evidence: only a merge or the work found on main proves this run delivered it.
    const done = new Set(events.filter((e) => e.type === OrchEvent.PrMerged || e.type === OrchEvent.AlreadyOnMain).map((e) => e.data.taskId as string));
    // A replaced task is delivered once every task that replaced it merged; the plan still lists the original id.
    for (const e of events) {
      if (e.type === RunEvent.TaskReplanned && (e.data.replacements as { id: string }[]).every((r) => done.has(r.id))) done.add(e.data.taskId as string);
    }
    // A T900-fix-* task answers one verification attempt's own findings, so a retry never carries it as done.
    for (const id of done) if (!id.startsWith('T900-fix-') && planned.has(id)) delivered.add(canonicalJson(planned.get(id)));
  }
  return new Set(tasks.filter((t) => delivered.has(canonicalJson(t))).map((t) => t.id));
}
```

Add the imports `canonicalJson` (`../contracts/hash.js`), `PlanTask` (type, `../contracts/plan.js`) and `RunEvent` (`../pipeline/run-state.js`, which imports only contracts, so no cycle). In `server/orchestrator/run.ts:634`, pass the plan's tasks: `mergedByPriorRuns(this.deps.ws, this.deps.spec.specId, this.runId, this.plan.tasks)`, and update the comment above it to say an earlier run must have delivered the task with the same definition.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/orchestrator/workspace.test.ts test/orchestrator/run-retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: every test passes (4 skipped), no type errors.

- [ ] **Step 6: Docs and commit**

Add under R11.5 in `docs/superpowers/ROADMAP.md`, after the plan 74 review line, and change the heading to "plans 66 to 75":

```markdown
- Built (plan 75): a run adopts a task only when an earlier run of the spec delivered it itself, through a merged pull request or as work already on main, with the same definition (`mergedByPriorRuns`); seen live: run 3 of `cancelar-pedido`, the first run of its second version, adopted its six re-planned tasks because run 1 had merged those ids, changed no code and still reached `awaiting-validation`.
```

Add the row to `docs/superpowers/plans/README.md`:

```markdown
| 75 | [`2026-10-12-teams-ai-75-retry-inherits-delivered-work.md`](2026-10-12-teams-ai-75-retry-inherits-delivered-work.md) | Done — a run adopts only the work an earlier run delivered with the same definition; ROADMAP R11.5. |
```

```bash
git add server/orchestrator/workspace.ts server/orchestrator/run.ts test/orchestrator/workspace.test.ts test/orchestrator/run-retry.test.ts docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "fix(run): a run adopts only the work an earlier run delivered with the same definition"
```
