# Plan 84 - The owner's decisions reach the delivery (R11.7.6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Dev and the Test engineer read what the owner answered during refinement, so the delivery follows those answers instead of guessing them.

**Architecture:** the context pack gets a section with the spec's decisions, placed after the acceptance criteria and never dropped for budget, like the criteria. The Dev's task and technical spec packs and the Test engineer's review pack fill it from the frozen spec. A single spec already carries its decisions (R11.7.1), but a backlog item spec carries none, since the `spec` step has no such field. So when the program freezes an item, the answers to the refinement questions about that item's criteria (`relatedAcIds`) become its decisions.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** plan 76, design R11.7.6 (`docs/superpowers/plans/2026-10-12-teams-ai-76-docs-sync-after-refinement.md`): "The Dev and Test packs list the spec's decisions, so an implementer follows the owner's answer instead of guessing it." Plan 76's risk note says a backlog item spec carries no decisions; this plan closes that gap for the answers about an item's criteria. Plans 81 to 83 belong to another session.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- The worktree is shared with other sessions: commit with an explicit pathspec (`git commit -m ... -- <files>`) and verify in a clean worktree.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A single spec whose answers became decisions: the run's Dev task, technical spec and review packs list them, and a tiny budget never drops them.
2. A backlog item with an answered question about its criteria is frozen with that decision. A question about no criterion, an unanswered one or a skipped one stays out.
3. An item frozen twice, as after a crash between the freeze and the launch: the second attempt keeps the first freeze and adds nothing.
4. An item main retired (R11.7.5) that is frozen with answers: it is planned again and frozen with its decisions.
5. A long or multi-line answer stays readable in the pack, and an over-budget pack is flagged but keeps it.

## Limits

- Answers to questions about no criterion, such as priorities and cuts at the outline, reach the delivery only through the docs, which plan 50 makes their place.
- Answers given in an earlier draft reach a later draft's items only through the docs, or when that earlier draft's program froze the item.
- The SM's plan and the security review do not list the decisions.

---

### Task 1: The Dev and Test packs list the spec's decisions

**Files:**
- Modify: `server/knowledge/context-pack.ts` (`ContextPackInput`, `SECTION_ORDER`, `render`)
- Modify: `server/orchestrator/steps.ts` (`devPack`, `reviewPack`, `techSpecPack`)
- Modify: `.claude/agents/dev.md`, `.claude/agents/test.md`
- Test: `test/knowledge/context-pack.test.ts`, `test/orchestrator/steps.test.ts`

**Interfaces:**
- Produces: `ContextPackInput.decisions?: readonly SpecDecision[]`, rendered as the `decisions` section right after `criteria` and absent from the drop order.

- [ ] **Step 1: Write the failing tests**

In `test/knowledge/context-pack.test.ts`, add inside `describe('buildContextPack')`:

```ts
  // R11.7.6: what the owner answered in the refinement reaches the delivery, and no budget cuts it.
  it("renders the owner's decisions right after the criteria and never drops them", () => {
    const decisions = [{ question: 'O total inclui frete?', answer: 'Sim, sempre.' }, { question: 'Qual moeda?', answer: 'Real.', by: 'po' as const }];
    const pack = buildContextPack({ ...base, decisions, budgetTokens: 10 });
    expect(pack.sections).toEqual(['principles', 'contract', 'task', 'criteria', 'decisions']);
    expect(pack.text).toContain('- O total inclui frete?\n  Answer: Sim, sempre.');
    expect(pack.text).toContain('Answer (PO, from the docs): Real.');
    expect(pack.dropped).toContain('!over-budget');
  });
```

In `test/orchestrator/steps.test.ts`, add `techSpecPack` to the import from `steps.js` and add inside `describe('packs')`:

```ts
  // R11.7.6: the Dev and the Test engineer read the owner's answers the frozen spec carries.
  it("dev, tech-spec and review packs carry the spec's decisions, and a spec without them adds none", () => {
    const decided: PackBase = { ...base, spec: { ...spec, decisions: [{ question: 'O total inclui frete?', answer: 'Sim.' }] } };
    const review = { diffStat: '', changedFiles: [], diff: '', junit: [], code: { source: 'none' as const }, profile: 'standard' as const };
    for (const p of [devPack(decided, task, { code: { source: 'none' }, handoffs: [], feedback: null }), techSpecPack(decided, { feedback: null }), reviewPack(decided, task, review)]) {
      expect(p.decisions).toEqual([{ question: 'O total inclui frete?', answer: 'Sim.' }]);
    }
    expect(devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }).decisions).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/knowledge/context-pack.test.ts test/orchestrator/steps.test.ts`
Expected: FAIL. The pack has no decisions section and the packs carry no decisions.

- [ ] **Step 3: Implement**

In `server/knowledge/context-pack.ts`, change the spec import to `import type { AcceptanceCriterion, SpecDecision } from '../contracts/spec.js';`, add to `ContextPackInput` after `criteria`:

```ts
  /** R11.7.6: the owner's answers from the refinement, which the delivery follows; never dropped, like the criteria. */
  decisions?: readonly SpecDecision[];
```

add `'decisions',` to `SECTION_ORDER` right after `'criteria',`, and in `render`, right after the `criteria` section, add:

```ts
  if (input.decisions?.length) {
    out.set('decisions', `## Owner decisions (answers the owner gave during refinement; follow them)\n${input.decisions.map((d) => `- ${d.question}\n  Answer${d.by ? ` (${d.by.toUpperCase()}, from the docs)` : ''}: ${d.answer}`).join('\n')}`);
  }
```

In `server/orchestrator/steps.ts`, add `decisions: base.spec.decisions,` to the object `devPack` returns (after `criteria`), to the one `reviewPack` returns (after `criteria`), and to the one `techSpecPack` returns (after `criteria`).

In `.claude/agents/dev.md`, after the rule that starts with `- If the spec does not answer a question you need answered`, add:

```markdown
- Follow the owner's decisions the pack lists: they answer questions the docs left open, so a gap one of them answers is not a spec gap.
```

In `.claude/agents/test.md`, after the rule that starts with `- Review the impact radius`, add:

```markdown
- Judge the diff against the owner's decisions the pack lists too: a change that contradicts one is a finding.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/knowledge/context-pack.test.ts test/orchestrator/steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(orchestrator): the Dev and Test packs list the owner's decisions, never dropped for budget" -- server/knowledge/context-pack.ts server/orchestrator/steps.ts .claude/agents/dev.md .claude/agents/test.md test/knowledge/context-pack.test.ts test/orchestrator/steps.test.ts
```

### Task 2: A backlog item is frozen with the answers about its criteria

**Files:**
- Modify: `server/refine/session.ts` (`freezeItem`)
- Test: `test/api/refine-api.test.ts`

**Interfaces:**
- Consumes: `withDecisions(spec, rows)` from `server/refine/decisions.ts` (R11.7.1), which turns answered rows into decisions.

- [ ] **Step 1: Write the failing test**

In `test/api/refine-api.test.ts`, add after the test `'starts an item whose spec main retired meanwhile, frozen from planned'`:

```ts
  // R11.7.6: the owner's answer about a criterion travels with the item spec the program freezes.
  it('freezes an item with the answers to the questions about its criteria, and only those', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    const asked = [{ id: 'q1', text: 'O health responde em JSON?', blocking: false, relatedAcIds: ['AC-001'] }, { id: 'q2', text: 'Qual o nome do produto?', blocking: false, relatedAcIds: [] }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: asked, docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await call('POST', `${url}/backlog/detail`);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    for (const q of (await snapshot()).state.questions) {
      await call('POST', `${url}/answers`, { questionId: q.questionId, text: q.text.includes('JSON') ? 'Sim, application/json.' : 'Hello.' });
    }
    expect((await call('POST', `${url}/start`)).status).toBe(200);
    const file = `${home}/ws/hello-app/refine/hello-app-001/docs/specs/base/spec.json`;
    expect(JSON.parse(await fs.readFile(file, 'utf8')).decisions).toEqual([{ question: 'O health responde em JSON?', answer: 'Sim, application/json.' }]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/api/refine-api.test.ts`
Expected: FAIL. The frozen item spec has no decisions.

- [ ] **Step 3: Implement**

In `server/refine/session.ts`, in `freezeItem`, replace

```ts
    // R11.7.5: main retired it while this backlog kept it, so the owner wants it again.
    const frozen = freezeSpec(spec.status === 'retired' ? { ...spec, status: 'planned' } : spec);
```

with

```ts
    // R11.7.5: main retired it while this backlog kept it, so the owner wants it again.
    const planned = spec.status === 'retired' ? { ...spec, status: 'planned' as const } : spec;
    // R11.7.6: the owner's answers about this spec's criteria travel with it to the delivery.
    const ids = new Set(spec.acceptanceCriteria.map((c) => c.id));
    const frozen = freezeSpec(withDecisions(planned, this.state.questions.filter((q) => q.relatedAcIds.some((id) => ids.has(id)))));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/api/refine-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite, the type check and the web tests in a clean worktree**

`git worktree add --detach <scratch>/verify-84 HEAD` after committing, link `node_modules` and `web/node_modules`, run `npx vitest run`, `npx tsc --noEmit -p .` and `(cd web && npx vitest run)`, then remove the worktree.
Expected: every test passes (4 skipped), no type errors, web green.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(refine): a backlog item is frozen with the owner's answers about its criteria" -- server/refine/session.ts test/api/refine-api.test.ts
```

### Task 3: Record R11.7.6 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (R11.7)
- Modify: `docs/superpowers/plans/README.md` (row 84)

- [ ] **Step 1: Update the roadmap**

Change the R11.7 heading's status and note to `done` (`plans 76 to 80 and 84, 2026-10-12`) and add after the `Review of R11.7.5` line:

```markdown
- Built R11.7.6 (plan 84): the Dev's task and technical spec packs and the Test engineer's review pack list the spec's decisions right after its criteria, never dropped for budget, and a backlog item is frozen with the owner's answers to the refinement questions about its criteria; before it, an answer reached neither a backlog item spec nor any agent of the delivery.
```

- [ ] **Step 2: Add the plans index row**

After row 83 of `docs/superpowers/plans/README.md` (or after the last row), add:

```markdown
| 84 | [`2026-10-12-teams-ai-84-decisions-reach-delivery.md`](2026-10-12-teams-ai-84-decisions-reach-delivery.md) | Done — the Dev and Test agents read the owner's decisions, and a backlog item carries the answers about its criteria; ROADMAP R11.7.6. |
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(roadmap): R11.7.6 the owner's decisions reach the delivery, R11.7 done" -- docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
```
