# teams-ai Plan 9 — Jev Decisions Phase 3a Implementation Plan

**Status: partially implemented — see "Out of scope (deliberately)" below.** `server/decide/decisions/` (attempt-progress, gate-triage, model-tier, pr-risk) exists with matching tests, wired into `server/orchestrator/`. Decisions 2–4, 7, 9, 12 are not wired (depend on refine/validation flows not yet in the orchestrator); Evals (spec 10A.6) are not built; `decisions.enabled` still defaults to `false` (operator must flip it). Filename renamed from `2026-09-24-jev-decisions-phase3a.md` to fit the 01..08 plan numbering as plan 9.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route four more orchestrator decisions through the existing `Decider` (jev → local → claude) so the small model decides and the big models only write: merge-gate triage, attempt progress, PR risk, and model tier + effort per task.

**Architecture:** Each decision is one file under `server/decide/decisions/` shaped like `gate-triage.ts` (options → questions → state string → `decide()` → typed result with `source`), registered in `DECISION_IDS`, and called from `TaskRunner`. Every decision has a deterministic default so a disabled or unanswered decision behaves exactly as today. Nothing here may waive a gate, approve a review, or mark evidence as passed (spec 10A.5 rule).

**Tech Stack:** TypeScript (ESM), zod, vitest (`npm test`), existing `server/decide/*` layer.

**Spec:** `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` §10A.5 rows 1, 5, 6, 10, 11.

## Global Constraints

- Deterministic rules first, System 1 second, System 2 on low confidence (spec 10A.5).
- System 1 may route, prioritise and triage; it may **never** waive a gate, approve a review, or mark evidence as passed.
- `decisions.enabled` defaults to `false`; with it off every new decision must take its default path and the orchestrator behaviour must be byte-identical to today (existing tests stay green).
- The decider accepts an answer only when the *minimum* confidence across questions clears the threshold; keep one call per decision small (≤ 2 questions).
- Confidential projects skip jev (handled inside `Decider`; nothing to add).
- Written language is English; commits follow `feat(scope): ...` as in the log.

## Review Focus

1. Decision layer disabled (`answered: false, reason: 'disabled'`) → behaviour identical to today. Pinned in every task's "default" test.
2. Backend returns a score `value` between levels (e.g. `1.4`) → rounding must pick a level deterministically. Pinned in Task 2 and Task 4 tests.
3. Attempt 2 on an already-replanned task with `stalled` progress → must **not** replan again (would violate the "replaced tasks never replan" rule); it retries instead. Pinned in Task 2.
4. OmniRoute-profile role with a `model-tier` answer → the pinned OmniRoute model must not be replaced by a Claude tier name. Pinned in Task 4.
5. Merge-gates failure with no `GateResult` (older `MergeSteps` fakes returning only `detail`) → falls back to the `[infra]` prefix rule. Pinned in Task 1.

---

### Task 1: Merge-gates failure goes through `triageGateFailure`

**Files:**
- Modify: `server/git/merge-queue.ts:8` (`MergeSteps.gates` return type), `:19` (`MergeOutcome`)
- Modify: `server/orchestrator/merge-steps.ts:67-73`
- Modify: `server/orchestrator/task-runner.ts:318-323`
- Test: `test/orchestrator/task-runner.test.ts`

**Interfaces:**
- Consumes: `triageGateFailure(gate, result, decider, ctx)` from `server/decide/decisions/gate-triage.ts`.
- Produces: `MergeSteps.gates(): Promise<{ ok: boolean; detail?: string; failure?: GateResult }>`; `MergeOutcome` failure branch gains `gateFailure?: GateResult`.

- [ ] **Step 1: Write the failing test** (append to `test/orchestrator/task-runner.test.ts`, inside a new `describe('TaskRunner: merge gates triage')`)

```ts
describe('TaskRunner: merge gates triage', () => {
  const toRebasing = async (r: TaskRunner) => {
    await r.advance(); // implementing → validating
    await r.advance(); // validating → reviewing
    await r.advance(); // reviewing → rebasing
  };
  const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));

  it('sends a merge-gate failure to the gate triage and uses its kind', async () => {
    const calls: unknown[][] = [];
    const decider = { decide: async (...args: unknown[]) => { calls.push(args); return { answered: true, backend: 'jev', escalated: false, answers: { kind: { type: 'choice', value: 'flaky-test', probabilities: { 'flaky-test': 0.9 }, confidence: 0.9 } } } as const; } };
    const failure = gate('unit-test', { passed: false, exitCode: 1, stderrTail: 'boom', failure: 'code' });
    const r = new TaskRunner('T1', deps({ agent, decider, merge: { gates: async () => ({ ok: false, detail: '[code] unit-test exit 1\nboom', failure }) } }));
    await toRebasing(r);
    await r.advance();
    expect(calls[0]![0]).toBe('gate-triage');
    expect(journal.events.find((e) => e.type === RunEvent.FlakyRetry)!.data).toMatchObject({ taskId: 'T1', gate: 'merge-gates' });
    expect(journal.events.find((e) => e.type === OrchEvent.GateFailed && e.data.gate === 'merge-gates')!.data).toMatchObject({ failure: 'code', exitCode: 1 });
  });

  it('falls back to the [infra] prefix when the merge steps give no GateResult', async () => {
    const r = new TaskRunner('T1', deps({ agent, merge: { gates: async () => ({ ok: false, detail: '[infra] docker daemon down' }) } }));
    await toRebasing(r);
    await r.advance();
    expect(journal.events.find((e) => e.type === RunEvent.InfraRetry)!.data).toMatchObject({ taskId: 'T1', gate: 'merge-gates' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/orchestrator/task-runner.test.ts -t "merge gates triage"`
