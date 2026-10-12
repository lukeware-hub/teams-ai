# Plan 76 - Docs sync after refinement (R11.7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** what the owner decided during a refinement survives every later version of the spec, and a change to the docs reaches the specs it affects without ever rewriting a spec that already started or was delivered.

**Architecture:** this plan holds the design of the six R11.7 slices and the tasks of the first one. Slice R11.7.1 gives the spec an optional `decisions` list: the session records every answered question in it when the spec is frozen, each later derivation carries it from the previous version, the refinement agents see it as answered questions, a question it already answers is dropped, and the brief of a continued spec renders it. The other slices get their own plans.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest.

**Spec:** ROADMAP R11.7 ("Re-derive `planned` specs whose sources changed, add and retire items, adjustment specs for started or delivered specs"); plan 50 (`docs/superpowers/plans/2026-10-06-teams-ai-50-spec-driven-backlog.md`), decisions 4 and 5 and the spec-driven principles; plan 51, the R11.7 line ("re-derive from the `derivedFrom` section hashes"); and the live finding below.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- A spec on main without decisions keeps the hash it has today, so no plan or run becomes stale (checked on the three real specs below).
- Decisions come only from answered questions in the refinement journal; an agent never writes one.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A spec on main without decisions, the state of every project today: it parses and keeps its hash.
2. An answer given after the last evaluation, then start: a session is `ready` with a pending question that does not block, and the frozen spec still records the answer.
3. The derive agent returning a `decisions` array: dropped, since decisions come only from answers.
4. The same question answered twice, or answered again in a later version: one decision with the latest answer.
5. A role's answer from the docs (R11.5.7): recorded with `by`, so it is told apart from the owner's.

## Human decisions

- Plan 50, decision 4: "When refinement ends ALL specs are detailed (objectives, features, acceptance criteria); questions answered once."
- Plan 50, decision 5: "When a doc changes later, specs not yet started are re-derived only where the source changed (by hash), keeping ids and the human's priority decisions; delivered specs produce an adjustment spec for approval."
- Plan 50, principles: "The five docs are the only hand-edited truth"; "A frozen spec never mutates; drift on a started or delivered spec yields a new adjustment spec."

## Where it breaks today

- Seen live on 2026-10-12: the second continuation of `loja-eventos/cancelar-pedido` asked again the five questions the owner had answered in the first one, one of them blocking, and spent a refinement cycle on it.
- An answer lives only in the draft's journal (`session.answer`, `server/refine/session.ts:278-282`); the derive step never receives answers (`derivePack`, `server/refine/derive.ts:8-19`), and nothing writes them into `spec.json`, `brief.md` or the docs.
- A continued draft starts with an empty journal, rewrites `brief.md` from `spec.json` (`server/refine/draft.ts:227`), and the "Restart" action deletes the old draft with its journal (`server/refine/registry.ts:238-256`).
- The "prior specs" section of the PO and SM packs is always empty, since nothing in `server/` ever fills the knowledge index (`server/refine/cycle.ts:247`).
- In backlog mode a new draft re-derives every item, because the re-derive check reads only its own journal (`server/refine/detail-cycle.ts:178,208`), and it overwrites the spec of a started or delivered item as `planned` with version 0 (`server/refine/detail-cycle.ts:36-42`, `server/refine/item-spec.ts:45,49`); Phase 0 then publishes it over the delivered one.
- An item dropped from the outline is deleted only from the draft (`removeRetired`, `server/refine/detail-cycle.ts:70-76`); main keeps its spec and `specs.json` keeps listing it.
- `derivedFrom` records the input hash and the hash of each cited section (`server/contracts/spec.ts:60-66`), but nothing compares it with the current docs.

## Design

**R11.7.1 Decisions travel with the spec.** The spec gets an optional `decisions` list of `{question, answer, by?}`, included in the spec hash (a spec without it hashes as today). When the session freezes the spec, every answered question of its journal becomes a decision, and a later answer to the same question (compared without case and extra spaces) replaces the earlier one; `by` names the role when the answer came from the docs (R11.5.7). Each derivation carries the previous version's decisions and drops any the agent wrote. The PO, SM and Front packs list them with the answered questions under "do not ask again", the question merge drops a question a decision already answers, and the brief of a continued spec renders them under `## Decisions`, so the docs show them from the next version on. Writing each answer into `brief.md` when it is given was set aside: it would mark the draft stale and force another evaluation after every answer.

