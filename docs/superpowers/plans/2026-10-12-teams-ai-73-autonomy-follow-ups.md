# Plan 73 - Autonomy hardening follow-ups (R11.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close every gap the independent reviews of plans 68 to 72 left open, so R11.5 has no known defect left.

**Architecture:** five small groups, one per slice, each where the gap lives: the program blocks an item whose dependency names no item; backlog keys refuse only the branches that share a repository; the API check reads endpoints after an HTTP method and outside code blocks; the squash commit on main carries the spec line, and the run page drops the wrong fallbacks; the delivery round also repairs a blocked criterion, and the program and the run page explain a failure that comes only from blocked work; the answer step runs on Sonnet from the second cycle, reads the floor at each evaluation, trusts only Jev's routes, never answers a contradiction meant for the human, and the eval reads several projects and shows the band right above its floor.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest, React web app.

**Spec:** plan 66 (`docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md`), its section "Design"; the review lines of R11.5.3 to R11.5.7 in `docs/superpowers/ROADMAP.md`, which list these gaps.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; a rename with no behavior change rides with the task's tests; the whole suite stays green after each task.
- Agent prompts and pull request bodies stay in English; everything a human reads stays in Brazilian Portuguese.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A program saved before dependencies used the items' real ids: its dependent item ends blocked with a reason instead of waiting forever.
2. A squash merge whose body is the pull request body: GitHub keeps it as the commit message on main, and an empty body leaves today's default.
3. A delivery round where both files are missing and a criterion's tasks all blocked: one planned round holds both kinds of fix, with ids that never collide.
4. A refinement draft whose routes come from the local model (Jev skipped): no auto answer and no eval sample, whatever the confidence.
5. A history contradiction routed `auto` with high confidence: it stays with the human.

## Limits

- The floor itself stays unset: only labelled answers, collected over real refinements, can set it.

---

### Task 1: Program dependencies and backlog keys

**Files:**
- Modify: `server/program/controller.ts:171-183` (the blocking loop of `tick`)
- Modify: `server/validators/backlog.ts:9-10` (`BRANCH_TAIL`)
- Modify: `docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md:54` (R11.5.3 paragraph)
- Test: `test/program/controller.test.ts`, `test/validators/backlog.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/program/controller.test.ts`, add to `describe('program controller', ...)`:

```ts
  it('blocks an item whose dependency names no item of the program, so a wrong id shows instead of stalling', async () => {
    const { fx, calls } = world();
    // A program saved before dependencies used the items' real ids names d-shop-a, which no item is.
    let p = newProgram('d', [entry('a', 1), { specId: 'd-b', key: 'b', rank: 2, dependsOn: ['d-shop-a'] }], NOW);
    p = await tick(p, fx, save);
    expect(status(p)).toEqual({ a: 'running', b: 'blocked' });
    expect(p.items[1]!.reason).toBe('depends on d-shop-a, which names no item of this program');
    expect(calls).toEqual(['start d-a']);
  });
```

In `test/validators/backlog.test.ts`, drop `'pricing-orders-workflows'` from the list of the test "rejects a key that is another key plus a branch suffix, since both specs would share that docs branch", and add to the test "accepts keys that only look like a branch suffix when no other key is their start":

```ts
    // A service's workflows branch lives in the service's own repository, where no other spec has docs branches.
    expect(check(backlog([item('pricing', { priority: 'P0' }), item('pricing-orders-workflows')]))).toEqual([]);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/program/controller.test.ts test/validators/backlog.test.ts`
Expected: the controller case FAILS (b stays pending) and the new accept line FAILS (the key is refused).

- [ ] **Step 3: Implement**

In `server/program/controller.ts`, replace the blocking loop with:

```ts
  // A dependent of a failed or blocked item can never run, nor one whose dependency names no item: block it, transitively.
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of p.items) {
      if (item.status !== 'pending') continue;
      const unknown = item.dependsOn.find((d) => !p.items.some((i) => i.specId === d));
      const bad = item.dependsOn.map((d) => p.items.find((i) => i.specId === d)).find((d) => d !== undefined && (d.status === 'failed' || d.status === 'blocked'));
      if (!unknown && !bad) continue;
      item.status = 'blocked';
      item.reason = unknown ? `depends on ${unknown}, which names no item of this program` : `depends on ${bad!.key}, which ${bad!.status === 'failed' ? 'failed' : 'is blocked'}`;
      item.finishedAt = stamp();
      changed = dirty = true;
    }
  }
```

