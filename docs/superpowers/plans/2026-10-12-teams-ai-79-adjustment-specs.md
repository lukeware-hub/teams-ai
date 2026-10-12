# Plan 79 - A change to a started spec becomes an adjustment the owner approves (R11.7.4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** when the sections a started or delivered spec cites change, the owner approves an adjustment spec `<key>-ajuste-<n>` in briefing.md, and the backlog derives and runs it after that spec, never rewriting what was delivered.

**Architecture:** after backlog detailing, the cycle compares the cited sections of each original's latest started spec (the original's own, or its last adjustment's) with the docs, by section hash. When they differ, the cycle proposes a PO patch that adds a `## Ajuste aprovado: <key>-ajuste-<n>` section at the end of briefing.md. A patch with an empty `find` appends, and a section added at the end changes the text of no section an item cites. Accepting that patch is the approval: the next outline gets the adjustment item from the orchestrator, never from the agent, placed after the spec it changes and citing its sections and its approval section. Detailing then derives the adjustment against the started specs it changes, and the program runs it after them. Rejecting keeps the spec as it is, and the same adjustment is not asked again in that draft.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** plan 76, design R11.7.4 (`docs/superpowers/plans/2026-10-12-teams-ai-76-docs-sync-after-refinement.md`); plan 50, decision 5 ("delivered specs produce an adjustment spec for approval") and its principles ("A frozen spec never mutates; drift on a started or delivered spec yields a new adjustment spec"; "The human's decisions ... are written in natural language in `briefing.md` (agents may propose them as the existing accept/reject patches)"). Refinement of plan 76, as presented to the owner on 2026-10-12: approval comes before derivation, through briefing.md, with no new screen or route. A declined adjustment then costs no agent call, and an adjustment nobody approved never exists for the program to run.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- What the owner reads (the patch reason and the approval section) is in Brazilian Portuguese; rules given to agents stay in English, like the rules around them.
- Commit only this plan's files by name, check `git status` for files another session holds before each commit, and verify in a clean worktree.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Before the owner decides, a delivered item whose cited section changed goes through several evaluations: it gets exactly one approval patch, never a duplicate, and after a rejection none again in that draft.
2. The owner accepts the approval while other briefing.md patches from the PO or SM are pending: every one of them still applies, and the approval section changes the text of no section an item cites.
3. A second change after the first adjustment was delivered asks for `<key>-ajuste-2`, which depends on `<key>-ajuste-1`; a change while the first adjustment is still planned derives that adjustment again instead of asking.
4. The PO's outline writes an adjustment item itself, or a previous backlog (main's or the draft's) holds one: the agent never sees or keeps it, and only the approvals in briefing.md add adjustments.
5. A started spec with no provenance (from a single-spec draft), one with unchanged sections, and an approval whose original left the outline: no proposal and no item.

## Limits

- A rejected adjustment is asked again in a new draft while the docs still differ from what was delivered: the docs are the truth, so the owner either approves it or reverts the docs.
- Within one draft a rejection holds for that adjustment number even if the cited sections change again; a new draft asks again.
- Removing the approval section of an adjustment that already started drops that item from the outline; R11.7.5 decides what happens to a started item that leaves the outline.
- An approval stays pending if the docs change back before the owner decides; rejecting it is the owner's call.
- A briefing.md that ends inside an open code block takes the approval section into that block; the probe found no other case where appending changes an existing section.
- A spec without provenance (`derivedFrom`, from a single-spec draft) is never adjusted, since there is no section hash to compare.
- Review fix: a spec derived since this plan records each cited section's hash below its heading line (`bodyHash`), so a renumbered or renamed section asks nothing; a spec derived before it compares whole sections, so renumbering still asks for it.
- The adjustment's run changes code another spec delivered; updating a test of that spec that asserts the old behavior is left to the run's Dev and Test steps, which this plan does not change.
- Found while writing this plan, not changed here: a backlog with a started item never gets the SM's conflict map. The map waits for a pre-plan of every item, a started item has none, and the program then runs one spec at a time. Every backlog with an adjustment has such an item.

## Probe (before this plan, synthetic inputs and this repository's Markdown)

- Appending `\n## Ajuste aprovado: ...` changed only level-one sections, which hold the whole document. Every other section kept its exact text. The inputs were briefings with and without a trailing newline, with two trailing newlines, with CRLF, ending in a level-three section, and with numbered mermaid sections, plus 16 Markdown files of this repository. A document ending inside an open code block was the only exception.
- `sectionText(doc, 'Ajuste aprovado: opme-ajuste-1')` resolves to its own section beside `opme-ajuste-11`, `opme-ajuste-2` and `x-opme-ajuste-1`, and to none when the section is missing.
- The approval heading parses with or without backticks, in any case, at any heading level and with CRLF. A list line, extra text after the key, a bare key without `-ajuste-<n>`, and a heading inside prose are ignored.
- `rankItems` places `opme-ajuste-1` (P1, after `opme`) between `opme` and the P2 item that depends on `opme`.
- The draft module returned the expected result in each case: a changed section on a done or running spec, no change, a planned spec, no provenance, a planned adjustment, a delivered adjustment, a removed source, and a missing original. A pending or rejected approval was not asked again, and a pending `opme-ajuste-11` did not hide `opme-ajuste-1`. Adjustments `1`, `2` and `10` sort by number.
- `checkPatch` refuses an agent's empty `find` ("find not found"), so only the orchestrator can append.