Expected: FAIL — TypeScript error on `failure` in the `gates` return, and/or no `FlakyRetry` event.

- [ ] **Step 3: Carry the `GateResult` through the merge queue**

`server/git/merge-queue.ts`:

```ts
import type { GateResult } from '../exec/gate-runner.js';
// MergeSteps.gates
  gates(): Promise<{ ok: boolean; detail?: string; failure?: GateResult }>;
// MergeOutcome
export type MergeOutcome =
  | { ok: true; pr: number; already?: true; warning?: string }
  | { ok: false; stage: MergeStage; conflicts?: string[]; detail?: string; gateFailure?: GateResult };
// in enqueue, the gates stage:
      const gates = await steps.gates();
      if (!gates.ok) return { ok: false, stage, detail: gates.detail, gateFailure: gates.failure };
```

`server/orchestrator/merge-steps.ts:67-73` — add `failure: f` to the returned object:

```ts
      return { ok: false, failure: f, detail: redactSecrets(`${gateLine(f)}\n${tail(f.stderrTail || f.stdoutTail)}`, deps.secretValues()) };
```

- [ ] **Step 4: Triage in `TaskRunner.merge()`** (replace the `case 'gates'` block at `task-runner.ts:318-323`)

```ts
      case 'gates': {
        const f = outcome.gateFailure;
        // Fakes and older steps give only the detail; the prefix is the gate runner's own classification.
        const kind = f
          ? (await triageGateFailure(this.deps.plan.gates.find((g) => g.name === f.name) ?? { name: f.name, command: '', blocking: true, network: 'none' as const, secrets: [] }, f, this.deps.decider, this.ctx)).kind
          : /^\[infra\]/.test(outcome.detail ?? '') ? 'infra' : 'code';
        await this.deps.journal.fact(OrchEvent.GateFailed, { taskId: this.taskId, gate: 'merge-gates', failure: f?.failure ?? (kind === 'infra' ? 'infra' : 'code'), exitCode: f?.exitCode ?? null, durationMs: f?.durationMs ?? 0, junit: [] });
        return this.fail(kind, `Gates failed after rebase (${kind}):\n${this.clean(outcome.detail ?? '')}`, 'merge-gates');
      }
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS (the `merge-steps.test.ts` fakes that return `{ ok: true }` still type-check because `failure` is optional).

- [ ] **Step 6: Commit**

```bash
git add server/git/merge-queue.ts server/orchestrator/merge-steps.ts server/orchestrator/task-runner.ts test/orchestrator/task-runner.test.ts
git commit -m "feat(decide): triage merge-gate failures through the gate triage decision"
```

---

### Task 2: Attempt progress (spec decision 6) triggers early replan

**Files:**
- Create: `server/decide/decisions/attempt-progress.ts`
- Modify: `server/decide/types.ts:8` (`DECISION_IDS`)
- Modify: `server/config/config.ts:39-46` (per-decision defaults: `escalateTo: 'sm'`)
- Modify: `server/orchestrator/task-runner.ts` `fail()` (`retry-dev` branch)
- Test: `test/decide/attempt-progress.test.ts`, `test/config/decisions.test.ts`, `test/orchestrator/task-runner.test.ts`

**Interfaces:**
- Produces: `assessAttemptProgress(task: PlanTask, attempt: number, history: readonly string[], decider, ctx): Promise<{ progress: AttemptProgress; source: 'default' | BackendName }>` with `AttemptProgress = 'diverging' | 'stalled' | 'converging'`.
- Produces: `DECISION_DEFAULTS` in `config.ts` (also used by Task 3 and Task 4).

- [ ] **Step 1: Write the failing decision test** (`test/decide/attempt-progress.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { ATTEMPT_PROGRESS_LEVELS, assessAttemptProgress, attemptProgressQuestions, attemptProgressState } from '../../server/decide/decisions/attempt-progress.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { makePlanTask } from '../fixtures/contracts.js';

const task = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const history = ['Gate unit-test failed (code, exit 1)\nFailed tests:\na::adds', 'Review requested changes:\n- src/a.ts [major] off by one (fix: use <=)'];
const fake = (outcome: DecisionOutcome) => ({ decide: async () => outcome });
const score = (value: number, confidence = 0.9): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers: { progress: { type: 'score', value, probabilities: {}, confidence } } });

