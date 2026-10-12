# Plan 77 - A started or delivered spec is never re-derived (R11.7.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a new backlog draft over a project that already delivered some items never rewrites their specs, and its program never runs them again.

**Architecture:** backlog detailing reads each item's spec on main (the draft's base copy, which a start's sync keeps equal to main; review fix: never the draft's own copy, which its own start freezes) and keeps one whose status is past `planned` exactly as main has it: no `spec` or `preplan` step, main's folder put back over the draft's, its row recorded from main's copy. The coverage that gates `ready` counts such an item as covered without a pre-plan, since its own run planned it. The program's entries come from a new `programEntries`: a `done` item starts the program done, and an item still running, paused or awaiting validation, or a backlog with nothing left to deliver, refuses the start with the reason.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** plan 76, design R11.7.2 (`docs/superpowers/plans/2026-10-12-teams-ai-76-docs-sync-after-refinement.md`), and plan 50's principle "A frozen spec never mutates".

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green.
- `server/refine/coverage.ts` stays browser-safe: no `node:` import and only type imports of the contracts.
- Do not edit `server/refine/registry.ts` or `test/api/refine-api.test.ts`: another session has uncommitted work in them.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A new backlog draft over a delivered item: its spec stays byte for byte, and no `spec` or `preplan` call names it.
2. The same draft reaches `ready` although the delivered item has no pre-plan for its current revision.
3. The program: the delivered item starts done, its dependents run, and it never runs again.
4. An item still running, paused or awaiting validation: the start is refused with its status named, before the session takes its start lock.
5. Every item already delivered: the start is refused with that reason, instead of "o programa não iniciou nenhuma run".

## Limits

- An item whose key changed in the new outline is a new item; matching items to existing specs across drafts is R11.7.3 and R11.7.5.
- A delivered item whose sources changed is not reported yet; R11.7.4 proposes its adjustment spec.
- No backlog project is on disk to probe; the tests reproduce a fresh draft over a delivered item instead.

---

### Task 1: Detailing and coverage leave a started or delivered spec alone

**Files:**
- Modify: `server/refine/coverage.ts` (`isStarted`, `coverageGaps`)
- Modify: `server/refine/detail-cycle.ts` (`detail`)
- Test: `test/refine/coverage.test.ts`
- Test: `test/refine/detail-cycle.test.ts`

**Interfaces:**
- Produces: `isStarted(status: SpecStatus): boolean` in `server/refine/coverage.ts`, true for `running`, `paused:quota`, `paused:auth`, `awaiting-validation` and `done`.

- [ ] **Step 1: Write the failing tests**

In `test/refine/coverage.test.ts`, inside `describe('coverageGaps')`:

```ts
  // R11.7.2: a started or delivered spec was planned by its own run, so it needs no pre-plan in a later draft.
  it('counts a started or delivered spec as covered without a pre-plan', () => {
    const caso = specRow('caso', ['AC-048']);
    const done = { ...caso, spec: { ...caso.spec, status: 'done' as const } };
    expect(coverageGaps(backlog({ specs: { opme: specRow('opme', ['AC-047']), caso: done }, preplans: { opme: preplanRow([['P1', ['AC-047']]]) } }))).toEqual([]);
  });
```

In `test/refine/detail-cycle.test.ts`, inside `describe('backlog detailing failure paths')`:

```ts
  // R11.7.2: a new backlog draft over a delivered item never re-derives nor rewrites its spec.
  it('keeps an item whose spec on main started or was delivered exactly as it is, and still reaches ready', async () => {
    const { journal, run, itemDir, agent } = await detailed();
    const delivered = { specId: 'big-001-caso', specVersion: 2, specHash: H, type: 'feature', objectives: ['Entregar caso'], features: ['caso'], acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w caso', then: 't1', smoke: true }], outOfScope: [], externalDependencies: [], status: 'done', validationReports: [] };
    await mkdir(itemDir('caso'), { recursive: true });
    await writeFile(`${itemDir('caso')}/spec.json`, JSON.stringify(delivered));
    await run(agent, 2);
    const detailing = agent.calls.filter((c) => c.kind === 'spec' || c.kind === 'preplan');
    expect(detailing.length).toBeGreaterThan(0);
    expect(detailing.some((c) => c.feedback.includes('## Item caso:') || c.feedback.includes('## Spec caso:'))).toBe(false);
    expect(JSON.parse(await readFile(`${itemDir('caso')}/spec.json`, 'utf8'))).toEqual(delivered);
    expect(journal.state.backlog?.specs?.caso?.spec?.status).toBe('done');
    expect(journal.state.status).toBe('ready');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/coverage.test.ts test/refine/detail-cycle.test.ts`
Expected: FAIL. Coverage reports `item caso: sem pré-plano válido`, and detailing sends `caso` to the `spec` step and rewrites its file as `planned`.

