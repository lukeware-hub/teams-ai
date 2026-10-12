# Plan 81 - A failed spec is classified, retried with its failure and then handed to the owner (R11.14)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a spec whose run failed is classified by the decision layer, run again with its failures as input up to two times, and only then left `failed` for the owner, while the specs that depend on it wait and the independent ones keep going.

**Architecture:** a new decision `failure-cause` (Jev, then the local model) classifies the failure as `code-defect`, `environment` or `spec-problem`. In the program controller, a delivering run that ends `failed` asks an optional effect `repair(specId, failures)`: it answers yes for the first two kinds (and when the layer gives no answer), and leaves the failures of every earlier attempt in `<draft root>/repair/<specId>.md`. On yes the item goes back to `pending` with `repairs + 1` and the failure kept in `failures`; on no, or after `MAX_REPAIRS` (2), it stays `failed` exactly as today, which blocks its dependents and shows the owner the existing retry button (the manual retry from plan `program-robustness` gives a fresh bound). The next run of the spec reads that file into the assumptions section of every step pack, so the Dev, the SM and the reviewers see why the last attempt failed. A run of the same spec already reuses its plan and the tasks an earlier run merged (`mergedByPriorRuns`, `server/orchestrator/workspace.ts:177`), so a repair pays only for the unmerged tasks, verification and deploy.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest.

**Spec:** roadmap R11.14 (`docs/superpowers/ROADMAP.md`, human decision 2026-10-06 in R11.4: "isolate, review, fix, adjust and continue; Jev classifying the cause and replanning; ask the human only after a bounded number of repair attempts"). This plan builds the smallest slice: classify, retry with the failure, escalate after the bound. It builds on the merged `program-robustness` work (`7708c18`, `d01418a`, `4d74021`): `retryItem` and `prioritizeItem` (`server/program/controller.ts:94`, `:105`), the restart-safe resume (`outcome()` returns `restart: true`, `server/program/service.ts:151`) and the blocked reason on a dependent (`controller.ts:199`).

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- What the owner reads is in Brazilian Portuguese.
- The worktree is shared with other sessions: commit with an explicit pathspec (`git commit -m ... -- <files>`), never a bare `git commit`, and verify in a clean worktree.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A failed delivering run with budget left goes back to `pending`, keeps its cost and its dependents stay `pending` (never `blocked`) while it is repaired; after the second repair it ends `failed` and the dependents block as today.
2. A restart at any point of a repair repeats nothing that costs: before the ledger write the failure is simply seen again (the classification repeats, the note is rewritten from the same list), after it the item is `running` with no run and the existing adoption branch (`controller.ts:152`) starts it.
3. A failure of the `spec complete` run, a resume failure, a start failure and `interrupted` resumes exhausted are not repaired: they stay `failed` for the owner as today.
4. `spec-problem` and a confidential project that the chain cannot answer behave as designed: the first goes straight to the owner; an unanswered classification counts as a retry, so the bound is the only limit.
5. The note travels outside `docs/`, so Phase 0 never publishes it to main.

## Limits