In `server/validators/backlog.ts`, replace the `BRANCH_TAIL` lines with:

```ts
/** What follows `<spec>-` in a spec's docs branches in the project's repository; a service's workflows branch lives in that service's. */
const BRANCH_TAIL = /^(?:plan|report|done|readme|workflows|v\d+)$/;
```

In the plan 66 R11.5.3 paragraph, replace "A key may not end in a branch suffix (`-plan`, `-report`, `-done`, `-readme`, `-workflows`, `-v<n>`) nor equal another key plus one;" with "A key may not equal another key plus a branch suffix (`-plan`, `-report`, `-done`, `-readme`, `-workflows`, `-v<n>`), since spec ids are the bare keys; a key alone that ends in one shares no branch;".

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/program test/validators test/refine && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/program/controller.ts server/validators/backlog.ts docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md test/program/controller.test.ts test/validators/backlog.test.ts
git commit -m "fix(program): an unknown dependency blocks its item, and keys share no other repository's branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Endpoints the current API.md documents

**Files:**
- Modify: `server/validators/docs.ts` (a new `documentedEndpoints`; `validateApiDocs`)
- Modify: `server/orchestrator/phases/report.ts:76` (rename the shadowing `current`)
- Test: `test/validators/docs.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/validators/docs.test.ts`, add `documentedEndpoints` to the import and add to `describe('validateApiDocs', ...)`:

```ts
  it('reads the endpoints of the current docs/API.md after their methods and outside code blocks', () => {
    const current = ['# API', '', '| Método | Rota |', '|DELETE|/stock/{sku}/reservas|', '', '**GET**/legacy', '', '```', 'curl -X POST /app/data/pedidos.json', '```', '', 'Os logs ficam em /var/log/loja.log.'].join('\n');
    expect(documentedEndpoints(current)).toEqual(['/stock/{sku}/reservas', '/legacy']);
    expect(validateApiDocs('### DELETE /stock/{sku}/reservas\n\n### GET /legacy', [], current)).toEqual([]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/validators/docs.test.ts`
Expected: FAIL (`documentedEndpoints` is not exported).

- [ ] **Step 3: Implement**

In `server/validators/docs.ts`, add after `featureEndpoints`:

```ts
const METHOD_PATH = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[\s*`|]*(\/[\w\-./:{}]*[\w}])/g;

/** Endpoint paths an API document names after an HTTP method, outside code blocks, where file paths and examples live. */
export function documentedEndpoints(md: string): string[] {
  const out = new Set<string>();
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence) for (const m of line.matchAll(METHOD_PATH)) out.add(m[1]!);
  }
  return [...out];
}
```

and in `validateApiDocs` replace `featureEndpoints([current])` with `documentedEndpoints(current)`.

In `server/orchestrator/phases/report.ts`, in the `awaiting-validation` branch, rename `const current = JSON.parse(...)` and its use to `specJson`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/validators test/orchestrator/phase6-docs.test.ts test/orchestrator/run.test.ts && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/validators/docs.ts server/orchestrator/phases/report.ts test/validators/docs.test.ts
git commit -m "fix(docs): the API check reads endpoints after their methods, outside code blocks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Pull requests on main and on the run page

**Files:**
- Modify: `server/git/github.ts:101-109` (`mergePr`), `server/orchestrator/merge-steps.ts` (`common().merge`), `test/fixtures/fake-gh.ts` (`merge`, `FakePr`)
- Modify: `web/src/pages/Run.tsx:521` (`repoUrl`), `web/src/run/selectors.ts` (`mergedPrs`, the `REBASE_REPLAYED` line)
- Test: `test/git/github.test.ts`, `test/orchestrator/merge-steps.test.ts`, `web/src/pages/Run.test.tsx`, `web/src/run/selectors.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/git/github.test.ts`, add to `describe('prState and mergePr', ...)`:

```ts
  it('gives the squash commit the pull request body, so main carries the spec line', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"OPEN","headRefOid":"abc"}' }))
      .onArgs('gh', ['pr', 'merge'], () => ({ stdout: '' }));
    expect(await mergePr({ cwd, number: 45, headSha: 'abc', body: '## Summary\ns\n\nSpec: spec-001' }, fake.exec)).toEqual({ merged: true, already: false });
    expect(fake.lines('gh')[1]).toBe('pr merge 45 --squash --match-head-commit abc --body-file -');
  });
