# Plan 72 - Jev answers from the docs (R11.5.7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a blocking refinement question the documents already answer stops reaching the human, once real data shows how far Jev's routing can be trusted.

**Architecture:** the three steps of plan 66, each in its own task and each switched on only after the one before it is measured. First, the `question-routing` decision runs in shadow mode by default, so every blocking question gets a journaled route, and the owner can mark an answer with "the documents already answered this", which labels it. Second, a pure function over the refinement journals (`autoAnswerFloor` in `server/decide/evals.ts`, run by `scripts/evals/question-routing.ts`) finds the lowest confidence at which questions routed `auto` really were answered by the documents. Third, with `decisions.autoAnswerFloor` set to that floor, a question routed `auto` at or above it is answered from the documents by its owner role in a new `answer` step and journaled as that role's answer, which the refinement page shows as an assumption; with the floor unset, the default, nothing changes.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest, React web app.

**Spec:** plan 66 (`docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md`), section "Design", paragraph **R11.5.7 Jev answers from the docs**, its "Where autonomy breaks today" bullet on Jev, and the human decision of 2026-10-07 (each Jev decision gets an eval before it is switched on); roadmap items R11.5 and R11.5a in `docs/superpowers/ROADMAP.md`.

**Seen live (2026-10-12):** the refinement journals of `loja-eventos` and `customer-api` hold 29 answered questions and no route at all, since `question-routing` is off by default; there is nothing yet to measure a floor on.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- Routing never answers, drops or hides a question unless `decisions.autoAnswerFloor` is set; the default leaves every question with the human, as today.
- Agent prompts stay in English; everything a human reads stays in Brazilian Portuguese.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The decision layer off (`decisions.enabled: false`, the default for new installs): no route, no label needed, and the answer form still works.
2. A confidential draft, where Jev is skipped: the route is missing and the question stays with the human, whatever the floor.
3. An owner who answers without ticking the mark: the answer counts as "the human was needed", the conservative label.
4. The answer step returning `null`, failing, or the run being stopped meanwhile: the question stays pending for the human.
5. A question auto-answered in one cycle: the next cycle's PO and SM see it answered, with the answer, as any human answer.

## Limits

- The floor is set by a person after running the eval; nothing switches the auto answer on by itself.
- The label is binary (the documents already answered it, or not): it measures `auto` only, not the split between `po`, `sm` and `human`.

---

### Task 1: Routing runs in shadow mode, and the owner labels each answer

**Files:**
- Modify: `server/config/config.ts:57-58` (the `question-routing` default)
- Modify: `server/refine/session.ts` (`answer`)
- Modify: `server/api/refine-routes.ts` (the `answers` route)
- Modify: `web/src/api.ts` (`answer`), `web/src/pages/Refinement.tsx` (answer form, `onAnswer`)
- Test: `test/config/decisions.test.ts`, `test/refine/session.test.ts`, `test/api/refine-api.test.ts`, `test/refine/cycle.test.ts` (one test name), `web/src/pages/Refinement.test.tsx`

**Interfaces:**
- Produces: `RefineSession.answer(questionId: string, text: string, docsAnswered = false)`; the fact `QUESTION_ANSWERED { questionId, text, docsAnswered?: true }`; the API body `{ questionId, text, docsAnswered?: boolean }`; `RefinementView` prop `onAnswer(id: string, text: string, docsAnswered: boolean)`.

- [ ] **Step 1: Write the failing tests**

In `test/config/decisions.test.ts`, add to "per-decision defaults follow the spec escalation column":

```ts
    // R11.5.7: question routing runs in shadow mode by default, so labelled data builds up.
    expect(DEFAULT_CONFIG.decisions.perDecision['question-routing']).toMatchObject({ enabled: true, chain: ['jev', 'local'], escalateTo: 'po' });
```

In `test/refine/session.test.ts`, add to `describe('RefineSession', ...)`:

```ts
  it("journals the owner's mark that the documents already answered a question, the label the routing eval reads", async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.answer('po-c1-0', 'project.md › Execução: 8080', true);
    await s.close();
    const answered = (await fs.readFile(draft().events, 'utf8')).split('\n').filter((l) => l.includes('"QUESTION_ANSWERED"')).map((l) => JSON.parse(l).data);
    expect(answered).toEqual([{ questionId: 'po-c1-0', text: 'project.md › Execução: 8080', docsAnswered: true }]);
  });
```

In `test/api/refine-api.test.ts`, in "creates a new project draft, lists it, saves a doc, evaluates and streams the journal", replace the first `answers` call with:

```ts
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/answers', { questionId: 'po-c1-0', text: '8080', docsAnswered: true })).status).toBe(200);
    const after = await fetch(`${base()}/api/refine/hello-app/hello-app-001/events`, { headers: { 'last-event-id': '1' } });
    const answered = after.body!.getReader();
    let journal = '';
    while (!journal.includes('QUESTION_ANSWERED')) journal += new TextDecoder().decode((await answered.read()).value);
    await answered.cancel();
    expect(journal).toContain('"docsAnswered":true');
```

In `test/refine/cycle.test.ts`, rename the test "adds no hint when the decision is off (the default)" to "adds no hint without a decider".

In `web/src/pages/Refinement.test.tsx`, change `expect(h.onAnswer).toHaveBeenCalledWith('po-c1-0', '8080');` to `expect(h.onAnswer).toHaveBeenCalledWith('po-c1-0', '8080', false);`, and add after the test that holds it:

```ts
  it('lets the owner mark that the documents already answered a question', () => {
    const h = on();
    render(
      <MemoryRouter>
        <RefinementView snap={base({})} busy={false} {...h} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('answer'), { target: { value: 'Está em project.md › Execução: 8080' } });
    fireEvent.click(screen.getByTestId('docs-answered'));
    fireEvent.click(screen.getByTestId('answer-po-c1-0'));
    expect(h.onAnswer).toHaveBeenCalledWith('po-c1-0', 'Está em project.md › Execução: 8080', true);
    expect((screen.getByTestId('docs-answered') as HTMLInputElement).checked).toBe(false);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/config/decisions.test.ts test/refine/session.test.ts test/api/refine-api.test.ts test/refine/cycle.test.ts` and, from `web/`, `npx vitest run src/pages/Refinement.test.tsx`
Expected: the defaults case (`enabled` is false), the session case and the API case (no `docsAnswered`), and both web cases FAIL; the renamed cycle case passes.

- [ ] **Step 3: Implement**

In `server/config/config.ts`, replace the two `question-routing` lines of `DECISION_DEFAULTS` with:

```ts
  // R11.5.7: shadow mode by default, so labelled data builds up; on its own it never answers, drops or hides a question.
  'question-routing': { chain: ['jev', 'local'], escalateTo: 'po' },
```

In `server/refine/session.ts`, replace `answer` with:

```ts
  /** `docsAnswered`: the owner's mark that the documents already answered it, the label the routing eval reads. */
  async answer(questionId: string, text: string, docsAnswered = false): Promise<void> {
    this.guard();
    this.question(questionId);
    await this.journal.fact(RefineEvent.QuestionAnswered, { questionId, text, ...(docsAnswered ? { docsAnswered: true } : {}) });
  }
```

In `server/api/refine-routes.ts`, the `answers` handler calls `(await get(params)).answer(str(b, 'questionId'), str(b, 'text'), b.docsAnswered === true);`.

In `web/src/api.ts`, `answer` becomes:

```ts
  answer: (p: string, s: string, questionId: string, text: string, docsAnswered = false) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/answers`, { questionId, text, docsAnswered }).then((r) => json<{ ok: true }>(r)),
```

In `web/src/pages/Refinement.tsx`: the prop becomes `onAnswer(id: string, text: string, docsAnswered: boolean): void;`; add `const [docsAnswered, setDocsAnswered] = useState(false);` next to the `answer` state; add after the answer `<textarea>`:

```tsx
            <label className="field-label">
              <input type="checkbox" data-testid="docs-answered" checked={docsAnswered} onChange={(e) => setDocsAnswered(e.target.checked)} /> Os documentos já respondiam esta pergunta
            </label>