describe('attempt progress', () => {
  it('asks one score question with the three ordered levels', () => {
    expect(ATTEMPT_PROGRESS_LEVELS).toEqual(['diverging', 'stalled', 'converging']);
    expect(attemptProgressQuestions().progress).toMatchObject({ type: 'score' });
  });
  it('state lists the task, the attempt number and every delta, newest last', () => {
    const s = attemptProgressState(task, 3, history);
    expect(s).toContain('task: T1');
    expect(s).toContain('attempt about to start: 3');
    expect(s.indexOf('Gate unit-test')).toBeLessThan(s.indexOf('Review requested'));
  });
  it('rounds the weighted level index to the nearest level', async () => {
    expect((await assessAttemptProgress(task, 2, history, fake(score(0.4)), { confidential: false })).progress).toBe('diverging');
    expect((await assessAttemptProgress(task, 2, history, fake(score(1.4)), { confidential: false })).progress).toBe('stalled');
    expect((await assessAttemptProgress(task, 2, history, fake(score(1.6)), { confidential: false })).progress).toBe('converging');
  });
  it('defaults to converging when unanswered, so the retry policy is unchanged', async () => {
    expect(await assessAttemptProgress(task, 2, history, fake({ answered: false, reason: 'disabled' }), { confidential: false })).toEqual({ progress: 'converging', source: 'default' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/decide/attempt-progress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Register the id and write the decision**

`server/decide/types.ts:8`:

```ts
export const DECISION_IDS = ['gate-triage', 'attempt-progress', 'pr-risk', 'model-tier'] as const;
```

`server/decide/decisions/attempt-progress.ts`:

```ts
import type { PlanTask } from '../../contracts/plan.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 6. Levels are ordered low → high as a score question requires. */
export const ATTEMPT_PROGRESS_LEVELS = ['diverging', 'stalled', 'converging'] as const;
export type AttemptProgress = (typeof ATTEMPT_PROGRESS_LEVELS)[number];

export const ATTEMPT_PROGRESS_DEFAULT: AttemptProgress = 'converging';
const DELTA_CHARS = 3000;

export function attemptProgressQuestions(): Questions {
  return {
    progress: {
      type: 'score',
      instructions:
        'A developer agent has failed this task more than once. Each delta below is the feedback handed to the next attempt. Judge whether the attempts are diverging (new, unrelated failures each time), stalled (the same failure repeats) or converging (fewer or smaller failures each time).',
      levels: [...ATTEMPT_PROGRESS_LEVELS],
    },
  };
}

export function attemptProgressState(task: PlanTask, attempt: number, history: readonly string[]): string {
  const deltas = history.map((h, i) => `--- delta ${i + 1} ---\n${h.length > DELTA_CHARS ? h.slice(0, DELTA_CHARS) : h}`);
  return [`task: ${task.id}`, `title: ${task.title}`, `criteria: ${task.criteriaRefs.join(', ')}`, `attempt about to start: ${attempt}`, '', ...deltas].join('\n');
}

export interface ProgressResult {
  progress: AttemptProgress;
  source: 'default' | BackendName;
}

/** The weighted level index may fall between levels; round to the nearest one. */
export async function assessAttemptProgress(
  task: PlanTask,
  attempt: number,
  history: readonly string[],
  decider: Pick<Decider, 'decide'>,
  ctx: DecideContext,
): Promise<ProgressResult> {
  const outcome = await decider.decide('attempt-progress', attemptProgressState(task, attempt, history), attemptProgressQuestions(), ctx);
  if (!outcome.answered) return { progress: ATTEMPT_PROGRESS_DEFAULT, source: 'default' };
  const answer = outcome.answers.progress;
  if (!answer || answer.type !== 'score') return { progress: ATTEMPT_PROGRESS_DEFAULT, source: 'default' };
  const idx = Math.min(ATTEMPT_PROGRESS_LEVELS.length - 1, Math.max(0, Math.round(answer.value)));
  return { progress: ATTEMPT_PROGRESS_LEVELS[idx]!, source: outcome.backend };
}
```

- [ ] **Step 4: Run the decision test**

Run: `npx vitest run test/decide/attempt-progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Per-decision config defaults** — failing test first, in `test/config/decisions.test.ts`:

```ts
  it('per-decision defaults follow the spec escalation column', () => {
    expect(DEFAULT_CONFIG.decisions.perDecision['attempt-progress']).toMatchObject({ escalateTo: 'sm', chain: ['jev', 'local', 'claude'] });
    expect(DEFAULT_CONFIG.decisions.perDecision['pr-risk']).toMatchObject({ escalateTo: 'test' });
    expect(DEFAULT_CONFIG.decisions.perDecision['model-tier']).toMatchObject({ chain: ['jev', 'local'] });
  });
```

Then in `server/config/config.ts` replace `PerDecisionSchema` with:

```ts
/** Spec 10A.5 "Escalates to" column; decisions with "—" never reach Claude. */
const DECISION_DEFAULTS: Partial<Record<DecisionId, Partial<DecisionConfig>>> = {
  'attempt-progress': { escalateTo: 'sm' },
  'model-tier': { chain: ['jev', 'local'] },
};

const PerDecisionSchema = z
  .object(
    Object.fromEntries(DECISION_IDS.map((id) => [id, DecisionConfigSchema.prefault(DECISION_DEFAULTS[id] ?? {})])) as Record<
      DecisionId,
      z.ZodPrefault<typeof DecisionConfigSchema>
    >,
  )
  .strict();
```

Run: `npx vitest run test/config` → PASS.

- [ ] **Step 6: Failing orchestrator test** (append to `test/orchestrator/task-runner.test.ts`)

```ts
describe('TaskRunner: attempt progress', () => {
  const failingGates = async () => ({ results: [gate('unit-test', { passed: false, exitCode: 1, stderrTail: 'boom', failure: 'code' as const })], blockingFailure: gate('unit-test', { passed: false, exitCode: 1, stderrTail: 'boom', failure: 'code' as const }) });
  const stalled = { decide: async (id: string) => (id === 'attempt-progress' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { progress: { type: 'score' as const, value: 1, probabilities: {}, confidence: 0.9 } } } : { answered: false as const, reason: 'disabled' as const }) };
  const replanAgent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [makePlanTask({ id: 'T1a', criteriaRefs: ['AC-001'], affectedPaths: ['src'], dependsOn: [] })] }) : devDone()(req));

  it('replans after the second failed attempt when progress is stalled', async () => {
    const r = new TaskRunner('T1', deps({ agent: replanAgent, gates: failingGates, decider: stalled }));
    await r.advance(); await r.advance(); // attempt 1 fails → retry-dev
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    await r.advance(); await r.advance(); // attempt 2 fails → stalled → replan
    expect(agentCalls.map((c) => c.kind)).toEqual(['dev', 'dev', 'replan']);
    expect(journal.events.find((e) => e.type === RunEvent.TaskReplanned)).toBeTruthy();
  });

  it('never replans a task that was already replanned; it retries instead', async () => {
    // The reducer marks replacements `replanned: true`; replace T1 by T2 through the journal, then run T2.
    const T2 = makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['src'], dependsOn: [] });
    await journal.fact(RunEvent.TaskReplanned, { taskId: 'T1', replacements: [T2] });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T2', to: 'ready' });
    const r = new TaskRunner('T2', deps({ agent: replanAgent, gates: failingGates, decider: stalled }));
    await r.advance(); await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.filter((c) => c.kind === 'replan')).toHaveLength(0);
    expect(journal.state.tasks.get('T2')).toMatchObject({ state: 'implementing', attempts: 2, replanned: true });
  });
});
```

`makePlanTask` must be imported from `../fixtures/contracts.js` (the file already imports `makePlan`, `makePlanTask`, etc. — check the import line). If a replaced task needs `TaskStateChanged` to `ready` or starts there already, follow what `server/pipeline/run-state.ts` `replan()` does.

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run test/orchestrator/task-runner.test.ts -t "attempt progress"`
Expected: FAIL — no `replan` call after attempt 2.