**R11.7.2 A started or delivered spec is never re-derived.** Backlog detailing reads each item's spec on main and leaves `running`, `paused:quota`, `paused:auth`, `awaiting-validation` and `done` specs untouched: no `spec` step, no overwrite, no version reset.

**R11.7.3 Only changed sources re-derive, across drafts.** A new backlog draft compares each item's `specInputHash` with the `derivedFrom.inputHash` of its spec on main and reuses that spec when they match, instead of re-deriving every item because its own journal is empty; a new item, with no spec on main, is derived as today.

**R11.7.4 Drift on a started or delivered spec proposes an adjustment spec.** When an item's sources changed but R11.7.2 protects its spec, detailing derives a new item `<key>-ajuste-<n>` whose criteria cover only what changes against the delivered spec; it depends on the original and waits for the owner's approval before the program runs it (decision 5).

**R11.7.5 Retired items leave main.** An item dropped from the outline whose spec on main is `planned` gets the new status `retired` and leaves `specs.json`; a started or delivered one is never retired on its own: the PO asks the owner whether the feature stays or an adjustment removes it.

**R11.7.6 Decisions reach the delivery.** The Dev and Test packs list the spec's decisions, so an implementer follows the owner's answer instead of guessing it.

## Slices (roadmap R11.7)

1. R11.7.1 Decisions travel with the spec (this plan).
2. R11.7.2 A started or delivered spec is never re-derived.
3. R11.7.3 Only changed sources re-derive, across drafts.
4. R11.7.4 Drift on a started or delivered spec proposes an adjustment spec.
5. R11.7.5 Retired items leave main.
6. R11.7.6 Decisions reach the delivery.

## Risks and open points

- The question merge drops only a question whose text matches a decision once case and spaces are ignored; a reworded one still relies on the agents reading the decisions, and a check by meaning (the `question-dedup` decision) is a later step.
- The owner changes a recorded decision only by answering the same question again; editing or removing one from the refinement page is a later step.
- Backlog mode still records decisions in `docs/briefing.md`, so the citation cost R11.10 describes is unchanged.
- A backlog item spec carries no decisions, since the `spec` step's output has no such field; R11.7.2 keeps a delivered item, the only kind that could hold some, from being re-derived.

## Probe (before this plan, on real data)

- The three real specs on disk (`customer-api/create-customer`, `loja-eventos/cancelar-pedido`, `loja-eventos/reservar-estoque`): the stored hash equals `computeSpecHash` today and equals the hash with `decisions` added to the hashed fields.
- The journal of today's `cancelar-pedido` refinement: the freeze rule records exactly the five answers its next version asked again.

---

## Slice R11.7.1 tasks

### Task 1: Decisions on the spec and the rule that records them

**Files:**
- Modify: `server/contracts/spec.ts` (`SpecDecision`, the `decisions` field, `HASHED_FIELDS`)
- Create: `server/refine/decisions.ts`
- Test: `test/contracts/contracts.test.ts`
- Test: `test/refine/decisions.test.ts`

**Interfaces:**
- Produces: `SpecDecision` (zod schema and type `{ question: string; answer: string; by?: 'po' | 'sm' }`) and `Spec.decisions?: SpecDecision[]` in `server/contracts/spec.ts`.
- Produces: `norm(text: string): string` and `withDecisions(spec: Spec, rows: readonly QuestionRow[]): Spec` in `server/refine/decisions.ts`.

- [ ] **Step 1: Write the failing tests**

In `test/contracts/contracts.test.ts`, add `import { canonicalJson, sha256 } from '../../server/contracts/hash.js';` and `import { makeSpec } from '../fixtures/contracts.js';` if missing, and this test inside the spec describe:

```ts
  // R11.7.1: decisions are part of the frozen contract, while every spec written before them keeps its hash.
  it('hashes the decisions, and a spec without them keeps the hash it had before decisions existed', () => {
    const spec = Spec.parse(makeSpec());
    const { specId, specVersion, type, bug, objectives, features, acceptanceCriteria, outOfScope, externalDependencies, tasks } = spec;
    const before = sha256(canonicalJson({ specId, specVersion, type, bug, objectives, features, acceptanceCriteria, outOfScope, externalDependencies, tasks }));
    expect(computeSpecHash(spec)).toBe(before);
    expect(computeSpecHash({ ...spec, decisions: [{ question: 'Port?', answer: '8080' }] })).not.toBe(before);
  });
```

