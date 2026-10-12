# Plan 78 - A new draft reuses what main already planned (R11.7.3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a new backlog draft derives again only the items whose sources changed; every other item keeps the spec and pre-plan main already has, with no agent call.

**Architecture:** in backlog detailing, an item with no row in the draft's journal (a new draft) whose spec on main (`readMainSpec`, plan 77) records the same input hash (`derivedFrom.inputHash`) as the item has now is reused: its row comes from main's spec, and main's `preplan.json` too when it was made for that spec revision and the current pre-plan inputs. Items reused this way are never written, so the run's Phase 0 publishes nothing for them.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** plan 76, design R11.7.3 (`docs/superpowers/plans/2026-10-12-teams-ai-76-docs-sync-after-refinement.md`), and plan 50's decision 5 ("specs not yet started are re-derived only where the source changed (by hash)").

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green.
- Do not edit files another session holds uncommitted (today `server/refine/registry.ts`, `test/api/refine-api.test.ts` and several web files); commit only this plan's files by name and verify in a clean worktree.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A new draft over unchanged docs: no `spec` or `preplan` call, and it reaches `ready`.
2. A new draft where one cited section changed: only that item is derived again.
3. Main's pre-plan made for another spec revision or other pre-plan inputs (stack.md changed, rank moved to first): the spec is reused but the pre-plan is made again.
4. A broken or missing `preplan.json` on main: the pre-plan is made again, the cycle does not fail.
5. A started or delivered item (plan 77) keeps its own handling, and a reused item is never written in the draft.

## Limits

- An item whose key changed in the new outline has no spec on main under its id, so it is derived as new; R11.7.5 handles the old one.
- `HASH_VERSION` bumps still re-derive every item once, as designed.

---

### Task 1: Reuse main's spec and pre-plan of an unchanged item

**Files:**
- Modify: `server/refine/detail-cycle.ts` (`detail`)
- Test: `test/refine/detail-cycle.test.ts` (`setup` takes an existing root; two tests)

**Interfaces:**
- Consumes: `readMainSpec(d: Draft, specId: string): Promise<Spec | null>` from `server/refine/draft.ts` (plan 77).

- [ ] **Step 1: Write the failing tests**

In `test/refine/detail-cycle.test.ts`, add `cp` to the `node:fs/promises` import, and let `setup` reuse a root: change `async function setup() {` to `async function setup(existing?: string) {` and its first line to `const root = existing ?? (await mkdtemp(path.join(os.tmpdir(), 'teams-ai-detail-'))).replace(/\\/g, '/');`. Then add, inside `describe('backlog detailing in the refinement cycle')`:

```ts
  // R11.7.3: a new draft over what main already planned derives nothing again unless a cited section changed.
  const secondDraft = async (change?: (flow: string) => string) => {
    const first = await setup();
    const agent1 = fakeAgent(() => OUTLINE);
    await first.run(agent1, 1);
    await first.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await first.run(agent1, 2);
    // Main as the first draft published it becomes the base copy of a new draft over the same folder.
    await cp(first.docs, first.draft.base!, { recursive: true });
    const second = await setup(first.draft.root);
    if (change) await writeFile(second.draft.flowMd, change(FLOW));
    const agent = fakeAgent(() => OUTLINE);
    await second.run(agent, 1);
    await second.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    const from = agent.calls.length;
    await second.run(agent, 2);
    return { second, detailing: agent.calls.slice(from).filter((c) => c.kind === 'spec' || c.kind === 'preplan') };
  };

  it("reuses main's spec and pre-plan of every item whose inputs did not change", async () => {
    const { second, detailing } = await secondDraft();
    expect(detailing).toEqual([]);
    expect(second.journal.state.status).toBe('ready');
    expect(Object.keys(second.journal.state.backlog?.preplans ?? {}).sort()).toEqual(['caso', 'fat', 'opme', 'triagem']);
  });

  it('derives again only the item whose cited section changed', async () => {
    const { second, detailing } = await secondDraft((flow) => flow.replace('C --> D', 'C --> D2[Cotação]'));
    expect(detailing.filter((c) => c.kind === 'spec').map((c) => [...c.feedback.matchAll(/^## Item ([a-z0-9-]+):/gm)].map((m) => m[1]))).toEqual([['opme']]);
    expect(second.journal.state.status).toBe('ready');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/detail-cycle.test.ts`
Expected: FAIL. The new draft sends every item to the `spec` and `preplan` steps.

- [ ] **Step 3: Implement**

In `server/refine/detail-cycle.ts`, add `import { Preplan } from '../contracts/preplan.js';` if missing (it is imported today), and right after the line `const planHashOf = (item: Item, rev: string) => preplanInputHash(item, rev, docs['stack.md'], item.rank === 1);` add:

```ts
  // R11.7.3: a new draft reuses main's spec of an item whose inputs did not change, and its pre-plan when still current.
  for (const i of items) {
    if (kept.has(i.key) || specs[i.key]) continue;
    const onMain = await readMainSpec(draft, idOf(i.key));
    if (!onMain || onMain.derivedFrom?.inputHash !== specHash.get(i.key)) continue;
    const rev = computeSpecHash(onMain);
    specs[i.key] = { inputHash: specHash.get(i.key)!, specId: onMain.specId, rev, spec: onMain, issues: [], cycle };
    await journal.fact(RefineEvent.SpecDerived, { cycle, key: i.key, specId: onMain.specId, inputHash: specHash.get(i.key), rev, spec: onMain, issues: [], highWater });
    const pre = Preplan.safeParse(draft.base ? await readJson(path.posix.join(draft.base, 'specs', onMain.specId, 'preplan.json')) : null);
    if (!pre.success || pre.data.specRev !== rev || pre.data.inputHash !== planHashOf(i, rev)) continue;
    preplans[i.key] = { inputHash: pre.data.inputHash, specRev: rev, preplan: pre.data, issues: [], cycle };
    await journal.fact(RefineEvent.PreplanDerived, { cycle, key: i.key, inputHash: pre.data.inputHash, specRev: rev, preplan: pre.data, issues: [] });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/detail-cycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite, the type check and the web tests in a clean worktree**

`git worktree add --detach <scratch>/verify-78 HEAD` after committing, link `node_modules` and `web/node_modules`, run `npx vitest run`, `npx tsc --noEmit -p .` and `(cd web && npx vitest run)`, then remove the worktree.
Expected: every test passes (4 skipped), no type errors, web green.

- [ ] **Step 6: Commit**

```bash
git add server/refine/detail-cycle.ts test/refine/detail-cycle.test.ts
git commit -m "feat(refine): a new backlog draft reuses main's spec and pre-plan of an unchanged item"
```

### Task 2: Record R11.7.3 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R11.7)
- Modify: `docs/superpowers/plans/README.md` (row 78)

- [ ] **Step 1: Update the roadmap**

Change the R11.7 heading's note to `plans 76 to 78, 2026-10-12; slices 1 to 3 of 6 built` and add after the R11.7.2 lines:

```markdown
- Built R11.7.3 (plan 78): a new backlog draft reuses main's spec of an item whose input hash did not change, and its pre-plan when it was made for that spec revision and the current pre-plan inputs, with no agent call and nothing written in the draft; before it, a new draft re-derived every item, since its own journal was empty.
```

- [ ] **Step 2: Add the plans index row**

```markdown
| 78 | [`2026-10-12-teams-ai-78-unchanged-items-reused.md`](2026-10-12-teams-ai-78-unchanged-items-reused.md) | Done — a new backlog draft derives again only the items whose sources changed; ROADMAP R11.7.3. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.7.3 a new draft reuses what main already planned"
```