- [ ] **Step 8: Wire into `fail()`** — in `task-runner.ts`, add the import and change the `retry-dev` case:

```ts
import { assessAttemptProgress } from '../decide/decisions/attempt-progress.js';
// ...
      case 'retry-dev': {
        this.schemaRetries = 0;
        // Spec 10A.5 decision 6: from attempt 2 on, stalled or diverging attempts replan early (never a replaced task).
        const next = this.task.attempts + 2; // the attempt that would start after this feedback
        if (next >= 3 && !this.task.replanned) {
          const history = this.deps.journal.events.filter((e) => e.type === OrchEvent.Feedback && e.data.taskId === this.taskId).map((e) => String(e.data.text));
          const { progress, source } = await assessAttemptProgress(this.task.def, next, [...history, text], this.deps.decider, this.ctx);
          if (progress !== 'converging') {
            await this.feedback(`${text}\n\nAttempt progress judged ${progress} (${source}); replanning early.`);
            return this.replan();
          }
        }
        if (this.task.state === 'merging') await this.transition('rebasing');
        await this.feedback(text);
        await this.transition('implementing');
        await this.deps.journal.fact(RunEvent.AttemptConsumed, { taskId: this.taskId });
        return;
      }
```

Note on `next`: with `attempts = 1` (attempt 1 already consumed) and this failure about to consume attempt 2, `next = 3` — i.e. the decision runs once at least two attempts have failed. Keep the existing `merging → rebasing` transition ahead of `replan()` if `this.task.state === 'merging'` (add `if (this.task.state === 'merging') await this.transition('rebasing');` before the early-replan block).

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/decide/decisions/attempt-progress.ts server/decide/types.ts server/config/config.ts server/orchestrator/task-runner.ts test/decide/attempt-progress.test.ts test/config/decisions.test.ts test/orchestrator/task-runner.test.ts
git commit -m "feat(decide): attempt progress decision replans stalled or diverging tasks early"
```

---

### Task 3: PR risk (spec decision 5) selects the review profile

**Files:**
- Create: `server/decide/decisions/pr-risk.ts`
- Modify: `server/orchestrator/task-runner.ts` (`TaskRunnerDeps.impact` signature, `review()`)
- Modify: `server/orchestrator/steps.ts:73-80` (`reviewPack` takes `profile`)
- Modify: `server/orchestrator/run.ts` (`impact` takes `depth`)
- Modify: `server/orchestrator/events.ts` (`OrchEvent.ReviewProfileChosen`)
- Test: `test/decide/pr-risk.test.ts`, `test/orchestrator/task-runner.test.ts`

**Interfaces:**
- Produces: `ReviewProfile = 'quick' | 'standard' | 'deep'`; `choosePrRisk(task, opts: { changedFiles, diffStat }, decider, ctx): Promise<{ risk: PrRisk; profile: ReviewProfile; source }>`; `REVIEW_PROFILE_DEPTH: Record<ReviewProfile, number>` (`quick: 0`, `standard: 2`, `deep: 3`).
- Changes: `TaskRunnerDeps.impact(worktree, branch, changed, depth: number)`; `reviewPack(base, task, { diffStat, changedFiles, code, profile })`.

- [ ] **Step 1: Failing decision test** (`test/decide/pr-risk.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { PR_RISK_LEVELS, REVIEW_PROFILE_DEPTH, choosePrRisk, prRiskState } from '../../server/decide/decisions/pr-risk.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { makePlanTask } from '../fixtures/contracts.js';

const task = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const opts = { changedFiles: ['src/a.ts', 'src/b.ts'], diffStat: ' 2 files changed, 40 insertions(+)' };
const fake = (o: DecisionOutcome) => ({ decide: async () => o });
const score = (value: number): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers: { risk: { type: 'score', value, probabilities: {}, confidence: 0.9 } } });