- [ ] **Step 3: Implement**

In `server/refine/coverage.ts`, add `import type { SpecStatus } from '../contracts/spec.js';` and, above `byRank`:

```ts
/** A spec whose run started (running, paused, awaiting validation or done): refinement never touches it again (R11.7.2). */
export const isStarted = (status: SpecStatus): boolean => status !== 'refining' && status !== 'planned';
```

In `coverageGaps`, right after `if (!spec?.spec) { gaps.push(`item ${item.key}: sem spec válida`); continue; }` add:

```ts
    // A started or delivered spec was planned by its own run; it needs no pre-plan here.
    if (isStarted(spec.spec.status)) continue;
```

In `server/refine/detail-cycle.ts`, add `import { isStarted } from './coverage.js';`, and right after the line `for (const i of items) previous.set(i.key, specs[i.key]?.spec ?? (await readItemSpec(draft, idOf(i.key))));` add:

```ts
  // R11.7.2: an item whose spec on main started or was delivered is kept as it is; only a newer delivery is recorded again.
  const kept = new Set<string>();
  for (const i of items) {
    const onDisk = await readItemSpec(draft, idOf(i.key));
    if (!onDisk || !isStarted(onDisk.status)) continue;
    kept.add(i.key);
    const rev = computeSpecHash(onDisk);
    if (specs[i.key]?.rev === rev && specs[i.key]?.spec?.status === onDisk.status) continue;
    specs[i.key] = { inputHash: specHash.get(i.key)!, specId: onDisk.specId, rev, spec: onDisk, issues: [], cycle };
    await journal.fact(RefineEvent.SpecDerived, { cycle, key: i.key, specId: onDisk.specId, inputHash: specHash.get(i.key), rev, spec: onDisk, issues: [], highWater });
  }
```

Then exclude kept items from both work lists:

```ts
  const specTodo = items.filter((i) => !kept.has(i.key) && (!specs[i.key] || specs[i.key]!.inputHash !== specHash.get(i.key) || specs[i.key]!.spec === null));
```

```ts
  const preplanTodo = items.filter((i) => !kept.has(i.key) && planHash.has(i.key) && (!preplans[i.key] || preplans[i.key]!.inputHash !== planHash.get(i.key) || preplans[i.key]!.preplan === null));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/coverage.test.ts test/refine/detail-cycle.test.ts`
Expected: PASS, including the browser-safety test of `coverage.ts`.

- [ ] **Step 5: Commit**

```bash
git add server/refine/coverage.ts server/refine/detail-cycle.ts test/refine/coverage.test.ts test/refine/detail-cycle.test.ts
git commit -m "feat(refine): backlog detailing keeps a started or delivered spec as it is"
```

### Task 2: The program starts a delivered item done and refuses work in flight

**Files:**
- Modify: `server/program/controller.ts` (`ProgramEntry.done`, `newProgram`)
- Modify: `server/refine/session.ts` (`programEntries`, `freezeProgram`)
- Test: `test/program/controller.test.ts`
- Test: `test/refine/session.test.ts`

**Interfaces:**
- Consumes: `isStarted` from Task 1.
- Produces: `ProgramEntry.done?: boolean`; `programEntries(draftId: string, backlog: BacklogState): ProgramEntry[]` exported from `server/refine/session.ts`.

- [ ] **Step 1: Write the failing tests**

In `test/program/controller.test.ts`, inside `describe('program controller')`:

```ts
  // R11.7.2: an item delivered before this program starts done, so its dependents run and it never runs again.
  it('starts an item delivered before the program as done and runs its dependents', async () => {
    const { fx, calls } = world();
    let p = newProgram('d', [{ ...entry('a', 1), done: true }, entry('b', 2, ['a'])], NOW);
    expect(status(p)).toEqual({ a: 'done', b: 'pending' });
    expect('done' in p.items[0]!).toBe(false);
    p = await tick(p, fx, save);
    expect(calls).toEqual(['start d-b']);
  });
```

In `test/refine/session.test.ts`, change the session import to `import { ConflictError, programEntries, RefineSession } from '../../server/refine/session.js';`, add `import type { BacklogState } from '../../server/refine/state.js';`, and append:

```ts
// R11.7.2: a program never runs again what an earlier one delivered, and never starts over work still in flight.
describe('programEntries', () => {
  const item = (key: string, rank: number, dependsOn: string[] = []) => ({ key, title: key, epic: 'e', priority: 'P1', rank, size: 'M', scope: 's', rationale: 'r', dependsOn, sources: [] });
  const backlog = (login: string, cart: string) =>
    ({ epics: [], keyIds: true, items: [item('login', 1), item('cart', 2, ['login'])], specs: { login: { spec: { status: login } }, cart: { spec: { status: cart } } } }) as unknown as BacklogState;

  it('starts a delivered item done and every other one pending', () => {
    expect(programEntries('shop', backlog('done', 'planned'))).toEqual([
      { specId: 'login', key: 'login', rank: 1, dependsOn: [], done: true },
      { specId: 'cart', key: 'cart', rank: 2, dependsOn: ['login'] },
    ]);
  });

  it('refuses while an item is running, paused or awaiting validation, and when nothing is left to deliver', () => {
    expect(() => programEntries('shop', backlog('awaiting-validation', 'planned'))).toThrow(/login está awaiting-validation/);
    expect(() => programEntries('shop', backlog('paused:quota', 'planned'))).toThrow(ConflictError);
    expect(() => programEntries('shop', backlog('done', 'done'))).toThrow(/já foram entregues/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/program/controller.test.ts test/refine/session.test.ts`
Expected: FAIL. The controller starts `d-a` again, and `programEntries` is not exported yet.

- [ ] **Step 3: Implement**

In `server/program/controller.ts`, add to `ProgramEntry`:

```ts
  /** Delivered before this program (R11.7.2): it starts done and never runs again. */
  done?: boolean;
```

and replace the `items` line of `newProgram` with:

```ts
  const items = [...entries].sort((a, b) => a.rank - b.rank).map(({ done, ...e }): ProgramItem => ({ ...e, dependsOn: [...e.dependsOn], status: done ? 'done' : 'pending', runId: null, completeRunId: null, startedAt: null, finishedAt: done ? now.toISOString() : null, reason: done ? 'entregue antes deste programa' : null, resumes: 0, costUsd: null }));
```

In `server/refine/session.ts`, add `import { isStarted } from './coverage.js';` and `type BacklogState` to the import from `./state.js`, and add above the `RefineSession` class:

```ts
/** R11.7.2: the program's entries; a delivered item starts done, and work still in flight or nothing left to deliver refuses the start. */
export function programEntries(draftId: string, backlog: BacklogState): ProgramEntry[] {
  const entries = buildSpecsIndex(draftId, backlog).specs.map((s): ProgramEntry => {
    const status = backlog.specs?.[s.key]?.spec?.status;
    if (status && isStarted(status) && status !== 'done') throw new ConflictError(`A spec ${s.specId} está ${status}; termine ou valide essa entrega antes de iniciar este programa.`);
    return { specId: s.specId, key: s.key, rank: s.rank, dependsOn: s.dependsOn, ...(status === 'done' ? { done: true } : {}) };
  });
  if (entries.every((e) => e.done)) throw new ConflictError('Todas as specs deste backlog já foram entregues; não há nada para iniciar.');
  return entries;
}
```

In `freezeProgram`, replace

```ts
    this.starting = true;
    return buildSpecsIndex(this.deps.draft.specId, backlog).specs.map((s) => ({ specId: s.specId, key: s.key, rank: s.rank, dependsOn: s.dependsOn }));
```

with

```ts
    // Built before the start lock, so a refused start leaves the session free to try again.
    const entries = programEntries(this.deps.draft.specId, backlog);
    this.starting = true;
    return entries;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/program/controller.test.ts test/refine/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check, in a clean worktree**

The working tree holds another session's uncommitted changes, so verify the branch alone: `git worktree add --detach <scratch>/verify-77 HEAD`, link `node_modules` and `web/node_modules` from the main worktree, then run `npx vitest run`, `npx tsc --noEmit -p .` and `(cd web && npx vitest run)` there, and remove the worktree.
Expected: every test passes (4 skipped), no type errors, web green.

- [ ] **Step 6: Commit**

```bash
git add server/program/controller.ts server/refine/session.ts test/program/controller.test.ts test/refine/session.test.ts
git commit -m "feat(program): a delivered item starts done and work in flight refuses a new program"
```

### Task 3: Record R11.7.2 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R11.7)
- Modify: `docs/superpowers/plans/README.md` (row 77)

- [ ] **Step 1: Update the roadmap**

Change the R11.7 heading's status note to `slices 1 and 2 of 6 built` and add after the R11.7.1 lines:

```markdown
- Built R11.7.2 (plan 77): backlog detailing keeps a spec whose run started or was delivered exactly as it is, with no `spec` or `preplan` step and no file written, and coverage counts it without a pre-plan; a new program starts such a `done` item done, and refuses to start while an item is running, paused or awaiting validation, or when every item was delivered (`isStarted`, `programEntries`). Before it, a new backlog draft rewrote a delivered spec as `planned` version 0 and Phase 0 published it over the delivered one.
```

- [ ] **Step 2: Add the plans index row**

```markdown
| 77 | [`2026-10-12-teams-ai-77-started-specs-never-rederived.md`](2026-10-12-teams-ai-77-started-specs-never-rederived.md) | Done — a started or delivered spec is never re-derived, and a new program never runs it again; ROADMAP R11.7.2. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.7.2 started specs are never re-derived"
```
