# Plan 68 - Backlog keys and dependencies hold (R11.5.3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a program built from a backlog starts the items that depend on others, and no two backlog items share a docs branch.

**Architecture:** two small fixes where the ids are made. `buildSpecsIndex` (`server/refine/specs-index.ts`) names each dependency with the same rule as its item, so the program controller finds the spec it waits for. `validateBacklog` (`server/validators/backlog.ts`) refuses a key that is another key plus a branch suffix, and the PO prompt states the rule, so the backlog step learns it before the validator has to reject it.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest.

**Spec:** plan 66 (`docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md`), section "Design", paragraph **R11.5.3 Backlog keys and dependencies hold**, and its "Where autonomy breaks today" bullet on backlog keys; roadmap item R11.5 in `docs/superpowers/ROADMAP.md`.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- Drafts made before readable ids (no `keyIds`) keep their `<draft>-<key>` ids, for items and dependencies alike: their specs already exist under those names.
- Validator messages stay in Brazilian Portuguese, as every other message of `validateBacklog`; agent prompts stay in English.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A draft with readable ids and a chain of dependencies (A, B after A, C after B): every `dependsOn` names a spec id the same index lists, so the program starts B once A is done and C once B is.
2. An older draft without `keyIds`: its dependencies keep the `<draft>-<key>` form, exactly as its items do.
3. A key equal to the draft id on a draft with readable ids: it falls back to `<draft>-<key>`, and a dependency that names it falls back the same way.
4. Keys that only look like a suffix when alone (`pricing-plan` with no `pricing`, `daily-report`): accepted, since they share no branch with anything.
5. A service's workflows branch (`docs/<spec>-<service>-workflows`): a key such as `pricing-orders-workflows` next to `pricing` is refused.

## Limits