```

In `test/orchestrator/merge-steps.test.ts`, add to "rebases, pushes, opens the PR, merges it guarded by the head sha and records the handoff", after the body checks:

```ts
    expect(gh.prs[0]!.mergeBody?.endsWith('\n\nSpec: spec-001')).toBe(true);
```

In `web/src/pages/Run.test.tsx`, add to "links to the project repository on GitHub, falling back to a merged PR URL":

```ts
    cleanup();
    // A server that knows the repository has no GitHub address: no link to a service's repository instead.
    render(view({ detail: { ...detail, repoUrl: null } }));
    expect(screen.queryByTestId('github-link')).toBeNull();
```

(import `cleanup` from `@testing-library/react` if the file does not already). In `web/src/run/selectors.test.ts`, change `'Tarefa T3 movida para a main atual, sem conflitos'` to `'Tarefa T3 movida para a main atual, sem conflitos a resolver'`, and add to `describe('pull requests of tasks', ...)`:

```ts
  it('finds the pull request of a run before readable ids, and never joins T1 to T1-fix', () => {
    const old = [ev(1, 'PR_CREATED', { branch: 'task/hello-001/T1', number: 3, url: 'https://github.com/o/r/pull/3', created: true }), ev(2, 'PR_MERGED', { taskId: 'T1', pr: 3 })];
    expect(mergedPrs(old)).toEqual([{ taskId: 'T1', number: 3, url: 'https://github.com/o/r/pull/3' }]);
    const fix = [ev(1, 'PR_CREATED', { branch: 'task/spec-T1-fix', number: 8, url: 'https://github.com/o/r/pull/8', created: true })];
    expect(taskDetail(fix, 'T1').pr).toBeNull();
    expect(taskDetail(fix, 'T1-fix').pr).toEqual({ number: 8, url: 'https://github.com/o/r/pull/8' });
  });

  it('lists no merged pull request for an empty merge, which opened none', () => {
    const empty = [ev(1, 'PR_CREATED', { branch: 'task/spec-T1', number: 5, url: 'https://github.com/o/r/pull/5', created: true }), ev(2, 'PR_MERGED', { taskId: 'T1', pr: 0 })];
    expect(mergedPrs(empty)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/git/github.test.ts test/orchestrator/merge-steps.test.ts` and, from `web/`, `npx vitest run src/pages/Run.test.tsx src/run/selectors.test.ts`
Expected: the squash body case, the merge-steps line, the Run fallback case, the "sem conflitos a resolver" line and the empty merge case FAIL; the old-branch case passes already.

- [ ] **Step 3: Implement**

In `server/git/github.ts`, `mergePr` takes `body?: string` in its input and merges with:

```ts
  // The squash commit takes the pull request body, so main carries the spec line too.
  const r = await gh(input.cwd, ['pr', 'merge', String(input.number), '--squash', '--match-head-commit', input.headSha, ...(input.body ? ['--body-file', '-'] : [])], exec, input.body);
```

In `server/orchestrator/merge-steps.ts`, the merge effect calls `mergePr({ cwd: repo, number, headSha: sha, body: await body() }, deps.ghExec)`. In `test/fixtures/fake-gh.ts`, add `mergeBody?: string;` to `FakePr` and `pr.mergeBody = s.stdin;` in the `merge` case, before the push.

In `web/src/pages/Run.tsx`, the fallback becomes:

```ts
  // Older servers do not send repoUrl; a merged PR URL still names the repository. A null repoUrl means the repository has no GitHub address.
  const repoUrl = detail.repoUrl === undefined ? prs.find((p) => p.url)?.url?.replace(/\/pull\/\d+.*$/, '') ?? null : detail.repoUrl;
```

In `web/src/run/selectors.ts`, `mergedPrs` skips an empty merge with `if (!Number.isFinite(number) || number === 0) continue;`, and the `REBASE_REPLAYED` line says `', sem conflitos a resolver'`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/git test/orchestrator && npx tsc --noEmit -p .` and, from `web/`, `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, both type checks clean.

- [ ] **Step 5: Commit**

```bash
git add server/git/github.ts server/orchestrator/merge-steps.ts test/fixtures/fake-gh.ts web/src/pages/Run.tsx web/src/run/selectors.ts test/git/github.test.ts test/orchestrator/merge-steps.test.ts web/src/pages/Run.test.tsx web/src/run/selectors.test.ts
git commit -m "fix(merge): the squash commit carries the spec line, and the run page drops wrong fallbacks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Blocked work in the delivery round, the program and the run page

**Files:**
- Modify: `server/orchestrator/phases/verify.ts:94-176` (`blockedTasks`, a new `smFixTasks`, the delivery branch, the gates branch)
- Modify: `server/orchestrator/steps.ts` (`fixTasksPack` blocked lines)
- Modify: `server/program/service.ts` (the failure reason)
- Modify: `web/src/run/selectors.ts` (`STOP_RULES`), `web/src/pages/Validation.test.tsx` (a comment on the fixture)
- Test: `test/orchestrator/verify-blocked.test.ts`, `test/orchestrator/steps.test.ts`, `test/program/service.test.ts`, `web/src/run/selectors.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/orchestrator/verify-blocked.test.ts`, give `setup` a second parameter `over: Partial<{ delivery: Record<string, unknown>; junit: GateResult['junit'] }> = {}`, build the plan with `makePlan(spec, { tasks: [t1, t2, t3], ...(over.delivery ? { delivery: over.delivery } : {}) })` and the gate with `{ ...gate, junit: over.junit ?? gate.junit }`, and add:

```ts
  it('passes a criterion whose test passed even though its task blocked afterwards, since tests come first', async () => {
    const junit = [...gate.junit!, { id: 't::[AC-002] works', name: '[AC-002] works', classname: 't', status: 'passed' as const, acIds: ['AC-002'] }];
    const res = await runPhase4(await setup([], { junit }), 1);
    expect(res.ok).toBe(true);
  });

  it('repairs a blocked criterion in the delivery round too, since round 2 is the verdict', async () => {
    const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/run.test.ts', readmeSections: ['Run'] };
    const res = await runPhase4(await setup([[fix()]], { delivery }), 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fixTasks?.map((t) => [t.id, t.owner, t.criteriaRefs])).toEqual([['T900-fix-1', 'devops', []], ['T900-fix-2', 'dev', []], ['T900-fix-3', 'dev', ['AC-002']]]);
    expect(packs[0]).toContain('Criteria without passed evidence:\n- AC-002');
  });
```

In `test/orchestrator/steps.test.ts`, add to "fix-tasks pack names the service of each existing task":

```ts
    const blocked = fixTasksPack(base, { failedTests: [], tails: '', uncoveredAcs: [], blocked: [{ taskId: 'T2', reason: 'stuck', service: 'inventory' }], plan: { tasks: plan.tasks, gates: [] }, services: ['orders', 'inventory'], boundaries: [], feedback: null });
    expect(blocked.feedback).toContain('- T2 (inventory): stuck');
```

In `test/program/service.test.ts`, add to "a completion run that ended done is done; every other end is a failure with its reason":

```ts
    await journal('e-r1', [started('e'), finished('verification-failed', { reason: 'verification failed in round 2: 0 failing tests, 1 uncovered criteria', blocked: [{ taskId: 'T2', reason: 'the Dev found no way' }, { taskId: 'T3', reason: 'a dependency is blocked' }] })]);
    expect(await s.outcome('e-r1')).toEqual({ kind: 'failed', reason: 'verification-failed: verification failed in round 2: 0 failing tests, 1 uncovered criteria; blocked: T2 (the Dev found no way)', costUsd: null });
```

In `web/src/run/selectors.test.ts`, add near the other `explainStop` cases:

```ts
  it('explains a round 2 failure that comes only from criteria left without evidence', () => {
    expect(explainStop('verification failed in round 2: 0 failing tests, 1 uncovered criteria')?.title).toBe('Critérios de aceitação ficaram sem evidência');
    expect(explainStop('verification failed in round 2: 2 failing tests, 0 uncovered criteria')?.title).toBe('Os testes de aceitação não passaram');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/verify-blocked.test.ts test/orchestrator/steps.test.ts test/program/service.test.ts` and, from `web/`, `npx vitest run src/run/selectors.test.ts`
Expected: the delivery round case, the service line, the program reason and the stop title FAIL; the "tests come first" case passes already, since it pins the plan's constraint.

- [ ] **Step 3: Implement**

In `server/orchestrator/phases/verify.ts`, `blockedTasks` becomes:

```ts
const blockedTasks = (deps: PhaseDeps) => [...deps.tasks!()].filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: blockReason(deps.journal.events, t.def.id), ...(t.def.service ? { service: t.def.service } : {}) }));
```

add after `fixTaskErrors`:

```ts
/** Asks the SM for 1 to 3 fix tasks; `planned` are fix tasks this round already holds, so the new ids come after theirs. */
async function smFixTasks(deps: PhaseDeps, repos: ServiceRepo[], input: { failedTests: string[]; tails: string; uncoveredAcs: string[]; cwd: string; planned?: PlanTask[] }): Promise<{ tasks: PlanTask[] } | { reason: string }> {
  const services = deps.services;
  // The SM plans across every service: their tasks and test gates.
  const plan = services ? { tasks: services.plan.tasks, gates: repos.flatMap((r) => r.plan.gates) } : deps.plan!;
  const planned = input.planned ?? [];
  let feedback: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runAgent<'fix-tasks'>({ kind: 'fix-tasks', role: 'sm', pack: fixTasksPack(deps.packBase(), { failedTests: input.failedTests, tails: input.tails, uncoveredAcs: input.uncoveredAcs, blocked: blockedTasks(deps), plan, ...(services ? { services: Object.keys(services.plan.services) } : {}), boundaries: deps.boundaries ? await deps.boundaries() : [], feedback }), cwd: input.cwd, phase: 'phase4', taskId: null, attempt }) as StepOutcome<FixTasksOutput>;
    if (!out.ok) { if (await pauseForFailure(deps, out.failure)) return { reason: PAUSED_AUTH }; feedback = out.errors.join('\n'); continue; }
    // Ids are assigned here and must stay unique across rounds and resumes.
    const existing = [...deps.journal.state.tasks.keys()].filter((id) => id.startsWith('T900-fix-')).length + planned.length;
    const fixTasks = out.value.tasks.map((t, i) => ({ ...t, id: `T900-fix-${existing + i + 1}`, origin: 'fix' as const }));
    const errors = fixTaskErrors(deps, [...planned, ...fixTasks]);
    if (errors.length) { feedback = errors.join('\n'); continue; }
    return { tasks: fixTasks };
  }
  return { reason: `fix-tasks rejected twice: ${feedback ?? 'no answer'}` };
}
```

in the delivery branch, replace the two lines from `await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: fixTasks, round });` with:

```ts
    // Round 1 is the only repair: a criterion whose every task is blocked gets its fix task in this round too.
    const blockedAcs = buildEvidenceMatrix(deps.spec, deps.tasks(), []).filter((r) => r.status === 'blocked').map((r) => r.criterion);
    const sm = blockedAcs.length > 0 ? await smFixTasks(deps, repos, { failedTests: [], tails: '', uncoveredAcs: blockedAcs, cwd: repos[0]!.ws.repo, planned: fixTasks }) : { tasks: [] };
    if ('reason' in sm && sm.reason === PAUSED_AUTH) return { ok: false, reason: PAUSED_AUTH };
    const all = 'tasks' in sm ? [...fixTasks, ...sm.tasks] : fixTasks;
    await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: all, round });
    return { ok: false, reason: `${reason}; fix tasks planned`, fixTasks: all };
```

and replace everything after the `round === 2` return of the gates branch with:

```ts
  const sm = await smFixTasks(deps, repos, { failedTests, tails: tail(results.map((r) => `${r.name}: ${r.stderrTail || r.stdoutTail}`).join('\n')), uncoveredAcs, cwd: (failing ?? repos[0]!).ws.repo });
  if ('reason' in sm) return { ok: false, reason: sm.reason };
  await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: sm.tasks, round });
  return { ok: false, reason: 'verification failed; fix tasks planned', fixTasks: sm.tasks };
```

In `server/orchestrator/steps.ts` `fixTasksPack`, the `blocked` option becomes `ReadonlyArray<{ taskId: string; reason: string; service?: string }>` and its line prints `` `- ${b.taskId}${b.service ? ` (${b.service})` : ''}: ${b.reason}` ``.

In `server/program/service.ts`, the `default` case of `outcome` becomes:

```ts
      default: {
        const data = await finished();
        // The tasks that blocked on their own cause tell why criteria went without evidence; their dependents add nothing.
        const own = (data?.blocked ?? []).filter((b) => b.reason !== 'a dependency is blocked').map((b) => `${b.taskId} (${b.reason})`);
        return { kind: 'failed', reason: `${row.status}${data?.reason ? `: ${String(data.reason).slice(0, 400)}` : ''}${own.length ? `; blocked: ${own.join('; ').slice(0, 400)}` : ''}`, costUsd: data?.tokens?.costUsd ?? null };
      }
```

In `web/src/run/selectors.ts`, add before the `^verification failed in round 2` rule:

```ts
  [/^verification failed in round 2: 0 failing tests/, { title: 'Critérios de aceitação ficaram sem evidência', hint: 'Nenhum teste falhou, mas critérios ficaram sem teste aprovado, quase sempre porque as tarefas deles bloquearam. Veja os bloqueios na lista de tarefas e reprocesse a spec.', owner: 'Sistema' }],
```

In `web/src/pages/Validation.test.tsx`, add above the `report` fixture: `// A report from before R11.5.6, when a criterion whose tasks all blocked could still reach validation; the page still reads such reports.`

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/orchestrator test/program test/evidence && npx tsc --noEmit -p .` and, from `web/`, `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, both type checks clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases/verify.ts server/orchestrator/steps.ts server/program/service.ts web/src/run/selectors.ts web/src/pages/Validation.test.tsx test/orchestrator/verify-blocked.test.ts test/orchestrator/steps.test.ts test/program/service.test.ts web/src/run/selectors.test.ts
git commit -m "fix(verify): the delivery round repairs blocked criteria, and failures name blocked work

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Answers from the docs before the floor is set

**Files:**
- Modify: `server/config/config.ts:117` (`laterCycleModels` default)
- Modify: `server/refine/cycle.ts` (route `source`, contradiction ids, eligibility)
- Modify: `server/refine/session.ts` (`autoAnswerFloor` getter), `server/refine/registry.ts:80`
- Modify: `server/decide/evals.ts` (`routingSamples`, a new `precisionNearFloor`), `scripts/evals/question-routing.ts`
- Modify: `web/src/pages/Refinement.tsx` (an `InfoTip` on the mark)
- Test: `test/config/decisions.test.ts`, `test/refine/cycle.test.ts`, `test/refine/session.test.ts`, `test/decide/evals.test.ts`, `web/src/pages/Refinement.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `test/config/decisions.test.ts`, add to "per-decision defaults follow the spec escalation column":

```ts
    // The answer step reads five documents for one question: Sonnet from the second cycle on, as the other refinement checklists.
    expect(DEFAULT_CONFIG.routing.laterCycleModels.answer).toBe('sonnet');
```

In `test/refine/cycle.test.ts`, give `autoRouted` a third parameter `over: { answer?: string | null; ok?: boolean; backend?: 'jev' | 'local'; contradiction?: boolean; decider?: unknown; confidential?: boolean } = {}`: the `answer` branch returns `over.ok === false ? { ok: false, failure: 'schema', errors: ['bad'], summary: {} } : ok({ specHash: 'draft', answer: over.answer === undefined ? 'project.md diz 8080.' : over.answer })`; derive returns `project: { ...makeProject(), ...(over.confidential ? { confidential: true } : {}) }`; the decider answers `history-contradiction` with `{ answered: true, backend: 'jev', escalated: false, answers: { q0: { type: 'noul', value: 1, probabilities: { yes: 1, no: 0 }, confidence: 1 } } }` when `over.contradiction`, routes with `backend: over.backend ?? 'jev'` and the confidence of the first scripted question the state names, else 0.99; `run` passes `decider: over.decider ?? decider` and `retrieval: () => (over.contradiction ? [{ chunkId: 'c', docId: 'd', kind: 'spec', title: 'Spec 1', heading: 'Decisões', snippet: 'a porta é 9090', text: 'A porta é 9090.', score: 1 }] : [])`. Then add:

```ts
  it('leaves the question with the human when the answer step returns null or fails', async () => {
    for (const over of [{ answer: null }, { ok: false }]) {
      const r = await autoRouted({ 'Which port?': 0.95 }, undefined, over);
      await r.run(0.9);
      expect(r.events.some((e) => e.type === 'QUESTION_ANSWERED')).toBe(false);
      expect(r.events.some((e) => e.type === 'REFINE_CYCLE_FAILED')).toBe(false);
    }
  });

  it('answers only what Jev routed: a route from the local model is no measured route', async () => {
    const r = await autoRouted({ 'Which port?': 0.99 }, undefined, { backend: 'local' });
    await r.run(0.9);
    expect(r.answered).toEqual([]);
  });

  it('never answers a history contradiction, which exists for the human to decide', async () => {
    const r = await autoRouted({ 'Which port?': 0.5 }, undefined, { contradiction: true });
    await r.run(0.9);
    const evaluated = r.events.find((e) => e.type === 'REFINE_EVALUATED')!.data.questions as Array<{ text: string }>;
    expect(evaluated.some((q) => q.text.startsWith('The new spec seems to contradict earlier project history'))).toBe(true);
    expect(r.answered).toEqual([]);
  });

  it('routes nothing on a confidential draft, where the decider skips Jev, so nothing is answered', async () => {
    const jev = { evaluate: async () => { throw new Error('a confidential draft never reaches Jev'); } };
    const decider = new Decider({ backends: { jev } as never, config: () => ({ enabled: true, chain: ['jev', 'local'], thresholds: { jev: 0.8, local: 0.9 }, escalateTo: 'po' }), onDecision: () => undefined, clock: () => new Date() });
    const r = await autoRouted({ 'Which port?': 0.99 }, undefined, { decider, confidential: true });
    await r.run(0.9);
    expect(r.events.find((e) => e.type === 'REFINE_EVALUATED')!.data.questionRouting).toEqual({});
    expect(r.answered).toEqual([]);
  });
```

(import `Decider` from `../../server/decide/decider.js`). In `test/refine/session.test.ts`, add:

```ts
  it('reads the auto answer floor at each evaluation, and the next cycle sees the answer a role gave from the docs', async () => {
    let floor: number | undefined = 0.9;
    const decider = { decide: async (id: string) => (id === 'question-routing' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { route: { type: 'choice' as const, value: 'auto', probabilities: { auto: 0.95 }, confidence: 0.95 } } } : { answered: false as const, reason: 'disabled' as const }) };
    const s = await RefineSession.create({ ...deps(), decider: decider as never, autoAnswerFloor: async () => floor }, 'new-project');
    script['derive/po'] = [derived, derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }]), refineOut(green(PO), [{ id: 'q2', text: 'Name?', blocking: true, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM)), refineOut(green(SM))];
    script['answer/po'] = [{ answer: 'project.md › Execução: 8080.' }];
    await s.evaluate();
    expect(s.state.questions.find((q) => q.questionId === 'po-c1-0')).toMatchObject({ status: 'answered', answeredBy: 'po' });
    floor = undefined;
    await s.evaluate();
    expect(calls.filter((c) => c.kind === 'answer')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'refine').at(-1)!.prompt).toContain('project.md › Execução: 8080.');
    expect(s.state.questions.find((q) => q.questionId === 'po-c2-0')).toMatchObject({ status: 'pending' });
    await s.close();
  });
