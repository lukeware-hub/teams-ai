# Plan 71 - Blocked work does not pass (R11.5.6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a criterion whose every task is blocked fails Phase 4, so the run plans a fix task for it instead of deploying code that does not exist.

**Architecture:** the evidence matrix keeps its `blocked` label, so the report still says why a criterion has no evidence, but Phase 4 counts that criterion as uncovered (`readyForValidation` in `server/evidence/matrix.ts`, `uncoveredAcs` in `server/orchestrator/phases/verify.ts`). Round 1 then asks the SM for fix tasks, as for any other uncovered criterion; the SM now sees the blocked tasks with their reasons, and a fix task that depends on a blocked task is refused, since it would block at once (`fixTasksPack` in `server/orchestrator/steps.ts`, `fixTaskErrors` in `verify.ts`). Round 2 stays the verdict.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** plan 66 (`docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md`), section "Design", paragraph **R11.5.6 Blocked work does not pass**, and its "Where autonomy breaks today" bullet on blocked work; the repair loop decision under R11.3 of `docs/superpowers/ROADMAP.md`.

**Seen live (R12.7, 2026-10-12):** in both specs a criterion whose tasks were blocked passed Phase 4, and Phase 5 deployed code that did not exist yet.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- Agent prompts stay in English; the matrix keeps the `blocked` status, so the report and the run page keep showing it.
- A criterion with a passed test passes, whatever the state of its tasks, as today.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A criterion with a passed test whose task blocked afterwards (a later attempt): it passes, since tests come first.
2. A blocked task's dependents, blocked with "a dependency is blocked": they appear in the SM's list too, and a fix task that depends on any of them is refused.
3. Round 2 with the criterion still blocked: the run ends `verification-failed` with the criterion counted as uncovered, and never deploys.
4. A services run: the same rule holds across services, and a fix task names its service as today.
5. A resumed run whose round 1 fix tasks were already planned: Phase 4 returns them without asking the SM again, as today.

## Limits

- The verdict is still round 2: a criterion whose fix task blocks too ends the run `verification-failed`, where before it reached `awaiting-validation` with the criterion marked blocked.

---

### Task 1: A criterion whose every task is blocked fails Phase 4

**Files:**
- Modify: `server/evidence/matrix.ts:57-59` (`readyForValidation`)
- Modify: `server/orchestrator/phases/verify.ts:152` (`uncoveredAcs`)
- Create: `test/orchestrator/verify-blocked.test.ts`
- Test: `test/evidence/matrix.test.ts:70-75`

**Interfaces:**
- Produces: `readyForValidation(rows)` true only when every row passed; Phase 4's `uncoveredAcs` lists `missing` and `blocked` criteria.

- [ ] **Step 1: Write the failing tests**

In `test/evidence/matrix.test.ts`, replace the `readyForValidation` test with:

```ts
  it('requires every criterion to have passed, so a criterion whose tasks all blocked is not ready', () => {
    expect(readyForValidation([{ criterion: 'AC-001', tasks: [], tests: [], status: 'passed' }])).toBe(true);
    expect(readyForValidation([{ criterion: 'AC-001', tasks: [], tests: [], status: 'passed' }, { criterion: 'AC-002', tasks: ['T2'], tests: [], status: 'blocked' }])).toBe(false);
    expect(readyForValidation([{ criterion: 'AC-001', tasks: [], tests: [], status: 'missing' }])).toBe(false);
  });
```

Create `test/orchestrator/verify-blocked.test.ts`:

```ts
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlanTask } from '../../server/contracts/plan.js';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase4, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };
const t1 = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'] });
const t2 = makePlanTask({ id: 'T2', criteriaRefs: ['AC-002'] });
const t3 = makePlanTask({ id: 'T3', criteriaRefs: ['AC-002'], dependsOn: ['T2'] });
// Only AC-001 has a passed test: every task of AC-002 blocked.
const gate: GateResult = { name: 'unit-test', blocking: true, passed: true, exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: '', junit: [{ id: 't::[AC-001] works', name: '[AC-001] works', classname: 't', status: 'passed', acIds: ['AC-001'] }], failure: null };
const fix = (over: Partial<PlanTask> = {}) => makePlanTask({ id: 'F', criteriaRefs: ['AC-002'], ...over });

let remote: Remote;
let journal: Journal;
let packs: string[];
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

/** A run whose T2 blocked and took T3 with it; the SM answers each fix-tasks step with the next list. */
async function setup(answers: PlanTask[][]): Promise<PhaseDeps> {
  remote = await makeRemote({ 'README.md': '#\n' });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  await journal.fact(OrchEvent.TaskBlocked, { taskId: 'T2', reason: 'the Dev found no way to reach the payment API' });
  await journal.fact(OrchEvent.TaskBlocked, { taskId: 'T3', reason: 'a dependency is blocked' });
  packs = [];
  return {
    journal, ws: { repo: remote.repo }, spec, exec: execCommand, firstSpec: false, plan: makePlan(spec, { tasks: [t1, t2, t3] }),
    tasks: () => [{ def: t1, state: 'merged' }, { def: t2, state: 'blocked' }, { def: t3, state: 'blocked' }],
    gates: async () => ({ results: [gate], blockingFailure: null }),
    packBase: () => ({ spec, project: makeProject(), specHash: HASH, assumptions: [], budgetTokens: 8000 }),
    runAgent: async (req: AgentStepRequest<'fix-tasks'>) => { packs.push(String(req.pack.feedback)); return { ok: true, value: { specHash: HASH, tasks: answers.shift()! }, summary }; },
  } as unknown as PhaseDeps;
}

describe('Phase 4 with blocked work', () => {
  it('fails round 1 when every task of a criterion is blocked, and asks the SM for a fix task for it', async () => {
    const res = await runPhase4(await setup([[fix()]]), 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fixTasks?.map((t) => [t.id, t.criteriaRefs])).toEqual([['T900-fix-1', ['AC-002']]]);
    const failed = journal.events.find((e) => e.type === OrchEvent.VerificationFailed)!.data;
    expect(failed.uncoveredAcs).toEqual(['AC-002']);
    // The report still says why the criterion has no evidence.
    expect((failed.matrix as Array<{ criterion: string; status: string }>).map((r) => [r.criterion, r.status])).toEqual([['AC-001', 'passed'], ['AC-002', 'blocked']]);
    expect(packs[0]).toContain('Criteria without passed evidence:\n- AC-002');
  });

  it('ends round 2 failed with the blocked criterion counted, so nothing is deployed', async () => {
    const res = await runPhase4(await setup([]), 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('verification failed in round 2: 0 failing tests, 1 uncovered criteria');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/evidence/matrix.test.ts test/orchestrator/verify-blocked.test.ts`
Expected: the `readyForValidation` case and both Phase 4 cases FAIL (a blocked criterion counts as ready, so Phase 4 passes).

- [ ] **Step 3: Implement**

In `server/evidence/matrix.ts`, replace `readyForValidation` with:

```ts
/** Every criterion passed; a blocked one is not ready, since the code it needs never reached main. */
export function readyForValidation(rows: readonly EvidenceRow[]): boolean {
  return rows.every((r) => r.status === 'passed');
}
```

In `server/orchestrator/phases/verify.ts`, change the `uncoveredAcs` line to:

```ts
  const uncoveredAcs = matrix.filter((r) => r.status === 'missing' || r.status === 'blocked').map((r) => r.criterion);
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/evidence test/orchestrator && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/evidence/matrix.ts server/orchestrator/phases/verify.ts test/evidence/matrix.test.ts test/orchestrator/verify-blocked.test.ts
git commit -m "fix(verify): a criterion whose every task is blocked fails Phase 4

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The SM plans the repair around the blocked tasks

**Files:**
- Modify: `server/orchestrator/steps.ts:324-338` (`fixTasksPack`)
- Modify: `server/orchestrator/phases/verify.ts:93-99` (`fixTaskErrors`), `:161` (the `fixTasksPack` call)
- Test: `test/orchestrator/verify-blocked.test.ts`

**Interfaces:**
- Consumes: `blockReason(events, taskId)` from `server/orchestrator/phases/report.ts`; `deps.tasks()` (`EvidenceTask`: `def`, `state`).
- Produces: `fixTasksPack(base, { ..., blocked: ReadonlyArray<{ taskId: string; reason: string }> })`; `fixTaskErrors` also refuses a fix task that depends on a blocked task.

- [ ] **Step 1: Write the failing tests**

Add to `describe('Phase 4 with blocked work', ...)` in `test/orchestrator/verify-blocked.test.ts`:

```ts
  it('shows the SM every blocked task with its reason', async () => {
    await runPhase4(await setup([[fix()]]), 1);
    expect(packs[0]).toContain('Blocked tasks (their work never reached main; a fix task redoes what a criterion still needs and never depends on them):\n- T2: the Dev found no way to reach the payment API\n- T3: a dependency is blocked');
  });

  it('refuses a fix task that depends on a blocked task, since it would block at once, and asks again', async () => {
    const res = await runPhase4(await setup([[fix({ dependsOn: ['T3'] })], [fix({ dependsOn: ['T1'] })]]), 1);
    expect(packs).toHaveLength(2);
    expect(packs[1]).toContain('T900-fix-1 depends on T3, which is blocked: a fix task never depends on a blocked task');
    if (!res.ok) expect(res.fixTasks?.map((t) => t.dependsOn)).toEqual([['T1']]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/verify-blocked.test.ts`
Expected: both new cases FAIL (no blocked list in the pack; the first answer is accepted); the Task 1 cases pass.

- [ ] **Step 3: Implement**

In `server/orchestrator/steps.ts` `fixTasksPack`, add `blocked: ReadonlyArray<{ taskId: string; reason: string }>` to the options and this line after the `Criteria without passed evidence` line:

```ts
    `Blocked tasks (their work never reached main; a fix task redoes what a criterion still needs and never depends on them):\n${opts.blocked.map((b) => `- ${b.taskId}: ${b.reason}`).join('\n') || '- none'}`,
```

In `server/orchestrator/phases/verify.ts`, import `blockReason` from `./report.js`, add before `fixTaskErrors`:

```ts
/** The run's blocked tasks: a fix task never depends on one, since it would block at once. */
const blockedTasks = (deps: PhaseDeps) => (deps.tasks?.() ?? []).filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: blockReason(deps.journal.events, t.def.id) }));
```

make `fixTaskErrors` return the dependency errors before the plan check:

```ts
function fixTaskErrors(deps: PhaseDeps, fixTasks: readonly PlanTask[]): string[] {
  const blocked = new Set(blockedTasks(deps).map((b) => b.taskId));
  const onBlocked = fixTasks.flatMap((t) => t.dependsOn.filter((d) => blocked.has(d)).map((d) => `${t.id} depends on ${d}, which is blocked: a fix task never depends on a blocked task`));
  if (onBlocked.length > 0) return onBlocked;
  const services = deps.services;
```

(the rest of the function unchanged), and pass `blocked: blockedTasks(deps)` to the `fixTasksPack(...)` call.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/orchestrator test/evidence && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/steps.ts server/orchestrator/phases/verify.ts test/orchestrator/verify-blocked.test.ts
git commit -m "fix(verify): the SM plans the repair around the blocked tasks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Record R11.5.6 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (section `### R11.5 Autonomy hardening`, after the R11.5.5 lines)
- Modify: `docs/superpowers/plans/README.md` (the table, after row 70)

- [ ] **Step 1: Update the roadmap**

Add after the last R11.5.5 line:

```md
- Built R11.5.6 (plan 71): a criterion whose every task is blocked fails Phase 4 instead of passing (`readyForValidation`), so round 1 asks the SM for a fix task for it and round 2 is the verdict, and nothing is deployed for work that never reached main; the matrix keeps the `blocked` label for the report; the SM sees every blocked task with its reason, and a fix task that depends on one is refused, since it would block at once (`fixTasksPack`, `fixTaskErrors`). Seen live in R12.7: both specs deployed code that did not exist yet.
```

- [ ] **Step 2: Update the plans index**

Add after row 70 of `docs/superpowers/plans/README.md`:

```md
| 71 | [`2026-10-12-teams-ai-71-blocked-work-does-not-pass.md`](2026-10-12-teams-ai-71-blocked-work-does-not-pass.md) | Done — a criterion whose every task is blocked fails Phase 4 and gets a fix task, which never depends on a blocked task; ROADMAP R11.5.6. |
```

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.5.6 blocked work does not pass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
