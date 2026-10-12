# Plan 70 - A spec knows its pull requests (R11.5.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** from a spec a person finds every pull request that delivered it, and from a pull request the spec it belongs to.

**Architecture:** three small changes where the facts already exist. Every pull request body ends with `Spec: <specId>` (`prBody` and `docsMergeSteps` in `server/orchestrator/merge-steps.ts`). `report.json` gets `prs`, built from the `PR_CREATED`, `PR_MERGED` and `DOCS_MERGED` facts (`runPrs` in `server/orchestrator/phases/report.ts`); the repository comes from the pull request URL, so a services run names each service's repository. The run page joins a task to its pull request by the real branch, `task/<specId>-<taskId>` (`web/src/run/selectors.ts`), and shows a line when a task was moved onto the current main (`REBASE_REPLAYED`, which plan 66 left for this slice).

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest, React web app.

**Spec:** plan 66 (`docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md`), section "Design", paragraph **R11.5.5 A spec knows its pull requests**, its "Where autonomy breaks today" bullet on the ledger, and its risk line on `REBASE_REPLAYED`; roadmap item R11.5 in `docs/superpowers/ROADMAP.md`.

**Seen live (2026-10-12):** the `cancelar-pedido` run 1 opened 12 pull requests in three repositories (`loja-eventos`, `loja-eventos-estoque`, `loja-eventos-pedidos`), two of them numbered 9; none names its spec, and the run page shows no pull request for any task, since `task/cancelar-pedido-T1-add-order-cancel` never ends with `/T1-add-order-cancel`.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- Everything a human reads on the run page stays in Brazilian Portuguese; pull request bodies stay in English, as today.
- Runs journaled before readable ids, with branches `task/<specId>/<taskId>`, keep showing their pull requests.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A services run: task pull requests live in each service's repository and docs pull requests in the project's, so the ledger names each repository, and the same number in two repositories counts as two pull requests.
2. A task whose pull request opened and never merged, such as a blocked task: listed with `merged: false`.
3. A resumed run that opens the same branch's pull request again (`PR_CREATED` journaled again with `created: false`): listed once.
4. A run journaled before readable ids, with branches `task/<specId>/<taskId>`: the run page still finds its pull requests.
5. A pull request body longer than the cap: it still ends with the spec line, and the whole body stays inside the cap.

## Limits

- `report.json` lists every pull request but the docs pull request that carries `report.json` itself, which opens after the file is written.
- Pull requests opened before this change carry no spec line; their link to the spec is the run's journal and `report.json`.

---

### Task 1: Every pull request body ends with its spec

**Files:**
- Modify: `server/orchestrator/merge-steps.ts:28-43` (`prBody`), `:132` (`taskMergeSteps`), `:159-160` (`docsMergeSteps`)
- Modify: `server/orchestrator/phases/shared.ts` (`commitAndMergeDocs`, the `docsMergeSteps` call)
- Test: `test/orchestrator/merge-steps.test.ts`

**Interfaces:**
- Produces: `prBody(input: { summary; criteria; gateLines; specId: string }, secretValues)`; `docsMergeSteps(deps, branch, worktree, title, specId: string)`.

- [ ] **Step 1: Write the failing tests**

In `test/orchestrator/merge-steps.test.ts`, replace the `prBody` test with:

```ts
  it('lists summary, criteria and gate lines, redacts secrets, caps the size and ends with the spec', () => {
    const body = prBody({ summary: 'token hunter2 used', criteria: spec.acceptanceCriteria, gateLines: ['unit-test: passed', 'x'.repeat(10_000)], specId: 'spec-001' }, ['hunter2']);
    expect(body).toContain('[REDACTED]');
    expect(body).toContain('AC-001');
    expect(body.length).toBeLessThanOrEqual(8 * 1024);
    expect(body.endsWith('\n\nSpec: spec-001')).toBe(true);
    expect(prBody({ summary: 's', criteria: [], gateLines: [], specId: 'spec-001' }, []).endsWith('\n\nSpec: spec-001')).toBe(true);
  });
```

add `'spec-001'` as the last argument of the three `docsMergeSteps(...)` calls (lines 129, 145 and 188), and add to the test "merges a docs branch without gates and removes the worktree", after the title check:

```ts
    expect(gh.prs[0]!.body).toBe('Documentation update for the orchestrator run.\n\nSpec: spec-001');
```