- Deliberately left out, each a later slice: the Jev reviewing the repair, replanning the spec or its tasks, adjusting the backlog (adding, dropping or reordering items) and a per-program cost cap. This slice only retries.
- Only a failed delivering run is repaired; the other failures above stay with the owner (they are mostly the host, and the owner already has the retry button).
- The classification only decides retry or not. `environment` and `code-defect` are treated alike; the split is recorded in the decision journal so a later slice can use it.
- The failure is given to the next run as text in the assumptions section; a task that blocks again for the same reason uses another attempt of its own (the run's bounded task attempts), then the run fails and the next repair begins.
- A server restart while a repair run is going follows the existing restart rules and spends no repair.
- Cost: a repair run re-runs only what the earlier run did not merge, plus verification and deploy. The most a failed spec adds is two such runs; the classification costs about nothing (Jev). The worst case is read live from `ProgramItem.costUsd`, which already sums every run of an item and survives a retry (`controller.ts:28`, `:105`).

---

### Task 1: The `failure-cause` decision

**Files:**
- Create: `server/decide/decisions/failure-cause.ts`
- Modify: `server/decide/types.ts` (`DECISION_IDS`, line 8)
- Modify: `server/config/config.ts` (`DECISION_DEFAULTS`, line 45)
- Test: `test/decide/failure-cause.test.ts` (new), `test/config/decisions.test.ts` (the Docker list, line 65)

**Interfaces:**
- Consumes: `Decider.decide(id, state, questions, ctx)` and `DecisionOutcome` (`server/decide/decider.ts:62`, `server/decide/types.ts:119`), as `routeReport` does (`server/decide/decisions/report-routing.ts`).
- Produces: `classifyFailure(failures: readonly string[], decider, ctx): Promise<FailureCause | null>`, `FAILURE_CAUSES`, `retryable(cause: FailureCause | null): boolean` (null, unanswered, counts as retryable).

- [ ] **Step 1: Write the failing tests**

Create `test/decide/failure-cause.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FAILURE_CAUSES, classifyFailure, failureCauseQuestions, failureCauseState, retryable } from '../../server/decide/decisions/failure-cause.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { choiceAnswer } from '../fixtures/fake-backend.js';

function fakeDecider(outcome: DecisionOutcome) {
  const calls: unknown[][] = [];
  return {
    calls,
    decide: async (...args: unknown[]) => {
      calls.push(args);
      return outcome;
    },
  };
}

describe('failure cause classification (R11.14)', () => {
  it('offers the three causes and sends the newest failure last', () => {
    expect(Object.keys(FAILURE_CAUSES).sort()).toEqual(['code-defect', 'environment', 'spec-problem']);
    expect(failureCauseQuestions().cause).toMatchObject({ type: 'choice', options: FAILURE_CAUSES });
    expect(failureCauseState(['first', 'second'])).toBe('attempt 1:\nfirst\n\nattempt 2:\nsecond');
  });

  it('uses the answer and asks decision failure-cause', async () => {
    const d = fakeDecider({ answered: true, backend: 'jev', escalated: false, answers: { cause: choiceAnswer('spec-problem', { 'spec-problem': 0.9 }) } });
    expect(await classifyFailure(['x'], d, { confidential: false })).toBe('spec-problem');
    expect(d.calls[0]![0]).toBe('failure-cause');
  });

  it('gives null when unanswered or the answer is not an option', async () => {
    expect(await classifyFailure(['x'], fakeDecider({ answered: false, reason: 'disabled' }), { confidential: false })).toBeNull();
    const odd = fakeDecider({ answered: true, backend: 'local', escalated: false, answers: { cause: choiceAnswer('luck', { luck: 1 }) } });
    expect(await classifyFailure(['x'], odd, { confidential: false })).toBeNull();
  });

  it('retries everything but a spec problem, an unanswered classification included', () => {
    expect([null, 'code-defect', 'environment'].map((c) => retryable(c as never))).toEqual([true, true, true]);
    expect(retryable('spec-problem')).toBe(false);
  });
});
```

In `test/config/decisions.test.ts` line 65 add the new id (the Docker config names only the decisions it turns off, so a new one is on):

```ts
    expect(enabled).toEqual(['gate1-readiness', 'question-dedup', 'history-contradiction', 'question-routing', 'patch-dedup', 'failure-cause']);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/decide/failure-cause.test.ts test/config/decisions.test.ts`
Expected: FAIL. The module does not exist and `failure-cause` is not a decision id.

- [ ] **Step 3: Implement**

In `server/decide/types.ts` append `'failure-cause'` to `DECISION_IDS` after `'patch-dedup'`.

In `server/config/config.ts`, add to `DECISION_DEFAULTS` after the `'patch-dedup'` entry (it runs in the UI server, which has no Claude step to escalate to, like `report-routing`):

```ts
  // R11.14: only decides whether another run is worth trying; a wrong answer costs one bounded run or one question to the owner.
  'failure-cause': { chain: ['jev', 'local'], escalateTo: 'sm' },
```

Create `server/decide/decisions/failure-cause.ts`:

```ts
import type { DecideContext, Decider } from '../decider.js';
import type { Questions } from '../types.js';

/** R11.14. Only a spec problem stops a retry; the other two are told apart for the journal. */
export type FailureCause = 'code-defect' | 'environment' | 'spec-problem';

export const FAILURE_CAUSES: Record<FailureCause, string> = {
  'code-defect': 'The delivered code or its tests fail: a failing test, a failed gate, a blocked task or a criterion without evidence. Another run that sees this failure can fix it.',
  environment: 'The host failed, not the work: a container or network down, quota, login, a timeout or a full disk. Another run later can pass with no change.',
  'spec-problem': 'The criteria contradict each other or cannot be met as written, so every run fails the same way until a person changes the spec.',
};

export function failureCauseQuestions(): Questions {
  return { cause: { type: 'choice', instructions: 'A spec run failed. From the failures of its attempts, oldest first, classify the cause of the latest one.', options: FAILURE_CAUSES } };
}

export const failureCauseState = (failures: readonly string[]): string => failures.map((f, i) => `attempt ${i + 1}:\n${f}`).join('\n\n');

/** Unanswered (layer off or exhausted) gives null. */
export async function classifyFailure(failures: readonly string[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<FailureCause | null> {
  const outcome = await decider.decide('failure-cause', failureCauseState(failures), failureCauseQuestions(), ctx);
  if (!outcome.answered) return null;
  const answer = outcome.answers.cause;
  return answer?.type === 'choice' && answer.value in FAILURE_CAUSES ? (answer.value as FailureCause) : null;
}

export const retryable = (cause: FailureCause | null): boolean => cause !== 'spec-problem';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/decide test/config`
Expected: PASS (the config test also proves `failure-cause` parses with the default chain).

- [ ] **Step 5: Commit**

```bash
git add server/decide/decisions/failure-cause.ts test/decide/failure-cause.test.ts
git commit -m "feat(decide): a failure-cause decision tells a spec problem from a failure another run can fix" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -- server/decide/decisions/failure-cause.ts server/decide/types.ts server/config/config.ts test/decide/failure-cause.test.ts test/config/decisions.test.ts
```

### Task 2: The controller repairs a failed delivering run, bounded

**Files:**
- Modify: `server/program/controller.ts` (`ProgramItem`, `ProgramEffects`, `retryItem`, `tick`)
- Test: `test/program/controller.test.ts`

**Interfaces:**
- Consumes: `fail`, `addCost` and `dirty` inside `tick` (`controller.ts:131-141`), the failed branch at `controller.ts:166`.
- Produces: `MAX_REPAIRS = 2`; `ProgramItem.repairs?: number` and `failures?: string[]` (optional, since ledgers on disk before this plan lack them); `ProgramEffects.repair?(specId, failures): Promise<boolean>`.

Design proof against the code: `tick` loops the items first (settling runs), then blocks dependents of `failed` or `blocked` items (`controller.ts:199`), then fills slots. A repaired item is set `pending` inside the first loop, so the block pass never sees it `failed` and its dependents stay `pending`; the slot pass then starts it by rank in the same tick. `retryItem` (`controller.ts:105`) zeroes `resumes` and `runId` through `Object.assign`; the repair does the same through one shared helper and keeps `costUsd`, `failures` and `repairs`. The manual `retryItem` must also zero `repairs` and `failures`, or an owner who retries after the bound would get no repair and a stale note.

- [ ] **Step 1: Write the failing tests**

In `test/program/controller.test.ts` add `MAX_REPAIRS` to the import from `controller.js`, then add a `repair` option to `world()`: change the signature to `function world(outcomes: Record<string, RunOutcome | RunOutcome[]> = {}, repair?: ProgramEffects['repair'])` and add `repair,` as the last field of `fx`. Add after `'isolates a failed item, ...'`:

```ts
  // R11.14: a failed delivering run is repaired a bounded number of times before the owner is asked.
  it('runs a failed item again with its failures, keeps its dependents waiting and its cost, and fails it after the bound', async () => {
    const seen: string[][] = [];
    const { fx, calls } = world(
      {
        'd-a-r1': { kind: 'failed', reason: 'one', costUsd: 1 },
        'd-a-r2': { kind: 'failed', reason: 'two', costUsd: 2 },
        'd-a-r3': { kind: 'failed', reason: 'three', costUsd: 3 },
      },
      async (_specId, failures) => (seen.push([...failures]), true),
    );
    let p = newProgram('d', [entry('a', 1), entry('b', 2, ['a'])], NOW);
    p = await tick(p, fx, save);
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'running', b: 'pending' });
    expect(p.items[0]).toMatchObject({ runId: 'd-a-r2', repairs: 1, failures: ['one'], costUsd: 1 });
    p = await tick(p, fx, save);
    expect(p.items[0]).toMatchObject({ runId: 'd-a-r3', repairs: 2, failures: ['one', 'two'], costUsd: 3 });
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'failed', b: 'blocked' });
    expect(p.items[0]!.reason).toBe(`three; ${MAX_REPAIRS} reparo(s) automático(s) não resolveram`);
    expect(p.items[0]!.costUsd).toBe(6);
    expect(seen).toEqual([['one'], ['one', 'two']]);
    expect(calls).toEqual(['start d-a', 'start d-a', 'start d-a']);
  });

  it('fails at once when the repair says no, and never repairs without the effect', async () => {
    const refused = world({ 'd-a-r1': { kind: 'failed', reason: 'criteria contradict' } }, async () => false);
    let p = await tick(newProgram('d', [entry('a', 1)], NOW), refused.fx, save);
    p = await tick(p, refused.fx, save);
    expect(p.items[0]).toMatchObject({ status: 'failed', reason: 'criteria contradict' });
    expect(p.items[0]!.repairs).toBeUndefined();
    const plain = world({ 'd-a-r1': { kind: 'failed', reason: 'x' } });
    let q = await tick(newProgram('d', [entry('a', 1)], NOW), plain.fx, save);
    q = await tick(q, plain.fx, save);
    expect(q.items[0]!.status).toBe('failed');
  });

  it('does not repair a failed completion, and a classification that throws counts as no repair', async () => {
    const { fx } = world({ 'd-a-r1': { kind: 'delivered' }, 'd-a-complete-r1': { kind: 'failed', reason: 'merge' } }, async () => true);
    let p = await tick(newProgram('d', [entry('a', 1)], NOW), fx, save);
    for (let i = 0; i < 3; i++) p = await tick(p, fx, save);
    expect(p.items[0]).toMatchObject({ status: 'failed', reason: 'completion failed: merge' });
    const broken = world({ 'd-a-r1': { kind: 'failed', reason: 'x' } }, async () => { throw new Error('down'); });
    let q = await tick(newProgram('d', [entry('a', 1)], NOW), broken.fx, save);
    q = await tick(q, broken.fx, save);
    expect(q.items[0]!.status).toBe('failed');
  });
```

Extend the `retryItem` test (`'retryItem clears a failed item back to pending ...'`): give the failed item `repairs: 2, failures: ['a', 'b']` in its spread and add `expect(retried.items[0]).toMatchObject({ repairs: 0, failures: [] });`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/program/controller.test.ts`
Expected: FAIL. `MAX_REPAIRS` and the `repair` effect do not exist; a failed item stays failed.

- [ ] **Step 3: Implement**

In `server/program/controller.ts`:

Update the file header's last line to: `A failed spec is isolated: its dependents wait while it is repaired (R11.14, bounded by MAX_REPAIRS) and are blocked once it stays failed; everything independent of it keeps going.`

Add to `ProgramItem`, after `priority`:

```ts
  /** Automatic repairs so far (R11.14); absent in a ledger written before them. */
  repairs?: number;
  /** The failure of each attempt, oldest first; the next run reads them. */
  failures?: string[];
```

Add to `ProgramEffects`, after `outcome`:

```ts
  /** Whether another run can fix this failure; when it can, it also hands the failures to that run. Absent: a failure is final. */
  repair?(specId: string, failures: readonly string[]): Promise<boolean>;
```

Add after `MAX_RESUMES`:

```ts
/** Automatic repairs of one failed spec; after them the owner decides. */
export const MAX_REPAIRS = 2;
```

Replace the `Object.assign(item, { status: 'pending', ... resumes: 0 });` line of `retryItem` and share it:

```ts
const clearForRetry = (item: ProgramItem) => Object.assign(item, { status: 'pending', runId: null, completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 });
```

(declare it above `retryItem`) and in `retryItem` use `Object.assign(clearForRetry(item), { repairs: 0, failures: [] });`.

In `tick`, after `fail`, add:

```ts
  // A failed delivering run goes again with its failures while it has repairs left; an unwilling or broken repair leaves it failed.
  const failOrRepair = async (item: ProgramItem, reason: string, costUsd?: number | null) => {
    const repairs = item.repairs ?? 0;
    const failures = [...(item.failures ?? []), reason];
    if (fx.repair && repairs < MAX_REPAIRS && (await fx.repair(item.specId, failures).catch(() => false))) {
      addCost(item, costUsd);
      Object.assign(clearForRetry(item), { repairs: repairs + 1, failures });
      dirty = true;
    } else fail(item, repairs > 0 ? `${reason}; ${repairs} reparo(s) automático(s) não resolveram` : reason, costUsd);
  };
```

and change line 166 to `if (o.kind === 'failed') await failOrRepair(item, o.reason, o.costUsd);`. Leave the `completing` branch's `fail(...)` calls unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/program`
Expected: PASS, the existing `'isolates a failed item ...'` test included (no `repair` effect there).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(program): a failed delivering run goes again with its failures twice before the owner is asked" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -- server/program/controller.ts test/program/controller.test.ts
```

### Task 3: The service classifies and leaves the note

**Files:**
- Create: `server/program/repair-notes.ts`
- Modify: `server/program/service.ts` (`ProgramServiceDeps`, `effects`)
- Modify: `server/refine/registry.ts` (the `ProgramService` constructor call, line 63)
- Test: `test/program/service.test.ts`

**Interfaces:**
- Consumes: `classifyFailure`, `retryable` (Task 1); `Project` (`server/contracts/project.ts:36` has `confidential`); `writeFileAtomic` (`server/core/atomic-write.js`, already imported in `service.ts`); the registry's `deps.decider` (`server/refine/registry.ts:31`, the UI server's decider that never throws, `server/cli.ts:108`).
- Produces: `repairNotesFile(root, specId)`, `writeRepairNotes(root, specId, failures)`, `readRepairNotes(projectDir, specId): Promise<string | null>`; `ProgramServiceDeps.decider?`.

The note lives at `<draft root>/repair/<specId>.md`, next to `program.json` and outside `docs/`, so Phase 0 (which copies `docs/specs/<id>/` to main) never publishes it. It is rewritten whole from the ledger's `failures`, so repeating the write after a restart changes nothing. Without a decider the effect is not provided, so a failure is final, as today.

- [ ] **Step 1: Write the failing test**

In `test/program/service.test.ts` change `service()` to take the decider: `function service(decider?: ProgramServiceDeps['decider'])`, add `decider,` to the `ProgramService` options and import `type ProgramServiceDeps`. Add inside `describe('program service tick')`:

```ts
  // R11.14: a failed run is classified, and the next run reads the failures.
  it('runs a failed spec again with its failure in a note, and leaves a spec problem to the owner', async () => {
    const specFile = path.join(root, 'draft', 'docs', 'specs', 'd-a', 'spec.json');
    await fs.mkdir(path.dirname(specFile), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'docs', 'project.json'), JSON.stringify({ confidential: false }));
    const item = { specId: 'd-a', key: 'a', rank: 1, dependsOn: [], status: 'running', runId: 'd-a-r1', completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 };
    const ledger = path.join(root, 'draft', 'program.json');
    await fs.writeFile(ledger, JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [item] }));
    await journal('d-a-r1', [started('d-a'), finished('verification-failed', { reason: 'AC-004 missing' })]);
    const cause = (value: string) => ({ decide: async () => ({ answered: true as const, backend: 'jev' as const, escalated: false, answers: { cause: { type: 'choice' as const, value, probabilities: { [value]: 1 }, confidence: 1 } } }) });
    const again = await service(cause('code-defect')).tick('shop', 'd');
    expect(again!.items[0]).toMatchObject({ repairs: 1, failures: ['verification-failed: AC-004 missing'] });
    expect(await fs.readFile(path.join(root, 'draft', 'repair', 'd-a.md'), 'utf8')).toContain('verification-failed: AC-004 missing');
    await fs.writeFile(ledger, JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [item] }));
    const final = await service(cause('spec-problem')).tick('shop', 'd');
    expect(final!.items[0]).toMatchObject({ status: 'failed', reason: 'verification-failed: AC-004 missing' });
  });
