# Plan 80 - Items that leave the backlog leave main (R11.7.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a planned item that leaves the backlog is retired on main, and a started or delivered one never leaves on its own: it stays, and the owner decides through an adjustment whether it goes.

**Architecture:** the spec gets the status `retired`, which never runs. When a new outline drops an item whose spec main has planned, the outline step puts main's folder back in the draft with that status, so the next start's Phase 0 publishes it, and `specs.json` no longer lists it. An item whose spec on main started (an adjustment included) stays in the outline even when the PO drops it, so an owner who removes the approval section of a started adjustment no longer drops that adjustment either. When every section such an item cites left the docs, the R11.7.4 approval asks whether an adjustment removes the feature. Phase 0 never replaces the folder of a spec main started or delivered: another program may have started it after this draft retired it.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest, React with Testing Library.

**Spec:** plan 76, design R11.7.5 (`docs/superpowers/plans/2026-10-12-teams-ai-76-docs-sync-after-refinement.md`): "An item dropped from the outline whose spec on main is `planned` gets the new status `retired` and leaves `specs.json`; a started or delivered one is never retired on its own: the PO asks the owner whether the feature stays or an adjustment removes it." This plan follows the design presented to the owner on 2026-10-12: the orchestrator keeps the started item, and the R11.7.4 approval patch is the question.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- What the owner reads is in Brazilian Portuguese.
- The worktree is shared with other sessions: commit with an explicit pathspec (`git commit -m ... -- <files>`), never a bare `git commit`, and verify in a clean worktree.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A new draft over main drops a planned item: main has that spec `retired` after the next start, and `specs.json` no longer lists it; a dropped item main never had just leaves the draft.
2. An older draft's program starts a spec while a newer draft retires it: Phase 0 of the newer draft keeps main's started folder, status and files.
3. A delivered item whose sections left the docs stays in the outline with its dependents' order, and the owner gets one removal approval; rejecting keeps it, accepting derives a removal adjustment.
4. A started adjustment whose approval section the owner removed stays, and a later approved adjustment of the same original comes after it.
5. A project with a retired spec: the projects list still parses it and shows it as `retirada`, and it can never be frozen or run.

## Limits

- A retirement reaches main only with the next start's Phase 0, so a backlog with nothing left to run never publishes it.
- A spec started on main after a newer draft dropped it keeps main's folder, but the `specs.json` that draft publishes no longer lists it.
- A started item the PO merged into another item, with sections that did not change, stays as it is with no question, and the new item may cover what it delivered.
- Spec ids from drafts made before readable ids (`<draft>-<key>`) do not match a newer draft's keys, as in R11.7.2 and R11.7.3.

---

### Task 1: The `retired` status

**Files:**
- Modify: `server/contracts/spec.ts` (`SpecStatus`)
- Modify: `web/src/pages/project-shared.tsx` (`LABEL`)
- Test: `test/contracts/contracts.test.ts`, `web/src/pages/project-shared.test.tsx` (new)

**Interfaces:**
- Produces: `SpecStatus` includes `'retired'`; `freezeSpec` refuses it, as it refuses every status but `refining` and `planned`.

- [ ] **Step 1: Write the failing tests**

In `test/contracts/contracts.test.ts`, add inside `describe('Spec')`, after `'refuses to freeze a spec that is neither refining nor planned'`:

```ts
  it('parses a spec retired from the backlog, which can never be frozen (R11.7.5)', () => {
    const retired = makeSpec({ status: 'retired' });
    expect(retired.status).toBe('retired');
    expect(() => freezeSpec(retired)).toThrow(SpecFrozenError);
  });
```

Create `web/src/pages/project-shared.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { chip } from './project-shared.js';

describe('chip', () => {
  it('names a spec retired from the backlog in Portuguese (R11.7.5)', () => {
    render(chip('retired'));
    expect(screen.getByText('retirada')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/contracts/contracts.test.ts` and `(cd web && npx vitest run src/pages/project-shared.test.tsx)`