and to the test "rebases, pushes, opens the PR, merges it guarded by the head sha and records the handoff", after `expect(gh.prs[0]!.body).toContain('did T1');`:

```ts
    expect(gh.prs[0]!.body.endsWith('\n\nSpec: spec-001')).toBe(true);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/merge-steps.test.ts`
Expected: the `prBody` case, the docs body check and the task body check FAIL (no spec line); every other case passes.

- [ ] **Step 3: Implement**

In `server/orchestrator/merge-steps.ts`, replace `prBody` with:

```ts
export function prBody(input: { summary: string; criteria: readonly AcceptanceCriterion[]; gateLines: readonly string[]; specId: string }, secretValues: readonly string[]): string {
  const text = [
    '## Summary',
    input.summary,
    '',
    '## Acceptance criteria',
    ...input.criteria.map((c) => `- **${c.id}** Given ${c.given}, when ${c.when}, then ${c.then}`),
    '',
    '## Gates',
    ...input.gateLines.map((l) => `- ${l}`),
  ].join('\n');
  const clean = redactSecrets(text, secretValues);
  // The spec line comes last and survives the cap, so every pull request names its spec.
  const spec = `\n\nSpec: ${input.specId}`;
  const limit = BODY_LIMIT - spec.length;
  return `${clean.length > limit ? `${clean.slice(0, limit - 16)}\n[... truncated]` : clean}${spec}`;
}
```

In `taskMergeSteps`, pass `specId: spec.specId` in the `prBody({ ... })` input. Change `docsMergeSteps` to:

```ts
export function docsMergeSteps(deps: MergeStepsDeps, branch: string, worktree: string, title: string, specId: string): MergeSteps {
  const base = common(deps, worktree, branch, title, async () => `Documentation update for the orchestrator run.\n\nSpec: ${specId}`, false);
```

In `server/orchestrator/phases/shared.ts` `commitAndMergeDocs`, call `docsMergeSteps(deps.mergeDeps, branch, worktree, title, deps.spec.specId)`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/orchestrator && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/merge-steps.ts server/orchestrator/phases/shared.ts test/orchestrator/merge-steps.test.ts
git commit -m "feat(merge): every pull request body ends with its spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: report.json lists the spec's pull requests

**Files:**
- Modify: `server/orchestrator/phases/report.ts:13-16` (types), a new `runPrs` after `blockReason`, `:53` (`base`)
- Create: `test/orchestrator/report-prs.test.ts`
- Test: `test/orchestrator/phase6-docs.test.ts`

**Interfaces:**
- Produces: `interface ReportPr { task: string | null; branch: string; number: number; url: string; repository: string; merged: boolean }`; `Report.prs: ReportPr[]`; `runPrs(events, specId): ReportPr[]`.

- [ ] **Step 1: Write the failing tests**

Create `test/orchestrator/report-prs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { runPrs } from '../../server/orchestrator/phases/report.js';

describe('report pull requests', () => {
  it('lists every pull request of the run once, with its task, its repository and whether it merged', () => {
    const opened = (branch: string, url: string, created = true) => ({ type: OrchEvent.PrCreated, data: { branch, number: Number(url.split('/').pop()), url, created } });
    const events = [
      opened('docs/cancelar-pedido-plan', 'https://github.com/o/loja-eventos/pull/7'),
      { type: OrchEvent.DocsMerged, data: { phase: 2, pr: 7, branch: 'docs/cancelar-pedido-plan' } },
      opened('task/cancelar-pedido-T1-add-order-cancel', 'https://github.com/o/loja-eventos-pedidos/pull/9'),
      opened('task/cancelar-pedido-T5-document-cancel-event', 'https://github.com/o/loja-eventos-estoque/pull/9'),
      // A resumed run opens the same pull request again.
      opened('task/cancelar-pedido-T1-add-order-cancel', 'https://github.com/o/loja-eventos-pedidos/pull/9', false),
      { type: OrchEvent.PrMerged, data: { taskId: 'T1-add-order-cancel', pr: 9 } },
    ];
    expect(runPrs(events, 'cancelar-pedido')).toEqual([
      { task: null, branch: 'docs/cancelar-pedido-plan', number: 7, url: 'https://github.com/o/loja-eventos/pull/7', repository: 'o/loja-eventos', merged: true },
      { task: 'T1-add-order-cancel', branch: 'task/cancelar-pedido-T1-add-order-cancel', number: 9, url: 'https://github.com/o/loja-eventos-pedidos/pull/9', repository: 'o/loja-eventos-pedidos', merged: true },
      // Same number in another repository: another pull request, and this one never merged.
      { task: 'T5-document-cancel-event', branch: 'task/cancelar-pedido-T5-document-cancel-event', number: 9, url: 'https://github.com/o/loja-eventos-estoque/pull/9', repository: 'o/loja-eventos-estoque', merged: false },
    ]);
  });
});
```