```

Add to the same file a note round trip, in a new `describe('repair notes')`:

```ts
describe('repair notes', () => {
  it('reads back what was written, and nothing when there is no note', async () => {
    expect(await readRepairNotes(path.join(root, 'draft'), 'd-a')).toBeNull();
    await writeRepairNotes(path.join(root, 'draft'), 'd-a', ['one', 'two']);
    const text = (await readRepairNotes(path.join(root, 'draft'), 'd-a'))!;
    expect(text).toContain('attempt 1 failed: one');
    expect(text).toContain('attempt 2 failed: two');
  });
});
```

(import `readRepairNotes`, `writeRepairNotes` from `../../server/program/repair-notes.js`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/program/service.test.ts`
Expected: FAIL. The module does not exist and a failed run ends `failed`.

- [ ] **Step 3: Implement**

Create `server/program/repair-notes.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';

/** Outside `docs/`, which Phase 0 publishes to main. */
export const repairNotesFile = (root: string, specId: string): string => path.posix.join(root, 'repair', `${specId}.md`);

export async function writeRepairNotes(root: string, specId: string, failures: readonly string[]): Promise<void> {
  await fs.mkdir(path.dirname(repairNotesFile(root, specId)), { recursive: true });
  await writeFileAtomic(repairNotesFile(root, specId), `${failures.map((f, i) => `attempt ${i + 1} failed: ${f}`).join('\n')}\n`);
}

export const readRepairNotes = (root: string, specId: string): Promise<string | null> => fs.readFile(repairNotesFile(root, specId), 'utf8').catch(() => null);
```