```

make the answer button call `p.onAnswer(current.questionId, answer, docsAnswered);` and then `setAnswer(''); setDocsAnswered(false);`; and the page passes `onAnswer={(id, t, d) => act(() => refineApi.answer(projectId, specId, id, t, d))()}`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/config test/refine test/api && npx tsc --noEmit -p .` and, from `web/`, `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, both type checks clean.

- [ ] **Step 5: Commit**

```bash
git add server/config/config.ts server/refine/session.ts server/api/refine-routes.ts web/src/api.ts web/src/pages/Refinement.tsx test/config/decisions.test.ts test/refine/session.test.ts test/api/refine-api.test.ts test/refine/cycle.test.ts web/src/pages/Refinement.test.tsx
git commit -m "feat(refine): routing runs in shadow mode and the owner labels each answer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: An eval over the labelled answers sets the confidence floor

**Files:**
- Modify: `server/decide/evals.ts` (append)
- Create: `scripts/evals/question-routing.ts`
- Test: `test/decide/evals.test.ts`

**Interfaces:**
- Consumes: the facts `REFINE_EVALUATED { questionRouting: { [questionId]: { route, confidence } } }` and `QUESTION_ANSWERED { questionId, docsAnswered? }` from Task 1.
- Produces: `interface RoutingSample { route: string; confidence: number | null; docsAnswered: boolean }`; `routingSamples(events): RoutingSample[]`; `autoAnswerFloor(samples, opts?: { precision?: number; minSamples?: number }): number | null`.

- [ ] **Step 1: Write the failing tests**

In `test/decide/evals.test.ts`, add `autoAnswerFloor, routingSamples` to the import from `../../server/decide/evals.js`, and add:

```ts
describe('question routing eval', () => {
  it('labels each routed question with its answer, and leaves out the ones nobody answered yet', () => {
    const events = [
      { type: 'REFINE_EVALUATED', data: { questionRouting: { 'po-c1-0': { route: 'auto', confidence: 0.96 }, 'po-c1-1': { route: 'human', confidence: 0.7 }, 'sm-c1-0': { route: 'auto', confidence: 0.9 } } } },
      { type: 'QUESTION_ANSWERED', data: { questionId: 'po-c1-0', text: 'project.md › Execução', docsAnswered: true } },
      { type: 'QUESTION_ANSWERED', data: { questionId: 'po-c1-1', text: '5 segundos' } },
    ];
    expect(routingSamples(events)).toEqual([
      { route: 'auto', confidence: 0.96, docsAnswered: true },
      { route: 'human', confidence: 0.7, docsAnswered: false },
    ]);
  });

  it('finds the lowest confidence at which questions routed auto were answered by the documents often enough', () => {
    const auto = (confidence: number, docsAnswered = true) => ({ route: 'auto', confidence, docsAnswered });
    // 20 right answers from 0.99 down to 0.80, then a wrong one at 0.79 and more right ones below it.
    const right = Array.from({ length: 20 }, (_, i) => auto(0.99 - i * 0.01));
    expect(autoAnswerFloor(right)).toBeCloseTo(0.8);
    expect(autoAnswerFloor([...right, auto(0.79, false), auto(0.78), auto(0.77)], { precision: 0.99 })).toBeCloseTo(0.8);
    // Too few samples, or too many wrong ones: no floor yet.
    expect(autoAnswerFloor(right.slice(0, 19))).toBeNull();
    expect(autoAnswerFloor(right.map((s, i) => ({ ...s, docsAnswered: i % 2 === 0 })))).toBeNull();
    // Other routes and questions without a confidence never count.
    expect(autoAnswerFloor([...right.map((s) => ({ ...s, route: 'po' })), { route: 'auto', confidence: null, docsAnswered: true }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/decide/evals.test.ts`
Expected: both new cases FAIL (`routingSamples` and `autoAnswerFloor` are not exported); the existing cases pass.