Add to `describe('Phase 6 documentation gate', ...)` in `test/orchestrator/phase6-docs.test.ts`:

```ts
  it('lists the pull requests of the run in report.json', async () => {
    await journal.fact(OrchEvent.PrCreated, { branch: 'task/spec-001-T1', number: 4, url: 'https://github.com/o/shop/pull/4', created: true });
    const r = await p6(async () => report(GOOD));
    expect(r.report.prs).toEqual([{ task: 'T1', branch: 'task/spec-001-T1', number: 4, url: 'https://github.com/o/shop/pull/4', repository: 'o/shop', merged: false }]);
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/report.json'], execCommand)).prs).toHaveLength(1);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/report-prs.test.ts test/orchestrator/phase6-docs.test.ts`
Expected: both new cases FAIL (`runPrs` is not exported; `report.prs` is undefined); every other case passes.

- [ ] **Step 3: Implement**

In `server/orchestrator/phases/report.ts`, add after the `ReportService` interface:

```ts
/** A pull request the run opened: the task its branch carries (none for a docs branch), and whether it merged. */
export interface ReportPr { task: string | null; branch: string; number: number; url: string; repository: string; merged: boolean }
```

add `prs: ReportPr[];` at the end of the `Report` interface (after `securityFindings: SecurityFinding[];`), add after `blockReason`:

```ts
/** Every pull request the run opened, once each; the repository comes from the URL, since a services run spans several. */
export function runPrs(events: readonly { type: string; data: Record<string, unknown> }[], specId: string): ReportPr[] {
  const prefix = `task/${specId}-`;
  const merged = new Set(events.flatMap((e) => (e.type === OrchEvent.PrMerged ? [`${prefix}${String(e.data.taskId)}#${String(e.data.pr)}`] : e.type === OrchEvent.DocsMerged ? [`${String(e.data.branch)}#${String(e.data.pr)}`] : [])));
  const prs = new Map<string, ReportPr>();
  for (const e of events) {
    if (e.type !== OrchEvent.PrCreated) continue;
    const branch = String(e.data.branch);
    const number = Number(e.data.number);
    const url = String(e.data.url);
    prs.set(url, { task: branch.startsWith(prefix) ? branch.slice(prefix.length) : null, branch, number, url, repository: /([^/]+\/[^/]+)\/pull\/\d+$/.exec(url)?.[1] ?? '', merged: merged.has(`${branch}#${number}`) });
  }
  return [...prs.values()];
}
```

and in `runPhase6`, add `prs: runPrs(events, deps.spec.specId)` to `base`, after `securityFindings: securityFindings(events)`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/orchestrator && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases/report.ts test/orchestrator/report-prs.test.ts test/orchestrator/phase6-docs.test.ts
git commit -m "feat(report): report.json lists the spec's pull requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The run page finds each task's pull request and shows a moved task

**Files:**
- Modify: `web/src/run/selectors.ts:251` (`taskDetail`), `:461-474` (`mergedPrs`), `describe` (a `REBASE_REPLAYED` case), `phaseActivity` (the task events it keeps)
- Test: `web/src/run/selectors.test.ts`

**Interfaces:**
- Consumes: the facts `PR_CREATED { branch, number, url }`, `PR_MERGED { taskId, pr }`, `REBASE_REPLAYED { taskId, previous, files }`.

- [ ] **Step 1: Write the failing tests**

In `web/src/run/selectors.test.ts`, add `mergedPrs` to the import from `./selectors.js`, add to `describe('phase activity', ...)`:

```ts
  it('a task moved onto the current main says whether conflicts are left to resolve', () => {
    const out = phaseActivity(
      evs([
        ['PHASE_STARTED', { phase: 3 }],
        ['REBASE_REPLAYED', { taskId: 'T2', previous: 'abc', files: ['src/a.ts', 'src/b.ts'] }],
        ['REBASE_REPLAYED', { taskId: 'T3', previous: 'def', files: [] }],
      ]),
    ).get(3)!;
    expect(out.items.map((i) => [i.text, i.tone])).toEqual([
      ['Tarefa T2 movida para a main atual, com conflitos a resolver em src/a.ts, src/b.ts', 'bad'],
      ['Tarefa T3 movida para a main atual, sem conflitos', ''],
    ]);
  });