(`writeFileAtomic` does not create the parent directory, `server/core/atomic-write.ts`, hence the `mkdir`.)

In `server/program/service.ts`: import `classifyFailure`, `retryable` from `../decide/decisions/failure-cause.js`, `Project` from `../contracts/project.js` and `writeRepairNotes` from `./repair-notes.js`. Add to `ProgramServiceDeps`:

```ts
  /** Classifies a failed run (R11.14); absent means a failed run is never repaired. */
  decider?: Pick<Decider, 'decide'>;
```

(import `type Decider` from `../decide/decider.js`). In the object `effects()` returns, add after `outcome`:

```ts
      repair: this.deps.decider && ((specId, failures) => this.repair(root, specId, failures)),
```

and add the method:

```ts
  /** Classifies the latest failure; when another run may fix it, leaves every failure for that run to read. */
  private async repair(root: string, specId: string, failures: readonly string[]): Promise<boolean> {
    const { confidential } = Project.parse(JSON.parse(await fs.readFile(path.join(root, 'docs', 'project.json'), 'utf8')));
    if (!retryable(await classifyFailure(failures, this.deps.decider!, { confidential }))) return false;
    await writeRepairNotes(root, specId, failures);
    return true;
  }
```

In the test fixture above `project.json` holds only `{ confidential: false }`; if `Project.parse` rejects it, write a full project with `makeProject` from `test/fixtures/contracts.js` instead (same file `makeFrozenSpec` comes from) so the test uses the real shape.