- [ ] **Step 3: Implement**

Append to `server/decide/evals.ts`:

```ts
/** One routed blocking refinement question, labelled by its owner's answer (R11.5.7). */
export interface RoutingSample {
  route: string;
  confidence: number | null;
  /** The owner marked that the documents already answered it; an answer without the mark counts as the human being needed. */
  docsAnswered: boolean;
}

type JournalEvent = { type: string; data: Record<string, unknown> };

/** Joins every route of a refinement journal with the answer to its question; questions nobody answered carry no label yet. */
export function routingSamples(events: readonly JournalEvent[]): RoutingSample[] {
  const answers = new Map(events.filter((e) => e.type === 'QUESTION_ANSWERED').map((e) => [String(e.data.questionId), e.data.docsAnswered === true]));
  return events
    .filter((e) => e.type === 'REFINE_EVALUATED')
    .flatMap((e) => Object.entries((e.data.questionRouting ?? {}) as Record<string, { route: string; confidence: number | null }>))
    .filter(([id]) => answers.has(id))
    .map(([id, r]) => ({ route: r.route, confidence: r.confidence, docsAnswered: answers.get(id)! }));
}

/**
 * The lowest confidence at which the questions routed `auto`, counted from the most confident down, were answered by the
 * documents at least `precision` of the time over at least `minSamples` of them; null until the data shows one.
 */
export function autoAnswerFloor(samples: readonly RoutingSample[], opts: { precision?: number; minSamples?: number } = {}): number | null {
  const { precision = 0.95, minSamples = 20 } = opts;
  const auto = samples.filter((s) => s.route === 'auto' && s.confidence !== null).sort((a, b) => b.confidence! - a.confidence!);
  let floor: number | null = null;
  let right = 0;
  auto.forEach((s, i) => {
    if (s.docsAnswered) right++;
    // A floor sits at the end of a run of equal confidences, so every question at that confidence is counted.
    if (i + 1 >= minSamples && right / (i + 1) >= precision && auto[i + 1]?.confidence !== s.confidence) floor = s.confidence;
  });
  return floor;
}
```

Create `scripts/evals/question-routing.ts`:

```ts
/**
 * R11.5.7: the confidence floor for answering a blocking refinement question from the documents, from labelled journals.
 *   npx tsx scripts/evals/question-routing.ts --refine ~/.teams-ai/workspaces/<project>/refine
 * An answer the owner marked "the documents already answered this" labels its question; set decisions.autoAnswerFloor to
 * the floor printed, and only once it is not null.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { autoAnswerFloor, routingSamples } from '../../server/decide/evals.js';

const i = process.argv.indexOf('--refine');
const dir = i > 0 ? process.argv[i + 1] : undefined;
if (!dir) {
  console.error('usage: question-routing.ts --refine <refine dir>');
  process.exit(2);
}
const samples = [];
for (const specId of await fs.readdir(dir)) {
  const text = await fs.readFile(path.join(dir, specId, 'events.ndjson'), 'utf8').catch(() => '');
  samples.push(...routingSamples(text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))));
}
const auto = samples.filter((s) => s.route === 'auto');
console.log(JSON.stringify({ samples: samples.length, routedAuto: auto.length, answeredByDocs: auto.filter((s) => s.docsAnswered).length, floor: autoAnswerFloor(samples) }, null, 2));
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/decide && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/decide/evals.ts scripts/evals/question-routing.ts test/decide/evals.test.ts
git commit -m "feat(decide): an eval over labelled answers sets the auto answer floor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: A question routed auto above the floor is answered from the docs

**Files:**
- Modify: `server/config/config.ts` (`decisions.autoAnswerFloor`)
- Modify: `server/agents/outputs.ts` (`STEP_KINDS`, `AnswerOutput`, `OUTPUT_SCHEMAS`)
- Modify: `server/runner/invocation.ts:38-40` (`SHORT_CACHE_KINDS`)
- Create: `server/refine/answer.ts` (`answerPack`)
- Modify: `server/refine/cycle.ts` (`CycleDeps`, the end of `runCycle`)
- Modify: `server/refine/session.ts` (`SessionDeps`, the `runCycle` deps), `server/refine/registry.ts:80` (`session`)
- Modify: `server/refine/state.ts:152-160` (`answeredBy`), `web/src/api.ts` (the question type), `web/src/pages/Refinement.tsx` (the history line)
- Test: `test/refine/cycle.test.ts`, `test/refine/state.test.ts`, `web/src/pages/Refinement.test.tsx`

**Interfaces:**
- Consumes: `questionRouting` from the cycle; `QUESTION_ANSWERED` from Task 1.
- Produces: config `decisions.autoAnswerFloor?: number` (0 to 1, unset by default); step kind `answer` with output `{ specHash, answer: string | null }`; `answerPack(input: { specHash: string; role: 'po' | 'sm'; question: string; docs: { projectMd: string; briefMd: string; stackMd: string; flowMd: string; designMd: string } }): ContextPackInput`; `CycleDeps.autoAnswerFloor?: number`; the fact `QUESTION_ANSWERED { questionId, text, by: 'po' | 'sm' }`; `QuestionRow.answeredBy: 'po' | 'sm' | null` on the server and `answeredBy?: 'po' | 'sm' | null` on the web.

- [ ] **Step 1: Write the failing tests**

In `test/refine/cycle.test.ts`, add to the `describe` that holds "adds no hint without a decider":

```ts
  it('answers a question routed auto at the floor or above from the docs, by its owner role, and leaves the others with the human', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'brief.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc\nA porta é 8080.')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const answers: string[] = [];
    const runAgent = vi.fn(async (req: { kind: string; role: string; pack: { feedback?: string } }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (req.kind === 'answer') { answers.push(`${req.role}: ${String(req.pack.feedback).includes('Which port?') ? 'Which port?' : 'Which name?'}`); return ok({ specHash: 'draft', answer: 'project.md diz 8080.' }); }
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'Which port?', blocking: true, relatedAcIds: [] }, { text: 'Which name?', blocking: true, relatedAcIds: [] }], docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    // Which port? is routed auto at 0.95; Which name? at 0.85, under the floor of 0.9.
    const decider = {
      decide: async (id: string, state: string) => {
        if (id !== 'question-routing') return { answered: false as const, reason: 'disabled' as const };
        const confidence = state.includes('Which port?') ? 0.95 : 0.85;
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: { route: { type: 'choice' as const, value: 'auto', probabilities: { auto: confidence }, confidence } } };
      },
    };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root, decider, autoAnswerFloor: 0.9 } as never, 1);
    expect(answers).toEqual(['po: Which port?']);
    const evaluated = events.findIndex((e) => e.type === 'REFINE_EVALUATED');
    const answered = events.filter((e) => e.type === 'QUESTION_ANSWERED');
    expect(answered.map((e) => e.data)).toEqual([{ questionId: 'po-c1-0', text: 'project.md diz 8080.', by: 'po' }]);
    expect(events.indexOf(answered[0]!)).toBeGreaterThan(evaluated);
  });

  it('never answers a question by itself while the floor is unset, the default', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'brief.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'Which port?', blocking: true, relatedAcIds: [] }], docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    const decider = { decide: async (id: string) => (id === 'question-routing' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { route: { type: 'choice' as const, value: 'auto', probabilities: { auto: 0.99 }, confidence: 0.99 } } } : { answered: false as const, reason: 'disabled' as const }) };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root, decider } as never, 1);
    expect(runAgent.mock.calls.some(([req]) => req.kind === 'answer')).toBe(false);
    expect(events.some((e) => e.type === 'QUESTION_ANSWERED')).toBe(false);
  });
```

In `test/refine/state.test.ts`, add:

```ts
  it('keeps who answered a question when a role answered it from the docs', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [], questions: [{ questionId: 'po-c1-0', role: 'po', text: 'Port?', blocking: true, relatedAcIds: [], cycle: 1 }], discardedPatches: [] } },
      { type: RefineEvent.QuestionAnswered, data: { questionId: 'po-c1-0', text: '8080', by: 'po' } },
    ]);
    expect(s.questions[0]).toMatchObject({ status: 'answered', answer: '8080', answeredBy: 'po' });
  });