```

In `test/decide/evals.test.ts`, add `source: 'jev'` to every route of the test "labels each routed question with its answer, and leaves out the ones nobody answered yet", add `'po-c1-2': { route: 'auto', confidence: 0.97, source: 'local' }` to its routes with `{ type: 'QUESTION_ANSWERED', data: { questionId: 'po-c1-2', text: 'x', docsAnswered: true } }` (still two samples), add `precisionNearFloor` to the import, and add:

```ts
  it('shows the precision of the band right above the floor, which the overall precision can hide', () => {
    const auto = (confidence: number, docsAnswered = true) => ({ route: 'auto', confidence, docsAnswered });
    const samples = [...Array.from({ length: 100 }, () => auto(0.99)), ...[0.9, 0.89, 0.88, 0.87, 0.86].map((c) => auto(c, false))];
    expect(autoAnswerFloor(samples)).toBeCloseTo(0.86);
    expect(precisionNearFloor(samples, 0.86)).toBe(0.5);
    expect(precisionNearFloor([], 0.9)).toBeNull();
  });
```

In `web/src/pages/Refinement.test.tsx`, add to "lets the owner mark that the documents already answered a question":

```ts
    expect(screen.getByLabelText(/medem quando o Jev pode responder sozinho/)).toBeTruthy();
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/config/decisions.test.ts test/refine test/decide/evals.test.ts` and, from `web/`, `npx vitest run src/pages/Refinement.test.tsx`
Expected: the model default, the local-route case, the contradiction case, the session case, the eval cases and the web tip FAIL; the null/failure case and the confidential case pass already, since they pin behavior the auto answer must keep.

- [ ] **Step 3: Implement**

In `server/config/config.ts`, the `laterCycleModels` default gets `answer: 'sonnet'`.

In `server/refine/cycle.ts`: the `questionRouting` type gets `source?: string` and each entry records `source: r.source`; before decision 4 add `const forHuman = new Set<string>();` and give each history question its id from a local `const id = ...`, adding `forHuman.add(id)`; the eligibility filter becomes `q.blocking && !forHuman.has(q.questionId) && r?.route === 'auto' && r.source === 'jev' && r.confidence !== null && r.confidence >= floor`.

In `server/refine/session.ts`, `SessionDeps.autoAnswerFloor` becomes `autoAnswerFloor?: () => Promise<number | undefined>;` with the comment `/** Read at each evaluation, so a floor set in the config reaches drafts already open. */`, and the `runCycle` deps get `autoAnswerFloor: await this.deps.autoAnswerFloor?.()`. In `server/refine/registry.ts`, `session` passes `autoAnswerFloor: async () => (await this.deps.cfg()).decisions.autoAnswerFloor`.

In `server/decide/evals.ts`, `routingSamples` keeps only routes with `source === 'jev'` (type `{ route: string; confidence: number | null; source?: string }`), and add:

```ts
/** The share of the `n` least confident questions routed `auto` at or above the floor that the documents answered: the band the overall precision can hide. */
export function precisionNearFloor(samples: readonly RoutingSample[], floor: number, n = 10): number | null {
  const near = samples.filter((s) => s.route === 'auto' && s.confidence !== null && s.confidence >= floor).sort((a, b) => a.confidence! - b.confidence!).slice(0, n);
  return near.length === 0 ? null : near.filter((s) => s.docsAnswered).length / near.length;
}
```

In `scripts/evals/question-routing.ts`, read every `--refine <dir>` given (`process.argv.flatMap((a, i) => (process.argv[i - 1] === '--refine' ? [a] : []))`), and print `precisionNearFloor` next to `floor` (null when the floor is null).

In `web/src/pages/Refinement.tsx`, add after the mark's text `<InfoTip text="Marque quando a resposta já estava nos documentos: essas marcas medem quando o Jev pode responder sozinho." />`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/config test/refine test/decide test/api && npx tsc --noEmit -p .` and, from `web/`, `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, both type checks clean.

- [ ] **Step 5: Commit**

```bash
git add server/config/config.ts server/refine/cycle.ts server/refine/session.ts server/refine/registry.ts server/decide/evals.ts scripts/evals/question-routing.ts web/src/pages/Refinement.tsx test/config/decisions.test.ts test/refine/cycle.test.ts test/refine/session.test.ts test/decide/evals.test.ts web/src/pages/Refinement.test.tsx
git commit -m "fix(refine): answers from the docs trust only Jev, read the floor each time and spare contradictions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Record the follow-ups

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (after the R11.5.7 review line), `docs/superpowers/plans/README.md` (after row 72)

- [ ] **Step 1: Update the roadmap and the index**

Add after the R11.5.7 review line:

```md
- Built the R11.5 follow-ups (plan 73), closing every gap the reviews left: a program blocks an item whose dependency names no item; a backlog key may extend another only into a branch of another repository; the API check reads endpoints after an HTTP method and outside code blocks; the squash commit on main carries the pull request body with its spec line, and the run page drops the empty-merge row and the wrong repository fallback; the delivery round also asks the SM to repair a criterion whose tasks all blocked, and a program's failure names the tasks that blocked; the answer step runs on Sonnet from the second cycle, reads the floor at each evaluation, answers only Jev's routes and never a history contradiction, and the eval reads several projects and prints the precision right above its floor.
```

and after row 72 of `docs/superpowers/plans/README.md`:

```md
| 73 | [`2026-10-12-teams-ai-73-autonomy-follow-ups.md`](2026-10-12-teams-ai-73-autonomy-follow-ups.md) | Done — the gaps the reviews of plans 68 to 72 left open; ROADMAP R11.5. |
```

- [ ] **Step 2: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.5 follow-ups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