In `server/refine/registry.ts`, in the `new ProgramService({ ... })` call (line 63) add `decider: deps.decider,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/program test/refine/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/program/repair-notes.ts
git commit -m "feat(program): the program classifies a failed spec and leaves its failures for the next run" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -- server/program/repair-notes.ts server/program/service.ts server/refine/registry.ts test/program/service.test.ts
```

### Task 4: The next run reads the failures

**Files:**
- Modify: `server/orchestrator/run.ts` (`RunDeps`, `packBase`, line 405)
- Modify: `server/cli.ts` (`loadRunDeps`, return at line 236)
- Test: `test/orchestrator/run-repair-notes.test.ts` (new)

**Interfaces:**
- Consumes: `readRepairNotes` (Task 3); `PackBase.assumptions` (`server/orchestrator/steps.ts:31`), rendered in every pack as `## Assumptions logged during this run` (`server/knowledge/context-pack.ts:111`).
- Produces: `RunDeps.repairNotes?: string | null`; `packBase().assumptions` begins with the note.

The run process starts with `--project <draft root>` (`spawnRun`, `server/program/service.ts:101`), so `projectDir` in `loadRunDeps` is the draft root where the note lives. An ordinary run (no program, no note) reads `null` and nothing changes. `assumptions` sits late in the pack drop order (`context-pack.ts:77`: dropped before only `current-docs` and `feedback`), so the note survives a tight budget longer than the code and the retrieval around it.