---

### Task 1: An approved adjustment enters the outline

**Files:**
- Create: `server/refine/adjustments.ts`
- Modify: `server/refine/backlog.ts` (`RULES`, `postProcessBacklog`)
- Modify: `server/refine/cycle.ts` (the backlog branch of `runCycleSteps`)
- Modify: `.claude/agents/po.md` (backlog step)
- Test: `test/refine/adjustments.test.ts` (new), `test/refine/backlog-derive.test.ts`, `test/refine/detail-cycle.test.ts`

**Interfaces:**
- Produces: `isAdjustment(key: string): boolean`, `approvedAdjustments(briefing: string): string[]`, `adjustmentItems(items: readonly BacklogItem[], approved: readonly string[]): BacklogItem[]`, and `postProcessBacklog(out, previous, flow, approved: readonly string[] = [])`.

- [ ] **Step 1: Write the failing tests**

Create `test/refine/adjustments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { adjustmentItems, approvedAdjustments, isAdjustment } from '../../server/refine/adjustments.js';

const item = (key: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  key, title: `Item ${key}`, epic: 'supr', scope: `Entrega ${key}`, priority: 'P1', rationale: 'valor', dependsOn: [], sources: [{ doc: 'flow.md', heading: '3. OPME' }], size: 'M', ...over,
});

describe('approved adjustments', () => {
  it('reads one key per "Ajuste aprovado" heading of briefing.md, and nothing else', () => {
    const briefing = ['# Briefing', '', '## Ajuste aprovado: opme-ajuste-1', '', 'texto', '', '### ajuste aprovado: `OPME-Ajuste-2`', '', '## Ajuste aprovado: opme-ajuste-1', '', '- Ajuste aprovado: caso-ajuste-1', '## Ajuste aprovado: caso-ajuste-1 (texto a mais)', '## Ajuste aprovado: caso', 'Texto ## Ajuste aprovado: fat-ajuste-1'].join('\n');
    expect(approvedAdjustments(briefing)).toEqual(['opme-ajuste-1', 'opme-ajuste-2']);
    expect(approvedAdjustments('# Briefing\r\n\r\n## Ajuste aprovado: opme-ajuste-1\r\n')).toEqual(['opme-ajuste-1']);
  });

  it('tells an adjustment key from an item key', () => {
    expect(['opme-ajuste-1', 'a-b-ajuste-12', 'ajuste-1', 'opme', 'opme-ajuste-x'].map(isAdjustment)).toEqual([true, true, false, false, false]);
  });

  it('adds each approved adjustment after its original and the earlier ones, citing its approval', () => {
    const opme = item('opme', { dependsOn: ['caso'], priority: 'P2', size: 'L' });
    const items = adjustmentItems([item('caso'), opme], ['opme-ajuste-10', 'opme-ajuste-2', 'opme-ajuste-1', 'fat-ajuste-1']);
    expect(items.map((i) => [i.key, i.dependsOn])).toEqual([['opme-ajuste-1', ['opme']], ['opme-ajuste-2', ['opme-ajuste-1']], ['opme-ajuste-10', ['opme-ajuste-2']]]);
    expect(items[0]).toMatchObject({ title: 'Ajuste 1: Item opme', epic: 'supr', priority: 'P2', size: 'L', sources: [{ doc: 'flow.md', heading: '3. OPME' }, { doc: 'briefing.md', heading: 'Ajuste aprovado: opme-ajuste-1' }] });
  });
});
```

In `test/refine/backlog-derive.test.ts`, add inside `describe('postProcessBacklog')`:

```ts
  it('drops any adjustment the agent writes and adds each approved one after its original (R11.7.4)', () => {
    const items = [item('opme'), item('opme-ajuste-1', { title: 'inventado' }), item('caso', { priority: 'P0' })];
    const keys = (approved: string[]) => {
      const out = postProcessBacklog(raw(items), null, '', approved);
      return out.ok ? out.value.backlog.items.map((i) => [i.key, i.rank, i.title]) : out.issues;
    };
    expect(keys([])).toEqual([['caso', 1, 'Item caso'], ['opme', 2, 'Item opme']]);
    expect(keys(['opme-ajuste-1'])).toEqual([['caso', 1, 'Item caso'], ['opme', 2, 'Item opme'], ['opme-ajuste-1', 3, 'Ajuste 1: Item opme']]);
  });
```

In `test/refine/detail-cycle.test.ts`, add inside `describe('backlog detailing in the refinement cycle')`, after the test `'never writes a reused item, and keeps a delivered one beside it'`:

```ts
  // R11.7.4: an adjustment comes only from its approval in briefing.md; the PO is never shown one to keep or reword.
  it('adds an approved adjustment after its original and never shows it to the PO', async () => {
    const { draft, journal, run } = await setup();
    await writeFile(draft.briefingMd, '# Briefing\n\n## Objectives\n\n- tudo\n\n## Ajuste aprovado: opme-ajuste-1\n\nA spec big-001-opme foi entregue antes da mudança.\n');
    const agent = fakeAgent(() => OUTLINE);
    await run(agent, 1);
    expect(journal.state.backlog!.items.find((i) => i.key === 'opme-ajuste-1')).toMatchObject({ dependsOn: ['opme'], rank: 4 });
    await writeFile(draft.flowMd, FLOW.replace('C --> D', 'C --> D2[Cotação]'));
    await run(agent, 2);
    const shown = agent.calls.filter((c) => c.kind === 'backlog').at(-1)!.feedback.split('### previous backlog (keep the keys)\n\n')[1]!.split('\n\n### ')[0]!;
    expect(shown).toContain('"opme"');
    expect(shown).not.toContain('opme-ajuste-1');
    expect(journal.state.backlog!.items.map((i) => i.key)).toContain('opme-ajuste-1');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/adjustments.test.ts test/refine/backlog-derive.test.ts test/refine/detail-cycle.test.ts`
Expected: FAIL. `adjustments.js` does not exist, the agent's `opme-ajuste-1` is kept with its own title, and the outline has no adjustment.

- [ ] **Step 3: Implement**

Create `server/refine/adjustments.ts`:

```ts
import type { BacklogItem } from '../contracts/backlog.js';

/**
 * R11.7.4: a spec whose run started never changes. When the sections it cites change, the owner approves an adjustment
 * spec `<key>-ajuste-<n>` by accepting its `## Ajuste aprovado:` section in briefing.md, and the orchestrator, never the
 * agent, adds it to the backlog after the spec it changes.
 */
const ADJUSTMENT = /^([a-z0-9]+(?:-[a-z0-9]+)*)-ajuste-(\d+)$/;
const APPROVED = /^#{1,6}[ \t]+Ajuste aprovado:[ \t]*`?([a-z0-9]+(?:-[a-z0-9]+)*-ajuste-\d+)`?[ \t]*$/gim;

const rootOf = (key: string) => ADJUSTMENT.exec(key)?.[1];
const numberOf = (key: string) => Number(ADJUSTMENT.exec(key)?.[2] ?? 0);
const approvalHeading = (key: string) => `Ajuste aprovado: ${key}`;

export const isAdjustment = (key: string): boolean => ADJUSTMENT.test(key);

/** The adjustments the owner approved: one `## Ajuste aprovado: <key>` section each in briefing.md. */
export function approvedAdjustments(briefing: string): string[] {
  return [...new Set([...briefing.matchAll(APPROVED)].map((m) => m[1]!.toLowerCase()))];
}

/** Each approved adjustment (keys from `approvedAdjustments`) of an item in the outline, after it and its earlier adjustments. */
export function adjustmentItems(items: readonly BacklogItem[], approved: readonly string[]): BacklogItem[] {
  const out: BacklogItem[] = [];
  for (const key of [...approved].sort((a, b) => rootOf(a)!.localeCompare(rootOf(b)!) || numberOf(a) - numberOf(b))) {
    const original = items.find((i) => i.key === rootOf(key));
    if (!original) continue;
    const after = out.filter((a) => rootOf(a.key) === original.key).at(-1)?.key ?? original.key;
    out.push({
      ...original,
      key,
      title: `Ajuste ${numberOf(key)}: ${original.title}`,
      scope: `Só o que mudou desde que começou: ${original.scope}`,
      rationale: 'Ajuste aprovado no briefing.md: as seções que a spec original cita mudaram depois que ela começou.',
      dependsOn: [after],
      sources: [...original.sources, { doc: 'briefing.md', heading: approvalHeading(key) }],
    });
  }
  return out;
}
```

In `server/refine/backlog.ts`, add `import { adjustmentItems, isAdjustment } from './adjustments.js';` and, in `RULES`, after the line that starts with `'- key: a short slug.`, add:

```ts
  '- Never write an item whose key ends in -ajuste-<n>: the orchestrator adds one, after its original, for each "## Ajuste aprovado:" section of briefing.md.',
```

Then replace `postProcessBacklog`'s comment, signature and the lines from `const items = keepPreviousKeys(...)` to its `return` with:

```ts
/** The orchestrator, not the agent, owns key stability, validity and rank, and adds the adjustments the owner approved (R11.7.4). */
export function postProcessBacklog(out: { project: unknown; backlog: unknown }, previous: BacklogState | null, flow: string, approved: readonly string[] = []): BacklogCheck {
```