Expected: FAIL. `retired` is not a spec status, and the chip shows `retired`.

- [ ] **Step 3: Implement**

In `server/contracts/spec.ts`, add to `SpecStatus` after `'done',`:

```ts
  /** R11.7.5: a planned spec whose item left the backlog; it never runs. */
  'retired',
```

In `web/src/pages/project-shared.tsx`, in `LABEL`, change `planned: 'planejada',` to `planned: 'planejada', retired: 'retirada',`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/contracts/contracts.test.ts` and `(cd web && npx vitest run src/pages/project-shared.test.tsx)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(contracts): a spec retired from the backlog has its own status and never runs" -- server/contracts/spec.ts web/src/pages/project-shared.tsx test/contracts/contracts.test.ts web/src/pages/project-shared.test.tsx
```

(`git add` the new test file first: a pathspec commit only takes files git already tracks or that are staged.)

### Task 2: A planned item that leaves the outline is retired on main

**Files:**
- Modify: `server/refine/detail-cycle.ts` (`removeRetired` becomes `retireDropped`)
- Modify: `server/refine/cycle.ts` (the backlog branch of `runCycleSteps`)
- Modify: `server/orchestrator/phases/bootstrap.ts` (`runPhase0`)
- Test: `test/refine/detail-cycle.test.ts`, `test/orchestrator/phase0.test.ts`

**Interfaces:**
- Consumes: `'retired'` in `SpecStatus` (Task 1).
- Produces: `retireDropped(draft: Draft, specIds: readonly string[]): Promise<void>`; in `cycle.ts`, `last` (the outline the PO was shown, adjustments included) and `idOf(key)`, which Task 3 reuses.

- [ ] **Step 1: Write the failing tests**

In `test/refine/detail-cycle.test.ts`, replace the helper `deliveredThenChanged` with:

```ts
  // Main's copy of an item spec moved on, as a program of the first draft would leave it.
  const markStatus = async (d: Env, key: string, status: string) => {
    const file = `${d.draft.base}/specs/big-001-${key}/spec.json`;
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status, specVersion: 1, specHash: H }));
  };
  // R11.7.4: main delivered `opme`, and later its cited flow section changed.
  const deliveredThenChanged = async (d: Env) => {
    await markStatus(d, 'opme', 'done');
    await writeFile(d.draft.flowMd, FLOW.replace('C --> D', 'C --> D2[Cotação]'));
  };
  const withoutFat = (d: Env) => writeFile(d.draft.flowMd, FLOW.replace('%% 4. Faturamento\n  D --> E\n', ''));
```

In the test `'brings back the files of an item dropped and added again in the same draft'`, replace `expect(await exists(fat)).toBe(false);` with `expect(JSON.parse(await readFile(fat, 'utf8')).status).toBe('retired');` and `expect(await exists(fat)).toBe(true);` with `expect(JSON.parse(await readFile(fat, 'utf8')).status).toBe('planned');`.

Then add after the R11.7.4 tests:

```ts
  // R11.7.5: an item that leaves the outline leaves main too, as a retired spec Phase 0 publishes.
  it('retires a planned item the new outline dropped, and leaves it out of specs.json', async () => {
    const { second } = await secondDraft(withoutFat, fakeAgent(() => OUTLINE.filter((i) => i.key !== 'fat')));
    expect(JSON.parse(await readFile(`${second.itemDir('fat')}/spec.json`, 'utf8')).status).toBe('retired');
    expect(JSON.parse(await readFile(`${second.docs}/specs.json`, 'utf8')).specs.map((s: { key: string }) => s.key)).toEqual(['caso', 'triagem', 'opme']);
    expect(second.journal.state.status).toBe('ready');
  });