```

and at the end of the file:

```ts
describe('pull requests of tasks', () => {
  const ev = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq, at: '2026-10-12T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact', data });
  const list = [
    ev(1, 'PR_CREATED', { branch: 'task/cancelar-pedido-T11', number: 13, url: 'https://github.com/o/r/pull/13', created: true }),
    ev(2, 'PR_CREATED', { branch: 'task/cancelar-pedido-T1', number: 14, url: 'https://github.com/o/r/pull/14', created: true }),
    ev(3, 'PR_MERGED', { taskId: 'T1', pr: 14 }),
  ];

  it('joins a task to the pull request of its real branch, task/<specId>-<taskId>, and never to a longer id', () => {
    expect(taskDetail(list, 'T1').pr).toEqual({ number: 14, url: 'https://github.com/o/r/pull/14' });
    expect(mergedPrs(list)).toEqual([{ taskId: 'T1', number: 14, url: 'https://github.com/o/r/pull/14' }]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npx vitest run src/run/selectors.test.ts`
Expected: both new cases FAIL (no activity line; no pull request found, an empty URL); the existing fixture case with `task/hello-001/T1` still passes.

- [ ] **Step 3: Implement**

In `web/src/run/selectors.ts`, add before `taskDetail`:

```ts
/** A task's branch is task/<specId>-<taskId>; runs before readable ids used task/<specId>/<taskId>. */
const isTaskBranch = (branch: string, taskId: string): boolean => branch.startsWith('task/') && (branch.endsWith(`-${taskId}`) || branch.endsWith(`/${taskId}`));
```

In `taskDetail`, replace `if (String(d.branch).endsWith(`/${taskId}`))` with `if (isTaskBranch(String(d.branch), taskId))`. In `mergedPrs`, replace `.find(([b]) => b.endsWith(`/${taskId}`))` with `.find(([b]) => isTaskBranch(b, taskId))`.

In `describe`, add before `case 'TASK_BLOCKED':`:

```ts
    case 'REBASE_REPLAYED': {
      const files = list(d.files);
      return item(`Tarefa ${String(d.taskId)} movida para a main atual${files.length ? `, com conflitos a resolver em ${files.join(', ')}` : ', sem conflitos'}`, files.length ? 'bad' : '');
    }
```

In `phaseActivity`, keep the new line with the other task events: replace `(!task || e.type === 'PR_MERGED' || e.type === 'TASK_BLOCKED')` with `(!task || e.type === 'PR_MERGED' || e.type === 'TASK_BLOCKED' || e.type === 'REBASE_REPLAYED')`.

- [ ] **Step 4: Run them to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/run/selectors.ts web/src/run/selectors.test.ts
git commit -m "fix(web): the run page finds each task's pull request by its real branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Record R11.5.5 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (section `### R11.5 Autonomy hardening`, after the R11.5.4 lines)
- Modify: `docs/superpowers/plans/README.md` (the table, after row 69)

- [ ] **Step 1: Update the roadmap**

Add after the last R11.5.4 line:

```md
- Built R11.5.5 (plan 70): every pull request body ends with `Spec: <specId>` (`prBody`, `docsMergeSteps`); `report.json` lists `prs`, each with its task (none for a docs branch), branch, number, URL, repository and whether it merged, built from the `PR_CREATED`, `PR_MERGED` and `DOCS_MERGED` facts (`runPrs`); the run page finds each task's pull request by its real branch `task/<specId>-<taskId>`, which it never matched before, and shows a line when a task was moved onto the current main (`REBASE_REPLAYED`).
```

- [ ] **Step 2: Update the plans index**

Add after row 69 of `docs/superpowers/plans/README.md`:

```md
| 70 | [`2026-10-12-teams-ai-70-spec-pull-requests.md`](2026-10-12-teams-ai-70-spec-pull-requests.md) | Done — pull requests name their spec, report.json lists the spec's pull requests, and the run page finds each task's pull request; ROADMAP R11.5.5. |
```

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.5.5 a spec knows its pull requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