- [ ] **Step 1: Write the failing test**

Look at how an existing test builds a `Run` with `packBase` (`grep -n "packBase" test/orchestrator/*.ts`); the smallest proof is to export the line as a pure function. In `server/orchestrator/run.ts` the change is one expression, so test it through a small exported helper in `repair-notes.ts`:

```ts
/** The assumptions a step sees: the failures of the earlier attempts first, then what this run logged. */
export const withRepairNotes = (notes: string | null | undefined, assumptions: readonly string[]): readonly string[] => (notes ? [`The earlier run of this spec failed, and this run must not repeat it:\n${notes.trim()}`, ...assumptions] : assumptions);
```

Create `test/orchestrator/run-repair-notes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withRepairNotes } from '../../server/program/repair-notes.js';

describe('repair notes in the pack', () => {
  it('puts the failures of the earlier attempts before the logged assumptions', () => {
    const [first, ...rest] = withRepairNotes('attempt 1 failed: AC-004 missing\n', ['an assumption']);
    expect(first).toContain('must not repeat it');
    expect(first).toContain('attempt 1 failed: AC-004 missing');
    expect(rest).toEqual(['an assumption']);
  });

  it('leaves the assumptions alone when there is no note', () => {
    expect(withRepairNotes(null, ['a'])).toEqual(['a']);
    expect(withRepairNotes(undefined, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/orchestrator/run-repair-notes.test.ts`