```

In `web/src/pages/Refinement.test.tsx`, add:

```ts
  it('shows an answer a role gave from the docs as its assumption', () => {
    const h = on();
    const answered = base({});
    answered.state.questions = answered.state.questions.map((q) => (q.questionId === 'po-c1-0' ? { ...q, status: 'answered' as const, answer: '8080', answeredBy: 'po' as const } : q));
    render(
      <MemoryRouter>
        <RefinementView snap={answered} busy={false} {...h} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/suposição do PO, tirada dos documentos/)).toBeTruthy();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/refine/cycle.test.ts test/refine/state.test.ts` and, from `web/`, `npx vitest run src/pages/Refinement.test.tsx`
Expected: the auto answer case, the state case and the web case FAIL; the "floor unset" case passes, since it pins the default.

- [ ] **Step 3: Implement the step**

In `server/config/config.ts`, add to the `decisions` object, after `perDecision`:

```ts
      /** R11.5.7: a blocking refinement question Jev routes `auto` at this confidence or more is answered from the docs by its owner role; unset until `scripts/evals/question-routing.ts` measured a floor. */
      autoAnswerFloor: unit.optional(),
```

In `server/agents/outputs.ts`, add `'answer'` at the end of `STEP_KINDS`, add after `SuggestOutput`:

```ts
/** R11.5.7: the owner role's answer to a refinement question from the docs, or null when they do not settle it. */
export const AnswerOutput = z.object({ specHash, answer: z.string().min(1).nullable() });
export type AnswerOutput = z.infer<typeof AnswerOutput>;
```

and `answer: AnswerOutput,` at the end of `OUTPUT_SCHEMAS`. In `server/runner/invocation.ts`, add `'answer'` to `SHORT_CACHE_KINDS`.

Create `server/refine/answer.ts`:

```ts
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';

/** R11.5.7: the owner role answers a blocking question from the five documents alone, or returns null when they do not settle it. */
export function answerPack(input: { specHash: string; role: 'po' | 'sm'; question: string; docs: { projectMd: string; briefMd: string; stackMd: string; flowMd: string; designMd: string } }): ContextPackInput {
  const feedback = [
    'Answer the refinement question below only with what the documents already state, in Brazilian Portuguese, in one or two sentences that name the document and the section the answer comes from.',
    'Return `answer: null` when the documents do not settle it, so the question goes to the human. Never make a product or technical choice the documents leave open. Do not edit any file.',
    `### Question\n${input.question}`,
    `### project.md\n${input.docs.projectMd}`,
    `### briefing.md\n${input.docs.briefMd}`,
    `### stack.md\n${input.docs.stackMd}`,
    `### flow.md (Mermaid)\n${input.docs.flowMd}`,
    `### design.md\n${input.docs.designMd}`,
  ].join('\n\n');
  return { kind: 'answer', role: input.role, specHash: input.specHash, principles: [], outputContract: outputContract('answer'), criteria: [], feedback, budgetTokens: 30_000 };
}
```

In `server/refine/cycle.ts`, import `answerPack` from `./answer.js`, add to `CycleDeps`:

```ts
  /** R11.5.7: the measured confidence floor for answering a question routed `auto` from the docs; unset leaves every question with the human. */
  autoAnswerFloor?: number;
```

and after the `RefineEvent.Evaluated` fact at the end of `runCycle`:

```ts
  // R11.5.7: a blocking question routed `auto` at the floor or above is answered by its owner role from the docs.
  const floor = deps.autoAnswerFloor;
  if (floor !== undefined) {
    for (const q of merged.filter((x) => x.blocking)) {
      const r = questionRouting[q.questionId];
      if (r?.route !== 'auto' || r.confidence === null || r.confidence < floor) continue;
      const out = await deps.runAgent<'answer'>({ kind: 'answer', role: q.role, pack: answerPack({ specHash: hash, role: q.role, question: q.text, docs: { projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'] } }), cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx);
      if (out.ok && out.value.answer) await journal.fact(RefineEvent.QuestionAnswered, { questionId: q.questionId, text: out.value.answer, by: q.role });
    }
  }
```

In `server/refine/session.ts`, add `autoAnswerFloor?: number;` to `SessionDeps` and `autoAnswerFloor: this.deps.autoAnswerFloor,` to the `runCycle` deps; in `server/refine/registry.ts` `session`, add `autoAnswerFloor: (await this.deps.cfg()).decisions.autoAnswerFloor` to `deps`.

- [ ] **Step 4: Implement the record and the page**

In `server/refine/state.ts`, add `answeredBy?: 'po' | 'sm' | null;` to `QuestionRow`, and in the `QuestionAnswered`/`QuestionSkipped` case set `q.answeredBy = (d.by as 'po' | 'sm' | undefined) ?? null;` after `q.answer`. In `web/src/api.ts`, add `answeredBy?: 'po' | 'sm' | null;` after `answer: string | null;` in the question type. In `web/src/pages/Refinement.tsx`, the history line becomes:

```tsx
                <span className={`badge ${q.role}`}>{q.role.toUpperCase()}</span> {questionText(q.text)} → {q.status === 'skipped' ? <i>ignorada</i> : q.answer}{q.answeredBy ? <i> (suposição do {q.answeredBy.toUpperCase()}, tirada dos documentos)</i> : null}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run test/refine test/config test/agents test/runner && npx tsc --noEmit -p .` and, from `web/`, `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, both type checks clean.

- [ ] **Step 6: Commit**

```bash
git add server/config/config.ts server/agents/outputs.ts server/runner/invocation.ts server/refine/answer.ts server/refine/cycle.ts server/refine/session.ts server/refine/registry.ts server/refine/state.ts web/src/api.ts web/src/pages/Refinement.tsx test/refine/cycle.test.ts test/refine/state.test.ts web/src/pages/Refinement.test.tsx
git commit -m "feat(refine): a question routed auto above the floor is answered from the docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Record R11.5.7 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (section `### R11.5 Autonomy hardening`: the status line and, after the R11.5.6 lines, the R11.5.7 line)
- Modify: `docs/superpowers/plans/README.md` (row 66 and, after row 71, row 72)

- [ ] **Step 1: Update the roadmap**

Add after the last R11.5.6 line:

```md
- Built R11.5.7 (plan 72): `question-routing` runs in shadow mode by default, so every blocking refinement question gets a journaled route, and the owner can mark an answer with "Os documentos já respondiam esta pergunta", which labels it; `scripts/evals/question-routing.ts` finds the lowest confidence at which questions routed `auto` were answered by the documents at least 95% of the time over at least 20 of them (`autoAnswerFloor`); with `decisions.autoAnswerFloor` set to that floor, a question routed `auto` at or above it is answered from the documents by its owner role in an `answer` step and shown as that role's assumption, and unset, the default, nothing is answered on its own. Next: collect labelled answers, run the eval, then set the floor.
```

and change the section heading `### R11.5 Autonomy hardening - \`partial\` (plan 66, 2026-10-12)` to `### R11.5 Autonomy hardening - \`built\` (plans 66 to 72, 2026-10-12; the auto answer of R11.5.7 waits for a measured floor)`.

- [ ] **Step 2: Update the plans index**

Change row 66's status to `Done — a run recovers from the failures that end it or waste its attempts; slices R11.5.1 to R11.5.7 in plans 66 to 72; ROADMAP R11.5.` and add after row 71:

```md
| 72 | [`2026-10-12-teams-ai-72-jev-answers-from-docs.md`](2026-10-12-teams-ai-72-jev-answers-from-docs.md) | Done — question routing runs in shadow mode with the owner's label, an eval sets the floor, and above it a question is answered from the docs; ROADMAP R11.5.7. |
```

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.5.7 Jev answers from the docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