describe('pr risk', () => {
  it('levels are trivial → high and the state carries files and diff stat', () => {
    expect(PR_RISK_LEVELS).toEqual(['trivial', 'low', 'medium', 'high']);
    const s = prRiskState(task, opts);
    expect(s).toContain('src/a.ts');
    expect(s).toContain('40 insertions');
  });
  it('maps risk to a review profile', async () => {
    const ctx = { confidential: false };
    expect(await choosePrRisk(task, opts, fake(score(0)), ctx)).toMatchObject({ risk: 'trivial', profile: 'quick' });
    expect(await choosePrRisk(task, opts, fake(score(1)), ctx)).toMatchObject({ risk: 'low', profile: 'standard' });
    expect(await choosePrRisk(task, opts, fake(score(2)), ctx)).toMatchObject({ risk: 'medium', profile: 'standard' });
    expect(await choosePrRisk(task, opts, fake(score(3)), ctx)).toMatchObject({ risk: 'high', profile: 'deep', source: 'jev' });
  });
  it('defaults to standard when unanswered', async () => {
    expect(await choosePrRisk(task, opts, fake({ answered: false, reason: 'disabled' }), { confidential: false })).toEqual({ risk: 'medium', profile: 'standard', source: 'default' });
    expect(REVIEW_PROFILE_DEPTH.standard).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/decide/pr-risk.test.ts` → module not found.

- [ ] **Step 3: Write the decision** (`server/decide/decisions/pr-risk.ts`)

```ts
import type { PlanTask } from '../../contracts/plan.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 5: risk picks the review profile; the review itself is never skipped. */
export const PR_RISK_LEVELS = ['trivial', 'low', 'medium', 'high'] as const;
export type PrRisk = (typeof PR_RISK_LEVELS)[number];
export type ReviewProfile = 'quick' | 'standard' | 'deep';

/** Graph impact radius (graphify `affected` depth) per profile; 0 means no impact context. */
export const REVIEW_PROFILE_DEPTH: Record<ReviewProfile, number> = { quick: 0, standard: 2, deep: 3 };
const PROFILE_OF: Record<PrRisk, ReviewProfile> = { trivial: 'quick', low: 'standard', medium: 'standard', high: 'deep' };
const DEFAULT_RISK: PrRisk = 'medium';
const MAX_FILES = 60;

export function prRiskQuestions(): Questions {
  return {
    risk: {
      type: 'score',
      instructions:
        'A developer agent committed a change for the task below. From the task, its acceptance criteria and the diff stat, rate how risky it is to merge: trivial (docs, config, tiny local change), low, medium, high (touches shared code, many files, data or auth paths).',
      levels: [...PR_RISK_LEVELS],
    },
  };
}

export function prRiskState(task: PlanTask, opts: { changedFiles: readonly string[]; diffStat: string }): string {
  const files = opts.changedFiles.slice(0, MAX_FILES);
  return [
    `task: ${task.id}`, `title: ${task.title}`, `description: ${task.description}`, `criteria: ${task.criteriaRefs.join(', ')}`,
    `declared paths: ${task.affectedPaths.join(', ')}`, '',
    `changed files (${opts.changedFiles.length}):`, ...files, '', `diff stat:\n${opts.diffStat}`,
  ].join('\n');
}

export interface PrRiskResult {
  risk: PrRisk;
  profile: ReviewProfile;
  source: 'default' | BackendName;
}

export async function choosePrRisk(task: PlanTask, opts: { changedFiles: readonly string[]; diffStat: string }, decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<PrRiskResult> {
  const outcome = await decider.decide('pr-risk', prRiskState(task, opts), prRiskQuestions(), ctx);
  const answer = outcome.answered ? outcome.answers.risk : undefined;
  if (!outcome.answered || !answer || answer.type !== 'score') return { risk: DEFAULT_RISK, profile: PROFILE_OF[DEFAULT_RISK], source: 'default' };
  const risk = PR_RISK_LEVELS[Math.min(PR_RISK_LEVELS.length - 1, Math.max(0, Math.round(answer.value)))]!;
  return { risk, profile: PROFILE_OF[risk], source: outcome.backend };
}
```

- [ ] **Step 4: Run** — `npx vitest run test/decide/pr-risk.test.ts` → PASS.

- [ ] **Step 5: Failing orchestrator test** (append to `test/orchestrator/task-runner.test.ts`)

```ts
describe('TaskRunner: review profile', () => {
  it('asks pr-risk before review, journals the profile and passes the depth to impact', async () => {
    const depths: number[] = [];
    const decider = { decide: async (id: string) => (id === 'pr-risk' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { risk: { type: 'score' as const, value: 3, probabilities: {}, confidence: 0.9 } } } : { answered: false as const, reason: 'disabled' as const }) };
    const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, decider, impact: async (_w, _b, _c, depth) => { depths.push(depth); return { source: 'none' }; } }));
    await r.advance(); await r.advance(); await r.advance();
    expect(depths).toEqual([3]);
    expect(journal.events.find((e) => e.type === OrchEvent.ReviewProfileChosen)!.data).toMatchObject({ taskId: 'T1', risk: 'high', profile: 'deep', source: 'jev' });
    expect(agentCalls.find((c) => c.kind === 'review')!.pack.feedback).toContain('Review profile: deep');
  });
  it('quick profile skips the impact query', async () => {
    const depths: number[] = [];
    const decider = { decide: async (id: string) => (id === 'pr-risk' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { risk: { type: 'score' as const, value: 0, probabilities: {}, confidence: 0.95 } } } : { answered: false as const, reason: 'disabled' as const }) };
    const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, decider, impact: async (_w, _b, _c, depth) => { depths.push(depth); return { source: 'graph', affected: [] }; } }));
    await r.advance(); await r.advance(); await r.advance();
    expect(depths).toEqual([]);
    expect(agentCalls.find((c) => c.kind === 'review')!.pack.code).toEqual({ source: 'none' });
  });
});
```

- [ ] **Step 6: Run to verify it fails** — `npx vitest run test/orchestrator/task-runner.test.ts -t "review profile"` → FAIL (`ReviewProfileChosen` undefined).

- [ ] **Step 7: Implement**

`server/orchestrator/events.ts` — add to `OrchEvent`:

```ts
  ReviewProfileChosen: 'REVIEW_PROFILE_CHOSEN',