Expected: FAIL. `withRepairNotes` does not exist.

- [ ] **Step 3: Implement**

Add `withRepairNotes` (above) to `server/program/repair-notes.ts`. In `server/orchestrator/run.ts`: add `repairNotes?: string | null;` to `RunDeps` after `spec: Spec;` and change line 409 to `assumptions: withRepairNotes(this.deps.repairNotes, this.journal.assumptions()),` (import `withRepairNotes`). In `server/cli.ts`, in the object `loadRunDeps` returns (line 236) add `repairNotes: await readRepairNotes(projectDir, specId),` (import `readRepairNotes`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/orchestrator test/program test/cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/orchestrator/run-repair-notes.test.ts
git commit -m "feat(orchestrator): a run of a repaired spec reads why the last attempt failed" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -- server/program/repair-notes.ts server/orchestrator/run.ts server/cli.ts test/orchestrator/run-repair-notes.test.ts
```

### Task 5: Roadmap and live check

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R11.14 entry; the "deliberately not built" line of R11.4, line 491)

- [ ] **Step 1: Verify the whole suite**

Run: `npx tsc --noEmit && npx vitest run && (cd web && npx vitest run)`
Expected: no type errors; every test passes (the suite count at the last roadmap entry was 1633 passed and 4 skipped, plus this plan's new tests).

- [ ] **Step 2: Live check (needed, the unit tests fake the run and the decision)**

On the Docker stack, with a small backlog of three specs (`a`, `b` depends on `a`, `c` independent):
1. Make spec `a` fail once on purpose (a criterion whose test the Dev can fix after reading the failure, for example an endpoint missing a field its criterion names, with the first run's task attempts cut to one through the run's own limits). Expected: `a` shows `running` again with `repairs: 1` in `program.json` and `repair/<spec>.md` holds the failure; `b` stays `pending`, never `blocked`; `c` runs meanwhile; the second run reaches `awaiting-validation` and `a` completes.
2. Make `a` fail twice more (a criterion that cannot pass). Expected: after the second repair `a` is `failed` with the Portuguese reason ending `2 reparo(s) automático(s) não resolveram`, `b` is `blocked` with the existing reason, `c` is `done`, and the retry button gives `a` a fresh bound.
3. Read the decision journal for `failure-cause`: the backend that answered, its confidence, and the cause chosen for each failure.
4. Record the cost: the item's `costUsd` after both cases against its first run, to confirm a repair re-runs only the unmerged work.

- [ ] **Step 3: Update the roadmap**

Add an R11.14 entry (or mark the existing one `built`) stating what was built (the `failure-cause` decision, the bounded repair in `tick`, the note read by the next run), the Limits above as the open items (review, replan and backlog adjustment by Jev; repair of completion and start failures; a per-program cost cap), and the live check result. In R11.4 line 491 replace "deliberately **not** built here" with a pointer to R11.14.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(roadmap): R11.14 repair loop built, with what it leaves out" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -- docs/superpowers/ROADMAP.md
```