- The validator sees one backlog. A key that collides with a spec made outside it (a single spec created by hand, or the draft's own branches) is not caught here; the backlog keeps the keys of every item that still exists, so the common case, sibling keys, is covered.

---

### Task 1: Dependencies use the same spec ids as their items

**Files:**
- Modify: `server/refine/specs-index.ts:46`
- Test: `test/refine/specs-index.test.ts`

**Interfaces:**
- Consumes: `specIdOf(draftId, key, keyIds?)` (unchanged).
- Produces: `buildSpecsIndex(...).specs[n].dependsOn`, now in the same id form as `specs[n].specId`.

- [ ] **Step 1: Write the failing test**

Add to `describe('buildSpecsIndex', ...)` in `test/refine/specs-index.test.ts`:

```ts
  it('names each dependency by the same rule as its item, so the program finds the spec it waits for', () => {
    const at = (key: string, rank: number, dependsOn: string[] = []) => ({ key, title: 't', epic: 'e', scope: 's', priority: 'P1' as const, rationale: 'r', dependsOn, sources: [], size: 'M' as const, rank });
    const items = [at('user-login', 1), at('order-checkout', 2, ['user-login']), at('order-service', 3), at('order-tracking', 4, ['order-checkout', 'order-service'])];
    const readable = buildSpecsIndex('order-service', { epics: [], items, keyIds: true });
    expect(readable.specs.map((s) => [s.specId, s.dependsOn])).toEqual([
      ['user-login', []],
      ['order-checkout', ['user-login']],
      // A key equal to the draft id keeps the draft prefix, for itself and for whoever depends on it.
      ['order-service-order-service', []],
      ['order-tracking', ['order-checkout', 'order-service-order-service']],
    ]);
    const older = buildSpecsIndex('shop-001', { epics: [], items: items.slice(0, 2) });
    expect(older.specs.map((s) => [s.specId, s.dependsOn])).toEqual([['shop-001-user-login', []], ['shop-001-order-checkout', ['shop-001-user-login']]]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/refine/specs-index.test.ts`
Expected: FAIL; the readable-ids dependencies come out as `order-service-user-login` and the like, while the item ids are the bare keys.

- [ ] **Step 3: Implement**

In `server/refine/specs-index.ts`, change line 46 to:

```ts
      dependsOn: i.dependsOn.map((d) => specIdOf(draftId, d, backlog.keyIds)),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/refine test/program && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/refine/specs-index.ts test/refine/specs-index.test.ts
git commit -m "fix(backlog): a dependency names the spec id its item really has

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: No key shares a docs branch with another

**Files:**
- Modify: `server/validators/backlog.ts` (constants at the top, the second loop over `backlog.items`)
- Modify: `.claude/agents/po.md:33` (the key rule)
- Test: `test/validators/backlog.test.ts`, `test/agents/prompts.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the validator message `chave <key>: o branch docs/<key> já é um branch do spec <owner>; escolha outra chave`.

- [ ] **Step 1: Write the failing tests**

Add to `describe('validateBacklog', ...)` in `test/validators/backlog.test.ts`:

```ts
  it('rejects a key that is another key plus a branch suffix, since both specs would share that docs branch', () => {
    for (const key of ['pricing-plan', 'pricing-v2', 'pricing-report', 'pricing-done', 'pricing-readme', 'pricing-workflows', 'pricing-orders-workflows']) {
      expect(check(backlog([item('pricing', { priority: 'P0' }), item(key)])), key).toEqual(expect.arrayContaining([`chave ${key}: o branch docs/${key} já é um branch do spec pricing; escolha outra chave`]));
    }
  });

  it('accepts keys that only look like a branch suffix when no other key is their start', () => {
    expect(check(backlog([item('pricing-plan'), item('daily-report'), item('pricing-planner')]))).toEqual([]);
  });
```

Add to the `describe` of `test/agents/prompts.test.ts`:

```ts
  it('tell the PO that a key never extends another key with a branch suffix', () => {
    expect(agent('po')).toContain('A key never equals another key followed by `-plan`, `-report`, `-done`, `-readme`, `-workflows` or a version such as `-v2`');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/validators/backlog.test.ts test/agents/prompts.test.ts`
Expected: the suffix rejection case and the PO case FAIL; the "accepts" case passes already, since it pins what must stay allowed.

- [ ] **Step 3: Implement**

In `server/validators/backlog.ts`, add below `RESERVED_KEY`:

```ts
/** What follows `<spec>-` in a spec's docs branches: plan, report, done, readme, a version, or a service's workflows. */
const BRANCH_TAIL = /^(?:plan|report|done|readme|v\d+|(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?workflows)$/;
```

and inside the second `for (const i of backlog.items)` loop, before the `for (const d of i.dependsOn)` line:

```ts
    // Spec ids are the bare keys: `pricing` and `pricing-plan` would both own the branch docs/pricing-plan.
    const owner = backlog.items.find((o) => o.key !== i.key && i.key.startsWith(`${o.key}-`) && BRANCH_TAIL.test(i.key.slice(o.key.length + 1)));
    if (owner) errors.push(`chave ${i.key}: o branch docs/${i.key} já é um branch do spec ${owner.key}; escolha outra chave`);
```

In `.claude/agents/po.md`, append to the key rule on line 33, after "(`core`, `base`, `misc`).":

```md
 A key never equals another key followed by `-plan`, `-report`, `-done`, `-readme`, `-workflows` or a version such as `-v2`: both specs would share a docs branch (`pricing` and `pricing-plan` both own `docs/pricing-plan`).
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/validators test/agents test/refine && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/validators/backlog.ts .claude/agents/po.md test/validators/backlog.test.ts test/agents/prompts.test.ts
git commit -m "fix(backlog): no backlog key shares a docs branch with another

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Record R11.5.3 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (section `### R11.5 Autonomy hardening`, after the R11.5.2 lines)
- Modify: `docs/superpowers/plans/README.md` (the table, after row 67)

- [ ] **Step 1: Update the roadmap**

Add after the last R11.5.2 line:

```md
- Built R11.5.3 (plan 68): on a draft with readable ids each dependency names the spec id its item really has, so a program starts the items that depend on others (`buildSpecsIndex` mapped them to `<draft>-<key>` while the items were the bare keys, and the controller waited forever); a backlog key may not equal another key plus a docs branch suffix (`-plan`, `-report`, `-done`, `-readme`, `-workflows`, a service's workflows or a version), since both specs would share that branch (`validateBacklog`, the PO key rule).
```

- [ ] **Step 2: Update the plans index**

Add after row 67 of `docs/superpowers/plans/README.md`:

```md
| 68 | [`2026-10-12-teams-ai-68-backlog-keys-and-dependencies.md`](2026-10-12-teams-ai-68-backlog-keys-and-dependencies.md) | Done — dependencies name the spec ids their items really have, and no two backlog keys share a docs branch; ROADMAP R11.5.3. |
```

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.5.3 backlog keys and dependencies hold

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