```

`server/orchestrator/steps.ts:73-80`:

```ts
export function reviewPack(
  base: PackBase,
  task: PlanTask,
  opts: { diffStat: string; changedFiles: readonly string[]; code: CodeContext; profile: ReviewProfile },
): ContextPackInput {
  const feedback = `Review profile: ${opts.profile}\n\nChanged files:\n${opts.changedFiles.join('\n')}\n\nDiff stat:\n${opts.diffStat}`;
  return { ...common(base, 'review', 'test'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), code: opts.code, feedback };
}
```
with `import type { ReviewProfile } from '../decide/decisions/pr-risk.js';`.

`server/orchestrator/task-runner.ts`:

```ts
import { REVIEW_PROFILE_DEPTH, choosePrRisk } from '../decide/decisions/pr-risk.js';
// TaskRunnerDeps
  impact: (worktree: string, branch: string, changed: readonly string[], depth: number) => Promise<CodeContext>;
// review(), replace the pack construction:
    const risk = await choosePrRisk(this.task.def, { changedFiles: changed, diffStat }, this.deps.decider, this.ctx);
    await this.deps.journal.fact(OrchEvent.ReviewProfileChosen, { taskId: this.taskId, risk: risk.risk, profile: risk.profile, source: risk.source });
    const depth = REVIEW_PROFILE_DEPTH[risk.profile];
    const code: CodeContext = depth === 0 ? { source: 'none' } : await this.deps.impact(this.worktree, this.branch, changed, depth);
    const pack = reviewPack(this.deps.packBase(), this.task.def, { diffStat, changedFiles: changed, code, profile: risk.profile });
```

`server/orchestrator/run.ts` `impact`:

```ts
  private impact = async (worktree: string, branch: string, changed: readonly string[], depth: number): Promise<CodeContext> => {
    // ... unchanged, except:
    const affected = (await Promise.all(changed.map((f) => g.affected(out, f, depth).catch(() => [])))).flat();
```

Update `test/orchestrator/steps.test.ts:89` — the existing `reviewPack(...)` call must gain `profile: 'standard'`. The `impact: async () => ({ source: 'none' })` fakes stay (an arity-0 arrow is assignable).

- [ ] **Step 8: Run the whole suite** — `npm test` → PASS. Existing review tests still see `Changed files:` in feedback (prefix added, nothing removed).

- [ ] **Step 9: Commit**

```bash
git add server/decide/decisions/pr-risk.ts server/orchestrator/events.ts server/orchestrator/steps.ts server/orchestrator/task-runner.ts server/orchestrator/run.ts test/decide/pr-risk.test.ts test/orchestrator/task-runner.test.ts
git commit -m "feat(decide): pr risk decision selects the review profile and impact depth"
```

---

### Task 4: Model tier and effort per task (spec decisions 10 and 11)

**Files:**
- Create: `server/decide/decisions/model-tier.ts`
- Modify: `server/config/config.ts` (`decisions.modelTiers`)
- Modify: `server/runner/invocation.ts:29-50,81` (`effort`, `--effort`)
- Modify: `server/runner/step.ts:17-38,142` (`StepRequest.effort`)
- Modify: `server/orchestrator/steps.ts:130-141,178-188` (`AgentStepRequest.model?`, `effort?`)
- Modify: `server/orchestrator/task-runner.ts` (`implement()`, `review()`)
- Modify: `server/orchestrator/run.ts` `runnerDeps()` (pass `tierModel`)
- Test: `test/decide/model-tier.test.ts`, `test/config/decisions.test.ts`, `test/runner/invocation.test.ts`, `test/orchestrator/steps.test.ts`, `test/orchestrator/task-runner.test.ts`

**Interfaces:**
- Produces: `Effort = 'low' | 'medium' | 'high' | 'max'`; `ModelTier = 'small' | 'medium' | 'large'`; `chooseModelTier(task, attempt, decider, ctx): Promise<{ tier: ModelTier | null; effort: Effort | null; source }>` (null = "use the role default").
- Produces: `Config.decisions.modelTiers: { small: string; medium: string; large: string }` (defaults `haiku` / `sonnet` / `opus`).
- Produces: `TaskRunnerDeps.tierModel: (role: Role, tier: ModelTier) => string | null` (null when the role's profile is not `claude`).
- Changes: `AgentStepRequest` gains `model?: string; effort?: Effort`; `StepRequest` gains `effort?: Effort`; `InvocationInput` gains `effort?: Effort`.

- [ ] **Step 1: Failing decision test** (`test/decide/model-tier.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, MODEL_TIERS, chooseModelTier, modelTierQuestions } from '../../server/decide/decisions/model-tier.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { makePlanTask } from '../fixtures/contracts.js';

const task = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const fake = (o: DecisionOutcome) => ({ decide: async () => o });
const answered = (tier: string, effort: number): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers: { tier: { type: 'choice', value: tier, probabilities: { [tier]: 0.9 }, confidence: 0.9 }, effort: { type: 'score', value: effort, probabilities: {}, confidence: 0.9 } } });
const ctx = { confidential: false };