```ts
  const items = keepPreviousKeys(backlog.data.items.filter((i) => !isAdjustment(i.key)), previous);
  const rules = validateBacklog({ epics: backlog.data.epics, items }, { flowHeadings: flowHeadings(flow) });
  if (rules.length > 0) return { ok: false, issues: rules };
  return { ok: true, value: { project: project.data, backlog: { epics: backlog.data.epics, items: rankItems([...items, ...adjustmentItems(items, approved)]) } } };
```

In `server/refine/cycle.ts`, add `import { approvedAdjustments, isAdjustment } from './adjustments.js';` and replace

```ts
      const previous = before?.items.length ? before : await mainOutline(draft, before);
```

with

```ts
      const last = before?.items.length ? before : await mainOutline(draft, before);
      // R11.7.4: adjustments are the orchestrator's: the PO never sees one, and each comes back from its approval in briefing.md.
      const previous = last && { ...last, items: last.items.filter((i) => !isAdjustment(i.key)) };
```

and replace `postProcessBacklog(out.value as BacklogOutput, previous, docs['flow.md'])` with `postProcessBacklog(out.value as BacklogOutput, previous, docs['flow.md'], approvedAdjustments(docs['brief.md']))`.

In `.claude/agents/po.md`, section "Breaking the docs into a backlog", after the line that starts with `- A priority, cut, merge or split the human wrote`, add:

```markdown
- Never write an item whose key ends in `-ajuste-<n>`: the orchestrator adds one, after its original, for each `## Ajuste aprovado:` section of the briefing.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/adjustments.test.ts test/refine/backlog-derive.test.ts test/refine/detail-cycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/refine/adjustments.ts server/refine/backlog.ts server/refine/cycle.ts .claude/agents/po.md test/refine/adjustments.test.ts test/refine/backlog-derive.test.ts test/refine/detail-cycle.test.ts
git commit -m "feat(refine): an adjustment approved in briefing.md enters the backlog after the spec it changes"
```

### Task 2: A change to a started spec asks the owner to approve an adjustment

**Files:**
- Modify: `server/refine/adjustments.ts` (`adjustmentsDue`, `approvalPatch`)
- Modify: `server/refine/patches.ts` (`applyPatch`)
- Modify: `server/refine/cycle.ts` (after detailing, and after the PO and SM patches)
- Test: `test/refine/adjustments.test.ts`, `test/refine/patches.test.ts`, `test/refine/detail-cycle.test.ts`

**Interfaces:**
- Consumes: `isAdjustment`, `adjustmentItems`, `approvedAdjustments` (Task 1).
- Produces: `interface DueAdjustment { key: string; specId: string; status: SpecStatus; changed: string[] }`, `adjustmentsDue(backlog: Pick<BacklogState, 'items' | 'specs'>, docs: BacklogDocs, patches: readonly Pick<PatchRow, 'status' | 'replace'>[]): DueAdjustment[]`, `approvalPatch(due: DueAdjustment): { find: string; replace: string; reason: string }`; `applyPatch` appends when `find` is empty.

- [ ] **Step 1: Write the failing tests**

In `test/refine/adjustments.test.ts`, extend the imports:

```ts
import type { SpecStatus } from '../../server/contracts/spec.js';
import { adjustmentItems, adjustmentsDue, approvalPatch, approvedAdjustments, isAdjustment } from '../../server/refine/adjustments.js';
import { sourceHashes, type BacklogDocs } from '../../server/refine/details.js';
import { applyPatch } from '../../server/refine/patches.js';
import { sectionText } from '../../server/refine/sections.js';
import type { PatchRow, SpecRow } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';
```

and add after the existing `describe`:

```ts
const H = `sha256:${'a'.repeat(64)}`;