Create `test/refine/decisions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withDecisions } from '../../server/refine/decisions.js';
import type { QuestionRow } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';

const row = (questionId: string, text: string, status: QuestionRow['status'], answer: string | null, answeredBy?: 'po' | 'sm'): QuestionRow =>
  ({ questionId, role: 'po', text, blocking: false, relatedAcIds: [], cycle: 1, status, answer, ...(answeredBy ? { answeredBy } : {}) });

describe('withDecisions', () => {
  it('records each answered question with the role that answered from the docs, and skips pending and skipped ones', () => {
    const spec = withDecisions(makeSpec(), [row('q1', 'Port?', 'answered', '8080'), row('q2', 'Region?', 'answered', 'eu', 'sm'), row('q3', 'Cache?', 'pending', null), row('q4', 'Queue?', 'skipped', null)]);
    expect(spec.decisions).toEqual([{ question: 'Port?', answer: '8080' }, { question: 'Region?', answer: 'eu', by: 'sm' }]);
  });

  it('keeps earlier decisions, and a later answer to the same question replaces the earlier one', () => {
    const earlier = { ...makeSpec(), decisions: [{ question: 'Port?', answer: '80' }, { question: 'Region?', answer: 'eu' }] };
    const spec = withDecisions(earlier, [row('q1', '  port?  ', 'answered', '8080')]);
    expect(spec.decisions).toEqual([{ question: '  port?  ', answer: '8080' }, { question: 'Region?', answer: 'eu' }]);
  });

  it('returns the spec untouched when nothing was answered', () => {
    const spec = makeSpec();
    expect(withDecisions(spec, [row('q1', 'Port?', 'pending', null)])).toBe(spec);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/contracts/contracts.test.ts test/refine/decisions.test.ts`
Expected: FAIL. The hash test fails because the schema strips the unknown `decisions` key, so the hash does not change; the decisions file fails to import `server/refine/decisions.js`.

- [ ] **Step 3: Implement**

In `server/contracts/spec.ts`, add above `export const Spec = z`:

```ts
/** An answer to a refinement question, kept with the spec so a later version neither loses it nor asks it again (R11.7.1). */
export const SpecDecision = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  /** The role that answered from the docs (R11.5.7); absent when the owner answered. */
  by: z.enum(['po', 'sm']).optional(),
});
export type SpecDecision = z.infer<typeof SpecDecision>;
```

In the `Spec` object, after `derivedFrom: SpecProvenance.optional(),` add `decisions: z.array(SpecDecision).optional(),`, and add `'decisions',` after `'tasks',` in `HASHED_FIELDS`.

Create `server/refine/decisions.ts`:

```ts
import type { Spec, SpecDecision } from '../contracts/spec.js';
import type { QuestionRow } from './state.js';

/** Question text compared without case and extra spaces, so the same question asked twice counts once. */
export const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** The spec with each answered question recorded as a decision; a later answer to the same question replaces the earlier one. */
export function withDecisions(spec: Spec, rows: readonly QuestionRow[]): Spec {
  const answered: SpecDecision[] = rows.flatMap((q) => (q.status === 'answered' && q.answer ? [{ question: q.text, answer: q.answer, ...(q.answeredBy ? { by: q.answeredBy } : {}) }] : []));
  if (answered.length === 0) return spec;
  const byQuestion = new Map((spec.decisions ?? []).map((d) => [norm(d.question), d]));
  for (const d of answered) byQuestion.set(norm(d.question), d);
  return { ...spec, decisions: [...byQuestion.values()] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/contracts/contracts.test.ts test/refine/decisions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/contracts/spec.ts server/refine/decisions.ts test/contracts/contracts.test.ts test/refine/decisions.test.ts
git commit -m "feat(refine): a spec can carry the decisions of its refinement"
```

### Task 2: Derivation carries the decisions and the freeze records them

**Files:**
- Modify: `server/refine/derive.ts` (`postProcessDerived`)
- Modify: `server/refine/session.ts` (`freeze`)
- Test: `test/refine/derive.test.ts`
- Test: `test/refine/session.test.ts`

**Interfaces:**
- Consumes: `withDecisions` from Task 1.
- Produces: a derived spec whose `decisions` are the previous version's; a frozen `spec.json` holding every answer of the session.

- [ ] **Step 1: Write the failing tests**

In `test/refine/derive.test.ts`, inside `describe('postProcessDerived')`:

```ts
  // R11.7.1: decisions are the owner's answers, carried from the previous version, never written by the agent.
  it('carries the decisions of the previous version and drops any the agent wrote', () => {
    const invented = { ...prev, decisions: [{ question: 'Invented?', answer: 'yes' }] };
    const decided = { ...prev, decisions: [{ question: 'Port?', answer: '8080' }] };
    const carried = postProcessDerived({ project: PROJECT, spec: invented }, decided, 'hello-001');
    expect(carried.ok && carried.value.spec.decisions).toEqual([{ question: 'Port?', answer: '8080' }]);
    const first = postProcessDerived({ project: PROJECT, spec: invented }, null, 'hello-001');
    expect(first.ok && first.value.spec.decisions).toBeUndefined();
  });
```

In `test/refine/session.test.ts`, inside `describe('RefineSession')`:

```ts
  // R11.7.1: ready allows a pending question that does not block, so an answer may come after the last evaluation.
  it('freezes the spec with every answer as a decision, also one given after the last evaluation', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: false, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await writeSecret(secretsDir, 'DB_URL', 'postgres://x');
    await s.evaluate();
    expect(s.state.status).toBe('ready');
    await s.answer('po-c1-0', '8080');
    const { spec } = await s.freeze();
    expect(spec.decisions).toEqual([{ question: 'Port?', answer: '8080' }]);
    expect(JSON.parse(await fs.readFile(draft().specJson, 'utf8')).decisions).toEqual([{ question: 'Port?', answer: '8080' }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/derive.test.ts test/refine/session.test.ts`
Expected: FAIL. The derive test gets the agent's invented decision, and the session test gets no decisions in the frozen spec.

- [ ] **Step 3: Implement**

In `server/refine/derive.ts`, in `postProcessDerived`, after `derivedFrom: undefined,` add:

```ts
    // Decisions are the owner's answers, never the agent's: carried from the previous version, recorded at freeze.
    decisions: previous?.decisions,
```

In `server/refine/session.ts`, add `import { withDecisions } from './decisions.js';` and in `freeze` replace

```ts
      const value = { project: derived.project, spec: freezeSpec(derived.spec) };
```

with

```ts
      // Every answer of this session travels with the frozen spec, also one given after the last evaluation (R11.7.1).
      const value = { project: derived.project, spec: freezeSpec(withDecisions(derived.spec, this.state.questions)) };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/derive.test.ts test/refine/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/refine/derive.ts server/refine/session.ts test/refine/derive.test.ts test/refine/session.test.ts
git commit -m "feat(refine): the frozen spec records every answer and later versions carry them"
```

### Task 3: The agents see the decisions, never ask one again, and the continued brief shows them

**Files:**
- Modify: `server/refine/packs.ts` (`refinePack`, the answered list)
- Modify: `server/refine/cycle.ts:59` (`norm` comes from `decisions.ts`) and `:290-291` (the decided set)
- Modify: `server/refine/draft.ts` (`renderBriefMd`)
- Test: `test/refine/packs.test.ts`
- Test: `test/refine/draft.test.ts`
- Test: `test/refine/session.test.ts`

**Interfaces:**
- Consumes: `Spec.decisions` and `norm` from Task 1; the carried decisions from Task 2.

- [ ] **Step 1: Write the failing tests**

In `test/refine/packs.test.ts`, inside `describe('refinePack')`:

```ts
  // R11.7.1: a continued spec's decisions are answered questions the agents must not ask again.
  it('lists the decisions the spec carries with the answered questions', () => {
    const decided = { ...base, derived: { project: {}, spec: { acceptanceCriteria: [], objectives: [], decisions: [{ question: 'Port?', answer: '8080' }] } } } as unknown as Parameters<typeof refinePack>[0];
    const { feedback } = refinePack({ ...decided, role: 'sm' });
    const answered = feedback.slice(feedback.indexOf('### Answered questions (do not ask again)'), feedback.indexOf('### Skipped questions'));
    expect(answered).toContain('Port?');
    expect(answered).toContain('8080');
  });
```

In `test/refine/draft.test.ts`, next to the other `renderBriefMd` tests:

```ts
  it('renderBriefMd lists the decisions the spec carries, and leaves a brief without them as it was', () => {
    expect(renderBriefMd(makeSpec())).not.toContain('## Decisions');
    const md = renderBriefMd({ ...makeSpec(), decisions: [{ question: 'Port?', answer: '8080' }, { question: 'Region?', answer: 'eu', by: 'sm' }] });
    expect(md).toContain('## Decisions\n\n- Port?\n  Answer: 8080\n- Region?\n  Answer (SM, from the docs): eu\n');
  });
```