```

In `test/orchestrator/phase0.test.ts`, add inside `describe('a draft with a base copy')`:

```ts
    // R11.7.5: a retirement reaches main, but never over a spec another program started meanwhile.
    it('publishes a retired spec, and never replaces the folder of a spec main started or delivered', { timeout: 60_000 }, async () => {
      const at = (status: string) => `${JSON.stringify({ specId: 'x', status }, null, 2)}\n`;
      const run = await setup(
        { 'specs/old/spec.json': at('planned'), 'specs/busy/spec.json': at('running'), 'specs/busy/spec.md': 'main\n' },
        { 'specs/old/spec.json': at('planned'), 'specs/busy/spec.json': at('planned'), 'specs/busy/spec.md': 'base\n' },
        { 'specs/old/spec.json': at('retired'), 'specs/busy/spec.json': at('retired'), 'specs/busy/spec.md': 'draft\n' },
      );
      expect(await run.executePhase0()).toEqual({ ok: true });
      expect(JSON.parse(await show('specs/old/spec.json')).status).toBe('retired');
      expect(JSON.parse(await show('specs/busy/spec.json')).status).toBe('running');
      expect(await show('specs/busy/spec.md')).toBe('main');
      await run.close();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/detail-cycle.test.ts test/orchestrator/phase0.test.ts`
Expected: FAIL. A new draft keeps the dropped item's folder `planned`, and Phase 0 merges the draft's retired copy into main's started spec.

- [ ] **Step 3: Implement**

In `server/refine/detail-cycle.ts`, replace `removeRetired` (its comment and body) with:

```ts
/**
 * The items a new outline dropped (R11.7.5): a spec main has planned gets main's folder back with the status `retired`,
 * which Phase 0 publishes; any other folder of theirs leaves the draft. Ids come from state and the outline the PO was
 * shown, never from a scan of main's spec dirs.
 */
export async function retireDropped(draft: Draft, specIds: readonly string[]): Promise<void> {
  for (const specId of specIds) {
    const onMain = await readMainSpec(draft, specId);
    if (onMain?.status === 'planned' || onMain?.status === 'refining') {
      await restoreFromBase(draft, specId);
      await fs.writeFile(path.posix.join(itemDir(draft, specId), 'spec.json'), json({ ...onMain, status: 'retired' }));
    } else await fs.rm(itemDir(draft, specId), { recursive: true, force: true, maxRetries: 3 });
  }
}
```

In `server/refine/cycle.ts`, import `retireDropped` instead of `removeRetired` from `./detail-cycle.js` and `specIdOf` from `./specs-index.js`. After the line `const previous = last && { ...last, items: last.items.filter((i) => !isAdjustment(i.key)) };`, add:

```ts
      const idOf = (key: string) => before?.specs?.[key]?.specId ?? specIdOf(draft.specId, key, before?.keyIds);
```

and replace

```ts
      await removeRetired(draft, before, ranked.items);
```

with

```ts
      const keys = new Set(ranked.items.map((i) => i.key));
      await retireDropped(draft, [...new Set([...Object.keys(before?.specs ?? {}), ...(last?.items ?? []).map((i) => i.key)])].filter((k) => !keys.has(k)).map(idOf));
```

keeping the comment above it.

In `server/orchestrator/phases/bootstrap.ts`, add `import { isStarted } from '../../refine/coverage.js';`, add after the `read` helper:

```ts
/** Whether main's copy of a spec says its run started or it was delivered (R11.7.5). */
async function startedOnMain(specJson: string): Promise<boolean> {
  try {
    return isStarted((JSON.parse((await read(specJson)) ?? '{}') as { status?: string }).status);
  } catch {
    return false;
  }
}
```

and in `runPhase0`, right after `if (!rel.startsWith(own)) {`, add:

```ts
      // A spec main started or delivered keeps main's folder: no draft copy, a retired one included, replaces it.
      const folder = /^specs\/([^/]+)\//.exec(rel)?.[1];
      if (folder && (await startedOnMain(path.join(wt, 'docs', 'specs', folder, 'spec.json')))) continue;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/detail-cycle.test.ts test/orchestrator/phase0.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(refine): a planned item that leaves the outline is retired on main, and Phase 0 never replaces a started spec" -- server/refine/detail-cycle.ts server/refine/cycle.ts server/orchestrator/phases/bootstrap.ts test/refine/detail-cycle.test.ts test/orchestrator/phase0.test.ts
```

### Task 3: A started item stays, and the owner decides whether an adjustment removes it

**Files:**
- Modify: `server/refine/backlog.ts` (`postProcessBacklog`)
- Modify: `server/refine/adjustments.ts` (`adjustmentItems`, `DueAdjustment`, `adjustmentsDue`, `approvalPatch`)
- Modify: `server/refine/cycle.ts` (the backlog branch of `runCycleSteps`)
- Test: `test/refine/backlog-derive.test.ts`, `test/refine/adjustments.test.ts`, `test/refine/detail-cycle.test.ts`

**Interfaces:**
- Consumes: `last` and `idOf` in `cycle.ts`, and `markStatus` and `withoutFat` in the cycle tests (Task 2).
- Produces: `postProcessBacklog(out, previous, flow, approved = [], started: readonly BacklogItem[] = [])`; `DueAdjustment.removed?: true` when every section the spec cites, its approval aside, left the docs.

- [ ] **Step 1: Write the failing tests**

In `test/refine/backlog-derive.test.ts`, add inside `describe('postProcessBacklog')`:

```ts
  // R11.7.5: a started item never leaves on its own; the owner decides through an adjustment whether it goes.
  it('keeps a started item the agent dropped, with only the dependencies still in the outline', () => {
    const out = postProcessBacklog(raw([item('opme'), item('caso', { title: 'reescrito' })]), null, '', [], [item('fat', { dependsOn: ['opme', 'antigo'] }), item('caso')]);
    expect(out.ok && out.value.backlog.items.map((i) => [i.key, i.title, i.dependsOn])).toEqual([['opme', 'Item opme', []], ['caso', 'reescrito', []], ['fat', 'Item fat', ['opme']]]);
  });

  it('keeps a started adjustment whose approval is gone, and puts a later approved one after it', () => {
    const out = postProcessBacklog(raw([item('opme')]), null, '', ['opme-ajuste-2'], [item('opme-ajuste-1', { title: 'Ajuste 1: Item opme', dependsOn: ['opme'] })]);
    expect(out.ok && out.value.backlog.items.map((i) => [i.key, i.dependsOn])).toEqual([['opme', []], ['opme-ajuste-1', ['opme']], ['opme-ajuste-2', ['opme-ajuste-1']]]);
  });
```

In `test/refine/adjustments.test.ts`, add inside `describe('adjustments due')`:

```ts
  // R11.7.5: a started item whose sections left the docs stays; the owner decides whether an adjustment removes it.
  it('asks to remove the feature when every section it cites left the docs, its approval aside', () => {
    const gone = { ...before, 'flow.md': before['flow.md'].replace('%% 3. OPME\n  C --> D\n', '') };
    const [due] = adjustmentsDue({ items: [{ ...opme, rank: 1 }], specs: { opme: started('opme', opme, before, 'done') } }, gone, []);
    expect(due).toMatchObject({ key: 'opme-ajuste-1', removed: true, changed: ['flow.md › 3. OPME'] });
    expect(approvalPatch(due!).reason).toMatch(/saíram dos documentos/);
    expect(approvalPatch(due!).replace).toMatch(/remove essa funcionalidade/);
    const approved = '# Briefing\n\n## Ajuste aprovado: opme-ajuste-1\n\ntexto\n';
    const [first] = adjustmentItems([opme], ['opme-ajuste-1']);
    const rows = { opme: started('opme', opme, before, 'done'), 'opme-ajuste-1': started('opme-ajuste-1', first!, { ...before, 'briefing.md': approved }, 'done') };
    expect(adjustmentsDue({ items: [{ ...opme, rank: 1 }, { ...first!, rank: 2 }], specs: rows }, { ...gone, 'briefing.md': approved }, [])).toMatchObject([{ key: 'opme-ajuste-2', removed: true }]);
  });
```

In `test/refine/detail-cycle.test.ts`, let `secondDraft` prepare the first draft: change its signature to `async (change?: (second: Env) => Promise<unknown>, agent = fakeAgent(() => OUTLINE), prepare?: (first: Env) => Promise<unknown>)` and add `if (prepare) await prepare(first);` right after `const first = await setup();`. Then add after the Task 2 test:

```ts
  it('keeps a delivered item whose sections left the docs, and asks the owner whether an adjustment removes it', async () => {
    const { second } = await secondDraft(async (d) => {
      await markStatus(d, 'fat', 'done');
      await withoutFat(d);
    }, fakeAgent(() => OUTLINE.filter((i) => i.key !== 'fat')));
    expect(second.journal.state.backlog!.items.find((i) => i.key === 'fat')).toMatchObject({ dependsOn: ['opme'] });
    expect(second.journal.state.backlog!.specs?.fat?.spec?.status).toBe('done');
    expect(approvals(second)).toEqual([expect.objectContaining({ status: 'pending', replace: expect.stringMatching(/^## Ajuste aprovado: fat-ajuste-1\n[\s\S]*remove essa funcionalidade/) })]);
  });

  it('keeps a started adjustment whose approval section the owner removed', async () => {
    const approve = (d: Env) => writeFile(d.draft.briefingMd, '# Briefing\n\n## Objectives\n\n- tudo\n\n## Ajuste aprovado: opme-ajuste-1\n\ntexto\n');
    const { second } = await secondDraft((d) => markStatus(d, 'opme-ajuste-1', 'running'), fakeAgent(() => OUTLINE), approve);
    expect(second.journal.state.backlog!.items.find((i) => i.key === 'opme-ajuste-1')).toMatchObject({ dependsOn: ['opme'] });
    expect(second.journal.state.backlog!.specs?.['opme-ajuste-1']?.spec?.status).toBe('running');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/backlog-derive.test.ts test/refine/adjustments.test.ts test/refine/detail-cycle.test.ts`
Expected: FAIL. A started item the agent dropped leaves the outline, a later adjustment depends on the original instead of the kept one, and the approval for a vanished feature talks about changes.

- [ ] **Step 3: Implement**

In `server/refine/adjustments.ts`, in `adjustmentItems`, replace the line `const after = out.filter((a) => rootOf(a.key) === original.key).at(-1)?.key ?? original.key;` with:

```ts
    const after = [...items, ...out].filter((a) => rootOf(a.key) === original.key && numberOf(a.key) < numberOf(key)).sort((a, b) => numberOf(a.key) - numberOf(b.key)).at(-1)?.key ?? original.key;
```

Add to `DueAdjustment`, after `changed`:

```ts
  /** R11.7.5: every section it cites, its approval aside, left the docs, so the adjustment removes the feature. */
  removed?: true;
```

In `adjustmentsDue`, replace its `return [{ key, specId: spec.specId, ... }];` line with:

```ts
    const cites = now.filter((s) => !approvalKey(s.heading));
    const removed = cites.length > 0 && cites.every((s) => s.hash === null);
    return [{ key, specId: spec.specId, status: spec.status, changed: (removed ? cites : now.filter((s) => !was.includes(hashOf(s)))).map((s) => `${s.doc} › ${s.heading}`), ...(removed ? { removed: true as const } : {}) }];
```

In `approvalPatch`, right after the `const changed = ...` line, add:

```ts
  if (due.removed) {
    return {
      find: '',
      replace: `## ${approvalHeading(due.key)}\n\nA spec ${due.specId} ${when} e depois as seções que ela cita saíram dos documentos (${changed}); este ajuste remove essa funcionalidade.\n`,
      reason: `As seções que a spec ${due.specId} cita saíram dos documentos depois que ela ${when}: ${changed}. Aceite para aprovar a spec de ajuste ${due.key}, que remove essa funcionalidade; rejeite para mantê-la como está.`,
    };
  }
```

In `server/refine/backlog.ts`, change `postProcessBacklog`'s comment and signature to:

```ts
/** The orchestrator, not the agent, owns key stability, validity and rank, keeps every started item (R11.7.5) and adds the adjustments the owner approved (R11.7.4). */
export function postProcessBacklog(out: { project: unknown; backlog: unknown }, previous: BacklogState | null, flow: string, approved: readonly string[] = [], started: readonly BacklogItem[] = []): BacklogCheck {
```

and replace its last two lines (the comment and the `return { ok: true, ... }`) with:

```ts
  // A started item the agent dropped stays as it was, with only the dependencies still in the outline.
  const keys = new Set([...items, ...started].map((i) => i.key));
  const all = [...items, ...started.filter((s) => !items.some((i) => i.key === s.key)).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => keys.has(d)) }))];
  // Adjustments first: rank breaks ties by position, so each runs right after its original, before what waits on it.
  const adjustments = adjustmentItems(all, approved).filter((a) => !all.some((i) => i.key === a.key));
  return { ok: true, value: { project: project.data, backlog: { epics: backlog.data.epics, items: rankItems([...adjustments, ...all]) } } };
```

In `server/refine/cycle.ts`, add `isStarted` (from `./coverage.js`) and `readMainSpec` (from `./draft.js`) to the imports, add after the `idOf` line:

```ts
      // R11.7.5: an item of the last outline whose spec started on main stays even when the PO drops it.
      const started = (await Promise.all((last?.items ?? []).map(async (i) => (isStarted((await readMainSpec(draft, idOf(i.key)))?.status) ? [i] : [])))).flat();
```

and pass it: `postProcessBacklog(out.value as BacklogOutput, previous, docs['flow.md'], approvedAdjustments(docs['brief.md']), started)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/backlog-derive.test.ts test/refine/adjustments.test.ts test/refine/detail-cycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite, the type check and the web tests in a clean worktree**

`git worktree add --detach <scratch>/verify-80 HEAD` after committing, link `node_modules` and `web/node_modules`, run `npx vitest run`, `npx tsc --noEmit -p .` and `(cd web && npx vitest run)`, then remove the worktree.
Expected: every test passes (4 skipped), no type errors, web green.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(refine): a started item stays in the backlog, and the owner decides whether an adjustment removes it" -- server/refine/backlog.ts server/refine/adjustments.ts server/refine/cycle.ts test/refine/backlog-derive.test.ts test/refine/adjustments.test.ts test/refine/detail-cycle.test.ts
```

### Task 4: Record R11.7.5 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R11.7)
- Modify: `docs/superpowers/plans/README.md` (row 80)

- [ ] **Step 1: Update the roadmap**

Change the R11.7 heading's note to `plans 76 to 80, 2026-10-12; slices 1 to 5 of 6 built` and add after the `Review of R11.7.4` line:

```markdown
- Built R11.7.5 (plan 80): a planned item that leaves the backlog gets the status `retired` on main through the next start's Phase 0 and leaves `specs.json`, while a started or delivered one stays in the outline even when the PO drops it, and when every section it cites left the docs the owner is asked to approve an adjustment that removes it (`retireDropped`); Phase 0 never replaces the folder of a spec main started or delivered. Before it, a dropped item stayed `planned` on main forever, and a started one simply vanished from the backlog.
```

- [ ] **Step 2: Add the plans index row**

After row 79 of `docs/superpowers/plans/README.md`, add:

```markdown
| 80 | [`2026-10-12-teams-ai-80-retired-items-leave-main.md`](2026-10-12-teams-ai-80-retired-items-leave-main.md) | Done — a planned item that leaves the backlog is retired on main, and a started one stays until the owner approves its removal; ROADMAP R11.7.5. |
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(roadmap): R11.7.5 items that leave the backlog leave main" -- docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
```