describe('adjustments due', () => {
  const flow = (opme: string) => ['```mermaid', '%% 1. Caso', '  A --> B', '%% 3. OPME', `  ${opme}`, '```', ''].join('\n');
  const docs = (opme: string, briefing = '# Briefing\n'): BacklogDocs => ({ 'project.md': '', 'briefing.md': briefing, 'stack.md': '', 'flow.md': flow(opme), 'design.md': '' });
  const before = docs('C --> D');
  const after = docs('C --> D2[Cotação]');
  const opme = item('opme');
  const started = (key: string, of: BacklogItem, from: BacklogDocs, status: SpecStatus): SpecRow => {
    const spec = { ...makeSpec({ specId: `big-001-${key}`, status }), derivedFrom: { backlogKey: of.key, inputHash: H, docsHash: H, sources: sourceHashes(of, from) } };
    return { inputHash: H, specId: spec.specId, rev: H, spec, issues: [], cycle: 1 };
  };
  const due = (specs: Record<string, SpecRow>, items: BacklogItem[] = [opme], d = after, patches: Array<Pick<PatchRow, 'status' | 'replace'>> = []) =>
    adjustmentsDue({ items: items.map((i, n) => ({ ...i, rank: n + 1 })), specs }, d, patches).map((a) => a.key);

  it('asks for the first adjustment of a delivered or running spec whose cited section changed', () => {
    expect(adjustmentsDue({ items: [{ ...opme, rank: 1 }], specs: { opme: started('opme', opme, before, 'done') } }, after, [])).toEqual([{ key: 'opme-ajuste-1', specId: 'big-001-opme', status: 'done', changed: ['flow.md › 3. OPME'] }]);
    expect(due({ opme: started('opme', opme, before, 'running') })).toEqual(['opme-ajuste-1']);
  });

  it('asks nothing for unchanged sections, a spec not started, or one with no provenance', () => {
    expect(due({ opme: started('opme', opme, before, 'done') }, [opme], before)).toEqual([]);
    expect(due({ opme: started('opme', opme, before, 'planned') })).toEqual([]);
    const done = started('opme', opme, before, 'done');
    expect(due({ opme: { ...done, spec: { ...done.spec!, derivedFrom: undefined } } })).toEqual([]);
  });

  it('leaves a change to the open adjustment, and asks for the next one once the last adjustment started', () => {
    const approved = '# Briefing\n\n## Ajuste aprovado: opme-ajuste-1\n\ntexto\n';
    const [first] = adjustmentItems([opme], ['opme-ajuste-1']);
    const derivedAt = docs('C --> D2[Cotação]', approved);
    const changedAgain = docs('C --> D3[Cotação dupla]', approved);
    const rows = (status: SpecStatus) => ({ opme: started('opme', opme, before, 'done'), 'opme-ajuste-1': started('opme-ajuste-1', first!, derivedAt, status) });
    expect(due(rows('planned'), [opme, first!], changedAgain)).toEqual([]);
    expect(due(rows('done'), [opme, first!], changedAgain)).toEqual(['opme-ajuste-2']);
  });

  it('never asks again what is still pending or was rejected in this draft', () => {
    const asked = (status: PatchRow['status'], key = 'opme-ajuste-1') => [{ status, replace: approvalPatch({ key, specId: 'x', status: 'done', changed: [] }).replace }];
    const specs = { opme: started('opme', opme, before, 'done') };
    expect(due(specs, [opme], after, asked('pending'))).toEqual([]);
    expect(due(specs, [opme], after, asked('rejected'))).toEqual([]);
    expect(due(specs, [opme], after, asked('pending', 'opme-ajuste-11'))).toEqual(['opme-ajuste-1']);
  });
});

describe('approval patch', () => {
  it('appends a section that changes the text of no other section, and every other patch still applies', () => {
    const briefing = '# Briefing\n\n## Prioridades\n\n- OPME é P2\n\n### Detalhe\n\ntexto';
    const p = approvalPatch({ key: 'opme-ajuste-1', specId: 'big-001-opme', status: 'done', changed: ['flow.md › 3. OPME'] });
    const accepted = applyPatch(briefing, p)!;
    expect(approvedAdjustments(accepted)).toEqual(['opme-ajuste-1']);
    for (const heading of ['Prioridades', 'Detalhe']) expect(sectionText(accepted, heading)).toBe(sectionText(briefing, heading));
    expect(applyPatch(accepted, { find: '- OPME é P2', replace: '- OPME é P1' })).not.toBeNull();
    expect(p.reason).toContain('flow.md › 3. OPME');
    expect(p.reason).toContain('opme-ajuste-1');
  });
});
```

In `test/refine/patches.test.ts`, add inside `describe('patches')`:

```ts
  it("appends when find is empty, which only the orchestrator's own patches carry: an agent's empty find is still refused", () => {
    expect(applyPatch('a\nb', { find: '', replace: '## C\n' })).toBe('a\nb\n## C\n');
    expect(checkPatch({ file: 'docs/project.md', find: '', replace: 'x', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'find not found in project.md' });
  });
```

In `test/refine/detail-cycle.test.ts`, add `import { applyPatch } from '../../server/refine/patches.js';`. Then, right after the `named` helper, add:

```ts
  // R11.7.4: main delivered `opme`, and later its cited flow section changed.
  const deliveredThenChanged = async (d: Env) => {
    const file = `${d.draft.base}/specs/big-001-opme/spec.json`;
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status: 'done', specVersion: 1, specHash: H }));
    await writeFile(d.draft.flowMd, FLOW.replace('C --> D', 'C --> D2[Cotação]'));
  };
  const approvals = (env: Env) => env.journal.state.patches.filter((p) => p.replace.startsWith('## Ajuste aprovado'));
```

In the test `'never writes a reused item, and keeps a delivered one beside it'`, add as its last line:

```ts
    expect(approvals(second)).toEqual([]);