In `test/refine/session.test.ts`, add `writeDerived` to the import from `../../server/refine/draft.js`, and inside `describe('RefineSession')`:

```ts
  // R11.7.1: seen live, a continued spec asked again the questions its last version had answered.
  it('drops a question the continued spec already answered', async () => {
    const s = await RefineSession.create(deps(), 'continue');
    await writeDerived(draft(), { project: makeProject(), spec: { ...makeSpec({ specId: 'hello-001' }), decisions: [{ question: 'Port?', answer: '8080' }] } });
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: '  port?  ', blocking: true, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await writeSecret(secretsDir, 'DB_URL', 'postgres://x');
    await s.evaluate();
    expect(s.state.questions).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/refine/packs.test.ts test/refine/draft.test.ts test/refine/session.test.ts`
Expected: FAIL. The answered list lacks the decision, the brief has no `## Decisions` section, and the re-asked question is kept.

- [ ] **Step 3: Implement**

In `server/refine/packs.ts`, in `refinePack`, replace

```ts
  const answered = input.history.filter((q) => q.status === 'answered').map((q) => `- [${q.role}] ${q.text}\n  answer: ${q.answer}`);
```

with

```ts
  // A continued spec's decisions are answers too (R11.7.1).
  const recorded = (input.derived.spec?.decisions ?? []).map((d) => `- ${d.question}\n  answer: ${d.answer}`);
  const answered = [...recorded, ...input.history.filter((q) => q.status === 'answered').map((q) => `- [${q.role}] ${q.text}\n  answer: ${q.answer}`)];
```

In `server/refine/cycle.ts`, delete `const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();` (line 59), add `import { norm } from './decisions.js';`, and replace

```ts
  // Spec §3.2 step 3: dedup by normalized text, blocking first, PO before SM within a class.
  const decided = new Set(state.questions.filter((q) => q.status !== 'pending').map((q) => norm(q.text)));
```

with

```ts
  // Spec §3.2 step 3: dedup by normalized text, blocking first, PO before SM within a class; a decision counts as decided (R11.7.1).
  const decided = new Set([...state.questions.filter((q) => q.status !== 'pending').map((q) => q.text), ...(derived.spec?.decisions ?? []).map((d) => d.question)].map(norm));
```

In `server/refine/draft.ts`, in `renderBriefMd`, add right after the `parts` array and before `if (validationReport)`:

```ts
  if (s.decisions?.length) parts.push('## Decisions', '', ...s.decisions.map((d) => `- ${d.question}\n  Answer${d.by ? ` (${d.by.toUpperCase()}, from the docs)` : ''}: ${d.answer}`), '');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/refine/packs.test.ts test/refine/draft.test.ts test/refine/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: every test passes (4 skipped), no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/refine/packs.ts server/refine/cycle.ts server/refine/draft.ts test/refine/packs.test.ts test/refine/draft.test.ts test/refine/session.test.ts
git commit -m "feat(refine): the agents see the spec's decisions and never ask one again"
```

### Task 4: Record R11.7.1 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R11.7)
- Modify: `docs/superpowers/plans/README.md` (row 76)

- [ ] **Step 1: Update the roadmap**

Change the R11.7 heading to `### R11.7 Docs sync after refinement - \`partial\` (plan 76, 2026-10-12; slice 1 of 6 built)` and add under its existing line:

```markdown
- Design and slices: `plans/2026-10-12-teams-ai-76-docs-sync-after-refinement.md` (R11.7.1 decisions travel with the spec, R11.7.2 a started or delivered spec is never re-derived, R11.7.3 only changed sources re-derive across drafts, R11.7.4 drift proposes an adjustment spec, R11.7.5 retired items leave main, R11.7.6 decisions reach the delivery).
- Built R11.7.1 (plan 76): the spec carries `decisions`, every answered question of the refinement recorded when the spec is frozen, carried by each later derivation, listed to the PO, SM and Front as answered, dropped from the questions when asked again, and rendered in the brief of a continued spec (`withDecisions`, `server/refine/decisions.ts`). Seen live: the second continuation of `cancelar-pedido` asked again the five questions its first one had answered.
```

- [ ] **Step 2: Add the plans index row**

```markdown
| 76 | [`2026-10-12-teams-ai-76-docs-sync-after-refinement.md`](2026-10-12-teams-ai-76-docs-sync-after-refinement.md) | Slice 1 done — the spec carries the decisions of its refinement, so a later version neither loses nor asks them again; ROADMAP R11.7. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.7.1 decisions travel with the spec"
```