describe('model tier', () => {
  it('asks a choice for the tier and a score for the effort', () => {
    expect(MODEL_TIERS).toEqual(['small', 'medium', 'large']);
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'max']);
    expect(modelTierQuestions().tier).toMatchObject({ type: 'choice' });
    expect(modelTierQuestions().effort).toMatchObject({ type: 'score', levels: [...EFFORT_LEVELS] });
  });
  it('uses the answer on attempt 1', async () => {
    expect(await chooseModelTier(task, 1, fake(answered('small', 0)), ctx)).toEqual({ tier: 'small', effort: 'low', source: 'jev' });
  });
  it('moves one tier and one effort level up per extra attempt, capped', async () => {
    expect(await chooseModelTier(task, 2, fake(answered('small', 0)), ctx)).toMatchObject({ tier: 'medium', effort: 'medium' });
    expect(await chooseModelTier(task, 5, fake(answered('small', 0)), ctx)).toMatchObject({ tier: 'large', effort: 'max' });
  });
  it('returns nulls when unanswered so the role default applies', async () => {
    expect(await chooseModelTier(task, 1, fake({ answered: false, reason: 'disabled' }), ctx)).toEqual({ tier: null, effort: null, source: 'default' });
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run test/decide/model-tier.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the decision** (`server/decide/decisions/model-tier.ts`)

```ts
import type { PlanTask } from '../../contracts/plan.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decisions 10 and 11: one call picks the model tier and the effort for attempt 1. */
export const MODEL_TIERS = ['small', 'medium', 'large'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

const TIER_OPTIONS: Record<ModelTier, string> = {
  small: 'Mechanical or local work: renames, config, docs, a single small function with an obvious test.',
  medium: 'Ordinary feature work inside one module with clear criteria and no cross-cutting design.',
  large: 'Cross-module changes, concurrency, data migrations, security or auth paths, or ambiguous criteria.',
};

export function modelTierQuestions(): Questions {
  return {
    tier: { type: 'choice', instructions: 'Pick the smallest model tier that can implement this task correctly on the first attempt.', options: TIER_OPTIONS },
    effort: { type: 'score', instructions: 'How much reasoning effort does this task need?', levels: [...EFFORT_LEVELS] },
  };
}

export function modelTierState(task: PlanTask, attempt: number): string {
  return [`task: ${task.id}`, `title: ${task.title}`, `description: ${task.description}`, `owner: ${task.owner}`, `criteria: ${task.criteriaRefs.join(', ')}`, `declared paths: ${task.affectedPaths.join(', ')}`, `attempt: ${attempt}`].join('\n');
}

export interface ModelTierResult {
  tier: ModelTier | null;
  effort: Effort | null;
  source: 'default' | BackendName;
}

const bump = <T extends readonly string[]>(levels: T, idx: number, steps: number): T[number] => levels[Math.min(levels.length - 1, idx + steps)]!;

/** Attempt 2 onward moves one tier and one effort level up, so a misclassified task self-corrects (spec 10A.5). */
export async function chooseModelTier(task: PlanTask, attempt: number, decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<ModelTierResult> {
  const outcome = await decider.decide('model-tier', modelTierState(task, attempt), modelTierQuestions(), ctx);
  if (!outcome.answered) return { tier: null, effort: null, source: 'default' };
  const t = outcome.answers.tier;
  const e = outcome.answers.effort;
  if (!t || t.type !== 'choice' || !(t.value in TIER_OPTIONS) || !e || e.type !== 'score') return { tier: null, effort: null, source: 'default' };
  const extra = Math.max(0, attempt - 1);
  const tier = bump(MODEL_TIERS, MODEL_TIERS.indexOf(t.value as ModelTier), extra);
  const effort = bump(EFFORT_LEVELS, Math.min(EFFORT_LEVELS.length - 1, Math.max(0, Math.round(e.value))), extra);
  return { tier, effort, source: outcome.backend };
}
```

- [ ] **Step 4: Run** — `npx vitest run test/decide/model-tier.test.ts` → PASS.

- [ ] **Step 5: Config `modelTiers`** — failing test in `test/config/decisions.test.ts`:

```ts
  it('model tiers default to haiku / sonnet / opus and must be non-empty', () => {
    expect(DEFAULT_CONFIG.decisions.modelTiers).toEqual({ small: 'haiku', medium: 'sonnet', large: 'opus' });
    expect(() => loadConfig({ decisions: { modelTiers: { small: '' } } })).toThrow(ConfigError);
  });
```

In `server/config/config.ts` `decisions` object, add after `openrouter`:

```ts
      /** Spec 10A.5 decision 10: tier names map to the role's Claude models; OmniRoute pins are never replaced. */
      modelTiers: z
        .object({ small: z.string().min(1).default('haiku'), medium: z.string().min(1).default('sonnet'), large: z.string().min(1).default('opus') })
        .prefault({}),
```

Run: `npx vitest run test/config` → PASS.

- [ ] **Step 6: `--effort` in the invocation** — failing test in `test/runner/invocation.test.ts`:

```ts
  it('passes --effort only when set', () => {
    expect(buildInvocation(base, hostEnv).args).not.toContain('--effort');
    const args = buildInvocation({ ...base, effort: 'high' }, hostEnv).args;
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
  });
```

`server/runner/invocation.ts`: add `effort?: Effort;` to `InvocationInput` (import `type Effort` from `../decide/decisions/model-tier.js`) and after the `--model` push:

```ts
  if (input.effort) args.push('--effort', input.effort);
```

`server/runner/step.ts`: add `effort?: Effort;` to `StepRequest` and `effort: req.effort,` in the `buildInvocation` call.

Run: `npx vitest run test/runner/invocation.test.ts` → PASS.

- [ ] **Step 7: Per-step model override in `runAgentStep`** — failing test in `test/orchestrator/steps.test.ts` (copy the file's existing `runAgentStep` harness; the `profile` fake there returns `sonnet`):

```ts
  it('a request model and effort override the role profile for that step only', async () => {
    const d = await deps(async () => ({ ok: true, value: { specHash: HASH, status: 'done', summary: 's', changedFiles: [], commitMessage: 'm' }, summary: summary() }));
    // The harness fake sees only {kind, prompt}; wrap runStep to capture the full StepRequest.
    const seen: unknown[] = [];
    const inner = d.runStep;
    d.runStep = (async (req, sd) => { seen.push(req); return inner(req, sd); }) as AgentStepDeps['runStep'];
    await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1, model: 'haiku', effort: 'low' }, d);
    expect(seen[0]).toMatchObject({ model: 'haiku', effort: 'low', profile: { provider: 'claude', model: 'sonnet' } });
  });
```
(Reuse the file's existing `summary()`/`base`/`task` helpers; if `devPack` feedback expects `string | null`, match its current signature.)

`server/orchestrator/steps.ts`:

```ts
export interface AgentStepRequest<K extends StepKind> {
  // ...existing fields
  /** Spec 10A.5 decisions 10/11: per-step model and effort; absent means the role profile. */
  model?: string;
  effort?: Effort;
}
// in runAgentStep's runStep call:
        model: req.model ?? profile.model,
        effort: req.effort,
```

Run: `npx vitest run test/orchestrator/steps.test.ts` → PASS.

- [ ] **Step 8: Failing orchestrator test** (append to `test/orchestrator/task-runner.test.ts`)

```ts
describe('TaskRunner: model tier', () => {
  const tierDecider = { decide: async (id: string) => (id === 'model-tier' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { tier: { type: 'choice' as const, value: 'small', probabilities: { small: 0.9 }, confidence: 0.9 }, effort: { type: 'score' as const, value: 0, probabilities: {}, confidence: 0.9 } } } : { answered: false as const, reason: 'disabled' as const }) };
  const tiers: Record<string, string> = { small: 'haiku', medium: 'sonnet', large: 'opus' };

  it('dev attempt 1 runs on the small tier with low effort; review on the test role uses the same decision', async () => {
    const agent: Agent = async (req) => (req.kind === 'review' ? approve() : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, decider: tierDecider, tierModel: (_role, tier) => tiers[tier]! }));
    await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.find((c) => c.kind === 'dev')).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(agentCalls.find((c) => c.kind === 'review')).toMatchObject({ model: 'haiku', effort: 'low' });
  });

  it('attempt 2 moves one tier up', async () => {
    const failingGates = async () => { const f = gate('unit-test', { passed: false, exitCode: 1, failure: 'code' as const }); return { results: [f], blockingFailure: f }; };
    const r = new TaskRunner('T1', deps({ gates: failingGates, decider: tierDecider, tierModel: (_role, tier) => tiers[tier]! }));
    await r.advance(); await r.advance(); await r.advance();
    expect(agentCalls.map((c) => [c.kind, c.model, c.effort])).toEqual([['dev', 'haiku', 'low'], ['dev', 'sonnet', 'medium']]);
  });

  it('leaves model and effort unset when the role is not on a claude profile (OmniRoute pin kept)', async () => {
    const r = new TaskRunner('T1', deps({ decider: tierDecider, tierModel: () => null }));
    await r.advance();
    expect(agentCalls[0]!.model).toBeUndefined();
    expect(agentCalls[0]!.effort).toBe('low');
  });

  it('with the decision off nothing is set', async () => {
    const r = new TaskRunner('T1', deps({ tierModel: (_role, tier) => tiers[tier]! }));
    await r.advance();
    expect(agentCalls[0]!.model).toBeUndefined();
    expect(agentCalls[0]!.effort).toBeUndefined();
  });
});
```

Add `tierModel: () => null,` to the `deps()` factory defaults in that test file.

- [ ] **Step 9: Run** — `npx vitest run test/orchestrator/task-runner.test.ts -t "model tier"` → FAIL (`tierModel` unknown).

- [ ] **Step 10: Wire into `TaskRunner`**

`server/orchestrator/task-runner.ts`:

```ts
import { chooseModelTier, type ModelTier } from '../decide/decisions/model-tier.js';
import type { Role } from '../config/config.js';
// TaskRunnerDeps
  /** Model name for a tier on this role's Claude profile; null when the role runs on another provider. */
  tierModel: (role: Role, tier: ModelTier) => string | null;
// helper on the class
  private async stepOverrides(role: Role, attempt: number): Promise<{ model?: string; effort?: Effort }> {
    const chosen = await chooseModelTier(this.task.def, attempt, this.deps.decider, this.ctx);
    const model = chosen.tier ? this.deps.tierModel(role, chosen.tier) : null;
    return { ...(model ? { model } : {}), ...(chosen.effort ? { effort: chosen.effort } : {}) };
  }
```
(import `type Effort` too.) In `implement()` spread `...(await this.stepOverrides('dev', attempt))` into the `runAgent<'dev'>` request; in `review()` spread `...(await this.stepOverrides('test', this.task.attempts + 1))` into the `runAgent<'review'>` request.

`server/orchestrator/run.ts` `runnerDeps()` return object:

```ts
      tierModel: (role, tier) => {
        const profile = resolveProfile(cfg, role, project);
        return profile.provider === 'claude' ? cfg.decisions.modelTiers[tier] : null;
      },
```

- [ ] **Step 11: Run the whole suite** — `npm test` → PASS.

- [ ] **Step 12: Commit**

```bash
git add server/decide/decisions/model-tier.ts server/config/config.ts server/runner/invocation.ts server/runner/step.ts server/orchestrator/steps.ts server/orchestrator/task-runner.ts server/orchestrator/run.ts test/decide/model-tier.test.ts test/config/decisions.test.ts test/runner/invocation.test.ts test/orchestrator/steps.test.ts test/orchestrator/task-runner.test.ts
git commit -m "feat(decide): model tier and effort per task from the model-tier decision"
```

---

## Out of scope (deliberately)

- Flipping `decisions.enabled` to `true` — operator choice per run (spec §1.3 keeps it off for runs 1–2).
- Decisions 2–4, 7, 9, 12 — depend on the refine/validation flows not yet wired into the orchestrator, or on multi-call per-item shapes.
- Evals (spec 10A.6) — labeled fixtures grow from `DECISION_MADE` journal records these tasks now produce.