```

and after the test added in Task 1, add:

```ts
  it('asks the owner once to approve an adjustment of a delivered item whose cited section changed', async () => {
    const { second, agent, detailing } = await secondDraft(deliveredThenChanged);
    expect(detailing).toEqual([]);
    expect(approvals(second)).toEqual([expect.objectContaining({ role: 'po', file: 'brief.md', find: '', status: 'pending' })]);
    expect(approvals(second)[0]!.replace).toMatch(/^## Ajuste aprovado: opme-ajuste-1\n/);
    expect(approvals(second)[0]!.reason).toContain('flow.md › 3. OPME');
    expect(second.journal.state.status).toBe('answering');
    await second.run(agent, 3);
    expect(approvals(second)).toHaveLength(1);
    await second.journal.fact(RefineEvent.PatchRejected, { patchId: approvals(second)[0]!.patchId, reason: null });
    await second.run(agent, 4);
    expect(approvals(second)).toHaveLength(1);
    expect(second.journal.state.status).toBe('ready');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/adjustments.test.ts test/refine/patches.test.ts test/refine/detail-cycle.test.ts`
Expected: FAIL. `adjustmentsDue` and `approvalPatch` do not exist, `applyPatch` returns null for an empty `find`, and the cycle proposes no approval.

- [ ] **Step 3: Implement**

In `server/refine/adjustments.ts`, replace the first import with:

```ts
import type { BacklogItem } from '../contracts/backlog.js';
import type { SpecStatus } from '../contracts/spec.js';
import { isStarted } from './coverage.js';
import { sourceHashes, type BacklogDocs } from './details.js';
import type { BacklogState, PatchRow } from './state.js';
```

and append:

```ts
export interface DueAdjustment {
  key: string;
  /** The started spec it changes: the original's own, or its latest adjustment's. */
  specId: string;
  status: SpecStatus;
  /** The cited sections whose text is new since that spec was derived. */
  changed: string[];
}

const sameHashes = (a: ReadonlyArray<string | null>, b: ReadonlyArray<string | null>) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** The next adjustment of each original whose latest spec started and whose cited sections changed since; one pending or rejected in this draft is not asked again. */
export function adjustmentsDue(backlog: Pick<BacklogState, 'items' | 'specs'>, docs: BacklogDocs, patches: readonly Pick<PatchRow, 'status' | 'replace'>[]): DueAdjustment[] {
  return backlog.items.filter((i) => !isAdjustment(i.key)).flatMap((original) => {
    const latest = backlog.items.filter((i) => i.key === original.key || rootOf(i.key) === original.key).reduce((a, b) => (numberOf(b.key) > numberOf(a.key) ? b : a));
    const spec = backlog.specs?.[latest.key]?.spec;
    if (!spec?.derivedFrom || !isStarted(spec.status)) return [];
    const was = spec.derivedFrom.sources.map((s) => s.hash);
    const now = sourceHashes(latest, docs);
    if (sameHashes(was, now.map((s) => s.hash))) return [];
    const key = `${original.key}-ajuste-${numberOf(latest.key) + 1}`;
    if (patches.some((p) => (p.status === 'pending' || p.status === 'rejected') && p.replace.startsWith(`## ${approvalHeading(key)}\n`))) return [];
    return [{ key, specId: spec.specId, status: spec.status, changed: now.filter((s) => !was.includes(s.hash)).map((s) => `${s.doc} › ${s.heading}`) }];
  });
}

/** The owner's approval as a patch: its empty `find` appends a section at the end of briefing.md, which changes no other section. */
export function approvalPatch(due: DueAdjustment): { find: string; replace: string; reason: string } {
  const when = due.status === 'done' ? 'foi entregue' : 'começou';
  const changed = due.changed.join('; ') || 'uma seção que ela citava saiu do item';
  return {
    find: '',
    replace: `## ${approvalHeading(due.key)}\n\nA spec ${due.specId} ${when} antes da mudança em ${changed}; este ajuste entrega só o que mudou.\n`,
    reason: `As seções que a spec ${due.specId} cita mudaram depois que ela ${when}: ${changed}. Aceite para aprovar a spec de ajuste ${due.key}, que entrega só o que mudou; rejeite para manter a spec como está.`,
  };
}
```

In `server/refine/patches.ts`, replace `applyPatch` with:

```ts
/** Applies `find` once; an empty `find` appends, and only the orchestrator's own patches carry one (`checkPatch` refuses it). */
export function applyPatch(text: string, p: { find: string; replace: string }): string | null {
  if (p.find === '') return `${text}\n${p.replace}`;
  return count(text, p.find) === 1 ? text.replace(p.find, () => p.replace) : null;
}
```

In `server/refine/cycle.ts`, change the adjustments import to `import { adjustmentsDue, approvalPatch, approvedAdjustments, isAdjustment, type DueAdjustment } from './adjustments.js';`, add `let due: DueAdjustment[] = [];` after `let secretNames: string[] = [];`, and after the line `secretNames = [...new Set(...)];` inside `if (backlog.detail)` add:

```ts
      // R11.7.4: a started spec whose cited sections changed gets an adjustment for the owner to approve.
      due = adjustmentsDue(backlog, backlogDocs, journal.state.patches);
```

Then, right before `const checklist: ChecklistItem[] = mergeChecklist(...)`, add:

```ts
  // R11.7.4: accepting the patch approves the adjustment; rejecting it keeps the started spec as it is.
  let next = state.patches.filter((p) => p.cycle === cycle && p.role === 'po').length;
  for (const a of due) {
    const p = approvalPatch(a);
    await journal.fact(RefineEvent.PatchProposed, { patchId: patchId('po', cycle, next++), role: 'po', file: 'brief.md', ...p, diff: unifiedDiff('brief.md', docs['brief.md'], applyPatch(docs['brief.md'], p)!), cycle });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/adjustments.test.ts test/refine/patches.test.ts test/refine/detail-cycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/refine/adjustments.ts server/refine/patches.ts server/refine/cycle.ts test/refine/adjustments.test.ts test/refine/patches.test.ts test/refine/detail-cycle.test.ts
git commit -m "feat(refine): a change to a started spec asks the owner to approve an adjustment in briefing.md"
```

### Task 3: An adjustment is derived against the specs it changes

**Files:**
- Modify: `server/refine/adjustments.ts` (`adjusted`)
- Modify: `server/refine/detail-packs.ts` (`SPEC_RULES`, `specPack`)
- Modify: `server/refine/detail-cycle.ts` (`detail`, the `spec` call)
- Modify: `.claude/agents/po.md` (spec step)
- Test: `test/refine/adjustments.test.ts`, `test/refine/detail-packs.test.ts`, `test/refine/detail-cycle.test.ts`

**Interfaces:**
- Consumes: `adjustmentItems` (Task 1) and `approvals`, `deliveredThenChanged` (Task 2's test helpers).
- Produces: `adjusted(key: string, items: readonly Pick<BacklogItem, 'key'>[]): string[]` and `specPack`'s optional input `adjusts?: Readonly<Record<string, readonly Spec[] | undefined>>`.

- [ ] **Step 1: Write the failing tests**

In `test/refine/adjustments.test.ts`, add `adjusted` to the import from `adjustments.js` and add inside `describe('approved adjustments')`:

```ts
  it('names what an adjustment changes, oldest first: its original and its earlier adjustments', () => {
    const items = [item('opme'), item('opme-ajuste-2'), item('opme-ajuste-1'), item('caso-ajuste-1')];
    expect(adjusted('opme-ajuste-2', items)).toEqual(['opme', 'opme-ajuste-1']);
    expect(adjusted('opme-ajuste-1', items)).toEqual(['opme']);
    expect(adjusted('opme', items)).toEqual([]);
    expect(adjusted('caso-ajuste-1', items)).toEqual([]);
  });
```

In `test/refine/detail-packs.test.ts`, add inside `describe('specPack')`:

```ts
  it('lists, under an adjustment only, the started specs it changes (R11.7.4)', () => {
    const delivered = { ...makeSpec({ specId: 'k-opme', status: 'done' }), acceptanceCriteria: [ac('AC-047', 'pedido registrado')] } as Spec;
    const adjustment = item('opme-ajuste-1', 2, { dependsOn: ['opme'] });
    const pack = specPack({ specHash: HASH, principles: [], docs, batch: [item('caso', 1), adjustment], all: [item('caso', 1), item('opme', 1), adjustment], previous: {}, rejection: {}, adjusts: { 'opme-ajuste-1': [delivered] } });
    const [caso, adj] = pack.feedback!.split('## Item ').slice(1);
    expect(adj).toContain('- k-opme:');
    expect(adj).toContain('AC-047: Given g, when w, then pedido registrado');
    expect(caso).not.toContain('k-opme');
    expect(pack.feedback).toMatch(/only what its cited sections add or change/);
  });
```

In `test/refine/detail-cycle.test.ts`, after the test added in Task 2, add:

```ts
  it('adds the approved adjustment after its original, derives it against the delivered spec, and the program runs it', async () => {
    const agent = fakeAgent(() => OUTLINE);
    const { second } = await secondDraft(deliveredThenChanged, agent);
    const [patch] = approvals(second);
    await writeFile(second.draft.briefingMd, applyPatch(await readFile(second.draft.briefingMd, 'utf8'), patch!)!);
    await second.journal.fact(RefineEvent.PatchAccepted, { patchId: patch!.patchId });
    const from = agent.calls.length;
    await second.run(agent, 3);
    const backlog = second.journal.state.backlog!;
    expect(backlog.items.find((i) => i.key === 'opme-ajuste-1')).toMatchObject({ dependsOn: ['opme'], rank: 4 });
    const specCalls = agent.calls.slice(from).filter((c) => c.kind === 'spec');
    expect(named(specCalls, 'Item')).toEqual(['opme-ajuste-1']);
    expect(specCalls[0]!.feedback).toContain('- big-001-opme:');
    expect(backlog.specs?.opme?.spec?.status).toBe('done');
    expect(approvals(second)).toHaveLength(1);
    expect(second.journal.state.status).toBe('ready');
    const entries = programEntries('big-001', backlog, { 'big-001-opme': 'done' });
    expect(entries.find((e) => e.key === 'opme')?.done).toBe(true);
    expect(entries.find((e) => e.key === 'opme-ajuste-1')).toMatchObject({ dependsOn: ['big-001-opme'] });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/adjustments.test.ts test/refine/detail-packs.test.ts test/refine/detail-cycle.test.ts`
Expected: FAIL. `adjusted` does not exist, and the spec pack carries no delivered spec.

- [ ] **Step 3: Implement**

In `server/refine/adjustments.ts`, add after `adjustmentItems`:

```ts
/** The keys an adjustment changes, oldest first: its original and the earlier adjustments of it in the outline. */
export function adjusted(key: string, items: readonly Pick<BacklogItem, 'key'>[]): string[] {
  const root = rootOf(key);
  if (!root || !items.some((i) => i.key === root)) return [];
  return [root, ...items.map((i) => i.key).filter((k) => rootOf(k) === root && numberOf(k) < numberOf(key)).sort((a, b) => numberOf(a) - numberOf(b))];
}
```

In `server/refine/detail-packs.ts`, add to `SPEC_RULES`, after the line that starts with `'- type is feature`:

```ts
  '- An item that adjusts specs already started or delivered (listed under it) changes software that already exists: its objectives, features and criteria cover only what its cited sections add or change against those specs; restate a criterion that changes in full as a new one, and never repeat what they already deliver.',
```

add to `specPack`'s input, after `rejection`:

```ts
  /** R11.7.4: for an adjustment, the started specs it changes, oldest first. */
  adjusts?: Readonly<Record<string, readonly Spec[] | undefined>>;
```

and in its `items` map, right after the `dependencyLines(i, input.all),` line, add:

```ts
      ...(input.adjusts?.[i.key]?.length ? ['Adjusts these specs, already started or delivered:', ...input.adjusts[i.key]!.map((s) => [`- ${s.specId}:`, JSON.stringify({ objectives: s.objectives, features: s.features, outOfScope: s.outOfScope }, null, 2), criteriaLines(s)].join('\n'))] : []),
```

In `server/refine/detail-cycle.ts`, add `import { adjusted } from './adjustments.js';`, add right before `const runSpecs = ...`:

```ts
  // R11.7.4: an adjustment is derived against the started specs it changes.
  const adjustsOf = (item: Item) => adjusted(item.key, items).flatMap((k) => (specs[k]?.spec ? [specs[k]!.spec!] : []));
```

and in `runSpecs`, replace `previous: Object.fromEntries(batch.map((i) => [i.key, previous.get(i.key)])), rejection })` with `previous: Object.fromEntries(batch.map((i) => [i.key, previous.get(i.key)])), rejection, adjusts: Object.fromEntries(batch.map((i) => [i.key, adjustsOf(i)])) })`.

In `.claude/agents/po.md`, section "Detailing a backlog item", after the line that starts with `- Derive the spec from the item and its cited sections only`, add:

```markdown
- An item that adjusts specs already started or delivered (listed under it) changes software that already exists: cover only what its cited sections add or change against them, restate a criterion that changes in full as a new one, and never repeat what they already deliver.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/adjustments.test.ts test/refine/detail-packs.test.ts test/refine/detail-cycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite, the type check and the web tests in a clean worktree**

`git worktree add --detach <scratch>/verify-79 HEAD` after committing, link `node_modules` and `web/node_modules`, run `npx vitest run`, `npx tsc --noEmit -p .` and `(cd web && npx vitest run)`, then remove the worktree.
Expected: every test passes (4 skipped), no type errors, web green.

- [ ] **Step 6: Commit**

```bash
git add server/refine/adjustments.ts server/refine/detail-packs.ts server/refine/detail-cycle.ts .claude/agents/po.md test/refine/adjustments.test.ts test/refine/detail-packs.test.ts test/refine/detail-cycle.test.ts
git commit -m "feat(refine): an adjustment spec is derived against the started specs it changes"
```

### Task 4: Record R11.7.4 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R11.7)
- Modify: `docs/superpowers/plans/README.md` (row 79)

- [ ] **Step 1: Update the roadmap**

Change the R11.7 heading's note to `plans 76 to 79, 2026-10-12; slices 1 to 4 of 6 built` and add after the `Review of R11.7.3` line:

```markdown
- Built R11.7.4 (plan 79): when the sections a started or delivered spec cites change, the PO asks the owner to approve an adjustment spec, as a patch that adds a `## Ajuste aprovado: <key>-ajuste-<n>` section to the end of briefing.md; once accepted, the orchestrator adds the adjustment to the backlog after the spec it changes, detailing derives it against what that spec delivered, and the program runs it next, while a rejected one leaves the spec as it is (`server/refine/adjustments.ts`). Before it, such a change reached nothing: the spec stayed as delivered and the docs silently diverged from it.
```

- [ ] **Step 2: Add the plans index row**

After row 78 of `docs/superpowers/plans/README.md`, add:

```markdown
| 79 | [`2026-10-12-teams-ai-79-adjustment-specs.md`](2026-10-12-teams-ai-79-adjustment-specs.md) | Done — a change to the sections of a started or delivered spec becomes an adjustment spec the owner approves in briefing.md; ROADMAP R11.7.4. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.7.4 a change to a started spec becomes an adjustment the owner approves"
```
