# teams-ai Plan 7 — Orchestrator, Phases 1–3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `server/orchestrator/`: the module that takes a frozen spec in an existing repository through the technical spec (Phase 1), the plan (Phase 2) and the task loop (Phase 3) with crash recovery, budgets, quota pauses and gate-failure triage, driven by a `teams-ai` CLI.

**Architecture:** A `Journal` (event store + reduced `RunState`) is the single write path for state; every side effect is `intent → effect → confirm`. One `Run` owns a `tick()` loop and at most `maxParallel` `TaskRunner`s; a runner advances one task state per call and returns through the journal, so live execution and replay follow the same code. Every external dependency (`runStep`, `Exec`, graphify, GitHub, clock) is injected; `npm test` uses the fake `claude`, a scripted `Exec` for docker/gh and a real local git remote.

**Tech Stack:** Node 22 (ESM), TypeScript 5.9.3, Vitest 5, zod 4, `node:sqlite`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-orchestrator-phases-1-3-design.md` (all sections) and the POC spec `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` §6, §7, §8, §9A, §12, §15A.

## Global Constraints

- Everything from Plan 1's Global Constraints (pins, ESM, `.js` import suffix, English, ID patterns, commit trailer).
- `npm test` spawns only `git` and `node`; never `docker`, `gh`, `claude`, `graphify` or the network. Those go through the injected `Exec`/`runStep` and are faked.
- Every side effect on git, GitHub, the filesystem or the log is an `intent → effect → confirm` triple with a deterministic `intentId` (`<TYPE>:<key>`), so reconcile can match it after a crash.
- `main` is written only through `MergeQueue` (tasks and docs alike). Worktrees push their own branch only.
- Every string that came from an agent or a process is passed through `redactSecrets(text, secretValues)` before it is appended to the journal or written under `runs/`.
- Runners never mutate `RunState`; they append events through the `Journal`, which reduces them.
- An interrupted LLM step is re-run and never consumes an attempt (POC spec §7.3).
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## Review Focus

1. **Crash between `PR_MERGE` intent and its confirm.** On resume the PR is merged on GitHub but the task is still `merging`; reconcile must confirm, run `afterMerge` and move the task to `merged` without a second merge (Task 6 test "confirms a merged PR and finishes the task without merging again").
2. **Dev commit message or summary containing a secret value.** The gate container's secrets can leak into stderr and from there into Dev's summary; the journal and the PR body must carry `[REDACTED]` (Task 3 test "redacts secret values from the step output before journaling", Task 5 test "redacts the PR body").
3. **Two runners merging concurrently.** `MergeQueue` serializes, but the second task's rebase base must be the `main` that includes the first merge; a stale base makes the queue refuse the merge and the task must go back to `rebasing`, not `implementing` (Task 4 test "a refused merge returns the task to rebasing without consuming an attempt").
4. **Spec-gap loop.** A Dev that keeps returning `spec-gap` never consumes an attempt; without a cap the run spins. The runner caps spec-gap rounds per attempt at 3, after which the round counts as a `code` failure (Task 4 test "caps spec-gap rounds at three per attempt").
5. **Quota pause with an in-flight step.** When the breaker opens while a runner is inside `runStep`, that step's outcome must still be journaled and the pause must start only after it returns; on resume no step runs twice (Task 8 test "pauses after the in-flight step returns and resumes without re-running it").

## File structure

```
server/orchestrator/events.ts            event and intent type names, zod payloads, Journal (store + RunState + feedback lookup)
server/orchestrator/workspace.ts         paths under ~/.teams-ai, run ids, step dirs, branch→dir mapping
server/orchestrator/steps.ts             packFor(kind, …) → ContextPackInput; runAgentStep(): governor, breaker, journal, redaction, step files
server/orchestrator/task-runner.ts       TaskRunner: one advance() per state row of spec §4.4, spec-gap, replan, failure routing
server/orchestrator/merge-steps.ts       realMergeSteps(): MergeSteps over git.ts/github.ts/runGates + afterMerge; docsMergeSteps()
server/orchestrator/reconcile.ts         reconcile(): unconfirmed intents → reality → confirm or redo marker
server/orchestrator/phases/tech-spec.ts  Phase 1
server/orchestrator/phases/plan.ts       Phase 2
server/orchestrator/run.ts               Run.create / Run.resume, tick loop, pause/resume, budgets, terminal states, decider wiring
server/cli.ts                            teams-ai run | resume | status
server/agents/outputs.ts                 + 'spec-gap', 'replan' step kinds and schemas
.claude/agents/sm.md                     + output sections for spec-gap and replan
test/orchestrator/*.test.ts
test/fixtures/git-remote.ts              makeRemote(): bare origin + clone with docs/ committed on main
test/fixtures/fake-claude/scenario.ts    Scenario: per (kind, taskId, attempt) structured output → ndjson fixture file
test/fixtures/fake-gh.ts                 in-memory PR store answering gh pr list/create/merge/view through FakeExec
scripts/integration/orchestrator.ts      manual end-to-end on hello-app
```

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Tasks 3–8 consume Task 1's `Journal`; Task 4 consumes Task 3's `runAgentStep` and Task 2's schemas; Task 8 consumes 4–7.

---

### Task 1: Events, Journal and workspace paths

**Files:**
- Create: `server/orchestrator/events.ts`, `server/orchestrator/workspace.ts`
- Test: `test/orchestrator/events.test.ts`, `test/orchestrator/workspace.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `StoredEvent`, `unconfirmedIntents` (`server/store/event-store.ts`); `RunState`, `RunEvent`, `applyEvent`, `reduceEvents`, `emptyRunState` (`server/pipeline/run-state.ts`); `Config` (`server/config/config.ts`); `stepId` (`server/core/ids.ts`).
- Produces:
  ```ts
  export const OrchEvent = { RunStarted: 'RUN_STARTED', PhaseStarted: 'PHASE_STARTED', PhaseFailed: 'PHASE_FAILED', TechSpecWritten: 'TECH_SPEC_WRITTEN', CoverageChecked: 'COVERAGE_CHECKED', DocsMerged: 'DOCS_MERGED', StepStarted: 'STEP_STARTED', StepFinished: 'STEP_FINISHED', DevCommitted: 'DEV_COMMITTED', GatePassed: 'GATE_PASSED', GateFailed: 'GATE_FAILED', ReviewApproved: 'REVIEW_APPROVED', ReviewChanges: 'REVIEW_CHANGES', SpecGapAnswered: 'SPEC_GAP_ANSWERED', DecisionMade: 'DECISION_MADE', MergeLockAcquired: 'MERGE_LOCK_ACQUIRED', PrCreated: 'PR_CREATED', PrMerged: 'PR_MERGED', TaskBlocked: 'TASK_BLOCKED', BudgetExceeded: 'BUDGET_EXCEEDED', RunFinished: 'RUN_FINISHED', Feedback: 'FEEDBACK' } as const;
  export const Intent = { WorktreeCreate: 'WORKTREE_CREATE', Commit: 'COMMIT', DocsCommit: 'DOCS_COMMIT', Push: 'PUSH', PrCreate: 'PR_CREATE', PrMerge: 'PR_MERGE', WorktreeRemove: 'WORKTREE_REMOVE' } as const;
  export type IntentType = (typeof Intent)[keyof typeof Intent];
  export function intentId(type: IntentType, key: string): string;          // `${type}:${key}`
  export type RunResult = 'complete' | 'blocked' | 'deadlocked' | 'drained' | 'phase-failed';
  export class Journal {
    static async open(opts: { file: string; runId: string; specHash: string; clock?: () => Date }): Promise<Journal>;
    readonly state: RunState;                       // reduced from every event on open, kept current by append
    readonly events: readonly StoredEvent[];        // in order
    fact(type: string, data?: Record<string, unknown>): Promise<StoredEvent>;
    intent(type: IntentType, key: string, data?: Record<string, unknown>): Promise<StoredEvent>;
    confirm(type: IntentType, key: string, data?: Record<string, unknown>): Promise<StoredEvent>;
    unconfirmed(): StoredEvent[];
    isConfirmed(type: IntentType, key: string): boolean;
    nextStepSeq(): number;                          // 1 + count of STEP_STARTED
    lastFeedback(taskId: string): string | null;    // data.text of the last FEEDBACK event for the task
    assumptions(): string[];                        // data.assumption of every SPEC_GAP_ANSWERED
    close(): Promise<void>;
  }
  // workspace.ts
  export interface Workspace { projectId: string; root: string; repo: string; worktrees: string; graph: string; knowledgeDb: string; runs: string }
  export function expandHome(p: string, home?: string): string;
  export function workspacePaths(cfg: Config, projectId: string, home?: string): Workspace;
  export function worktreeDir(ws: Workspace, branch: string): string;      // branch with '/' → '__'
  export function graphDir(ws: Workspace, branch: string | null): string;  // null = main
  export function runDir(ws: Workspace, runId: string): string;
  export function eventsFile(ws: Workspace, runId: string): string;
  export function stateFile(ws: Workspace, runId: string): string;
  export function stepDir(ws: Workspace, runId: string, seq: number): string;   // runs/<runId>/steps/<stepId(seq)>
  export async function nextRunId(ws: Workspace, specId: string): Promise<string>;  // `${specId}-r${n}`
  ```

- [ ] **Step 1: Write the failing tests**

`test/orchestrator/events.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Intent, Journal, OrchEvent, intentId } from '../../server/orchestrator/events.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import { makePlanTask } from '../fixtures/contracts.js';

const HASH = 'sha256:' + 'c'.repeat(64);
let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});
async function open() {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-journal-'));
  return Journal.open({ file: path.join(dir, 'events.ndjson'), runId: 'spec-r1', specHash: HASH, clock: () => new Date('2026-09-24T10:00:00Z') });
}

describe('Journal', () => {
  it('reduces run-state events on append and on reopen', async () => {
    const j = await open();
    await j.fact(RunEvent.TaskPlanned, { task: makePlanTask({ id: 'T1' }) });
    await j.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
    expect(j.state.tasks.get('T1')!.state).toBe('ready');
    await j.close();
    const again = await Journal.open({ file: path.join(dir, 'events.ndjson'), runId: 'spec-r1', specHash: HASH });
    expect(again.state.tasks.get('T1')!.state).toBe('ready');
    expect(again.events).toHaveLength(2);
    await again.close();
  });

  it('pairs intents and confirms by a deterministic id', async () => {
    const j = await open();
    await j.intent(Intent.Commit, 'T1', { worktree: '/w' });
    expect(j.unconfirmed().map((e) => e.intentId)).toEqual([intentId(Intent.Commit, 'T1')]);
    expect(j.isConfirmed(Intent.Commit, 'T1')).toBe(false);
    await j.confirm(Intent.Commit, 'T1', { sha: 'abc' });
    expect(j.unconfirmed()).toEqual([]);
    expect(j.isConfirmed(Intent.Commit, 'T1')).toBe(true);
    await j.close();
  });

  it('numbers steps, returns the last feedback per task and collects assumptions', async () => {
    const j = await open();
    expect(j.nextStepSeq()).toBe(1);
    await j.fact(OrchEvent.StepStarted, { stepId: 's00001', kind: 'dev' });
    expect(j.nextStepSeq()).toBe(2);
    expect(j.lastFeedback('T1')).toBeNull();
    await j.fact(OrchEvent.Feedback, { taskId: 'T1', text: 'gate unit-test failed' });
    await j.fact(OrchEvent.Feedback, { taskId: 'T2', text: 'other' });
    await j.fact(OrchEvent.Feedback, { taskId: 'T1', text: 'review: findings' });
    expect(j.lastFeedback('T1')).toBe('review: findings');
    await j.fact(OrchEvent.SpecGapAnswered, { taskId: 'T1', question: 'q', answer: 'a', assumption: 'T1: q → a' });
    expect(j.assumptions()).toEqual(['T1: q → a']);
    await j.close();
  });
});
```

`test/orchestrator/workspace.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../server/config/config.js';
import { eventsFile, expandHome, graphDir, nextRunId, stepDir, workspacePaths, worktreeDir } from '../../server/orchestrator/workspace.js';

let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('workspace', () => {
  it('expands ~ against the given home and lays out the project directories', () => {
    expect(expandHome('~/.teams-ai/x', '/home/u')).toBe('/home/u/.teams-ai/x');
    const ws = workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u');
    expect(ws).toEqual({
      projectId: 'shop',
      root: '/home/u/.teams-ai/workspaces/shop',
      repo: '/home/u/.teams-ai/workspaces/shop/repo',
      worktrees: '/home/u/.teams-ai/workspaces/shop/worktrees',
      graph: '/home/u/.teams-ai/workspaces/shop/graph',
      knowledgeDb: '/home/u/.teams-ai/workspaces/shop/knowledge.sqlite',
      runs: '/home/u/.teams-ai/runs',
    });
    expect(worktreeDir(ws, 'task/checkout-T1')).toBe('/home/u/.teams-ai/workspaces/shop/worktrees/task__checkout-T1');
    expect(graphDir(ws, null)).toBe('/home/u/.teams-ai/workspaces/shop/graph/main');
    expect(graphDir(ws, 'task/checkout-T1')).toBe('/home/u/.teams-ai/workspaces/shop/graph/worktrees/task__checkout-T1');
    expect(eventsFile(ws, 'checkout-r1')).toBe('/home/u/.teams-ai/runs/checkout-r1/events.ndjson');
    expect(stepDir(ws, 'checkout-r1', 7)).toBe('/home/u/.teams-ai/runs/checkout-r1/steps/s00007');
  });

  it('numbers runs per spec from the existing run directories', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    expect(await nextRunId(ws, 'checkout')).toBe('checkout-r1');
    await fs.mkdir(path.join(dir, 'checkout-r1'));
    await fs.mkdir(path.join(dir, 'checkout-r2'));
    await fs.mkdir(path.join(dir, 'other-r9'));
    expect(await nextRunId(ws, 'checkout')).toBe('checkout-r3');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/orchestrator`
Expected: FAIL, cannot resolve `../../server/orchestrator/events.js` and `workspace.js`.

- [ ] **Step 3: Implement events.ts**

`server/orchestrator/events.ts`:
```ts
import { applyEvent, emptyRunState, type RunState } from '../pipeline/run-state.js';
import { EventStore, unconfirmedIntents, type StoredEvent } from '../store/event-store.js';

export const OrchEvent = {
  RunStarted: 'RUN_STARTED',
  PhaseStarted: 'PHASE_STARTED',
  PhaseFailed: 'PHASE_FAILED',
  TechSpecWritten: 'TECH_SPEC_WRITTEN',
  CoverageChecked: 'COVERAGE_CHECKED',
  DocsMerged: 'DOCS_MERGED',
  StepStarted: 'STEP_STARTED',
  StepFinished: 'STEP_FINISHED',
  DevCommitted: 'DEV_COMMITTED',
  GatePassed: 'GATE_PASSED',
  GateFailed: 'GATE_FAILED',
  ReviewApproved: 'REVIEW_APPROVED',
  ReviewChanges: 'REVIEW_CHANGES',
  SpecGapAnswered: 'SPEC_GAP_ANSWERED',
  DecisionMade: 'DECISION_MADE',
  MergeLockAcquired: 'MERGE_LOCK_ACQUIRED',
  PrCreated: 'PR_CREATED',
  PrMerged: 'PR_MERGED',
  TaskBlocked: 'TASK_BLOCKED',
  BudgetExceeded: 'BUDGET_EXCEEDED',
  RunFinished: 'RUN_FINISHED',
  /** The delta handed to the next Dev attempt (gate failures, findings, conflicts, spec-gap answer). */
  Feedback: 'FEEDBACK',
} as const;

export const Intent = {
  WorktreeCreate: 'WORKTREE_CREATE',
  Commit: 'COMMIT',
  DocsCommit: 'DOCS_COMMIT',
  Push: 'PUSH',
  PrCreate: 'PR_CREATE',
  PrMerge: 'PR_MERGE',
  WorktreeRemove: 'WORKTREE_REMOVE',
} as const;
export type IntentType = (typeof Intent)[keyof typeof Intent];

export type RunResult = 'complete' | 'blocked' | 'deadlocked' | 'drained' | 'phase-failed';

/** Deterministic so reconcile can match an intent to its confirm across restarts (spec §7.2). */
export function intentId(type: IntentType, key: string): string {
  return `${type}:${key}`;
}

const REDUCED = new Set([
  'TASK_PLANNED',
  'TASK_STATE_CHANGED',
  'ATTEMPT_CONSUMED',
  'INFRA_RETRY',
  'FLAKY_RETRY',
  'TASK_REPLANNED',
  'RUN_PAUSED',
  'RUN_RESUMED',
  'RUN_BUDGET_EXHAUSTED',
]);

/** The single write path for run state: append to the log, then reduce. Replay and live execution share it. */
export class Journal {
  readonly state: RunState;
  private readonly log: StoredEvent[];

  private constructor(
    private readonly store: EventStore,
    events: StoredEvent[],
  ) {
    this.log = events;
    this.state = emptyRunState();
    for (const e of events) this.reduce(e);
  }

  static async open(opts: { file: string; runId: string; specHash: string; clock?: () => Date }): Promise<Journal> {
    const store = await EventStore.open(opts);
    const events = await store.readAll();
    return new Journal(store, events);
  }

  get events(): readonly StoredEvent[] {
    return this.log;
  }

  private reduce(e: StoredEvent): void {
    if (e.kind === 'fact' && REDUCED.has(e.type)) applyEvent(this.state, { type: e.type, data: e.data });
  }

  private async append(input: { type: string; kind?: 'fact' | 'intent' | 'confirm'; intentId?: string; data?: Record<string, unknown> }): Promise<StoredEvent> {
    const stored = await this.store.append(input);
    this.log.push(stored);
    this.reduce(stored);
    return stored;
  }

  fact(type: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    return this.append({ type, kind: 'fact', data });
  }

  intent(type: IntentType, key: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    return this.append({ type, kind: 'intent', intentId: intentId(type, key), data });
  }

  confirm(type: IntentType, key: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    return this.append({ type, kind: 'confirm', intentId: intentId(type, key), data });
  }

  unconfirmed(): StoredEvent[] {
    return unconfirmedIntents(this.log);
  }

  isConfirmed(type: IntentType, key: string): boolean {
    const id = intentId(type, key);
    return this.log.some((e) => e.kind === 'confirm' && e.intentId === id);
  }

  nextStepSeq(): number {
    return 1 + this.log.filter((e) => e.type === OrchEvent.StepStarted).length;
  }

  lastFeedback(taskId: string): string | null {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i]!;
      if (e.type === OrchEvent.Feedback && e.data.taskId === taskId) return String(e.data.text);
    }
    return null;
  }

  assumptions(): string[] {
    return this.log.filter((e) => e.type === OrchEvent.SpecGapAnswered).map((e) => String(e.data.assumption));
  }

  close(): Promise<void> {
    return this.store.close();
  }
}
```

- [ ] **Step 4: Implement workspace.ts**

`server/orchestrator/workspace.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { stepId } from '../core/ids.js';

export interface Workspace {
  projectId: string;
  root: string;
  repo: string;
  worktrees: string;
  graph: string;
  knowledgeDb: string;
  runs: string;
}

export function expandHome(p: string, home: string = os.homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? path.posix.join(home, p.slice(2)) : p;
}

/** Spec §3: everything for a project under workspaces/<projectId>; runs are global, keyed by runId. */
export function workspacePaths(cfg: Config, projectId: string, home?: string): Workspace {
  const root = path.posix.join(expandHome(cfg.paths.workspaces, home), projectId);
  return {
    projectId,
    root,
    repo: path.posix.join(root, 'repo'),
    worktrees: path.posix.join(root, 'worktrees'),
    graph: path.posix.join(root, 'graph'),
    knowledgeDb: path.posix.join(root, 'knowledge.sqlite'),
    runs: expandHome(cfg.paths.runs, home),
  };
}

const branchDir = (branch: string) => branch.replace(/\//g, '__');

export function worktreeDir(ws: Workspace, branch: string): string {
  return path.posix.join(ws.worktrees, branchDir(branch));
}

export function graphDir(ws: Workspace, branch: string | null): string {
  return branch === null ? path.posix.join(ws.graph, 'main') : path.posix.join(ws.graph, 'worktrees', branchDir(branch));
}

export function runDir(ws: Workspace, runId: string): string {
  return path.posix.join(ws.runs, runId);
}

export function eventsFile(ws: Workspace, runId: string): string {
  return path.posix.join(runDir(ws, runId), 'events.ndjson');
}

export function stateFile(ws: Workspace, runId: string): string {
  return path.posix.join(runDir(ws, runId), 'state.json');
}

export function stepDir(ws: Workspace, runId: string, seq: number): string {
  return path.posix.join(runDir(ws, runId), 'steps', stepId(seq));
}

/** `<specId>-r<n>`, n = 1 + the highest existing run number for that spec. */
export async function nextRunId(ws: Workspace, specId: string): Promise<string> {
  let names: string[] = [];
  try {
    names = await fs.readdir(ws.runs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const re = new RegExp(`^${specId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-r(\\d+)$`);
  const max = names.map((n) => re.exec(n)).filter((m): m is RegExpExecArray => m !== null).reduce((acc, m) => Math.max(acc, Number(m[1])), 0);
  return `${specId}-r${max + 1}`;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/orchestrator && npm run typecheck`
Expected: 5 tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/events.ts server/orchestrator/workspace.ts test/orchestrator/events.test.ts test/orchestrator/workspace.test.ts
git commit -m "feat(orchestrator): journal over the event store and workspace paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `spec-gap` and `replan` step kinds

**Files:**
- Modify: `server/agents/outputs.ts` (`STEP_KINDS`, two schemas, `OUTPUT_SCHEMAS`)
- Modify: `.claude/agents/sm.md` (append two output sections)
- Test: `test/agents/outputs.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export const SpecGapOutput = z.object({ specHash, answer: z.string().min(1), assumption: z.string().min(1) });
  export type SpecGapOutput = z.infer<typeof SpecGapOutput>;
  export const ReplanOutput = z.object({ specHash, replacements: z.array(PlanTask).min(1).max(3) });
  export type ReplanOutput = z.infer<typeof ReplanOutput>;
  STEP_KINDS gains 'spec-gap' and 'replan'.
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/agents/outputs.test.ts` inside its top-level `describe`:
```ts
  it('spec-gap and replan are step kinds with their own schemas', () => {
    const HASH = 'sha256:' + 'a'.repeat(64);
    expect(STEP_KINDS).toContain('spec-gap');
    expect(STEP_KINDS).toContain('replan');
    expect(OUTPUT_SCHEMAS['spec-gap'].safeParse({ specHash: HASH, answer: 'Use UTC', assumption: 'T1: timezone → UTC' }).success).toBe(true);
    expect(OUTPUT_SCHEMAS['spec-gap'].safeParse({ specHash: HASH, answer: '' }).success).toBe(false);
    const task = { id: 'T1-r1', title: 't', description: 'd', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: ['src'], owner: 'dev' };
    expect(OUTPUT_SCHEMAS.replan.safeParse({ specHash: HASH, replacements: [task] }).success).toBe(true);
    expect(OUTPUT_SCHEMAS.replan.safeParse({ specHash: HASH, replacements: [] }).success).toBe(false);
    expect(OUTPUT_SCHEMAS.replan.safeParse({ specHash: HASH, replacements: [task, task, task, task] }).success).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/agents/outputs.test.ts`
Expected: FAIL, `STEP_KINDS` does not contain `spec-gap`.

- [ ] **Step 3: Add the kinds and schemas**

In `server/agents/outputs.ts`:
```ts
export const STEP_KINDS = ['refine', 'tech-spec', 'coverage', 'plan', 'dev', 'review', 'deployment', 'report', 'decide', 'spec-gap', 'replan'] as const;
```
Change the plan import to `import { ADR_ID, Plan, PlanTask } from '../contracts/plan.js';` and add before `OUTPUT_SCHEMAS`:
```ts
/** Spec (orchestrator) §4.5: SM answers a Dev's spec-gap; the assumption is the one-line log entry. */
export const SpecGapOutput = z.object({ specHash, answer: z.string().min(1), assumption: z.string().min(1) });
export type SpecGapOutput = z.infer<typeof SpecGapOutput>;

/** Spec (orchestrator) §4.6: SM splits or changes a task that spent its attempts. */
export const ReplanOutput = z.object({ specHash, replacements: z.array(PlanTask).min(1).max(3) });
export type ReplanOutput = z.infer<typeof ReplanOutput>;
```
Add `'spec-gap': SpecGapOutput,` and `replan: ReplanOutput,` to `OUTPUT_SCHEMAS`.

- [ ] **Step 4: Extend the SM prompt**

Append to `.claude/agents/sm.md`:
```markdown

## Answering a spec gap (`spec-gap` step)

You receive the Dev's question, the task, its acceptance criteria and the tech-spec excerpt. Decide from the principles, the ADRs and the spec; never ask the human. Return `{specHash, answer, assumption}` where `answer` tells the Dev exactly what to do and `assumption` is one line for the assumptions log: `<taskId>: <question> → <decision> (<rationale>)`.

## Replanning a task (`replan` step)

You receive the task, the feedback from every failed attempt, its acceptance criteria and the module boundaries. Return `{specHash, replacements}`: one to three smaller tasks whose ids are `<taskId>-r1`, `<taskId>-r2`, …, whose `criteriaRefs` together cover the original task's criteria, whose `dependsOn` reference existing tasks or each other, and whose `affectedPaths` do not overlap each other. Never re-issue the original task unchanged.
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/agents test/decide && npm run typecheck`
Expected: PASS (the decide tests still pass; `OUTPUT_SCHEMAS` is exhaustive over `STEP_KINDS`).

- [ ] **Step 6: Commit**

```bash
git add server/agents/outputs.ts .claude/agents/sm.md test/agents/outputs.test.ts
git commit -m "feat(agents): spec-gap and replan step kinds for the SM

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Context packs per step kind and `runAgentStep`

**Files:**
- Create: `server/orchestrator/steps.ts`
- Test: `test/orchestrator/steps.test.ts`

**Interfaces:**
- Consumes: `buildContextPack`, `ContextPackInput`, `HandoffSummary`, `CodeContext` (`server/knowledge/context-pack.ts`); `Hit` (`retrieval.ts`); `runStep`, `StepRequest`, `StepDeps`, `StepOutcome` (`server/runner/step.ts`); `OutputOf`, `StepKind`, `toJsonSchema` (`server/agents/outputs.ts`); `AgentDefinition` (`registry.ts`); `Governor`; `QuotaBreaker`; `Journal`, `OrchEvent` (Task 1); `redactSecrets`; `stepId`.
- Produces:
  ```ts
  export interface PackBase { spec: Spec; project: Project; specHash: string; assumptions: readonly string[]; adrs?: ReadonlyArray<{ id: string; title: string; text: string }>; techSpecExcerpt?: string; retrieval?: readonly Hit[]; budgetTokens: number }
  export function devPack(base: PackBase, task: PlanTask, opts: { code: CodeContext; handoffs: readonly HandoffSummary[]; feedback: string | null }): ContextPackInput;
  export function reviewPack(base: PackBase, task: PlanTask, opts: { diffStat: string; changedFiles: readonly string[]; code: CodeContext }): ContextPackInput;
  export function techSpecPack(base: PackBase, opts: { feedback: string | null }): ContextPackInput;
  export function coveragePack(base: PackBase, opts: { techSpecText: string }): ContextPackInput;
  export function planPack(base: PackBase, opts: { techSpecText: string; godNodes: ReadonlyArray<{ label: string; edges: number }>; feedback: string | null }): ContextPackInput;
  export function specGapPack(base: PackBase, task: PlanTask, opts: { question: string }): ContextPackInput;
  export function replanPack(base: PackBase, task: PlanTask, opts: { history: readonly string[]; boundaries: readonly string[] }): ContextPackInput;
  export function outputContract(kind: StepKind): string;   // "Return exactly one JSON object matching this schema:\n" + JSON schema
  export interface AgentStepRequest<K extends StepKind> { kind: K; role: Role; pack: ContextPackInput; cwd: string; phase: string; taskId: string | null; attempt: number; refContext?: RefContext; refs?: StepRequest['refs']; semantic?: StepRequest['semantic']; extraAllow?: readonly string[] }
  export interface AgentStepDeps {
    runStep: typeof runStep;
    stepDeps: StepDeps;
    agents: Record<Role, AgentDefinition>;
    profile: (role: Role) => ProviderProfile;
    omniroute?: StepRequest['omniroute'];
    governor: Governor;
    breaker: QuotaBreaker;
    journal: Journal;
    stepDir: (seq: number) => string;
    secretValues: () => readonly string[];
    specHash: string;
  }
  export async function runAgentStep<K extends StepKind>(req: AgentStepRequest<K>, deps: AgentStepDeps): Promise<StepOutcome<OutputOf<K>>>;
  ```
- `runAgentStep`: `seq = journal.nextStepSeq()`; `STEP_STARTED {stepId, kind, role, taskId, attempt, tokens: pack.tokens, dropped}`; write `<stepDir>/prompt.md`; `release = await governor.acquire()`; `runStep({...})` with `prompt = buildContextPack(pack).text`; `release()`; `breaker.observe(outcome.summary.rateLimit)`; on `failure === 'quota'` → `breaker.onQuotaFailure(summary.rateLimit)`; write `<stepDir>/output.json` with the redacted outcome (value or errors); `STEP_FINISHED {stepId, ok, failure, usage, costUsd, durationMs}`; return the outcome with `errors` redacted.

- [ ] **Step 1: Write the failing test**

`test/orchestrator/steps.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { Governor } from '../../server/budget/governor.js';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { devPack, outputContract, planPack, reviewPack, runAgentStep, type AgentStepDeps, type PackBase } from '../../server/orchestrator/steps.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makePlanTask, makeProject, makeFrozenSpec } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const base: PackBase = { spec, project: makeProject(), specHash: HASH, assumptions: ['T0: db → sqlite'], budgetTokens: 8000 };
const task = makePlanTask({ id: 'T1', criteriaRefs: [spec.acceptanceCriteria[0]!.id] });
const summary = (over: Partial<ResultSummary> = {}): ResultSummary => ({
  found: true, isError: false, subtype: 'success', numTurns: 2, durationMs: 900, costUsd: 0.02,
  usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null,
  apiErrorStatus: null, rateLimit: null, compactions: 0, ...over,
});

let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function deps(fake: (req: { kind: string; prompt: string }) => Promise<StepOutcome<unknown>>): Promise<AgentStepDeps & { journal: Journal }> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-steps-'));
  const journal = await Journal.open({ file: path.join(dir, 'events.ndjson'), runId: 'r1', specHash: HASH });
  const agents = await loadAgents(path.resolve('.claude/agents'));
  return {
    runStep: (async (req) => fake({ kind: req.kind, prompt: req.prompt })) as AgentStepDeps['runStep'],
    stepDeps: {
      binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
      caps: { timeoutMs: 1000, maxTurns: 5 },
      accounting: new Accounting(),
      claudeJsonPath: path.join(dir, '.claude.json'),
      settingsDir: path.join(dir, 'settings'),
      workspacesRoot: dir,
      network: { allowedDomains: [] },
    },
    agents,
    profile: () => ({ provider: 'claude', model: 'sonnet' }),
    governor: new Governor(3),
    breaker: new QuotaBreaker(),
    journal,
    stepDir: (seq) => path.join(dir, 'steps', String(seq)),
    secretValues: () => ['s3cr3t-value'],
    specHash: HASH,
  };
}

describe('packs', () => {
  it('dev pack carries the task, its criteria only, assumptions, handoffs, code and feedback', () => {
    const p = devPack(base, task, { code: { source: 'none' }, handoffs: [{ taskId: 'T0', title: 'scaffold', summary: 'done', changedFiles: ['package.json'], mergedAt: '2026-09-24T10:00:00Z' }], feedback: 'gate unit-test failed: a::adds' });
    expect(p.kind).toBe('dev');
    expect(p.role).toBe('dev');
    expect(p.task).toEqual(task);
    expect(p.criteria.map((c) => c.id)).toEqual(task.criteriaRefs);
    expect(p.assumptions).toEqual(['T0: db → sqlite']);
    expect(p.handoffs).toHaveLength(1);
    expect(p.feedback).toBe('gate unit-test failed: a::adds');
    expect(p.outputContract).toBe(outputContract('dev'));
    expect(p.specHash).toBe(HASH);
  });

  it('review pack puts the diff and impact radius in feedback and code', () => {
    const p = reviewPack(base, task, { diffStat: ' src/a.ts | 2 +-', changedFiles: ['src/a.ts'], code: { source: 'graph', affected: [] } });
    expect(p.kind).toBe('review');
    expect(p.role).toBe('test');
    expect(p.feedback).toContain('src/a.ts');
    expect(p.code?.source).toBe('graph');
  });

  it('plan pack carries every criterion, the human tasks and god nodes', () => {
    const p = planPack({ ...base, spec: { ...spec, tasks: [{ title: 'Login', description: 'basic login' }] } }, { techSpecText: '# Tech spec', godNodes: [{ label: 'server/app.ts', edges: 12 }], feedback: null });
    expect(p.kind).toBe('plan');
    expect(p.criteria).toHaveLength(spec.acceptanceCriteria.length);
    expect(p.techSpecExcerpt).toBe('# Tech spec');
    expect(p.feedback).toContain('Login');
    expect(p.feedback).toContain('server/app.ts');
  });

  it('output contract states the JSON schema of the kind', () => {
    expect(outputContract('dev')).toContain('"specHash"');
    expect(outputContract('dev')).toContain('commitMessage');
  });
});

describe('runAgentStep', () => {
  it('journals STEP_STARTED/FINISHED, writes prompt and output files, and books through the runner', async () => {
    const d = await deps(async () => ({ ok: true, value: { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' }, summary: summary() }));
    const out = await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1 }, d);
    expect(out.ok).toBe(true);
    const types = d.journal.events.map((e) => e.type);
    expect(types).toEqual([OrchEvent.StepStarted, OrchEvent.StepFinished]);
    expect(d.journal.events[0]!.data).toMatchObject({ stepId: 's00001', kind: 'dev', role: 'dev', taskId: 'T1', attempt: 1 });
    expect(d.journal.events[1]!.data).toMatchObject({ stepId: 's00001', ok: true, usage: { inputTokens: 1200, outputTokens: 80 } });
    expect(await fs.readFile(path.join(dir, 'steps', '1', 'prompt.md'), 'utf8')).toContain('T1');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'steps', '1', 'output.json'), 'utf8'))).toMatchObject({ ok: true, value: { commitMessage: 'feat: x' } });
  });

  it('redacts secret values from the step output before journaling', async () => {
    const d = await deps(async () => ({ ok: false, failure: 'code', errors: ['token s3cr3t-value rejected'], summary: summary({ isError: true }), sandboxDisabled: false }));
    const out = await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1 }, d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors).toEqual(['token [REDACTED] rejected']);
    expect(JSON.stringify(d.journal.events)).not.toContain('s3cr3t-value');
    expect(await fs.readFile(path.join(dir, 'steps', '1', 'output.json'), 'utf8')).not.toContain('s3cr3t-value');
  });

  it('feeds the breaker on quota failures and holds the governor while the step runs', async () => {
    let active = 0;
    let peak = 0;
    const d = await deps(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { ok: false, failure: 'quota', errors: ['usage limit'], summary: summary({ isError: true, rateLimit: { status: 'rejected', resetsAt: 4102444800, fiveHourUtilization: 1, fiveHourResetsAt: 4102444800, sevenDayUtilization: 0.5, sevenDayResetsAt: 4102444800 } }), sandboxDisabled: false };
    });
    d.governor.setLimit(1);
    const req = { kind: 'dev' as const, role: 'dev' as const, pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1 };
    await Promise.all([runAgentStep(req, d), runAgentStep(req, d)]);
    expect(peak).toBe(1);
    expect(d.breaker.canStart()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/orchestrator/steps.test.ts`
Expected: FAIL, cannot resolve `../../server/orchestrator/steps.js`.

- [ ] **Step 3: Implement steps.ts**

`server/orchestrator/steps.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import type { Governor } from '../budget/governor.js';
import type { QuotaBreaker } from '../budget/quota-breaker.js';
import type { ProviderProfile, Role } from '../config/config.js';
import type { PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { stepId } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import { buildContextPack, type CodeContext, type ContextPackInput, type HandoffSummary } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { runStep as runStepFn, StepDeps, StepOutcome, StepRequest } from '../runner/step.js';
import type { RefContext } from '../validators/references.js';
import { OrchEvent, type Journal } from './events.js';

export interface PackBase {
  spec: Spec;
  project: Project;
  specHash: string;
  assumptions: readonly string[];
  adrs?: ReadonlyArray<{ id: string; title: string; text: string }>;
  techSpecExcerpt?: string;
  retrieval?: readonly Hit[];
  budgetTokens: number;
}

export function outputContract(kind: StepKind): string {
  return `Return exactly one JSON object matching this schema:\n${JSON.stringify(toJsonSchema(kind))}`;
}

function criteriaOf(spec: Spec, ids: readonly string[]) {
  return spec.acceptanceCriteria.filter((c) => ids.includes(c.id));
}

function common(base: PackBase, kind: StepKind, role: Role): Pick<ContextPackInput, 'kind' | 'role' | 'specHash' | 'principles' | 'outputContract' | 'assumptions' | 'adrs' | 'retrieval' | 'budgetTokens' | 'techSpecExcerpt'> {
  return {
    kind,
    role,
    specHash: base.specHash,
    principles: base.project.principles,
    outputContract: outputContract(kind),
    assumptions: base.assumptions,
    adrs: base.adrs,
    retrieval: base.retrieval,
    techSpecExcerpt: base.techSpecExcerpt,
    budgetTokens: base.budgetTokens,
  };
}

export function devPack(base: PackBase, task: PlanTask, opts: { code: CodeContext; handoffs: readonly HandoffSummary[]; feedback: string | null }): ContextPackInput {
  return { ...common(base, 'dev', 'dev'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), handoffs: opts.handoffs, code: opts.code, feedback: opts.feedback ?? undefined };
}

export function reviewPack(base: PackBase, task: PlanTask, opts: { diffStat: string; changedFiles: readonly string[]; code: CodeContext }): ContextPackInput {
  const feedback = `Changed files:\n${opts.changedFiles.join('\n')}\n\nDiff stat:\n${opts.diffStat}`;
  return { ...common(base, 'review', 'test'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), code: opts.code, feedback };
}

export function techSpecPack(base: PackBase, opts: { feedback: string | null }): ContextPackInput {
  return { ...common(base, 'tech-spec', 'dev'), criteria: base.spec.acceptanceCriteria, objectives: [...base.spec.objectives, ...base.spec.features.map((f) => `feature: ${f}`), ...base.project.constraints.map((c) => `constraint: ${c}`), ...(base.project.stack ? [`stack: ${base.project.stack}`] : [])], feedback: opts.feedback ?? undefined };
}

export function coveragePack(base: PackBase, opts: { techSpecText: string }): ContextPackInput {
  return { ...common(base, 'coverage', 'po'), criteria: base.spec.acceptanceCriteria, objectives: base.spec.objectives, techSpecExcerpt: opts.techSpecText };
}

export function planPack(base: PackBase, opts: { techSpecText: string; godNodes: ReadonlyArray<{ label: string; edges: number }>; feedback: string | null }): ContextPackInput {
  const human = (base.spec.tasks ?? []).map((t) => `- ${t.title}: ${t.description}`);
  const nodes = opts.godNodes.map((n) => `- ${n.label} (${n.edges} edges)`);
  const parts = [
    human.length > 0 ? `Human-defined tasks (derive dependencies, keep them):\n${human.join('\n')}` : '',
    nodes.length > 0 ? `Central modules of the current code (graph god-nodes):\n${nodes.join('\n')}` : '',
    opts.feedback ?? '',
  ].filter((s) => s !== '');
  return { ...common(base, 'plan', 'sm'), criteria: base.spec.acceptanceCriteria, objectives: [...base.spec.objectives, ...base.project.constraints.map((c) => `constraint: ${c}`)], techSpecExcerpt: opts.techSpecText, feedback: parts.length > 0 ? parts.join('\n\n') : undefined };
}

export function specGapPack(base: PackBase, task: PlanTask, opts: { question: string }): ContextPackInput {
  return { ...common(base, 'spec-gap', 'sm'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), feedback: `Dev question (spec gap):\n${opts.question}` };
}

export function replanPack(base: PackBase, task: PlanTask, opts: { history: readonly string[]; boundaries: readonly string[] }): ContextPackInput {
  const feedback = `Attempt history:\n${opts.history.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\nModule boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}`;
  return { ...common(base, 'replan', 'sm'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), feedback };
}

export interface AgentStepRequest<K extends StepKind> {
  kind: K;
  role: Role;
  pack: ContextPackInput;
  cwd: string;
  phase: string;
  taskId: string | null;
  attempt: number;
  refContext?: RefContext;
  refs?: StepRequest['refs'];
  semantic?: StepRequest['semantic'];
  extraAllow?: readonly string[];
}

export interface AgentStepDeps {
  runStep: typeof runStepFn;
  stepDeps: StepDeps;
  agents: Record<Role, AgentDefinition>;
  profile: (role: Role) => ProviderProfile;
  omniroute?: StepRequest['omniroute'];
  governor: Governor;
  breaker: QuotaBreaker;
  journal: Journal;
  stepDir: (seq: number) => string;
  secretValues: () => readonly string[];
  specHash: string;
}

/**
 * One agent step: journaled, governed, breaker-observed, redacted, with prompt and output kept under
 * runs/<runId>/steps/. Accounting is done by runStep itself (Plan 3).
 */
export async function runAgentStep<K extends StepKind>(req: AgentStepRequest<K>, deps: AgentStepDeps): Promise<StepOutcome<OutputOf<K>>> {
  const seq = deps.journal.nextStepSeq();
  const id = stepId(seq);
  const pack = buildContextPack(req.pack);
  const dir = deps.stepDir(seq);
  await fs.mkdir(dir, { recursive: true });
  await deps.journal.fact(OrchEvent.StepStarted, { stepId: id, kind: req.kind, role: req.role, taskId: req.taskId, attempt: req.attempt, tokens: pack.tokens, dropped: pack.dropped });
  await fs.writeFile(path.join(dir, 'prompt.md'), pack.text);
  const clean = (s: string) => redactSecrets(s, deps.secretValues());
  const profile = deps.profile(req.role);
  const release = await deps.governor.acquire();
  let outcome: StepOutcome<OutputOf<K>>;
  try {
    outcome = await deps.runStep<K>(
      {
        kind: req.kind,
        role: req.role,
        agent: deps.agents[req.role],
        profile,
        model: profile.model,
        cwd: req.cwd,
        prompt: pack.text,
        expectedSpecHash: deps.specHash,
        refContext: req.refContext,
        refs: req.refs,
        semantic: req.semantic,
        phase: req.phase,
        taskId: req.taskId,
        attempt: req.attempt,
        omniroute: profile.provider === 'omniroute' ? deps.omniroute : undefined,
        extraAllow: req.extraAllow,
      },
      deps.stepDeps,
    );
  } finally {
    release();
  }
  deps.breaker.observe(outcome.summary.rateLimit);
  if (!outcome.ok && outcome.failure === 'quota') deps.breaker.onQuotaFailure(outcome.summary.rateLimit);
  const result: StepOutcome<OutputOf<K>> = outcome.ok ? outcome : { ...outcome, errors: outcome.errors.map(clean) };
  const record = outcome.ok ? { ok: true, value: JSON.parse(clean(JSON.stringify(outcome.value))) } : { ok: false, failure: outcome.failure, errors: result.ok ? [] : result.errors };
  await fs.writeFile(path.join(dir, 'output.json'), JSON.stringify(record, null, 2));
  await deps.journal.fact(OrchEvent.StepFinished, {
    stepId: id,
    kind: req.kind,
    taskId: req.taskId,
    attempt: req.attempt,
    ok: outcome.ok,
    failure: outcome.ok ? null : outcome.failure,
    usage: outcome.summary.usage,
    costUsd: outcome.summary.costUsd,
    durationMs: outcome.summary.durationMs,
    numTurns: outcome.summary.numTurns,
  });
  return result;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/orchestrator/steps.test.ts && npm run typecheck`
Expected: 7 tests PASS; typecheck clean. If `runStep<K>` complains about the generic call, cast: `(deps.runStep as <T extends StepKind>(r: StepRequest, d: StepDeps) => Promise<StepOutcome<OutputOf<T>>>)<K>(…)`.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/steps.ts test/orchestrator/steps.test.ts
git commit -m "feat(orchestrator): context packs per step kind and the governed, journaled agent step

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Task runner (Phase 3 state machine)

**Files:**
- Create: `server/orchestrator/task-runner.ts`, `test/fixtures/git-remote.ts`
- Test: `test/orchestrator/task-runner.test.ts`

**Interfaces:**
- Consumes: `Journal`, `OrchEvent`, `Intent` (Task 1); `worktreeDir`, `Workspace` (Task 1); `AgentStepRequest`, `PackBase`, `devPack`, `reviewPack`, `specGapPack`, `replanPack` (Task 3); `createWorktree`, `commitAll`, `changedFiles`, `fetch`, `git` (`server/git/git.ts`); `MergeQueue`, `MergeSteps`, `MergeOutcome`; `GateResult`; `decideOnFailure`, `Failure`, `FailureKind`, `PolicyConfig`; `triageGateFailure`; `Decider`, `DecideContext`; `checkScope`; `verifyClaimedEvidence`; `RunEvent`, `TaskRuntime`; `TERMINAL_STATES`; `taskBranch`, `stepId`; `DevOutput`, `ReviewOutput`, `SpecGapOutput`, `ReplanOutput`, `OutputOf`.
- Produces:
  ```ts
  export interface TaskRunnerDeps {
    journal: Journal; ws: Workspace; spec: Spec; project: Project; plan: Plan; specHash: string; firstSpec: boolean;
    exec: Exec;
    runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => Promise<StepOutcome<OutputOf<K>>>;
    gates: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
    mergeQueue: MergeQueue;
    mergeSteps: (task: PlanTask, worktree: string, branch: string) => MergeSteps;
    code: (worktree: string, task: PlanTask) => Promise<CodeContext>;
    impact: (worktree: string, branch: string, changed: readonly string[]) => Promise<CodeContext>;
    decider: Pick<Decider, 'decide'>;
    policy: PolicyConfig;
    packBase: () => PackBase;
    handoffs: () => readonly HandoffSummary[];
    boundaries: () => Promise<readonly string[]>;     // module boundaries for replan (god nodes or top-level dirs)
    maxSpecGapRounds?: number;                          // default 3
  }
  export class TaskRunner {
    constructor(readonly taskId: string, deps: TaskRunnerDeps);
    get task(): TaskRuntime;
    get done(): boolean;
    readonly branch: string;   // taskBranch(specId, taskId)
    readonly worktree: string; // worktreeDir(ws, branch)
    advance(): Promise<void>;  // one state row per call (spec §4.4); safe to call again after a crash
  }
  ```
- `test/fixtures/git-remote.ts`:
  ```ts
  export interface Remote { root: string; origin: string; repo: string; cleanup(): Promise<void> }
  export async function makeRemote(files: Record<string, string>): Promise<Remote>;  // bare origin + clone, files committed and pushed on main
  ```

State rows (spec §4.4) as `advance()` behaves per `task.state`:
- `ready`: `TASK_STATE_CHANGED → implementing`, then the implementing row in the same call.
- `implementing`: `fetch(repo)`; intent `WORKTREE_CREATE:<taskId>` → `createWorktree(repo, worktree, branch, 'origin/main')` → confirm (skipped when already confirmed). Pack = `devPack(packBase(), task, {code, handoffs, feedback: journal.lastFeedback(taskId)})`. `runAgent({kind:'dev'})`. Outcome not ok → `fail(outcome.failure, errors)`. `spec-gap` → §4.5 round: `runAgent({kind:'spec-gap', role:'sm'})`; `SPEC_GAP_ANSWERED`; `FEEDBACK`; Dev again; more than `maxSpecGapRounds` rounds in one attempt → `fail('code', …)`. `done` → `checkScope` on `git status --porcelain` names (`allowFrozen = firstSpec && taskId === 'T0-scaffold'`); not ok → `fail('review-changes', errors)`. Intent `COMMIT:<stepId of the dev step>` → `commitAll` → confirm `{sha}`; `DEV_COMMITTED {taskId, sha, changedFiles, summary}`; `→ validating`.
- `validating`: `gates(worktree, branch)`; `GATE_PASSED`/`GATE_FAILED {taskId, gate, failure, exitCode}` per result; remember every `junit`; no blocking failure → `→ reviewing`; blocking failure → `triageGateFailure` → `fail(kind, delta, gate)` with delta = failed JUnit ids + tails (≤ 2000 chars each).
- `reviewing`: `changedFiles(worktree,'origin/main')`, `impact(...)`, diff stat; `runAgent({kind:'review', role:'test'})`; `verifyClaimedEvidence(criteria, junit)` errors → `fail('schema', errors)`; `changes` → `REVIEW_CHANGES` + `fail('review-changes', findings)`; approve → `REVIEW_APPROVED`, `→ rebasing`.
- `rebasing` / `merging`: `mergeQueue.enqueue(taskId, wrapped)` where `wrapped.push` also journals `→ merging`. `ok` → `PR_MERGED`, `→ merged`. `stage 'rebase'` → back to `rebasing` when in `merging`, then `fail('rebase-conflict', conflicts)`. `stage 'gates'` → `fail('code', detail, 'merge-gates')`. `stage 'push' | 'pr'` → `fail('infra', detail, 'merge')`. `stage 'merge'` → `→ rebasing`, no attempt.
- `fail(kind, text, gate?)`: `decideOnFailure({kind, gate, schemaRetriesUsed}, task, policy)`: `retry-dev` → `ATTEMPT_CONSUMED`, `FEEDBACK`, `→ implementing`; `rerun-gate` → `INFRA_RETRY`/`FLAKY_RETRY`; `rerun-step` → `FEEDBACK`, `schemaRetriesUsed += 1`; `replan` → §4.6 (`runAgent({kind:'replan', role:'sm'})`, ok → `TASK_REPLANNED`, else block); `block` → `→ blocked`, `TASK_BLOCKED {reason}`; `pause-quota`/`pause-auth` → `RUN_PAUSED {reason}` once, no attempt.

- [ ] **Step 1: Write the git remote fixture**

`test/fixtures/git-remote.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';

export interface Remote {
  root: string;
  origin: string;
  repo: string;
  cleanup(): Promise<void>;
}

/** Bare origin plus a clone whose main carries `files`; everything local, git only. */
export async function makeRemote(files: Record<string, string>): Promise<Remote> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-remote-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  await fs.mkdir(origin);
  await git(origin, ['init', '--bare', '-b', 'main'], execCommand);
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main'], execCommand);
  await git(repo, ['remote', 'add', 'origin', origin], execCommand);
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), text);
  }
  await git(repo, ['add', '-A'], execCommand);
  await git(repo, ['commit', '-q', '-m', 'docs: initial'], execCommand);
  await git(repo, ['push', '-q', '-u', 'origin', 'main'], execCommand);
  return { root, origin, repo, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
```

- [ ] **Step 2: Write the failing tests**

`test/orchestrator/task-runner.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { git, headSha } from '../../server/git/git.js';
import { MergeQueue, type MergeOutcome, type MergeSteps } from '../../server/git/merge-queue.js';
import { Intent, Journal, OrchEvent } from '../../server/orchestrator/events.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import { TaskRunner, type TaskRunnerDeps } from '../../server/orchestrator/task-runner.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { DEFAULT_POLICY, type FailureKind } from '../../server/scheduler/retry-policy.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const T1 = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const plan = makePlan(spec, { tasks: [T1] });
const summary = (over: Partial<ResultSummary> = {}): ResultSummary => ({
  found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 100, costUsd: 0.01,
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null,
  apiErrorStatus: null, rateLimit: null, compactions: 0, ...over,
});
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary: summary() });
const failed = (failure: FailureKind, ...errors: string[]): StepOutcome<never> => ({ ok: false, failure, errors, summary: summary({ isError: true }), sandboxDisabled: false });
const gate = (name: string, over: Partial<GateResult> = {}): GateResult => ({
  name, blocking: true, passed: true, exitCode: 0, timedOut: false, durationMs: 10, stdoutTail: '', stderrTail: '',
  junit: [{ id: 'sum::[AC-001] adds', name: '[AC-001] adds', classname: 'sum', status: 'passed', acIds: ['AC-001'] }], failure: null, ...over,
});

type Agent = (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>;
const devDone = (message = 'feat: T1'): Agent => async (req) => {
  await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true });
  await fs.writeFile(path.join(req.cwd, 'src', 'a.ts'), `// ${Date.now()}\n`);
  return ok({ specHash: HASH, status: 'done', summary: 'did T1', changedFiles: ['src/a.ts'], commitMessage: message });
};
const approve = () => ok({ specHash: HASH, decision: 'approve', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }], findings: [] });

let remote: Remote;
let journal: Journal;
let agentCalls: AgentStepRequest<any>[] = [];
beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'spec-001-r1', specHash: HASH });
  await journal.fact(RunEvent.TaskPlanned, { task: T1 });
  await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
  agentCalls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(over: Partial<TaskRunnerDeps> & { agent?: Agent; merge?: Partial<MergeSteps> | MergeOutcome } = {}): TaskRunnerDeps {
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: path.join(remote.root, 'graph'), knowledgeDb: '', runs: remote.root };
  const agent = over.agent ?? devDone();
  const forced: MergeOutcome | null = over.merge && 'ok' in over.merge ? over.merge : null;
  const steps: MergeSteps = {
    alreadyMerged: async () => null,
    rebase: async () => ({ ok: true, baseSha: 'base' }),
    gates: async () => ({ ok: true }),
    push: async () => {},
    ensurePr: async () => ({ number: 7 }),
    remoteMainSha: async () => 'base',
    merge: async () => (forced && !forced.ok ? { merged: false, reason: forced.detail } : { merged: true }),
    ...(over.merge && !('ok' in over.merge) ? over.merge : {}),
  };
  const { agent: _a, merge: _m, ...rest } = over;
  return {
    journal, ws, spec, project, plan, specHash: HASH, firstSpec: false,
    exec: execCommand,
    runAgent: (async (req) => { agentCalls.push(req); return agent(req); }) as TaskRunnerDeps['runAgent'],
    gates: async () => ({ results: [gate('unit-test')], blockingFailure: null }),
    mergeQueue: new MergeQueue(),
    mergeSteps: () => steps,
    code: async () => ({ source: 'none' }),
    impact: async () => ({ source: 'none' }),
    decider: { decide: async () => ({ answered: false, reason: 'disabled' }) },
    policy: DEFAULT_POLICY,
    packBase: () => ({ spec, project, specHash: HASH, assumptions: journal.assumptions(), budgetTokens: 8000 }),
    handoffs: () => [],
    boundaries: async () => ['src'],
    ...rest,
  };
}
const types = () => journal.events.map((e) => `${e.kind}:${e.type}`);
const state = () => journal.state.tasks.get('T1')!;

describe('TaskRunner: implementing', () => {
  it('creates the worktree, runs Dev, commits and moves to validating with intent/confirm pairs', async () => {
    const r = new TaskRunner('T1', deps());
    await r.advance();
    expect(state().state).toBe('validating');
    expect(types()).toEqual([
      'fact:TASK_PLANNED', 'fact:TASK_STATE_CHANGED', 'fact:TASK_STATE_CHANGED',
      `intent:${Intent.WorktreeCreate}`, `confirm:${Intent.WorktreeCreate}`,
      `intent:${Intent.Commit}`, `confirm:${Intent.Commit}`, `fact:${OrchEvent.DevCommitted}`, 'fact:TASK_STATE_CHANGED',
    ]);
    const sha = await headSha(r.worktree);
    expect(journal.events.find((e) => e.type === OrchEvent.DevCommitted)!.data).toMatchObject({ taskId: 'T1', sha, changedFiles: ['src/a.ts'] });
    expect(await git(r.worktree, ['log', '-1', '--format=%s'])).toBe('feat: T1');
    expect(agentCalls[0]).toMatchObject({ kind: 'dev', role: 'dev', taskId: 'T1', attempt: 1, cwd: r.worktree });
    expect(agentCalls[0]!.pack.feedback).toBeUndefined();
  });

  it('routes a spec-gap to the SM, journals the assumption and re-runs Dev with the answer, no attempt consumed', async () => {
    let devCalls = 0;
    const agent: Agent = async (req) => {
      if (req.kind === 'spec-gap') return ok({ specHash: HASH, answer: 'Use UTC everywhere', assumption: 'T1: timezone → UTC' });
      devCalls += 1;
      if (devCalls === 1) return ok({ specHash: HASH, status: 'spec-gap', summary: 'unclear', changedFiles: [], question: 'Which timezone?' });
      return devDone()(req);
    };
    const r = new TaskRunner('T1', deps({ agent }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'validating', attempts: 0 });
    expect(journal.events.find((e) => e.type === OrchEvent.SpecGapAnswered)!.data).toMatchObject({ taskId: 'T1', question: 'Which timezone?', answer: 'Use UTC everywhere', assumption: 'T1: timezone → UTC' });
    expect(agentCalls.map((c) => c.kind)).toEqual(['dev', 'spec-gap', 'dev']);
    expect(agentCalls[2]!.pack.feedback).toContain('Use UTC everywhere');
    expect(agentCalls[2]!.pack.assumptions).toContain('T1: timezone → UTC');
  });

  it('caps spec-gap rounds at three per attempt', async () => {
    const agent: Agent = async (req) =>
      req.kind === 'spec-gap' ? ok({ specHash: HASH, answer: 'a', assumption: 'T1: q → a' }) : ok({ specHash: HASH, status: 'spec-gap', summary: 's', changedFiles: [], question: 'q' });
    const r = new TaskRunner('T1', deps({ agent }));
    await r.advance();
    expect(agentCalls.filter((c) => c.kind === 'dev')).toHaveLength(4);
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('spec-gap rounds exhausted');
  });

  it('treats a scope violation as a failed attempt with the offending files as feedback', async () => {
    const agent: Agent = async (req) => {
      await fs.writeFile(path.join(req.cwd, 'README.md'), 'oops');
      return ok({ specHash: HASH, status: 'done', summary: 'x', changedFiles: ['README.md'], commitMessage: 'feat: x' });
    };
    const r = new TaskRunner('T1', deps({ agent }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('README.md');
    expect(journal.events.some((e) => e.type === Intent.Commit)).toBe(false);
  });

  it('pauses the run on a quota failure without consuming an attempt', async () => {
    const r = new TaskRunner('T1', deps({ agent: async () => failed('quota', 'usage limit reached') }));
    await r.advance();
    expect(journal.state.status).toBe('paused:quota');
    expect(state()).toMatchObject({ state: 'implementing', attempts: 0 });
  });
});

describe('TaskRunner: validating', () => {
  async function implemented(over: Parameters<typeof deps>[0] = {}) {
    const r = new TaskRunner('T1', deps(over));
    await r.advance();
    expect(state().state).toBe('validating');
    return r;
  }
  const failing = (over: Partial<GateResult>): TaskRunnerDeps['gates'] => async () => {
    const g = gate('unit-test', { passed: false, exitCode: 1, failure: 'code', junit: null, ...over });
    return { results: [g], blockingFailure: g };
  };

  it('passes every gate and moves to reviewing', async () => {
    const r = await implemented();
    await r.advance();
    expect(state().state).toBe('reviewing');
    expect(journal.events.filter((e) => e.type === OrchEvent.GatePassed).map((e) => e.data.gate)).toEqual(['unit-test']);
  });

  it('returns a code failure to Dev with the failed tests and the tail as feedback', async () => {
    const r = await implemented({ gates: failing({ stderrTail: 'AssertionError: 2 != 3', junit: [{ id: 'sum::[AC-001] adds', name: '[AC-001] adds', classname: 'sum', status: 'failed', acIds: ['AC-001'] }] }) });
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.events.find((e) => e.type === OrchEvent.GateFailed)!.data).toMatchObject({ gate: 'unit-test', failure: 'code' });
    const fb = journal.lastFeedback('T1')!;
    expect(fb).toContain('sum::[AC-001] adds');
    expect(fb).toContain('AssertionError');
  });

  it('re-runs an infra failure without consuming an attempt', async () => {
    const r = await implemented({ gates: failing({ exitCode: 137, failure: 'infra' }) });
    await r.advance();
    expect(state()).toMatchObject({ state: 'validating', attempts: 0, infraRetries: { 'unit-test': 1 } });
  });

  it('uses the decider triage when the rule says code', async () => {
    const r = await implemented({
      decider: { decide: async () => ({ answered: true, backend: 'jev', escalated: false, answers: { kind: { type: 'choice', value: 'flaky-test', probabilities: { 'flaky-test': 0.9, code: 0.1 }, confidence: 0.9 } } }) },
      gates: failing({}),
    });
    await r.advance();
    expect(state()).toMatchObject({ state: 'validating', attempts: 0, flakyRetries: { 'unit-test': 1 } });
  });
});

describe('TaskRunner: reviewing', () => {
  const review = (decision: 'approve' | 'changes', evidence = ['sum::[AC-001] adds']) =>
    ok({ specHash: HASH, decision, criteria: [{ id: 'AC-001', status: decision === 'approve' ? 'passed' : 'failed', evidence }], findings: decision === 'changes' ? [{ file: 'src/a.ts', line: 1, severity: 'major', text: 'no test for the empty case', acIds: ['AC-001'] }] : [] });
  async function validated(reviewer: Agent) {
    const r = new TaskRunner('T1', deps({ agent: async (req) => (req.kind === 'review' ? reviewer(req) : devDone()(req)) }));
    await r.advance();
    await r.advance();
    expect(state().state).toBe('reviewing');
    return r;
  }

  it('approves with verified evidence and moves to rebasing', async () => {
    const r = await validated(async () => review('approve'));
    await r.advance();
    expect(state().state).toBe('rebasing');
    expect(types()).toContain(`fact:${OrchEvent.ReviewApproved}`);
    expect(agentCalls.at(-1)!.pack.feedback).toContain('src/a.ts');
  });

  it('returns findings to Dev on changes', async () => {
    const r = await validated(async () => review('changes'));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('no test for the empty case');
  });

  it('rejects a review whose evidence does not exist as a schema failure, then counts an attempt', async () => {
    const r = await validated(async () => review('approve', ['sum::[AC-001] ghost']));
    await r.advance();
    expect(state()).toMatchObject({ state: 'reviewing', attempts: 0 });
    expect(journal.lastFeedback('T1')).toContain('ghost');
    await r.advance();
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
  });
});

describe('TaskRunner: merging', () => {
  async function reviewed(over: Parameters<typeof deps>[0] = {}) {
    const r = new TaskRunner('T1', deps({ ...over, agent: async (req) => (req.kind === 'review' ? approve() : devDone()(req)) }));
    for (let i = 0; i < 3; i++) await r.advance();
    expect(state().state).toBe('rebasing');
    return r;
  }

  it('merges through the queue and finishes the task', async () => {
    const r = await reviewed();
    await r.advance();
    expect(state().state).toBe('merged');
    expect(journal.events.find((e) => e.type === OrchEvent.PrMerged)!.data).toMatchObject({ taskId: 'T1', pr: 7 });
    const changes = journal.events.filter((e) => e.type === 'TASK_STATE_CHANGED').map((e) => e.data.to);
    expect(changes.slice(-2)).toEqual(['merging', 'merged']);
  });

  it('sends rebase conflicts back to Dev as an attempt', async () => {
    const r = await reviewed({ merge: { rebase: async () => ({ ok: false, conflicts: ['src/a.ts'] }) } });
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('src/a.ts');
  });

  it('a refused merge returns the task to rebasing without consuming an attempt', async () => {
    const r = await reviewed({ merge: { ok: false, stage: 'merge', detail: 'main moved' } });
    await r.advance();
    expect(state()).toMatchObject({ state: 'rebasing', attempts: 0 });
  });
});

describe('TaskRunner: attempts, replan, block', () => {
  const alwaysFailGates: TaskRunnerDeps['gates'] = async () => {
    const g = gate('unit-test', { passed: false, exitCode: 1, failure: 'code', junit: null });
    return { results: [g], blockingFailure: g };
  };
  const replacement = makePlanTask({ id: 'T1-r1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });

  it('replans once after three attempts and supersedes the task', async () => {
    const agent: Agent = async (req) => (req.kind === 'replan' ? ok({ specHash: HASH, replacements: [replacement] }) : devDone()(req));
    const r = new TaskRunner('T1', deps({ agent, gates: alwaysFailGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(state().state).toBe('superseded');
    expect(journal.state.tasks.get('T1-r1')).toMatchObject({ state: 'planned', attempts: 0, replanned: true });
    expect(agentCalls.filter((c) => c.kind === 'replan')).toHaveLength(1);
    expect(r.done).toBe(true);
  });

  it('blocks a replanned task when its attempts are spent', async () => {
    await journal.fact(RunEvent.TaskReplanned, { taskId: 'T1', replacements: [replacement] });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1-r1', to: 'ready' });
    const r = new TaskRunner('T1-r1', deps({ gates: alwaysFailGates }));
    for (let i = 0; i < 6; i++) await r.advance();
    expect(journal.state.tasks.get('T1-r1')!.state).toBe('blocked');
    expect(journal.events.find((e) => e.type === OrchEvent.TaskBlocked)!.data).toMatchObject({ taskId: 'T1-r1' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/orchestrator/task-runner.test.ts`
Expected: FAIL, cannot resolve `../../server/orchestrator/task-runner.js`.

- [ ] **Step 4: Implement task-runner.ts**

`server/orchestrator/task-runner.ts`:
```ts
import type { DevOutput, OutputOf, ReplanOutput, ReviewOutput, SpecGapOutput, StepKind } from '../agents/outputs.js';
import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { stepId, taskBranch } from '../core/ids.js';
import type { DecideContext, Decider } from '../decide/decider.js';
import { triageGateFailure } from '../decide/decisions/gate-triage.js';
import type { TestResult } from '../evidence/junit.js';
import { verifyClaimedEvidence } from '../evidence/matrix.js';
import type { Exec } from '../exec/command.js';
import type { GateResult } from '../exec/gate-runner.js';
import { changedFiles, commitAll, createWorktree, fetch as gitFetch, git } from '../git/git.js';
import type { MergeQueue, MergeSteps } from '../git/merge-queue.js';
import type { CodeContext, HandoffSummary } from '../knowledge/context-pack.js';
import { RunEvent, type TaskRuntime } from '../pipeline/run-state.js';
import { TERMINAL_STATES, type TaskState } from '../pipeline/task-state.js';
import type { StepOutcome } from '../runner/step.js';
import { decideOnFailure, type Failure, type FailureKind, type PolicyConfig } from '../scheduler/retry-policy.js';
import { checkScope } from '../validators/diff-guard.js';
import type { RefContext } from '../validators/references.js';
import { Intent, OrchEvent, type Journal } from './events.js';
import { devPack, replanPack, reviewPack, specGapPack, type AgentStepRequest, type PackBase } from './steps.js';
import { worktreeDir, type Workspace } from './workspace.js';

export interface TaskRunnerDeps {
  journal: Journal;
  ws: Workspace;
  spec: Spec;
  project: Project;
  plan: Plan;
  specHash: string;
  firstSpec: boolean;
  exec: Exec;
  runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => Promise<StepOutcome<OutputOf<K>>>;
  gates: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
  mergeQueue: MergeQueue;
  mergeSteps: (task: PlanTask, worktree: string, branch: string) => MergeSteps;
  code: (worktree: string, task: PlanTask) => Promise<CodeContext>;
  impact: (worktree: string, branch: string, changed: readonly string[]) => Promise<CodeContext>;
  decider: Pick<Decider, 'decide'>;
  policy: PolicyConfig;
  packBase: () => PackBase;
  handoffs: () => readonly HandoffSummary[];
  boundaries: () => Promise<readonly string[]>;
  maxSpecGapRounds?: number;
}

const TAIL = 2000;
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);

async function porcelainNames(dir: string, exec: Exec): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=all'], exec);
  return out === '' ? [] : out.split('\n').map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
}

/** Spec (orchestrator) §4.4: one state row per advance(); every effect is intent → effect → confirm. */
export class TaskRunner {
  readonly branch: string;
  readonly worktree: string;
  private schemaRetries = 0;
  private specGapRounds = 0;
  private junit: TestResult[] = [];
  private readonly maxSpecGapRounds: number;

  constructor(
    readonly taskId: string,
    private readonly deps: TaskRunnerDeps,
  ) {
    this.branch = taskBranch(deps.spec.specId, taskId);
    this.worktree = worktreeDir(deps.ws, this.branch);
    this.maxSpecGapRounds = deps.maxSpecGapRounds ?? 3;
  }

  get task(): TaskRuntime {
    const t = this.deps.journal.state.tasks.get(this.taskId);
    if (!t) throw new Error(`unknown task ${this.taskId}`);
    return t;
  }

  get done(): boolean {
    return TERMINAL_STATES.has(this.task.state);
  }

  private get ctx(): DecideContext {
    return { confidential: this.deps.project.confidential };
  }

  async advance(): Promise<void> {
    switch (this.task.state) {
      case 'ready':
        await this.transition('implementing');
        return this.implement();
      case 'implementing':
        return this.implement();
      case 'validating':
        return this.validate();
      case 'reviewing':
        return this.review();
      case 'rebasing':
      case 'merging':
        return this.merge();
      default:
        return;
    }
  }

  private async transition(to: TaskState): Promise<void> {
    if (this.task.state === to) return;
    await this.deps.journal.fact(RunEvent.TaskStateChanged, { taskId: this.taskId, to });
  }

  private feedback(text: string): Promise<unknown> {
    return this.deps.journal.fact(OrchEvent.Feedback, { taskId: this.taskId, text });
  }

  private async ensureWorktree(): Promise<void> {
    const { journal, ws, exec } = this.deps;
    await gitFetch(ws.repo, exec);
    const confirmed = journal.isConfirmed(Intent.WorktreeCreate, this.taskId);
    if (!confirmed) await journal.intent(Intent.WorktreeCreate, this.taskId, { worktree: this.worktree, branch: this.branch });
    await createWorktree(ws.repo, this.worktree, this.branch, 'origin/main', exec);
    if (!confirmed) await journal.confirm(Intent.WorktreeCreate, this.taskId, {});
  }

  private async refContext(): Promise<RefContext> {
    const tracked = (await git(this.worktree, ['ls-files'], this.deps.exec)).split('\n').filter((f) => f !== '');
    const untracked = await porcelainNames(this.worktree, this.deps.exec);
    return {
      acIds: new Set(this.deps.spec.acceptanceCriteria.map((c) => c.id)),
      taskIds: new Set(this.deps.plan.tasks.map((t) => t.id)),
      files: new Set([...tracked, ...untracked]),
      tests: new Set(this.junit.map((t) => t.id)),
      adrIds: new Set(this.deps.plan.adrRefs),
    };
  }

  private async implement(): Promise<void> {
    await this.ensureWorktree();
    const task = this.task;
    const attempt = task.attempts + 1;
    const pack = devPack(this.deps.packBase(), task.def, { code: await this.deps.code(this.worktree, task.def), handoffs: this.deps.handoffs(), feedback: this.deps.journal.lastFeedback(this.taskId) });
    const seq = this.deps.journal.nextStepSeq();
    const outcome = await this.deps.runAgent<'dev'>({
      kind: 'dev',
      role: 'dev',
      pack,
      cwd: this.worktree,
      phase: 'phase3',
      taskId: this.taskId,
      attempt,
      refContext: await this.refContext(),
      refs: ((v: DevOutput) => ({ files: v.changedFiles })) as never,
    });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as DevOutput;
    if (value.status === 'spec-gap') return this.specGap(task.def, value.question);
    this.specGapRounds = 0;
    const touched = await porcelainNames(this.worktree, this.deps.exec);
    const scope = checkScope({ changedFiles: touched, affectedPaths: task.def.affectedPaths, frozenPaths: this.deps.plan.frozenPaths, scopeJustification: value.scopeJustification, allowFrozen: this.deps.firstSpec && this.taskId === 'T0-scaffold' });
    if (!scope.ok) return this.fail('review-changes', `Scope violation:\n${scope.errors.join('\n')}`);
    const key = stepId(seq);
    await this.deps.journal.intent(Intent.Commit, key, { taskId: this.taskId, worktree: this.worktree, message: value.commitMessage });
    const sha = (await commitAll(this.worktree, value.commitMessage, {}, this.deps.exec)) ?? (await git(this.worktree, ['rev-parse', 'HEAD'], this.deps.exec));
    await this.deps.journal.confirm(Intent.Commit, key, { sha });
    const changed = await changedFiles(this.worktree, 'origin/main', this.deps.exec);
    await this.deps.journal.fact(OrchEvent.DevCommitted, { taskId: this.taskId, sha, changedFiles: changed, summary: value.summary });
    await this.transition('validating');
  }

  private async specGap(task: PlanTask, question: string): Promise<void> {
    this.specGapRounds += 1;
    if (this.specGapRounds > this.maxSpecGapRounds) {
      this.specGapRounds = 0;
      return this.fail('code', `spec-gap rounds exhausted (${this.maxSpecGapRounds}); last question: ${question}`);
    }
    const outcome = await this.deps.runAgent<'spec-gap'>({ kind: 'spec-gap', role: 'sm', pack: specGapPack(this.deps.packBase(), task, { question }), cwd: this.deps.ws.repo, phase: 'phase3', taskId: this.taskId, attempt: this.task.attempts + 1 });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as SpecGapOutput;
    await this.deps.journal.fact(OrchEvent.SpecGapAnswered, { taskId: this.taskId, question, answer: value.answer, assumption: value.assumption });
    await this.feedback(`Spec-gap answer from SM:\nQ: ${question}\nA: ${value.answer}`);
    return this.implement();
  }

  private async validate(): Promise<void> {
    const { results, blockingFailure } = await this.deps.gates(this.worktree, this.branch);
    for (const r of results) {
      await this.deps.journal.fact(r.passed ? OrchEvent.GatePassed : OrchEvent.GateFailed, { taskId: this.taskId, gate: r.name, failure: r.failure, exitCode: r.exitCode, durationMs: r.durationMs });
    }
    this.junit = results.flatMap((r) => r.junit ?? []);
    if (!blockingFailure) return this.transition('reviewing');
    const gateDef = this.deps.plan.gates.find((g) => g.name === blockingFailure.name) ?? { name: blockingFailure.name, command: '', blocking: true, network: 'none' as const, secrets: [] };
    const triage = await triageGateFailure(gateDef, blockingFailure, this.deps.decider, this.ctx);
    const failedIds = (blockingFailure.junit ?? []).filter((t) => t.status === 'failed').map((t) => t.id);
    const delta = [
      `Gate ${blockingFailure.name} failed (${triage.kind}, exit ${blockingFailure.exitCode})`,
      failedIds.length > 0 ? `Failed tests:\n${failedIds.join('\n')}` : '',
      blockingFailure.stderrTail ? `stderr (tail):\n${tail(blockingFailure.stderrTail)}` : '',
      blockingFailure.stdoutTail ? `stdout (tail):\n${tail(blockingFailure.stdoutTail)}` : '',
    ]
      .filter((s) => s !== '')
      .join('\n\n');
    return this.fail(triage.kind, delta, blockingFailure.name);
  }

  private async review(): Promise<void> {
    const changed = await changedFiles(this.worktree, 'origin/main', this.deps.exec);
    const diffStat = await git(this.worktree, ['diff', '--stat', 'origin/main...HEAD'], this.deps.exec);
    const pack = reviewPack(this.deps.packBase(), this.task.def, { diffStat, changedFiles: changed, code: await this.deps.impact(this.worktree, this.branch, changed) });
    const outcome = await this.deps.runAgent<'review'>({
      kind: 'review',
      role: 'test',
      pack,
      cwd: this.worktree,
      phase: 'phase3',
      taskId: this.taskId,
      attempt: this.task.attempts + 1,
      refContext: await this.refContext(),
      refs: ((v: ReviewOutput) => ({ acIds: v.criteria.map((c) => c.id), files: v.findings.map((f) => f.file) })) as never,
    });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as ReviewOutput;
    const evidenceErrors = verifyClaimedEvidence(value.criteria, this.junit);
    if (evidenceErrors.length > 0) return this.fail('schema', `Review evidence rejected:\n${evidenceErrors.join('\n')}`);
    if (value.decision === 'changes') {
      await this.deps.journal.fact(OrchEvent.ReviewChanges, { taskId: this.taskId, findings: value.findings });
      const text = value.findings.map((f) => `- ${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.text}`).join('\n');
      return this.fail('review-changes', `Review requested changes:\n${text}`);
    }
    await this.deps.journal.fact(OrchEvent.ReviewApproved, { taskId: this.taskId, criteria: value.criteria });
    await this.transition('rebasing');
  }

  private async merge(): Promise<void> {
    const steps = this.deps.mergeSteps(this.task.def, this.worktree, this.branch);
    const wrapped: MergeSteps = {
      ...steps,
      push: async () => {
        await steps.push();
        await this.transition('merging');
      },
    };
    const outcome = await this.deps.mergeQueue.enqueue(this.taskId, wrapped);
    if (outcome.ok) {
      await this.deps.journal.fact(OrchEvent.PrMerged, { taskId: this.taskId, pr: outcome.pr, already: outcome.already ?? false, warning: outcome.warning ?? null });
      if (this.task.state === 'rebasing') await this.transition('merging');
      return this.transition('merged');
    }
    if (outcome.stage === 'merge') return this.transition('rebasing');
    if (this.task.state === 'merging') await this.transition('rebasing');
    switch (outcome.stage) {
      case 'rebase':
        return this.fail('rebase-conflict', `Rebase conflicts on origin/main:\n${(outcome.conflicts ?? []).join('\n')}`);
      case 'gates':
        return this.fail('code', `Gates failed after rebase:\n${outcome.detail ?? ''}`, 'merge-gates');
      default:
        return this.fail('infra', `Merge queue ${outcome.stage} failed: ${outcome.detail ?? ''}`, 'merge');
    }
  }

  private async fail(kind: FailureKind, text: string, gate?: string): Promise<void> {
    const failure: Failure = { kind, gate, schemaRetriesUsed: this.schemaRetries };
    const decision = decideOnFailure(failure, this.task, this.deps.policy);
    switch (decision.action) {
      case 'retry-dev':
        this.schemaRetries = 0;
        await this.deps.journal.fact(RunEvent.AttemptConsumed, { taskId: this.taskId });
        await this.feedback(text);
        return this.transition('implementing');
      case 'rerun-gate':
        await this.deps.journal.fact(kind === 'flaky-test' ? RunEvent.FlakyRetry : RunEvent.InfraRetry, { taskId: this.taskId, gate });
        return;
      case 'rerun-step':
        this.schemaRetries += 1;
        await this.feedback(text);
        return;
      case 'replan':
        await this.feedback(text);
        return this.replan();
      case 'block':
        return this.block(text);
      case 'pause-quota':
      case 'pause-auth':
        if (this.deps.journal.state.status === 'running') {
          await this.deps.journal.fact(RunEvent.RunPaused, { reason: decision.action === 'pause-quota' ? 'quota' : 'auth' });
        }
        return;
      case 'route-spec-gap':
        return;
    }
  }

  private async replan(): Promise<void> {
    const history = this.deps.journal.events.filter((e) => e.type === OrchEvent.Feedback && e.data.taskId === this.taskId).map((e) => String(e.data.text));
    const outcome = await this.deps.runAgent<'replan'>({ kind: 'replan', role: 'sm', pack: replanPack(this.deps.packBase(), this.task.def, { history, boundaries: await this.deps.boundaries() }), cwd: this.deps.ws.repo, phase: 'phase3', taskId: this.taskId, attempt: this.task.attempts });
    if (!outcome.ok) return this.block(`replan failed: ${outcome.errors.join('; ')}`);
    const value = outcome.value as ReplanOutput;
    await this.deps.journal.fact(RunEvent.TaskReplanned, { taskId: this.taskId, replacements: value.replacements });
  }

  private async block(reason: string): Promise<void> {
    await this.transition('blocked');
    await this.deps.journal.fact(OrchEvent.TaskBlocked, { taskId: this.taskId, reason });
  }
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/orchestrator/task-runner.test.ts && npm run typecheck`
Expected: 17 tests PASS; typecheck clean. Known sharp edges: `RunEvent.TaskReplanned` marks the original `superseded` and adds the replacements as `planned` (Plan 1's `replan()`); `commitAll` returns `null` when nothing is staged, hence the `rev-parse` fallback; `git status --porcelain` quotes names with spaces, hence the quote strip.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/task-runner.ts test/fixtures/git-remote.ts test/orchestrator/task-runner.test.ts
git commit -m "feat(orchestrator): task runner state machine for the phase 3 loop

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Real merge steps, docs merge steps and the fake gh

**Files:**
- Create: `server/orchestrator/merge-steps.ts`, `test/fixtures/fake-gh.ts`
- Test: `test/orchestrator/merge-steps.test.ts`

**Interfaces:**
- Consumes: `MergeSteps`; `rebaseOnto`, `push`, `remoteMainSha`, `headSha`, `removeWorktree`, `changedFiles`, `git` (`git.ts`); `ensurePr`, `findMergedPr`, `mergePr` (`github.ts`); `runGates`, `GateContext`, `GateDeps` (`gate-runner.ts`); `Graphify`; `Journal`, `Intent`, `OrchEvent`; `HandoffSummary`; `redactSecrets`; `graphDir`.
- Produces:
  ```ts
  export interface MergeStepsDeps {
    journal: Journal; ws: Workspace; exec: Exec; ghExec: Exec;      // ghExec carries GH_TOKEN; exec does not
    gates: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
    graphify: Graphify | null;                                       // null → no graph update after merge
    secretValues: () => readonly string[];
    handoffs: HandoffSummary[];                                      // pushed to on afterMerge
    clock: () => Date;
  }
  export function prBody(input: { summary: string; criteria: readonly AcceptanceCriterion[]; gateLines: readonly string[] }, secretValues: readonly string[]): string;  // ≤ 8 kB, redacted
  export function taskMergeSteps(deps: MergeStepsDeps, task: PlanTask, worktree: string, branch: string, spec: Spec, summary: string): MergeSteps;
  export function docsMergeSteps(deps: MergeStepsDeps, branch: string, worktree: string, title: string): MergeSteps;   // gates: none; afterMerge: removeWorktree only
  ```
- `taskMergeSteps` semantics: `alreadyMerged` → `findMergedPr({cwd: repo, head: branch, base: 'main'}, ghExec)`; `rebase` → `fetch(repo)` then `rebaseOnto(worktree, 'origin/main', exec)`; `gates` → `deps.gates(worktree, branch)`, `detail` = failing gate name + tail; `push` → intent `PUSH:<branch>` (skip when confirmed) → `push(worktree, branch, exec)` → confirm; `ensurePr` → intent `PR_CREATE:<branch>` → `ensurePr({cwd: repo, head: branch, base: 'main', title: <taskId>: <title>, body})` → confirm `{number, url}` → `PR_CREATED`; `remoteMainSha` → `remoteMainSha(repo, exec)`; `merge(n)` → intent `PR_MERGE:<branch>` `{number}` → `mergePr({cwd: repo, number, headSha: await headSha(worktree)}, ghExec)` → confirm on `merged || already`; `afterMerge` → `graphify?.update(repo after fetch+checkout main, graphDir(ws, null))`, intent `WORKTREE_REMOVE:<branch>` → `removeWorktree` → confirm, push `HandoffSummary {taskId, title, summary, changedFiles, mergedAt}`.
- `test/fixtures/fake-gh.ts`:
  ```ts
  export interface FakePr { number: number; head: string; base: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string; title: string; body: string }
  export class FakeGh { readonly prs: FakePr[]; nextNumber = 1; install(exec: FakeExec): this;  /* answers gh pr list/create/view/merge; merge moves state to MERGED when headRefOid matches --match-head-commit */ }
  ```
  `pr create` reads the head sha from `git -C <cwd> rev-parse <head>` through `execCommand` so `--match-head-commit` is realistic; `pr merge` with a mismatching sha fails with `exitCode 1` and stderr `head commit changed`.

- [ ] **Step 1: Write the fake gh**

`test/fixtures/fake-gh.ts`:
```ts
import { execCommand } from '../../server/exec/command.js';
import type { FakeExec } from './fake-exec.js';

export interface FakePr {
  number: number;
  head: string;
  base: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefOid: string;
  title: string;
  body: string;
}

/** In-memory GitHub: enough of `gh pr` for ensurePr / findMergedPr / prState / mergePr. */
export class FakeGh {
  readonly prs: FakePr[] = [];
  nextNumber = 1;

  install(exec: FakeExec): this {
    exec.on((s) => s.bin === 'gh' && s.args[0] === 'pr', async (s) => {
      const arg = (flag: string) => s.args[s.args.indexOf(flag) + 1]!;
      switch (s.args[1]) {
        case 'list': {
          const state = arg('--state');
          const rows = this.prs.filter((p) => p.head === arg('--head') && p.base === arg('--base') && (state === 'all' || p.state === state.toUpperCase()));
          return { stdout: JSON.stringify(rows.map((p) => ({ number: p.number, url: `https://github.example/pr/${p.number}`, state: p.state }))) };
        }
        case 'create': {
          const head = arg('--head');
          const sha = (await execCommand({ bin: 'git', args: ['rev-parse', head], cwd: s.cwd, timeoutMs: 10_000 })).stdout.trim();
          const pr: FakePr = { number: this.nextNumber++, head, base: arg('--base'), state: 'OPEN', headRefOid: sha, title: arg('--title'), body: s.stdin ?? '' };
          this.prs.push(pr);
          return { stdout: `https://github.example/pr/${pr.number}\n` };
        }
        case 'view': {
          const pr = this.prs.find((p) => p.number === Number(s.args[2]));
          return pr ? { stdout: JSON.stringify({ state: pr.state, headRefOid: pr.headRefOid }) } : { exitCode: 1, stderr: 'not found' };
        }
        case 'merge': {
          const pr = this.prs.find((p) => p.number === Number(s.args[2]));
          if (!pr) return { exitCode: 1, stderr: 'not found' };
          if (pr.state === 'MERGED') return { exitCode: 1, stderr: 'Pull request is already merged' };
          const wanted = arg('--match-head-commit');
          const current = (await execCommand({ bin: 'git', args: ['rev-parse', pr.head], cwd: s.cwd, timeoutMs: 10_000 })).stdout.trim();
          if (wanted !== current) return { exitCode: 1, stderr: 'head commit changed' };
          pr.state = 'MERGED';
          pr.headRefOid = current;
          // Squash-merge into main on the remote, as GitHub would.
          await execCommand({ bin: 'git', args: ['push', 'origin', `${pr.head}:${pr.base}`], cwd: s.cwd, timeoutMs: 10_000 });
          return { stdout: '' };
        }
        default:
          return { exitCode: 1, stderr: `fake gh: unsupported ${s.args.join(' ')}` };
      }
    });
    return this;
  }
}
```

- [ ] **Step 2: Write the failing test**

`test/orchestrator/merge-steps.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { commitAll, createWorktree, git } from '../../server/git/git.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Intent, Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { docsMergeSteps, prBody, taskMergeSteps, type MergeStepsDeps } from '../../server/orchestrator/merge-steps.js';
import type { HandoffSummary } from '../../server/knowledge/context-pack.js';
import { makeFrozenSpec, makePlanTask } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const task = makePlanTask({ id: 'T1', title: 'Add sum', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
let remote: Remote;
let journal: Journal;
let gh: FakeGh;
let handoffs: HandoffSummary[];
let worktree: string;

beforeEach(async () => {
  remote = await makeRemote({ 'docs/README.md': '# docs' });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  gh = new FakeGh();
  handoffs = [];
  worktree = path.join(remote.root, 'wt', 'task__spec-001-T1');
  await createWorktree(remote.repo, worktree, 'task/spec-001-T1', 'origin/main');
  await fs.mkdir(path.join(worktree, 'src'), { recursive: true });
  await fs.writeFile(path.join(worktree, 'src', 'sum.ts'), 'export const sum = (a: number, b: number) => a + b;\n');
  await commitAll(worktree, 'feat: sum');
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(over: Partial<MergeStepsDeps> = {}): MergeStepsDeps {
  const ghExec = new FakeExec();
  gh.install(ghExec);
  // git goes to the real binary; everything else to the fake.
  const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
  const ghRouted = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s)).on((s) => s.bin === 'gh', (s) => ghExec.exec(s));
  return {
    journal,
    ws: { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: path.join(remote.root, 'graph'), knowledgeDb: '', runs: remote.root },
    exec: exec.exec,
    ghExec: ghRouted.exec,
    gates: async () => ({ results: [], blockingFailure: null }),
    graphify: null,
    secretValues: () => ['hunter2'],
    handoffs,
    clock: () => new Date('2026-09-24T12:00:00Z'),
    ...over,
  };
}

describe('prBody', () => {
  it('lists summary, criteria and gate lines, redacts secrets and caps the size', () => {
    const body = prBody({ summary: 'token hunter2 used', criteria: spec.acceptanceCriteria, gateLines: ['unit-test: passed', 'x'.repeat(10_000)] }, ['hunter2']);
    expect(body).toContain('[REDACTED]');
    expect(body).toContain('AC-001');
    expect(body.length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe('taskMergeSteps', () => {
  it('rebases, pushes, opens the PR, merges it guarded by the head sha and records the handoff', async () => {
    const d = deps();
    const steps = taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 'did T1');
    const out = await new MergeQueue().enqueue('T1', steps);
    expect(out).toEqual({ ok: true, pr: 1 });
    expect(gh.prs[0]).toMatchObject({ state: 'MERGED', head: 'task/spec-001-T1', title: 'T1: Add sum' });
    expect(gh.prs[0]!.body).toContain('did T1');
    expect(await git(remote.repo, ['ls-remote', 'origin', 'refs/heads/main'])).toContain(gh.prs[0]!.headRefOid);
    const kinds = journal.events.map((e) => `${e.kind}:${e.type}`);
    expect(kinds).toEqual([
      `intent:${Intent.Push}`, `confirm:${Intent.Push}`,
      `intent:${Intent.PrCreate}`, `confirm:${Intent.PrCreate}`, `fact:${OrchEvent.PrCreated}`,
      `intent:${Intent.PrMerge}`, `confirm:${Intent.PrMerge}`,
      `intent:${Intent.WorktreeRemove}`, `confirm:${Intent.WorktreeRemove}`,
    ]);
    expect(handoffs).toEqual([{ taskId: 'T1', title: 'Add sum', summary: 'did T1', changedFiles: ['src/sum.ts'], mergedAt: '2026-09-24T12:00:00.000Z' }]);
    await expect(fs.access(worktree)).rejects.toThrow();
  });

  it('reports rebase conflicts when main moved on the same file', async () => {
    await fs.writeFile(path.join(remote.repo, 'src', 'sum.ts'), 'export const sum = () => 0;\n').catch(async () => {
      await fs.mkdir(path.join(remote.repo, 'src'), { recursive: true });
      await fs.writeFile(path.join(remote.repo, 'src', 'sum.ts'), 'export const sum = () => 0;\n');
    });
    await commitAll(remote.repo, 'chore: conflicting');
    await git(remote.repo, ['push', '-q', 'origin', 'main']);
    const out = await new MergeQueue().enqueue('T1', taskMergeSteps(deps(), task, worktree, 'task/spec-001-T1', spec, 's'));
    expect(out).toMatchObject({ ok: false, stage: 'rebase', conflicts: ['src/sum.ts'] });
  });

  it('short-circuits when the PR is already merged (crash between merge and confirm)', async () => {
    const d = deps();
    const first = await new MergeQueue().enqueue('T1', taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 's'));
    expect(first.ok).toBe(true);
    const again = await new MergeQueue().enqueue('T1', taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 's'));
    expect(again).toEqual({ ok: true, pr: 1, already: true });
  });

  it('redacts the PR body', async () => {
    const d = deps();
    await new MergeQueue().enqueue('T1', taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 'password hunter2 leaked'));
    expect(gh.prs[0]!.body).not.toContain('hunter2');
    expect(JSON.stringify(journal.events)).not.toContain('hunter2');
  });

  it('fails the gates stage with the failing gate as detail', async () => {
    const d = deps({ gates: async () => ({ results: [], blockingFailure: { name: 'lint', blocking: true, passed: false, exitCode: 1, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: 'semi', junit: null, failure: 'code' } }) });
    const out = await new MergeQueue().enqueue('T1', taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 's'));
    expect(out).toMatchObject({ ok: false, stage: 'gates', detail: expect.stringContaining('lint') });
  });
});

describe('docsMergeSteps', () => {
  it('merges a docs branch without gates and removes the worktree', async () => {
    const docsWt = path.join(remote.root, 'wt', 'docs__spec-001');
    await createWorktree(remote.repo, docsWt, 'docs/spec-001', 'origin/main');
    await fs.writeFile(path.join(docsWt, 'docs', 'tech-spec.md'), '# spec');
    await commitAll(docsWt, 'docs: tech spec');
    const gates = async () => { throw new Error('gates must not run for docs'); };
    const out = await new MergeQueue().enqueue('docs', docsMergeSteps(deps({ gates }), 'docs/spec-001', docsWt, 'docs(spec-001): technical spec'));
    expect(out).toEqual({ ok: true, pr: 1 });
    expect(gh.prs[0]!.title).toBe('docs(spec-001): technical spec');
    await expect(fs.access(docsWt)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/orchestrator/merge-steps.test.ts`
Expected: FAIL, cannot resolve `../../server/orchestrator/merge-steps.js`.

- [ ] **Step 4: Implement merge-steps.ts**

`server/orchestrator/merge-steps.ts`:
```ts
import type { PlanTask } from '../contracts/plan.js';
import type { AcceptanceCriterion, Spec } from '../contracts/spec.js';
import { redactSecrets } from '../core/redact.js';
import type { Exec } from '../exec/command.js';
import type { GateResult } from '../exec/gate-runner.js';
import { changedFiles, fetch as gitFetch, git, headSha, push, rebaseOnto, remoteMainSha, removeWorktree } from '../git/git.js';
import { ensurePr, findMergedPr, mergePr } from '../git/github.js';
import type { MergeSteps } from '../git/merge-queue.js';
import type { HandoffSummary } from '../knowledge/context-pack.js';
import type { Graphify } from '../knowledge/graphify.js';
import { Intent, OrchEvent, type Journal } from './events.js';
import { graphDir, type Workspace } from './workspace.js';

export interface MergeStepsDeps {
  journal: Journal;
  ws: Workspace;
  /** Orchestrator tools without credentials (git). */
  exec: Exec;
  /** Same executor with GH_TOKEN for `gh`; never handed to agents. */
  ghExec: Exec;
  gates: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
  graphify: Graphify | null;
  secretValues: () => readonly string[];
  handoffs: HandoffSummary[];
  clock: () => Date;
}

const BODY_LIMIT = 8 * 1024;

export function prBody(input: { summary: string; criteria: readonly AcceptanceCriterion[]; gateLines: readonly string[] }, secretValues: readonly string[]): string {
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
  return clean.length > BODY_LIMIT ? `${clean.slice(0, BODY_LIMIT - 16)}\n[... truncated]` : clean;
}

const gateLine = (r: GateResult) => `${r.name}: ${r.passed ? 'passed' : `failed (${r.failure}, exit ${r.exitCode})`}`;
const tail = (s: string) => (s.length > 2000 ? s.slice(-2000) : s);

async function guarded(journal: Journal, type: (typeof Intent)[keyof typeof Intent], key: string, data: Record<string, unknown>, effect: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (journal.isConfirmed(type, key)) {
    const confirm = [...journal.events].reverse().find((e) => e.kind === 'confirm' && e.intentId === `${type}:${key}`);
    return confirm?.data ?? {};
  }
  await journal.intent(type, key, data);
  const result = await effect();
  await journal.confirm(type, key, result);
  return result;
}

function common(deps: MergeStepsDeps, worktree: string, branch: string, title: string, body: () => Promise<string>, runGates: boolean) {
  const repo = deps.ws.repo;
  return {
    alreadyMerged: () => findMergedPr({ cwd: repo, head: branch, base: 'main' }, deps.ghExec),
    rebase: async () => {
      await gitFetch(repo, deps.exec);
      return rebaseOnto(worktree, 'origin/main', deps.exec);
    },
    gates: async () => {
      if (!runGates) return { ok: true };
      const r = await deps.gates(worktree, branch);
      if (!r.blockingFailure) return { ok: true };
      const f = r.blockingFailure;
      return { ok: false, detail: redactSecrets(`${gateLine(f)}\n${tail(f.stderrTail || f.stdoutTail)}`, deps.secretValues()) };
    },
    push: async () => {
      await guarded(deps.journal, Intent.Push, branch, { worktree, branch }, async () => {
        await push(worktree, branch, deps.exec);
        return { sha: await headSha(worktree, deps.exec) };
      });
    },
    ensurePr: async () => {
      const data = await guarded(deps.journal, Intent.PrCreate, branch, { branch, title }, async () => {
        const pr = await ensurePr({ cwd: repo, head: branch, base: 'main', title, body: await body() }, deps.ghExec);
        await deps.journal.fact(OrchEvent.PrCreated, { branch, number: pr.number, url: pr.url, created: pr.created });
        return { number: pr.number, url: pr.url };
      });
      return { number: Number(data.number) };
    },
    remoteMainSha: () => remoteMainSha(repo, deps.exec),
    merge: async (number: number) => {
      const data = await guarded(deps.journal, Intent.PrMerge, branch, { branch, number }, async () => {
        const r = await mergePr({ cwd: repo, number, headSha: await headSha(worktree, deps.exec) }, deps.ghExec);
        if (!r.merged && !r.already) throw new Error(r.reason ?? 'merge refused');
        return { merged: true, already: r.already };
      }).catch((err: Error) => ({ merged: false, reason: err.message }));
      return data.merged ? { merged: true } : { merged: false, reason: String(data.reason) };
    },
    cleanup: async () => {
      await guarded(deps.journal, Intent.WorktreeRemove, branch, { worktree }, async () => {
        await removeWorktree(repo, worktree, deps.exec);
        return {};
      });
    },
  };
}

/** Spec (orchestrator) §4.4 last row: the real MergeSteps for a task branch. */
export function taskMergeSteps(deps: MergeStepsDeps, task: PlanTask, worktree: string, branch: string, spec: Spec, summary: string): MergeSteps {
  let gateResults: GateResult[] = [];
  const base = common(deps, worktree, branch, `${task.id}: ${task.title}`, async () => prBody({ summary, criteria: spec.acceptanceCriteria.filter((c) => task.criteriaRefs.includes(c.id)), gateLines: gateResults.map(gateLine) }, deps.secretValues()), true);
  return {
    ...base,
    gates: async () => {
      const r = await deps.gates(worktree, branch);
      gateResults = r.results;
      if (!r.blockingFailure) return { ok: true };
      const f = r.blockingFailure;
      return { ok: false, detail: redactSecrets(`${gateLine(f)}\n${tail(f.stderrTail || f.stdoutTail)}`, deps.secretValues()) };
    },
    afterMerge: async () => {
      const changed = await changedFiles(worktree, 'origin/main', deps.exec).catch(() => [] as string[]);
      await gitFetch(deps.ws.repo, deps.exec);
      await git(deps.ws.repo, ['checkout', '-q', 'main'], deps.exec);
      await git(deps.ws.repo, ['reset', '-q', '--hard', 'origin/main'], deps.exec);
      if (deps.graphify) await deps.graphify.update(deps.ws.repo, graphDir(deps.ws, null));
      await base.cleanup();
      deps.handoffs.push({ taskId: task.id, title: task.title, summary: redactSecrets(summary, deps.secretValues()), changedFiles: changed, mergedAt: deps.clock().toISOString() });
    },
  };
}

/** Docs branches (Phase 1 and 2) take the same path, minus gates and graph update (spec (orchestrator) §4.2). */
export function docsMergeSteps(deps: MergeStepsDeps, branch: string, worktree: string, title: string): MergeSteps {
  const base = common(deps, worktree, branch, title, async () => `Documentation update for the orchestrator run.`, false);
  return {
    ...base,
    afterMerge: async () => {
      await gitFetch(deps.ws.repo, deps.exec);
      await git(deps.ws.repo, ['checkout', '-q', 'main'], deps.exec);
      await git(deps.ws.repo, ['reset', '-q', '--hard', 'origin/main'], deps.exec);
      await base.cleanup();
    },
  };
}
```
Note: `changedFiles` for the handoff is computed before the fetch moves `origin/main`; it runs against the worktree's pre-merge base. `cleanup` is an extra property on the object returned by `common` and is not part of `MergeSteps`; spreading it into the returned steps is harmless (extra keys), but keep it out with destructuring if `tsc` complains about excess properties: `const { cleanup, ...steps } = base;`.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/orchestrator/merge-steps.test.ts && npm run typecheck`
Expected: 6 tests PASS; typecheck clean. The conflict test writes the same file on `main` and on the branch, so `rebaseOnto` reports `src/sum.ts`.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/merge-steps.ts test/fixtures/fake-gh.ts test/orchestrator/merge-steps.test.ts
git commit -m "feat(orchestrator): real merge steps over git, gh and gates, plus the docs merge path

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Reconcile

**Files:**
- Create: `server/orchestrator/reconcile.ts`
- Test: `test/orchestrator/reconcile.test.ts`

**Interfaces:**
- Consumes: `Journal`, `Intent`, `OrchEvent`; `git`, `headSha`, `removeWorktree` (`git.ts`); `findMergedPr`, `prState` (`github.ts`); `RunEvent`.
- Produces:
  ```ts
  export interface ReconcileDeps { journal: Journal; ws: Workspace; exec: Exec; ghExec: Exec; afterMerge: (taskId: string, branch: string) => Promise<void>; log: (line: string) => void }
  export interface ReconcileReport { confirmed: string[]; redo: string[] }   // intentIds
  export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport>;
  ```
- Per unconfirmed intent, in log order (spec §6):

  | Intent | Reality check | Confirm data | Otherwise |
  |---|---|---|---|
  | `WORKTREE_CREATE` | `git -C <data.worktree> rev-parse --is-inside-work-tree` succeeds | `{}` | redo (the runner re-creates it) |
  | `COMMIT` / `DOCS_COMMIT` | worktree exists, tree clean (`status --porcelain` empty) and `HEAD` differs from `data.baseSha` when given | `{sha: HEAD}` | redo (the step re-runs) |
  | `PUSH` | `git ls-remote origin refs/heads/<branch>` sha equals local `HEAD` of `data.worktree` | `{sha}` | redo (the merge steps push again) |
  | `PR_CREATE` | `gh pr list --head <branch> --state all` non-empty | `{number, url}` + `PR_CREATED` | redo |
  | `PR_MERGE` | `findMergedPr` or `prState(number)` is `MERGED` | `{merged: true, already: true}`, then `afterMerge(taskId, branch)`, `PR_MERGED {taskId, pr, already: true}`, task `→ merged` (via `rebasing`/`merging` as needed) | redo (queue re-submits; `alreadyMerged` guards) |
  | `WORKTREE_REMOVE` | directory missing | `{}` | remove it now, then confirm |

  A `STEP_STARTED` without `STEP_FINISHED` is reported in `redo` as `STEP:<stepId>`; nothing to confirm, the runner re-runs from the task's state.

- [ ] **Step 1: Write the failing test**

`test/orchestrator/reconcile.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { commitAll, createWorktree, git, headSha, push } from '../../server/git/git.js';
import { Intent, Journal, OrchEvent, intentId } from '../../server/orchestrator/events.js';
import { reconcile, type ReconcileDeps } from '../../server/orchestrator/reconcile.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import { makeFrozenSpec, makePlanTask } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const HASH = makeFrozenSpec().specHash!;
const BRANCH = 'task/spec-001-T1';
let remote: Remote;
let journal: Journal;
let gh: FakeGh;
let worktree: string;
let afterMergeCalls: string[];

beforeEach(async () => {
  remote = await makeRemote({ 'docs/README.md': '# docs' });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  await journal.fact(RunEvent.TaskPlanned, { task: makePlanTask({ id: 'T1' }) });
  for (const to of ['ready', 'implementing', 'validating', 'reviewing', 'rebasing'] as const) await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to });
  gh = new FakeGh();
  worktree = path.join(remote.root, 'wt', 'task__spec-001-T1');
  afterMergeCalls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(): ReconcileDeps {
  const ghExec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
  gh.install(ghExec);
  return {
    journal,
    ws: { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', runs: remote.root },
    exec: execCommand,
    ghExec: ghExec.exec,
    afterMerge: async (taskId, branch) => { afterMergeCalls.push(`${taskId}:${branch}`); },
    log: () => {},
  };
}
async function implemented() {
  await createWorktree(remote.repo, worktree, BRANCH, 'origin/main');
  await fs.writeFile(path.join(worktree, 'a.txt'), 'a');
  return commitAll(worktree, 'feat: a');
}

describe('reconcile', () => {
  it('confirms a worktree that exists and marks a missing one for redo', async () => {
    await journal.intent(Intent.WorktreeCreate, 'T1', { worktree, branch: BRANCH });
    let r = await reconcile(deps());
    expect(r).toEqual({ confirmed: [], redo: [intentId(Intent.WorktreeCreate, 'T1')] });
    await createWorktree(remote.repo, worktree, BRANCH, 'origin/main');
    r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.WorktreeCreate, 'T1')]);
    expect(journal.isConfirmed(Intent.WorktreeCreate, 'T1')).toBe(true);
  });

  it('confirms a commit that landed with its sha and flags a dirty or unchanged tree for redo', async () => {
    const base = await git(remote.repo, ['rev-parse', 'origin/main']);
    await journal.intent(Intent.Commit, 's00001', { taskId: 'T1', worktree, baseSha: base });
    await createWorktree(remote.repo, worktree, BRANCH, 'origin/main');
    expect((await reconcile(deps())).redo).toEqual([intentId(Intent.Commit, 's00001')]);
    const sha = await implemented();
    const r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.Commit, 's00001')]);
    expect(journal.events.at(-1)!.data).toEqual({ sha });
  });

  it('confirms a push whose remote sha matches and redoes one that is behind', async () => {
    await implemented();
    await journal.intent(Intent.Push, BRANCH, { worktree, branch: BRANCH });
    expect((await reconcile(deps())).redo).toEqual([intentId(Intent.Push, BRANCH)]);
    await push(worktree, BRANCH);
    expect((await reconcile(deps())).confirmed).toEqual([intentId(Intent.Push, BRANCH)]);
  });

  it('confirms a PR that exists and journals PR_CREATED', async () => {
    await implemented();
    await push(worktree, BRANCH);
    await journal.intent(Intent.PrCreate, BRANCH, { branch: BRANCH, title: 'T1' });
    expect((await reconcile(deps())).redo).toEqual([intentId(Intent.PrCreate, BRANCH)]);
    gh.prs.push({ number: 4, head: BRANCH, base: 'main', state: 'OPEN', headRefOid: await headSha(worktree), title: 'T1', body: '' });
    const r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.PrCreate, BRANCH)]);
    expect(journal.events.find((e) => e.type === OrchEvent.PrCreated)!.data).toMatchObject({ number: 4 });
  });

  it('confirms a merged PR and finishes the task without merging again', async () => {
    await implemented();
    await push(worktree, BRANCH);
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'merging' });
    await journal.intent(Intent.PrMerge, BRANCH, { branch: BRANCH, number: 4, taskId: 'T1' });
    gh.prs.push({ number: 4, head: BRANCH, base: 'main', state: 'MERGED', headRefOid: await headSha(worktree), title: 'T1', body: '' });
    const r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.PrMerge, BRANCH)]);
    expect(afterMergeCalls).toEqual([`T1:${BRANCH}`]);
    expect(journal.state.tasks.get('T1')!.state).toBe('merged');
    expect(journal.events.find((e) => e.type === OrchEvent.PrMerged)!.data).toMatchObject({ taskId: 'T1', pr: 4, already: true });
  });

  it('removes a worktree whose removal never confirmed', async () => {
    await createWorktree(remote.repo, worktree, BRANCH, 'origin/main');
    await journal.intent(Intent.WorktreeRemove, BRANCH, { worktree });
    const r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.WorktreeRemove, BRANCH)]);
    await expect(fs.access(worktree)).rejects.toThrow();
  });

  it('reports an interrupted step for redo', async () => {
    await journal.fact(OrchEvent.StepStarted, { stepId: 's00003', kind: 'dev', taskId: 'T1' });
    expect((await reconcile(deps())).redo).toEqual(['STEP:s00003']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/orchestrator/reconcile.test.ts`
Expected: FAIL, cannot resolve `../../server/orchestrator/reconcile.js`.

- [ ] **Step 3: Implement reconcile.ts**

`server/orchestrator/reconcile.ts`:
```ts
import { promises as fs } from 'node:fs';
import type { Exec } from '../exec/command.js';
import { git, headSha, removeWorktree } from '../git/git.js';
import { findMergedPr, prState } from '../git/github.js';
import { RunEvent } from '../pipeline/run-state.js';
import type { StoredEvent } from '../store/event-store.js';
import { Intent, OrchEvent, type IntentType, type Journal } from './events.js';
import type { Workspace } from './workspace.js';

export interface ReconcileDeps {
  journal: Journal;
  ws: Workspace;
  exec: Exec;
  ghExec: Exec;
  afterMerge: (taskId: string, branch: string) => Promise<void>;
  log: (line: string) => void;
}

export interface ReconcileReport {
  confirmed: string[];
  redo: string[];
}

const keyOf = (e: StoredEvent) => e.intentId!.slice(e.intentId!.indexOf(':') + 1);

async function insideWorktree(dir: string, exec: Exec): Promise<boolean> {
  try {
    await fs.access(dir);
    await git(dir, ['rev-parse', '--is-inside-work-tree'], exec);
    return true;
  } catch {
    return false;
  }
}

/** Spec (orchestrator) §6: an intent without a confirm is checked against reality, never replayed blindly. */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const { journal, exec, ghExec } = deps;
  const report: ReconcileReport = { confirmed: [], redo: [] };
  const confirm = async (e: StoredEvent, data: Record<string, unknown>) => {
    await journal.confirm(e.type as IntentType, keyOf(e), data);
    report.confirmed.push(e.intentId!);
    deps.log(`reconcile: confirmed ${e.intentId}`);
  };
  const redo = (e: StoredEvent) => {
    report.redo.push(e.intentId!);
    deps.log(`reconcile: redo ${e.intentId}`);
  };

  for (const e of journal.unconfirmed()) {
    const d = e.data as Record<string, string | number | undefined>;
    switch (e.type) {
      case Intent.WorktreeCreate: {
        (await insideWorktree(String(d.worktree), exec)) ? await confirm(e, {}) : redo(e);
        break;
      }
      case Intent.Commit:
      case Intent.DocsCommit: {
        const wt = String(d.worktree);
        if (!(await insideWorktree(wt, exec))) {
          redo(e);
          break;
        }
        const dirty = (await git(wt, ['status', '--porcelain', '--untracked-files=all'], exec)) !== '';
        const head = await headSha(wt, exec);
        const moved = d.baseSha === undefined || head !== d.baseSha;
        !dirty && moved ? await confirm(e, { sha: head }) : redo(e);
        break;
      }
      case Intent.Push: {
        const wt = String(d.worktree);
        const branch = String(d.branch);
        if (!(await insideWorktree(wt, exec))) {
          redo(e);
          break;
        }
        const local = await headSha(wt, exec);
        const remote = (await git(deps.ws.repo, ['ls-remote', 'origin', `refs/heads/${branch}`], exec)).split(/\s+/)[0] ?? '';
        remote === local ? await confirm(e, { sha: local }) : redo(e);
        break;
      }
      case Intent.PrCreate: {
        const branch = String(d.branch);
        const list = await deps.ghExec({ bin: 'gh', args: ['pr', 'list', '--head', branch, '--base', 'main', '--state', 'all', '--json', 'number,url'], cwd: deps.ws.repo, timeoutMs: 60_000 });
        const rows = list.exitCode === 0 ? (JSON.parse(list.stdout || '[]') as Array<{ number: number; url: string }>) : [];
        if (rows[0]) {
          await confirm(e, { number: rows[0].number, url: rows[0].url });
          await journal.fact(OrchEvent.PrCreated, { branch, number: rows[0].number, url: rows[0].url, created: false });
        } else redo(e);
        break;
      }
      case Intent.PrMerge: {
        const branch = String(d.branch);
        const number = Number(d.number);
        let merged = (await findMergedPr({ cwd: deps.ws.repo, head: branch, base: 'main' }, ghExec)) !== null;
        if (!merged && Number.isFinite(number)) merged = (await prState({ cwd: deps.ws.repo, number }, ghExec).catch(() => ({ state: 'OPEN' as const }))).state === 'MERGED';
        if (!merged) {
          redo(e);
          break;
        }
        await confirm(e, { merged: true, already: true });
        const taskId = String(d.taskId);
        await deps.afterMerge(taskId, branch);
        await journal.fact(OrchEvent.PrMerged, { taskId, pr: number, already: true, warning: null });
        const task = journal.state.tasks.get(taskId);
        if (task && task.state === 'rebasing') await journal.fact(RunEvent.TaskStateChanged, { taskId, to: 'merging' });
        if (task && (task.state === 'merging' || task.state === 'rebasing')) await journal.fact(RunEvent.TaskStateChanged, { taskId, to: 'merged' });
        break;
      }
      case Intent.WorktreeRemove: {
        const wt = String(d.worktree);
        if (await insideWorktree(wt, exec)) await removeWorktree(deps.ws.repo, wt, exec);
        await confirm(e, {});
        break;
      }
      default:
        redo(e);
    }
  }

  const finished = new Set(journal.events.filter((e) => e.type === OrchEvent.StepFinished).map((e) => String(e.data.stepId)));
  for (const e of journal.events) {
    if (e.type === OrchEvent.StepStarted && !finished.has(String(e.data.stepId))) {
      report.redo.push(`STEP:${String(e.data.stepId)}`);
      deps.log(`reconcile: step ${String(e.data.stepId)} was interrupted; it re-runs without an attempt`);
    }
  }
  return report;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/orchestrator/reconcile.test.ts && npm run typecheck`
Expected: 7 tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/reconcile.ts test/orchestrator/reconcile.test.ts
git commit -m "feat(orchestrator): reconcile unconfirmed intents against git and GitHub on resume

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Phases 1 and 2

**Files:**
- Create: `server/orchestrator/phases/tech-spec.ts`, `server/orchestrator/phases/plan.ts`
- Test: `test/orchestrator/phases.test.ts`

**Interfaces:**
- Consumes: `Journal`, `OrchEvent`, `Intent`; `techSpecPack`, `coveragePack`, `planPack`, `AgentStepRequest` (Task 3); `docsMergeSteps`, `MergeStepsDeps` (Task 5); `createWorktree`, `commitAll`, `git`; `MergeQueue`; `validatePlan`; `Plan`, `TechSpecOutput`, `CoverageOutput`; `RunEvent`; `worktreeDir`.
- Produces:
  ```ts
  export interface PhaseDeps {
    journal: Journal; ws: Workspace; spec: Spec; project: Project; specHash: string; firstSpec: boolean; exec: Exec;
    runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => Promise<StepOutcome<OutputOf<K>>>;
    mergeQueue: MergeQueue; mergeDeps: MergeStepsDeps; packBase: () => PackBase;
    godNodes: () => Promise<ReadonlyArray<{ label: string; edges: number }>>;
    maxPhaseAttempts?: number;   // default 3
  }
  export type PhaseResult = { ok: true } | { ok: false; reason: string };
  export async function runPhase1(deps: PhaseDeps): Promise<PhaseResult & { techSpecText?: string }>;
  export async function runPhase2(deps: PhaseDeps, techSpecText: string): Promise<PhaseResult & { plan?: Plan }>;
  export async function readDocs(repo: string, specId: string): Promise<{ techSpecText: string | null; plan: Plan | null }>;   // for resume: what is already on main
  ```
- Phase 1 (`runPhase1`): if `readDocs` finds `tech-spec.md` on `main` → `{ok: true, techSpecText}` (already done; idempotent resume). Else `PHASE_STARTED {phase: 1}`; docs worktree `docs/<specId>` from `origin/main` (intent `WORKTREE_CREATE:docs-<specId>`); loop attempts 1..3: `runAgent({kind:'tech-spec', role:'dev', cwd: worktree, refContext: {files: tracked ∪ untracked}, refs: v => ({files: [v.techSpecPath, ...v.adrs.map(a => a.path)], adrIds: v.adrs.map(a => a.id)})})`; `TECH_SPEC_WRITTEN {path, adrs, stack}`; read the tech-spec text; `runAgent({kind:'coverage', role:'po', cwd: worktree})`; `COVERAGE_CHECKED {uncovered}`; all covered → break; else feedback for the next Dev attempt = uncovered list. Attempts exhausted → `PHASE_FAILED {phase: 1, reason}` → `{ok: false}`. Then intent `DOCS_COMMIT:<specId>-1` → `commitAll(worktree, 'docs(<specId>): technical spec')` → confirm; `mergeQueue.enqueue('docs-1', docsMergeSteps(mergeDeps, 'docs/<specId>', worktree, 'docs(<specId>): technical spec'))`; not ok → one retry, then `PHASE_FAILED`; ok → `DOCS_MERGED {pr, phase: 1}`.
- Phase 2 (`runPhase2`): if `readDocs` finds `plan.json` → `{ok: true, plan}`. Else `PHASE_STARTED {phase: 2}`; docs worktree `docs/<specId>-plan`; attempts 1..3 of `runAgent({kind:'plan', role:'sm', cwd: worktree, semantic: [plan => validatePlan(plan, spec, {firstSpec})]})` (the semantic check makes plan errors a `schema` failure with the errors as feedback); ok → write `docs/specs/<specId>/plan.json` (canonical JSON, 2 spaces), intent `DOCS_COMMIT:<specId>-2` → commit → confirm; docs merge (`docs(<specId>): plan`); `DOCS_MERGED {pr, phase: 2}`; one `TASK_PLANNED {task}` per plan task in plan order; `{ok: true, plan}`.

- [ ] **Step 1: Write the failing test**

`test/orchestrator/phases.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase1, runPhase2, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary });
type Agent = (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>;

let remote: Remote;
let journal: Journal;
let gh: FakeGh;
let calls: AgentStepRequest<any>[];

beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  gh = new FakeGh();
  calls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

const writeTechSpec: Agent = async (req) => {
  await fs.mkdir(path.join(req.cwd, 'docs', 'specs', 'spec-001'), { recursive: true });
  await fs.mkdir(path.join(req.cwd, 'docs', 'adr'), { recursive: true });
  await fs.writeFile(path.join(req.cwd, 'docs', 'specs', 'spec-001', 'tech-spec.md'), '# Tech spec\n\n## AC-001\nsum');
  await fs.writeFile(path.join(req.cwd, 'docs', 'adr', 'ADR-001.md'), '# ADR-001 stack');
  return ok({ specHash: HASH, techSpecPath: 'docs/specs/spec-001/tech-spec.md', adrs: [{ id: 'ADR-001', title: 'stack', path: 'docs/adr/ADR-001.md' }], stack: 'node', summary: 'wrote it' });
};
const coverage = (covered: boolean) => ok({ specHash: HASH, coverage: spec.acceptanceCriteria.map((c) => ({ acId: c.id, section: covered ? 'AC-001' : null, covered, note: '' })) });

function deps(agent: Agent): PhaseDeps {
  const ghExec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
  gh.install(ghExec);
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', runs: remote.root };
  return {
    journal, ws, spec, project, specHash: HASH, firstSpec: true, exec: execCommand,
    runAgent: (async (req) => { calls.push(req); return agent(req); }) as PhaseDeps['runAgent'],
    mergeQueue: new MergeQueue(),
    mergeDeps: { journal, ws, exec: execCommand, ghExec: ghExec.exec, gates: async () => ({ results: [], blockingFailure: null }), graphify: null, secretValues: () => [], handoffs: [], clock: () => new Date() },
    packBase: () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 }),
    godNodes: async () => [],
  };
}

describe('Phase 1', () => {
  it('writes the tech spec, checks coverage and merges the docs branch', async () => {
    let n = 0;
    const r = await runPhase1(deps(async (req) => (req.kind === 'tech-spec' ? writeTechSpec(req) : (n++, coverage(n > 1)))));
    expect(r.ok).toBe(true);
    expect(r.techSpecText).toContain('# Tech spec');
    expect(calls.map((c) => c.kind)).toEqual(['tech-spec', 'coverage', 'tech-spec', 'coverage']);
    expect(calls[2]!.pack.feedback).toContain('AC-001');
    expect(gh.prs[0]!.title).toBe('docs(spec-001): technical spec');
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/tech-spec.md'])).toContain('# Tech spec');
    expect(journal.events.map((e) => e.type)).toContain(OrchEvent.DocsMerged);
    expect(journal.events.filter((e) => e.type === OrchEvent.CoverageChecked).map((e) => e.data.uncovered)).toEqual([['AC-001'], []]);
  });

  it('fails the phase after three uncovered rounds', async () => {
    const r = await runPhase1(deps(async (req) => (req.kind === 'tech-spec' ? writeTechSpec(req) : coverage(false))));
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('AC-001') });
    expect(journal.events.find((e) => e.type === OrchEvent.PhaseFailed)!.data).toMatchObject({ phase: 1 });
    expect(gh.prs).toHaveLength(0);
  });

  it('is idempotent: a tech spec already on main skips the phase', async () => {
    await fs.mkdir(path.join(remote.repo, 'docs', 'specs', 'spec-001'), { recursive: true });
    await fs.writeFile(path.join(remote.repo, 'docs', 'specs', 'spec-001', 'tech-spec.md'), '# existing');
    await git(remote.repo, ['add', '-A']);
    await git(remote.repo, ['commit', '-q', '-m', 'docs: existing']);
    await git(remote.repo, ['push', '-q', 'origin', 'main']);
    const r = await runPhase1(deps(async () => { throw new Error('no agent call expected'); }));
    expect(r).toEqual({ ok: true, techSpecText: '# existing' });
    expect(calls).toHaveLength(0);
  });
});

describe('Phase 2', () => {
  it('plans, validates, commits plan.json and journals every task', async () => {
    const plan = makePlan(spec);
    const r = await runPhase2(deps(async () => ok(plan)), '# Tech spec');
    expect(r.ok).toBe(true);
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(JSON.parse(await git(remote.repo, ['show', 'origin/main:docs/specs/spec-001/plan.json'])).tasks.map((t: { id: string }) => t.id)).toEqual(plan.tasks.map((t) => t.id));
    expect([...journal.state.tasks.keys()]).toEqual(plan.tasks.map((t) => t.id));
    expect(gh.prs[0]!.title).toBe('docs(spec-001): plan');
  });

  it('feeds validation errors back and fails after the retries', async () => {
    const bad = { ...makePlan(spec), tasks: [] };
    const r = await runPhase2(deps(async () => ({ ok: false, failure: 'schema', errors: ['tasks: Too small: expected array to have >=1 items'], summary, sandboxDisabled: false })), '# Tech spec');
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.pack.feedback).toContain('Too small');
    expect(journal.events.find((e) => e.type === OrchEvent.PhaseFailed)!.data).toMatchObject({ phase: 2 });
    void bad;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/orchestrator/phases.test.ts`
Expected: FAIL, cannot resolve `../../server/orchestrator/phases/index.js`.

- [ ] **Step 3: Implement the phases**

`server/orchestrator/phases/index.ts`:
```ts
export { runPhase1 } from './tech-spec.js';
export { runPhase2 } from './plan.js';
export { readDocs, type PhaseDeps, type PhaseResult } from './shared.js';
```

`server/orchestrator/phases/shared.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OutputOf, StepKind } from '../../agents/outputs.js';
import { Plan } from '../../contracts/plan.js';
import type { Project } from '../../contracts/project.js';
import type { Spec } from '../../contracts/spec.js';
import type { Exec } from '../../exec/command.js';
import { commitAll, createWorktree, fetch as gitFetch, git } from '../../git/git.js';
import type { MergeQueue } from '../../git/merge-queue.js';
import type { StepOutcome } from '../../runner/step.js';
import { Intent, OrchEvent, type Journal } from '../events.js';
import { docsMergeSteps, type MergeStepsDeps } from '../merge-steps.js';
import type { AgentStepRequest, PackBase } from '../steps.js';
import { worktreeDir, type Workspace } from '../workspace.js';

export interface PhaseDeps {
  journal: Journal;
  ws: Workspace;
  spec: Spec;
  project: Project;
  specHash: string;
  firstSpec: boolean;
  exec: Exec;
  runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => Promise<StepOutcome<OutputOf<K>>>;
  mergeQueue: MergeQueue;
  mergeDeps: MergeStepsDeps;
  packBase: () => PackBase;
  godNodes: () => Promise<ReadonlyArray<{ label: string; edges: number }>>;
  maxPhaseAttempts?: number;
}

export type PhaseResult = { ok: true } | { ok: false; reason: string };

export const specDir = (specId: string) => path.posix.join('docs', 'specs', specId);

/** What main already carries for this spec; lets a resumed run skip finished phases. */
export async function readDocs(repo: string, specId: string, exec?: Exec): Promise<{ techSpecText: string | null; plan: Plan | null }> {
  const show = async (rel: string) => {
    try {
      return await git(repo, ['show', `origin/main:${rel}`], exec);
    } catch {
      return null;
    }
  };
  const techSpecText = await show(`${specDir(specId)}/tech-spec.md`);
  const planText = await show(`${specDir(specId)}/plan.json`);
  return { techSpecText, plan: planText === null ? null : Plan.parse(JSON.parse(planText)) };
}

export async function docsWorktree(deps: PhaseDeps, branch: string): Promise<string> {
  const dir = worktreeDir(deps.ws, branch);
  const key = `docs-${branch}`;
  await gitFetch(deps.ws.repo, deps.exec);
  const confirmed = deps.journal.isConfirmed(Intent.WorktreeCreate, key);
  if (!confirmed) await deps.journal.intent(Intent.WorktreeCreate, key, { worktree: dir, branch });
  await createWorktree(deps.ws.repo, dir, branch, 'origin/main', deps.exec, { reset: true });
  if (!confirmed) await deps.journal.confirm(Intent.WorktreeCreate, key, {});
  return dir;
}

export async function commitAndMergeDocs(deps: PhaseDeps, phase: 1 | 2, branch: string, worktree: string, title: string): Promise<PhaseResult> {
  const key = `${deps.spec.specId}-${phase}`;
  await deps.journal.intent(Intent.DocsCommit, key, { worktree, branch, message: title });
  const sha = (await commitAll(worktree, title, {}, deps.exec)) ?? (await git(worktree, ['rev-parse', 'HEAD'], deps.exec));
  await deps.journal.confirm(Intent.DocsCommit, key, { sha });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.mergeQueue.enqueue(`docs-${phase}-${attempt}`, docsMergeSteps(deps.mergeDeps, branch, worktree, title));
    if (out.ok) {
      await deps.journal.fact(OrchEvent.DocsMerged, { phase, pr: out.pr, branch });
      return { ok: true };
    }
    if (attempt === 2) {
      const reason = `docs merge failed at ${out.stage}: ${out.detail ?? (out.conflicts ?? []).join(', ')}`;
      await deps.journal.fact(OrchEvent.PhaseFailed, { phase, reason });
      return { ok: false, reason };
    }
  }
  return { ok: false, reason: 'unreachable' };
}

export async function trackedAndUntracked(dir: string, exec: Exec): Promise<Set<string>> {
  const tracked = (await git(dir, ['ls-files'], exec)).split('\n').filter((f) => f !== '');
  const status = (await git(dir, ['status', '--porcelain', '--untracked-files=all'], exec)).split('\n').filter((l) => l !== '').map((l) => l.slice(3).trim());
  return new Set([...tracked, ...status]);
}

export async function readInWorktree(worktree: string, rel: string): Promise<string> {
  return fs.readFile(path.join(worktree, rel), 'utf8');
}
```

`server/orchestrator/phases/tech-spec.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CoverageOutput, TechSpecOutput } from '../../agents/outputs.js';
import { OrchEvent } from '../events.js';
import { coveragePack, techSpecPack } from '../steps.js';
import { commitAndMergeDocs, docsWorktree, readDocs, readInWorktree, trackedAndUntracked, type PhaseDeps, type PhaseResult } from './shared.js';

/** Spec (orchestrator) §4.2. */
export async function runPhase1(deps: PhaseDeps): Promise<PhaseResult & { techSpecText?: string }> {
  const existing = await readDocs(deps.ws.repo, deps.spec.specId, deps.exec);
  if (existing.techSpecText !== null) return { ok: true, techSpecText: existing.techSpecText };
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 1 });
  const branch = `docs/${deps.spec.specId}`;
  const worktree = await docsWorktree(deps, branch);
  const max = deps.maxPhaseAttempts ?? 3;
  let feedback: string | null = null;
  let techSpecText = '';
  let lastUncovered: string[] = [];
  for (let attempt = 1; attempt <= max; attempt++) {
    const files = await trackedAndUntracked(worktree, deps.exec);
    const wrote = await deps.runAgent<'tech-spec'>({
      kind: 'tech-spec',
      role: 'dev',
      pack: techSpecPack(deps.packBase(), { feedback }),
      cwd: worktree,
      phase: 'phase1',
      taskId: null,
      attempt,
      refContext: { acIds: new Set(deps.spec.acceptanceCriteria.map((c) => c.id)), taskIds: new Set(), files: await trackedAndUntracked(worktree, deps.exec), tests: new Set(), adrIds: new Set() },
      refs: ((v: TechSpecOutput) => ({ files: [v.techSpecPath, ...v.adrs.map((a) => a.path)] })) as never,
    });
    void files;
    if (!wrote.ok) {
      feedback = `Previous attempt failed (${wrote.failure}):\n${wrote.errors.join('\n')}`;
      continue;
    }
    const spec = wrote.value as TechSpecOutput;
    await deps.journal.fact(OrchEvent.TechSpecWritten, { path: spec.techSpecPath, adrs: spec.adrs, stack: spec.stack, attempt });
    techSpecText = await readInWorktree(worktree, spec.techSpecPath);
    const checked = await deps.runAgent<'coverage'>({ kind: 'coverage', role: 'po', pack: coveragePack(deps.packBase(), { techSpecText }), cwd: worktree, phase: 'phase1', taskId: null, attempt });
    if (!checked.ok) {
      feedback = `Coverage check failed (${checked.failure}):\n${checked.errors.join('\n')}`;
      continue;
    }
    const cov = checked.value as CoverageOutput;
    const covered = new Set(cov.coverage.filter((c) => c.covered).map((c) => c.acId));
    lastUncovered = deps.spec.acceptanceCriteria.map((c) => c.id).filter((id) => !covered.has(id));
    await deps.journal.fact(OrchEvent.CoverageChecked, { attempt, uncovered: lastUncovered });
    if (lastUncovered.length === 0) {
      const merged = await commitAndMergeDocs(deps, 1, branch, worktree, `docs(${deps.spec.specId}): technical spec`);
      return merged.ok ? { ok: true, techSpecText } : merged;
    }
    feedback = `The PO found these acceptance criteria uncovered by the tech spec; cover each with its own section:\n${lastUncovered.map((id) => `- ${id}: ${cov.coverage.find((c) => c.acId === id)?.note ?? ''}`).join('\n')}`;
  }
  const reason = `Phase 1 exhausted ${max} attempts; uncovered: ${lastUncovered.join(', ') || 'n/a'}`;
  await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 1, reason });
  await fs.rm(path.join(worktree), { recursive: true, force: true }).catch(() => undefined);
  return { ok: false, reason };
}
```

`server/orchestrator/phases/plan.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Plan } from '../../contracts/plan.js';
import { canonicalJson } from '../../contracts/hash.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { validatePlan } from '../../validators/plan.js';
import { OrchEvent } from '../events.js';
import { planPack } from '../steps.js';
import { commitAndMergeDocs, docsWorktree, readDocs, specDir, type PhaseDeps, type PhaseResult } from './shared.js';

/** Spec (orchestrator) §4.3. */
export async function runPhase2(deps: PhaseDeps, techSpecText: string): Promise<PhaseResult & { plan?: Plan }> {
  const existing = await readDocs(deps.ws.repo, deps.spec.specId, deps.exec);
  if (existing.plan !== null) {
    await journalTasks(deps, existing.plan);
    return { ok: true, plan: existing.plan };
  }
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 2 });
  const branch = `docs/${deps.spec.specId}-plan`;
  const worktree = await docsWorktree(deps, branch);
  const max = deps.maxPhaseAttempts ?? 3;
  let feedback: string | null = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    const out = await deps.runAgent<'plan'>({
      kind: 'plan',
      role: 'sm',
      pack: planPack(deps.packBase(), { techSpecText, godNodes: await deps.godNodes(), feedback }),
      cwd: worktree,
      phase: 'phase2',
      taskId: null,
      attempt,
      semantic: [((p: Plan) => validatePlan(p, deps.spec, { firstSpec: deps.firstSpec })) as never],
    });
    if (!out.ok) {
      feedback = `Previous plan was rejected (${out.failure}):\n${out.errors.join('\n')}`;
      continue;
    }
    const plan = out.value as Plan;
    const rel = `${specDir(deps.spec.specId)}/plan.json`;
    await fs.mkdir(path.dirname(path.join(worktree, rel)), { recursive: true });
    await fs.writeFile(path.join(worktree, rel), `${JSON.stringify(JSON.parse(canonicalJson(plan)), null, 2)}\n`);
    const merged = await commitAndMergeDocs(deps, 2, branch, worktree, `docs(${deps.spec.specId}): plan`);
    if (!merged.ok) return merged;
    await journalTasks(deps, plan);
    return { ok: true, plan };
  }
  const reason = `Phase 2 exhausted ${max} attempts; last feedback: ${feedback ?? 'none'}`;
  await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 2, reason });
  return { ok: false, reason };
}

async function journalTasks(deps: PhaseDeps, plan: Plan): Promise<void> {
  for (const task of plan.tasks) {
    if (!deps.journal.state.tasks.has(task.id)) await deps.journal.fact(RunEvent.TaskPlanned, { task });
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/orchestrator/phases.test.ts && npm run typecheck`
Expected: 5 tests PASS; typecheck clean. `docsWorktree` passes `reset: true` because a docs branch left by a crashed attempt carries commits that were never merged and must be discarded (the phase re-runs from `main`).

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases test/orchestrator/phases.test.ts
git commit -m "feat(orchestrator): phases 1 and 2 with docs merged through the queue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `Run` — tick loop, pause/resume, budgets, terminal states, decisions

**Files:**
- Create: `server/orchestrator/run.ts`
- Modify: `server/orchestrator/task-runner.ts` (add `budgetExceeded(tokens: number, cap: number): Promise<void>` — a public `fail('budget', …)`)
- Test: `test/orchestrator/run.test.ts`; extend `test/orchestrator/task-runner.test.ts` with one test

**Interfaces:**
- Consumes: everything from Tasks 1–7; `nextRunnable`, `runProgress`, `tasksToBlock` (`scheduler.ts`); `Governor`, `QuotaBreaker`, `Accounting`; `createDecider`, `EscalationRunner`; `runGates`, `GateContext`, `GateDeps`; `Graphify`, `grepFallback`, `MIN_COVERAGE`; `KnowledgeIndex`; `loadAgents`; `resolveProfile`; `computeSpecHash`; `loadSecrets`; `Project`, `Spec`, `Plan` contracts.
- Produces:
  ```ts
  export interface RunDeps {
    cfg: Config; ws: Workspace; project: Project; spec: Spec; firstSpec: boolean;
    exec: Exec; ghExec: Exec;
    runStep: typeof runStep;                      // real or fake
    binary: RunnerBinary;                         // claude (or the fake) for runStep
    agents: Record<Role, AgentDefinition>;
    graphify: Graphify | null;
    knowledge: KnowledgeIndex | null;
    secrets: Record<string, string>;
    fetch?: typeof fetch;                         // for Jev
    clock?: () => Date; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void;
    /** Test hook: throw from inside the journal right after this intent is appended (crash injection). */
    crashAfterIntent?: (intentId: string) => boolean;
    maxParallel?: number;
  }
  export type ExecuteResult = RunResult | 'paused:auth';
  export class Run {
    static async create(deps: RunDeps): Promise<Run>;           // new runId, RUN_STARTED
    static async resume(deps: RunDeps, runId: string): Promise<Run>;  // reconcile, then continue
    readonly runId: string; readonly journal: Journal; readonly accounting: Accounting;
    execute(): Promise<ExecuteResult>;   // phases 1–2 (skipped when done), then the loop; journals RUN_FINISHED for a RunResult
    close(): Promise<void>;
  }
  export class CrashInjected extends Error {}
  ```
- Wiring inside `Run`:
  - `journal` = `Journal.open({file: eventsFile(ws, runId), runId, specHash})`; `crashAfterIntent` wraps `journal.intent` so a matching intent id throws `CrashInjected` after the append (the event is on disk, the effect never happened: exactly the crash the reconciler must handle).
  - `accounting = new Accounting()`, `governor = new Governor(cfg.concurrency.maxClaudeProcesses)`, `breaker = new QuotaBreaker(DEFAULT_BREAKER, clock)`, `mergeQueue = new MergeQueue()`, `handoffs: HandoffSummary[] = []`.
  - `stepDeps: StepDeps = { binary, caps: cfg.budgets.step, accounting, claudeJsonPath: expandHome('~/.claude.json'), settingsDir: runDir/settings, workspacesRoot: ws.root, network: { allowedDomains: ['registry.npmjs.org', ...(cfg.omniroute.enabled ? ['localhost'] : [])] }, clock }`.
  - `runAgent = (req) => runAgentStep(req, { runStep, stepDeps, agents, profile: role => resolveProfile(cfg, role, project), omniroute: cfg.omniroute.enabled ? { baseUrl: cfg.omniroute.baseUrl, token: secrets.OMNIROUTE_TOKEN ?? '' } : undefined, governor, breaker, journal, stepDir: seq => stepDir(ws, runId, seq), secretValues: () => Object.values(secrets), specHash })`.
  - `gates = (worktree, branch) => runGates(plan.gates.filter(g => g.blocking), { worktree, image: plan.gateImage, junitPath: plan.junitPath, cpus: 2, memory: '2g', timeoutMs: 15 * 60_000, secrets, containerName: `teams-ai-${runId}-${branchDir}` }, { exec, readFile: p => fs.readFile(p,'utf8').catch(() => null), removeFile: p => fs.rm(p, {force: true}) })`.
  - `code = async (worktree, task)`: graphify present and `graphify.coverage(graphDir(ws, null), tracked).coverage >= MIN_COVERAGE` → `{source:'graph', nodes: (await graphify.query(graphDir(ws,null), `${task.title} ${task.description}`, 2000)).nodes}`; else `{source:'grep', grep: await grepFallback(worktree, termsOf(task), exec)}`; `impact = async (worktree, branch, changed)`: graphify → `update(worktree, graphDir(ws, branch))` then `affected` per changed file symbol (the file path is the symbol for the CLI), else `{source:'none'}`.
  - `decider = createDecider({cfg, secrets, accounting, runEscalation: ({role, prompt}) => runStep({kind:'decide', role, agent: agents[role], profile: resolveProfile(cfg, role, project), model, cwd: ws.repo, prompt, expectedSpecHash: specHash, phase:'decide', taskId: null, attempt: 0}, stepDeps), fetch, onDecision: r => void journal.fact(OrchEvent.DecisionMade, { record: r })})`.
  - `packBase = () => ({spec, project, specHash, assumptions: journal.assumptions(), adrs, techSpecExcerpt: techSpecText.slice(0, 6000), retrieval: knowledge?.search(…) ?? [], budgetTokens: 12_000})` with `adrs` read from `docs/adr/*.md` on `main` after Phase 1.
  - Loop (`execute`): Phase 1 → Phase 2 (each `{ok:false}` → `RUN_FINISHED {result:'phase-failed', reason}` and return); then `PHASE_STARTED {3}` once; then:
    ```
    runners = Map<taskId, TaskRunner>; inflight = Map<taskId, Promise<void>>
    loop:
      if state.status === 'paused:auth' → return 'paused:auth'
      if !breaker.canStart(): if status running → RunPaused{quota}; await sleep(until - now); breaker.tick(); continue
      if status === 'paused:quota' && breaker.canStart() → RunResumed
      if status running && !observeOnly && accounting.total().tokens > perRunTokens → RunBudgetExhausted
      progress = runProgress(state, maxParallel); if progress !== 'running' && inflight.size === 0 → finish(progress)
      for id of nextRunnable(state, maxParallel): runners.set(id, new TaskRunner(id, runnerDeps)); if !inflight.has(id) → start
      for [id, r] of runners: if !r.done && !inflight.has(id) && ACTIVE_STATES.has(r.task.state) && status running → start
      if inflight.size === 0 → finish(progress === 'running' ? 'deadlocked' : progress)   // nothing can move
      await Promise.race(inflight.values())
    start(id): inflight.set(id, r.advance().finally(() => inflight.delete(id)).then(() => perTaskBudget(id)))
    perTaskBudget(id): tokens = accounting.tokensOf(accounting.total({taskId: id})); if tokens > perTaskTokens → observeOnly ? BUDGET_EXCEEDED fact : r.budgetExceeded(tokens, cap)
    finish(result): RUN_FINISHED {result, merged: [...], blocked: [{taskId, reason}]}; write state.json; return result
    ```
  - `state.json` is rewritten after every tick (`{status, tasks: [{id, state, attempts}], runId, at}`).

- [ ] **Step 1: Write the failing tests**

Append to `test/orchestrator/task-runner.test.ts` (inside `describe('TaskRunner: attempts, replan, block')`):
```ts
  it('budgetExceeded consumes an attempt with the token count as feedback', async () => {
    const r = new TaskRunner('T1', deps());
    await r.advance();
    await r.budgetExceeded(1_600_000, 1_500_000);
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('1600000');
  });
```

`test/orchestrator/run.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { CrashInjected, Run, type RunDeps } from '../../server/orchestrator/run.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import type { StepRequest, StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec, { tasks: [makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src/a'] }), makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['src/b'] })] });
const JUNIT = `<testsuite name="sum"><testcase classname="sum" name="[AC-001] adds"/></testsuite>`;
const summary = (over: Partial<ResultSummary> = {}): ResultSummary => ({ found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 5, costUsd: 0.001, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0, ...over });

type Script = (req: StepRequest) => Promise<StepOutcome<any>>;
const happy: Script = async (req) => {
  switch (req.kind) {
    case 'dev': {
      const dir = path.join(req.cwd, 'src', req.taskId === 'T1' ? 'a' : 'b');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'index.ts'), `export const ${req.taskId} = 1;\n`);
      return { ok: true, value: { specHash: HASH, status: 'done', summary: `did ${req.taskId}`, changedFiles: [`src/${req.taskId === 'T1' ? 'a' : 'b'}/index.ts`], commitMessage: `feat: ${req.taskId}` }, summary: summary() };
    }
    case 'review':
      return { ok: true, value: { specHash: HASH, decision: 'approve', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }], findings: [] }, summary: summary() };
    default:
      throw new Error(`unexpected step ${req.kind}`);
  }
};

let remote: Remote;
let gh: FakeGh;
let clock: { now: Date };
let sleeps: number[];

beforeEach(async () => {
  remote = await makeRemote({
    'docs/project.json': JSON.stringify(project),
    'docs/specs/spec-001/spec.json': JSON.stringify(spec),
    'docs/specs/spec-001/tech-spec.md': '# Tech spec\n\n## AC-001\nsum',
    'docs/specs/spec-001/plan.json': JSON.stringify(plan),
  });
  gh = new FakeGh();
  clock = { now: new Date('2026-09-24T10:00:00Z') };
  sleeps = [];
});
afterEach(async () => {
  await remote.cleanup();
});

function deps(script: Script, over: Partial<RunDeps> = {}): RunDeps {
  const cfg = loadConfig({ paths: { workspaces: path.join(remote.root, 'ws').replace(/\\/g, '/'), runs: path.join(remote.root, 'runs').replace(/\\/g, '/'), secrets: '/tmp/none' }, budgets: { observeOnly: false, perTaskTokens: 50_000, perRunTokens: 1_000_000 } });
  const exec = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .onArgs('docker', ['run'], async (s) => {
      // Every gate passes and leaves a JUnit report in the bind-mounted worktree.
      const wt = s.args[s.args.indexOf('-v') + 1]!.split(':')[0]!;
      await fs.mkdir(path.join(wt, 'reports'), { recursive: true });
      await fs.writeFile(path.join(wt, 'reports', 'junit.xml'), JUNIT);
      return { exitCode: 0 };
    });
  gh.install(exec);
  const ws = { projectId: 'shop', root: path.join(remote.root, 'ws'), repo: remote.repo, worktrees: path.join(remote.root, 'ws', 'wt'), graph: path.join(remote.root, 'ws', 'graph'), knowledgeDb: '', runs: path.join(remote.root, 'runs') };
  return {
    cfg, ws, project, spec, firstSpec: false,
    exec: exec.exec, ghExec: exec.exec,
    runStep: (async (req: StepRequest) => script(req)) as RunDeps['runStep'],
    binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: undefined as never,
    graphify: null, knowledge: null, secrets: {},
    clock: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.now = new Date(clock.now.getTime() + ms); },
    log: () => {},
    ...over,
  };
}
async function withAgents(d: RunDeps): Promise<RunDeps> {
  return { ...d, agents: await loadAgents(path.resolve('.claude/agents')) };
}

describe('Run', () => {
  it('runs two independent tasks in parallel to merged and finishes complete', async () => {
    const run = await Run.create(await withAgents(deps(happy)));
    expect(await run.execute()).toBe('complete');
    const s = run.journal.state;
    expect([...s.tasks.values()].map((t) => t.state)).toEqual(['merged', 'merged']);
    expect(gh.prs.map((p) => p.state)).toEqual(['MERGED', 'MERGED']);
    expect(run.journal.events.at(-1)!.type).toBe(OrchEvent.RunFinished);
    expect(run.journal.events.at(-1)!.data).toMatchObject({ result: 'complete', merged: ['T1', 'T2'], blocked: [] });
    await git(remote.repo, ['fetch', '-q', 'origin']);
    expect(await git(remote.repo, ['ls-tree', '--name-only', 'origin/main', 'src/'])).toContain('src/a');
    expect(run.accounting.records().length).toBeGreaterThanOrEqual(4);
    await run.close();
  });

  it('pauses after the in-flight step returns and resumes without re-running it', async () => {
    let devCalls = 0;
    const script: Script = async (req) => {
      if (req.kind === 'dev' && devCalls++ === 0) {
        return { ok: false, failure: 'quota', errors: ['usage limit'], summary: summary({ isError: true, rateLimit: { status: 'rejected', resetsAt: Math.floor(clock.now.getTime() / 1000) + 600, fiveHourUtilization: 1, fiveHourResetsAt: 0, sevenDayUtilization: 0, sevenDayResetsAt: 0 } }), sandboxDisabled: false };
      }
      return happy(req);
    };
    const run = await Run.create(await withAgents(deps(script)));
    expect(await run.execute()).toBe('complete');
    const types = run.journal.events.map((e) => e.type);
    expect(types).toContain('RUN_PAUSED');
    expect(types).toContain('RUN_RESUMED');
    expect(types.indexOf('RUN_PAUSED')).toBeGreaterThan(types.indexOf(OrchEvent.StepFinished));
    expect(sleeps.length).toBeGreaterThan(0);
    expect(run.journal.events.filter((e) => e.type === OrchEvent.StepStarted && e.data.kind === 'dev' && e.data.taskId === 'T1')).toHaveLength(2);
    expect(run.journal.state.tasks.get('T1')!.attempts).toBe(0);
    await run.close();
  });

  it('drains when the run budget is spent: in-flight tasks finish, nothing new starts', async () => {
    const d = await withAgents(deps(happy, { maxParallel: 1 }));
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), budgets: { observeOnly: false, perTaskTokens: 50_000, perRunTokens: 2_500 } });
    const run = await Run.create(d);
    expect(await run.execute()).toBe('drained');
    const states = [...run.journal.state.tasks.values()].map((t) => t.state);
    expect(states).toContain('merged');
    expect(states).toContain('planned');
    expect(run.journal.events.map((e) => e.type)).toContain('RUN_BUDGET_EXHAUSTED');
    await run.close();
  });

  it('charges a task over its budget with a failed attempt', async () => {
    const d = await withAgents(deps(async (req) => (req.kind === 'dev' ? { ...(await happy(req)), summary: summary({ usage: { inputTokens: 60_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }) } : happy(req)), { maxParallel: 1 }));
    const run = await Run.create(d);
    await run.execute();
    expect(run.journal.events.some((e) => e.type === 'ATTEMPT_CONSUMED')).toBe(true);
    expect(run.journal.events.filter((e) => e.type === OrchEvent.Feedback).some((e) => String(e.data.text).includes('budget'))).toBe(true);
    await run.close();
  });

  it('blocks a task that spends its attempts and reports it', async () => {
    const script: Script = async (req) => (req.kind === 'review' ? { ok: true, value: { specHash: HASH, decision: 'changes', criteria: [{ id: 'AC-001', status: 'failed', evidence: [] }], findings: [{ file: 'src/a/index.ts', line: 1, severity: 'major', text: 'wrong', acIds: ['AC-001'] }] }, summary: summary() } : req.kind === 'replan' ? { ok: false, failure: 'code', errors: ['no'], summary: summary({ isError: true }), sandboxDisabled: false } : happy(req));
    const run = await Run.create(await withAgents(deps(script)));
    expect(await run.execute()).toBe('blocked');
    expect(run.journal.events.at(-1)!.data).toMatchObject({ result: 'blocked', blocked: [expect.objectContaining({ taskId: 'T1' }), expect.objectContaining({ taskId: 'T2' })] });
    await run.close();
  });

  it('journals every decision with its backend and cost', async () => {
    const d = await withAgents(deps(happy));
    d.cfg = loadConfig({ ...JSON.parse(JSON.stringify(d.cfg)), decisions: { enabled: true } });
    d.exec = new FakeExec()
      .on((s) => s.bin === 'git', (s) => execCommand(s))
      .onArgs('docker', ['run'], async () => ({ exitCode: 1, stderr: 'AssertionError' }))
      .exec;
    gh.install(d.exec as never);
    d.ghExec = d.exec;
    d.fetch = (async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13-20260917', answers: { kind: { type: 'choice', choice: 'code', probabilities: { code: 1, 'flaky-test': 0, infra: 0, environment: 0, dependency: 0 }, confidence: 1 } }, usage: { input_tokens: 300, output_tokens: 20, cost: 0.00001 } }), { status: 200 })) as typeof fetch;
    d.secrets = { OPENROUTER_API_KEY: 'sk-or-v1-' + 'ab'.repeat(32) };
    const run = await Run.create(d);
    await run.execute();
    const made = run.journal.events.filter((e) => e.type === OrchEvent.DecisionMade);
    expect(made.length).toBeGreaterThan(0);
    expect(made[0]!.data.record).toMatchObject({ decisionId: 'gate-triage', backend: 'jev' });
    expect(run.accounting.total({ provider: 'openrouter' }).steps).toBeGreaterThan(0);
    await run.close();
  });

  it('resume after a crash injected on the PR_MERGE intent confirms the merge and finishes', async () => {
    const d = await withAgents(deps(happy, { maxParallel: 1, crashAfterIntent: (id) => id === 'PR_MERGE:task/spec-001-T1' }));
    const run = await Run.create(d);
    await expect(run.execute()).rejects.toBeInstanceOf(CrashInjected);
    const runId = run.runId;
    await run.close();
    // The intent was journaled, the effect never ran: reconcile must see an OPEN PR and let the queue merge it.
    const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, runId);
    expect(await resumed.execute()).toBe('complete');
    expect(gh.prs.filter((p) => p.head === 'task/spec-001-T1')).toHaveLength(1);
    expect(resumed.journal.events.filter((e) => e.type === OrchEvent.PrMerged && e.data.taskId === 'T1')).toHaveLength(1);
    await resumed.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/orchestrator/run.test.ts test/orchestrator/task-runner.test.ts`
Expected: run.test FAILS to resolve `../../server/orchestrator/run.js`; the new task-runner test FAILS with `r.budgetExceeded is not a function`.

- [ ] **Step 3: Add `budgetExceeded` to the task runner**

In `server/orchestrator/task-runner.ts`, add after `advance()`:
```ts
  /** Spec §7: a task over its token budget fails the attempt (retry policy `budget`); observe-only runs never call this. */
  budgetExceeded(tokens: number, cap: number): Promise<void> {
    return this.fail('budget', `Task budget exceeded: ${tokens} tokens used across attempts, cap ${cap}`);
  }
```

- [ ] **Step 4: Implement run.ts**

`server/orchestrator/run.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agents/registry.js';
import type { OutputOf, StepKind } from '../agents/outputs.js';
import { Accounting } from '../budget/accounting.js';
import { Governor } from '../budget/governor.js';
import { DEFAULT_BREAKER, QuotaBreaker } from '../budget/quota-breaker.js';
import { resolveProfile, type Config, type Role } from '../config/config.js';
import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { createDecider } from '../decide/create-decider.js';
import type { Exec } from '../exec/command.js';
import { runGates } from '../exec/gate-runner.js';
import { git } from '../git/git.js';
import { MergeQueue } from '../git/merge-queue.js';
import type { CodeContext, HandoffSummary } from '../knowledge/context-pack.js';
import { grepFallback, MIN_COVERAGE, type Graphify } from '../knowledge/graphify.js';
import type { KnowledgeIndex } from '../knowledge/retrieval.js';
import { RunEvent } from '../pipeline/run-state.js';
import { ACTIVE_STATES } from '../pipeline/task-state.js';
import type { RunnerBinary } from '../runner/process-runner.js';
import type { runStep as runStepFn, StepDeps, StepOutcome } from '../runner/step.js';
import { nextRunnable, runProgress, tasksToBlock, type RunProgress } from '../scheduler/scheduler.js';
import { DEFAULT_POLICY } from '../scheduler/retry-policy.js';
import { Intent, Journal, OrchEvent, type IntentType, type RunResult } from './events.js';
import { taskMergeSteps, type MergeStepsDeps } from './merge-steps.js';
import { runPhase1, runPhase2, type PhaseDeps } from './phases/index.js';
import { reconcile } from './reconcile.js';
import { runAgentStep, type AgentStepDeps, type AgentStepRequest, type PackBase } from './steps.js';
import { TaskRunner, type TaskRunnerDeps } from './task-runner.js';
import { eventsFile, expandHome, graphDir, nextRunId, runDir, stateFile, stepDir, type Workspace } from './workspace.js';

export interface RunDeps {
  cfg: Config;
  ws: Workspace;
  project: Project;
  spec: Spec;
  firstSpec: boolean;
  exec: Exec;
  ghExec: Exec;
  runStep: typeof runStepFn;
  binary: RunnerBinary;
  agents: Record<Role, AgentDefinition>;
  graphify: Graphify | null;
  knowledge: KnowledgeIndex | null;
  secrets: Record<string, string>;
  fetch?: typeof fetch;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Test hook: the journal throws CrashInjected right after appending a matching intent. */
  crashAfterIntent?: (intentId: string) => boolean;
  maxParallel?: number;
}

export type ExecuteResult = RunResult | 'paused:auth';

export class CrashInjected extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spec (orchestrator) §2.2: one tick loop, runners return through the journal. */
export class Run {
  readonly accounting = new Accounting();
  private readonly governor: Governor;
  private readonly breaker: QuotaBreaker;
  private readonly mergeQueue = new MergeQueue();
  private readonly handoffs: HandoffSummary[] = [];
  private readonly clock: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly maxParallel: number;
  private plan: Plan | null = null;
  private techSpecText = '';
  private adrs: Array<{ id: string; title: string; text: string }> = [];
  private readonly runners = new Map<string, TaskRunner>();
  private readonly inflight = new Map<string, Promise<void>>();

  private constructor(
    readonly runId: string,
    readonly journal: Journal,
    private readonly deps: RunDeps,
  ) {
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
    this.maxParallel = deps.maxParallel ?? deps.cfg.concurrency.maxParallel;
    this.governor = new Governor(deps.cfg.concurrency.maxClaudeProcesses);
    this.breaker = new QuotaBreaker(DEFAULT_BREAKER, this.clock);
  }

  private static async openJournal(deps: RunDeps, runId: string): Promise<Journal> {
    const journal = await Journal.open({ file: eventsFile(deps.ws, runId), runId, specHash: deps.spec.specHash!, clock: deps.clock });
    if (deps.crashAfterIntent) {
      const hook = deps.crashAfterIntent;
      const original = journal.intent.bind(journal);
      journal.intent = (async (type: IntentType, key: string, data?: Record<string, unknown>) => {
        const stored = await original(type, key, data);
        if (hook(stored.intentId!)) throw new CrashInjected(`crash injected after ${stored.intentId}`);
        return stored;
      }) as Journal['intent'];
    }
    return journal;
  }

  static async create(deps: RunDeps): Promise<Run> {
    const runId = await nextRunId(deps.ws, deps.spec.specId);
    await fs.mkdir(runDir(deps.ws, runId), { recursive: true });
    const journal = await Run.openJournal(deps, runId);
    await journal.fact(OrchEvent.RunStarted, { runId, specId: deps.spec.specId, projectId: deps.project.projectId });
    return new Run(runId, journal, deps);
  }

  static async resume(deps: RunDeps, runId: string): Promise<Run> {
    const journal = await Run.openJournal(deps, runId);
    const run = new Run(runId, journal, deps);
    await reconcile({ journal, ws: deps.ws, exec: deps.exec, ghExec: deps.ghExec, afterMerge: (taskId, branch) => run.afterMergeOnResume(taskId, branch), log: run.log });
    return run;
  }

  private async afterMergeOnResume(taskId: string, branch: string): Promise<void> {
    const plan = this.plan ?? (await this.loadPlan());
    const task = plan?.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const steps = taskMergeSteps(this.mergeDeps(), task, this.worktreeOf(branch), branch, this.deps.spec, `resumed ${taskId}`);
    await steps.afterMerge?.();
  }

  private worktreeOf(branch: string): string {
    return path.posix.join(this.deps.ws.worktrees, branch.replace(/\//g, '__'));
  }

  private async loadPlan(): Promise<Plan | null> {
    const { readDocs } = await import('./phases/shared.js');
    return (await readDocs(this.deps.ws.repo, this.deps.spec.specId, this.deps.exec)).plan;
  }

  private stepDeps(): StepDeps {
    const { cfg, ws } = this.deps;
    return {
      binary: this.deps.binary,
      caps: cfg.budgets.step,
      accounting: this.accounting,
      claudeJsonPath: expandHome('~/.claude.json'),
      settingsDir: path.posix.join(runDir(ws, this.runId), 'settings'),
      workspacesRoot: ws.root,
      network: { allowedDomains: ['registry.npmjs.org', ...(cfg.omniroute.enabled ? ['localhost'] : [])] },
      clock: this.clock,
    };
  }

  private agentDeps(): AgentStepDeps {
    const { cfg, project, secrets } = this.deps;
    return {
      runStep: this.deps.runStep,
      stepDeps: this.stepDeps(),
      agents: this.deps.agents,
      profile: (role) => resolveProfile(cfg, role, project),
      omniroute: cfg.omniroute.enabled ? { baseUrl: cfg.omniroute.baseUrl, token: secrets.OMNIROUTE_TOKEN ?? '' } : undefined,
      governor: this.governor,
      breaker: this.breaker,
      journal: this.journal,
      stepDir: (seq) => stepDir(this.deps.ws, this.runId, seq),
      secretValues: () => Object.values(secrets),
      specHash: this.deps.spec.specHash!,
    };
  }

  private runAgent = <K extends StepKind>(req: AgentStepRequest<K>): Promise<StepOutcome<OutputOf<K>>> => runAgentStep(req, this.agentDeps());

  private gates = async (worktree: string, branch: string) => {
    const plan = this.plan!;
    return runGates(
      plan.gates.filter((g) => g.blocking),
      { worktree, image: plan.gateImage, junitPath: plan.junitPath, cpus: 2, memory: '2g', timeoutMs: 15 * 60_000, secrets: this.deps.secrets, containerName: `teams-ai-${this.runId}-${branch.replace(/\//g, '__')}` },
      { exec: this.deps.exec, readFile: (p) => fs.readFile(p, 'utf8').catch(() => null), removeFile: (p) => fs.rm(p, { force: true }) },
    );
  };

  private mergeDeps(): MergeStepsDeps {
    return { journal: this.journal, ws: this.deps.ws, exec: this.deps.exec, ghExec: this.deps.ghExec, gates: this.gates, graphify: this.deps.graphify, secretValues: () => Object.values(this.deps.secrets), handoffs: this.handoffs, clock: this.clock };
  }

  private packBase = (): PackBase => ({
    spec: this.deps.spec,
    project: this.deps.project,
    specHash: this.deps.spec.specHash!,
    assumptions: this.journal.assumptions(),
    adrs: this.adrs,
    techSpecExcerpt: this.techSpecText.slice(0, 6000),
    retrieval: this.deps.knowledge?.search(this.deps.spec.objectives.join(' '), { k: 5, specId: this.deps.spec.specId }) ?? [],
    budgetTokens: 12_000,
  });

  private code = async (worktree: string, task: PlanTask): Promise<CodeContext> => {
    const g = this.deps.graphify;
    const terms = [task.title, ...task.affectedPaths].map((t) => t.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 2)).flat().slice(0, 6);
    if (g) {
      const tracked = await g.trackedFiles(this.deps.ws.repo).catch(() => [] as string[]);
      const cov = await g.coverage(graphDir(this.deps.ws, null), tracked).catch(() => null);
      if (cov && cov.coverage >= MIN_COVERAGE) {
        const q = await g.query(graphDir(this.deps.ws, null), `${task.title} ${task.description}`, 2000);
        return { source: 'graph', nodes: q.nodes, truncated: q.truncated };
      }
    }
    return { source: 'grep', grep: await grepFallback(worktree, terms, this.deps.exec) };
  };

  private impact = async (worktree: string, branch: string, changed: readonly string[]): Promise<CodeContext> => {
    const g = this.deps.graphify;
    if (!g || changed.length === 0) return { source: 'none' };
    const out = graphDir(this.deps.ws, branch);
    await g.update(worktree, out).catch(() => undefined);
    const affected = (await Promise.all(changed.map((f) => g.affected(out, f, 2).catch(() => [])))).flat();
    return { source: 'graph', affected };
  };

  private runnerDeps(): TaskRunnerDeps {
    const { cfg, project, spec, secrets } = this.deps;
    const decider = createDecider({
      cfg,
      secrets,
      accounting: this.accounting,
      runEscalation: ({ role, prompt }) => {
        const profile = resolveProfile(cfg, role, project);
        return this.deps.runStep<'decide'>({ kind: 'decide', role, agent: this.deps.agents[role], profile, model: profile.model, cwd: this.deps.ws.repo, prompt, expectedSpecHash: spec.specHash!, phase: 'decide', taskId: null, attempt: 0 }, this.stepDeps());
      },
      fetch: this.deps.fetch,
      onDecision: (record) => {
        void this.journal.fact(OrchEvent.DecisionMade, { record: JSON.parse(JSON.stringify(record)) });
      },
    });
    return {
      journal: this.journal, ws: this.deps.ws, spec, project, plan: this.plan!, specHash: spec.specHash!, firstSpec: this.deps.firstSpec,
      exec: this.deps.exec,
      runAgent: this.runAgent,
      gates: this.gates,
      mergeQueue: this.mergeQueue,
      mergeSteps: (task, worktree, branch) => taskMergeSteps(this.mergeDeps(), task, worktree, branch, spec, this.summaryOf(task.id)),
      code: this.code,
      impact: this.impact,
      decider,
      policy: { ...DEFAULT_POLICY, ...cfg.retry },
      packBase: this.packBase,
      handoffs: () => this.handoffs,
      boundaries: async () => {
        const g = this.deps.graphify;
        if (g) {
          const nodes = await g.godNodes(graphDir(this.deps.ws, null), 10).catch(() => []);
          if (nodes.length > 0) return nodes.map((n) => n.label);
        }
        return (await git(this.deps.ws.repo, ['ls-tree', '--name-only', 'origin/main'], this.deps.exec)).split('\n').filter((l) => l !== '');
      },
    };
  }

  private summaryOf(taskId: string): string {
    const e = [...this.journal.events].reverse().find((ev) => ev.type === OrchEvent.DevCommitted && ev.data.taskId === taskId);
    return e ? String(e.data.summary) : taskId;
  }

  private phaseDeps(): PhaseDeps {
    return {
      journal: this.journal, ws: this.deps.ws, spec: this.deps.spec, project: this.deps.project, specHash: this.deps.spec.specHash!, firstSpec: this.deps.firstSpec, exec: this.deps.exec,
      runAgent: this.runAgent,
      mergeQueue: this.mergeQueue,
      mergeDeps: this.mergeDeps(),
      packBase: this.packBase,
      godNodes: () => (this.deps.graphify ? this.deps.graphify.godNodes(graphDir(this.deps.ws, null), 10).catch(() => []) : Promise.resolve([])),
    };
  }

  private async loadAdrs(): Promise<void> {
    const list = await git(this.deps.ws.repo, ['ls-tree', '--name-only', 'origin/main', 'docs/adr/'], this.deps.exec).catch(() => '');
    this.adrs = [];
    for (const rel of list.split('\n').filter((l) => l.endsWith('.md'))) {
      const text = await git(this.deps.ws.repo, ['show', `origin/main:${rel}`], this.deps.exec).catch(() => '');
      const id = /ADR-\d{3}/.exec(rel)?.[0] ?? rel;
      this.adrs.push({ id, title: text.split('\n')[0]?.replace(/^#\s*/, '') ?? id, text: text.slice(0, 4000) });
    }
  }

  async execute(): Promise<ExecuteResult> {
    const phase1 = await runPhase1(this.phaseDeps());
    if (!phase1.ok) return this.finish('phase-failed', phase1.reason);
    this.techSpecText = phase1.techSpecText ?? '';
    await this.loadAdrs();
    const phase2 = await runPhase2(this.phaseDeps(), this.techSpecText);
    if (!phase2.ok) return this.finish('phase-failed', phase2.reason);
    this.plan = phase2.plan!;
    if (!this.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 3)) await this.journal.fact(OrchEvent.PhaseStarted, { phase: 3 });
    for (const task of this.plan.tasks) {
      const t = this.journal.state.tasks.get(task.id);
      if (t && t.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: task.id, to: 'ready' });
    }
    return this.loop();
  }

  private async loop(): Promise<ExecuteResult> {
    const { cfg } = this.deps;
    for (;;) {
      const state = this.journal.state;
      if (state.status === 'paused:auth') return 'paused:auth';
      if (!this.breaker.canStart()) {
        if (state.status === 'running') await this.journal.fact(RunEvent.RunPaused, { reason: 'quota' });
        const b = this.breaker.state();
        const wait = b.status === 'paused' ? Math.max(1000, b.until.getTime() - this.clock().getTime()) : 60_000;
        this.log(`run paused (quota) for ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
        this.breaker.tick();
        continue;
      }
      if (state.status === 'paused:quota') await this.journal.fact(RunEvent.RunResumed, {});
      if (state.status === 'running' && !cfg.budgets.observeOnly && this.accounting.tokensOf(this.accounting.total()) > cfg.budgets.perRunTokens) {
        await this.journal.fact(RunEvent.RunBudgetExhausted, {});
      }
      for (const id of tasksToBlock(this.journal.state)) {
        const t = this.journal.state.tasks.get(id)!;
        if (t.state !== 'blocked') {
          await this.journal.fact(RunEvent.TaskStateChanged, { taskId: id, to: 'blocked' });
          await this.journal.fact(OrchEvent.TaskBlocked, { taskId: id, reason: 'a dependency is blocked' });
        }
      }
      const progress = runProgress(this.journal.state, this.maxParallel);
      if (progress !== 'running' && this.inflight.size === 0) return this.finish(progress === 'complete' ? 'complete' : progress);
      if (this.journal.state.status === 'running') {
        for (const id of nextRunnable(this.journal.state, this.maxParallel)) {
          if (!this.runners.has(id)) this.runners.set(id, new TaskRunner(id, this.runnerDeps()));
          this.start(id);
        }
        for (const [id, r] of this.runners) if (!r.done && !this.inflight.has(id) && ACTIVE_STATES.has(r.task.state)) this.start(id);
      }
      if (this.inflight.size === 0) {
        if (this.journal.state.status === 'draining') return this.finish('drained');
        return this.finish(progress === 'running' ? 'deadlocked' : progress);
      }
      await Promise.race(this.inflight.values());
      await this.writeState();
    }
  }

  private start(id: string): void {
    if (this.inflight.has(id)) return;
    const runner = this.runners.get(id)!;
    const p = runner
      .advance()
      .then(async () => {
        const cap = this.deps.cfg.budgets.perTaskTokens;
        const tokens = this.accounting.tokensOf(this.accounting.total({ taskId: id }));
        if (tokens > cap && !runner.done) {
          if (this.deps.cfg.budgets.observeOnly) await this.journal.fact(OrchEvent.BudgetExceeded, { taskId: id, tokens, cap });
          else await runner.budgetExceeded(tokens, cap);
        }
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
  }

  private async finish(result: RunProgress | RunResult, reason?: string): Promise<RunResult> {
    const r = result as RunResult;
    const tasks = [...this.journal.state.tasks.values()];
    const blocked = tasks.filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: String([...this.journal.events].reverse().find((e) => e.type === OrchEvent.TaskBlocked && e.data.taskId === t.def.id)?.data.reason ?? reason ?? 'blocked') }));
    await this.journal.fact(OrchEvent.RunFinished, { result: r, reason: reason ?? null, merged: tasks.filter((t) => t.state === 'merged').map((t) => t.def.id), blocked, tokens: this.accounting.total() });
    await this.writeState();
    return r;
  }

  private async writeState(): Promise<void> {
    const s = this.journal.state;
    const snapshot = { runId: this.runId, at: this.clock().toISOString(), status: s.status, tasks: [...s.tasks.values()].map((t) => ({ id: t.def.id, state: t.state, attempts: t.attempts })), tokens: this.accounting.total() };
    await fs.writeFile(stateFile(this.deps.ws, this.runId), JSON.stringify(snapshot, null, 2));
  }

  async close(): Promise<void> {
    await this.journal.close();
  }
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/orchestrator && npm run typecheck`
Expected: all orchestrator tests PASS; typecheck clean. Sharp edges to expect while making it green: `Config.retry` fields map one-to-one onto `PolicyConfig`; `resolveProfile` needs `project.confidential`; the FakeExec docker rule must find the worktree in `-v <worktree>:/work` (the gate runner passes the source with forward slashes); the crash test needs `crashAfterIntent` to match the id `PR_MERGE:task/spec-001-T1` produced by `taskMergeSteps` (key = branch).

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/run.ts server/orchestrator/task-runner.ts test/orchestrator/run.test.ts test/orchestrator/task-runner.test.ts
git commit -m "feat(orchestrator): run loop with phases, quota pause, budgets, decisions and crash resume

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: CLI, fake-claude scenarios and the loop integration test with crash-resume after every intent

**Files:**
- Create: `server/cli.ts`, `test/fixtures/fake-claude/scenario.ts`
- Test: `test/orchestrator/loop.test.ts`, `test/cli.test.ts`
- Modify: `package.json` (`"bin": {"teams-ai": "server/cli.ts"}` is not needed; add script `"teams-ai": "tsx --no-warnings=ExperimentalWarning server/cli.ts"`)

**Interfaces:**
- `server/cli.ts`:
  ```ts
  export interface CliIo { argv: string[]; env: NodeJS.ProcessEnv; stdout: (s: string) => void; stderr: (s: string) => void }
  export async function main(io: CliIo, factory?: (deps: RunDeps) => Promise<Run>): Promise<number>;   // exit code
  export async function loadRunDeps(io: CliIo, projectDir: string, specId: string | undefined): Promise<RunDeps>;  // reads config.json, project.json, spec.json, secrets; builds real exec/ghExec/runStep/graphify/knowledge
  ```
  Commands: `run --project <dir> [--spec <id>] [--max-parallel N] [--dry-run]`, `resume --run <runId> --project <dir>`, `status --run <runId> --project <dir> [--json]`. Exit codes per spec §4.7; `paused:auth` → 2 with the message `run paused: claude auth expired; run "claude auth login" and resume`. `--dry-run` sets `TEAMS_AI_FAKE_SCENARIO` handling: `binary` = node + fake-claude, `runStep` wrapped by the scenario (below). `status` reads `state.json` and prints a table (or JSON).
  Preconditions (spec §4.1) are checked in `loadRunDeps`: `repo/` exists with `origin`, `main` has both docs files, `spec.status === 'running'` and `specHash` set, `claude auth status --json` → `loggedIn`, `gh auth status` exit 0, `docker version` exit 0. Any failure prints the list and returns 2 before a run is created.
- `test/fixtures/fake-claude/scenario.ts`:
  ```ts
  export interface ScenarioStep { output: unknown; files?: Record<string, string>; failure?: { stderr: string; exitCode: number } }
  export class Scenario {
    constructor(readonly dir: string);
    set(kind: StepKind, taskId: string | null, attempt: number, step: ScenarioStep): this;
    /** Wraps a real runStep: applies `files` into req.cwd, points the fake claude at the fixture for (kind, taskId, attempt). */
    wrap(real: typeof runStep): typeof runStep;
    static fixtureLines(structuredOutput: unknown, usage?: { input: number; output: number }): string[];   // system init + result lines in the CLI 2.1.281 stream-json shape
  }
  ```
  `fixtureLines` produces two lines: `{"type":"system","subtype":"init","session_id":"fake","model":"fake","tools":["StructuredOutput"],"mcp_servers":[],"permissionMode":"dontAsk"}` and a `result` line with `subtype:"success"`, `is_error:false`, `num_turns:1`, `duration_ms:5`, `total_cost_usd:0.001`, `usage:{input_tokens, output_tokens, cache_creation_input_tokens:0, cache_read_input_tokens:0}`, `terminal_reason:"completed"`, `api_error_status:null`, `result: JSON.stringify(structuredOutput)`, `structured_output: structuredOutput`. `wrap` copies `deps.binary` with `env.FAKE_CLAUDE_FIXTURE` set to the fixture written for the key; a missing key throws `Scenario: no step for <kind>/<taskId>/<attempt>`.

- [ ] **Step 1: Write the scenario fixture**

`test/fixtures/fake-claude/scenario.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StepKind } from '../../../server/agents/outputs.js';
import type { runStep as runStepFn, StepDeps, StepRequest } from '../../../server/runner/step.js';

export interface ScenarioStep {
  output: unknown;
  files?: Record<string, string>;
  failure?: { stderr: string; exitCode: number };
}

const key = (kind: string, taskId: string | null, attempt: number) => `${kind}/${taskId ?? '-'}/${attempt}`;

/** Scripted fake-claude outputs per (kind, taskId, attempt); the wrapper applies file side effects the real Dev would make. */
export class Scenario {
  private readonly steps = new Map<string, ScenarioStep>();
  readonly seen: string[] = [];

  constructor(readonly dir: string) {}

  set(kind: StepKind, taskId: string | null, attempt: number, step: ScenarioStep): this {
    this.steps.set(key(kind, taskId, attempt), step);
    return this;
  }

  static fixtureLines(structuredOutput: unknown, usage = { input: 500, output: 40 }): string[] {
    const init = { type: 'system', subtype: 'init', session_id: 'fake', model: 'fake', tools: ['StructuredOutput'], mcp_servers: [], permissionMode: 'dontAsk' };
    const result = {
      type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0.001,
      usage: { input_tokens: usage.input, output_tokens: usage.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      terminal_reason: 'completed', api_error_status: null, session_id: 'fake',
      result: JSON.stringify(structuredOutput), structured_output: structuredOutput,
    };
    return [JSON.stringify(init), JSON.stringify(result)];
  }

  wrap(real: typeof runStepFn): typeof runStepFn {
    return (async (req: StepRequest, deps: StepDeps) => {
      const k = key(req.kind, req.taskId, req.attempt);
      this.seen.push(k);
      const step = this.steps.get(k);
      if (!step) throw new Error(`Scenario: no step for ${k}`);
      for (const [rel, text] of Object.entries(step.files ?? {})) {
        await fs.mkdir(path.dirname(path.join(req.cwd, rel)), { recursive: true });
        await fs.writeFile(path.join(req.cwd, rel), text);
      }
      const fixture = path.join(this.dir, `${k.replace(/[^a-zA-Z0-9]+/g, '_')}.ndjson`);
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(fixture, `${Scenario.fixtureLines(step.output).join('\n')}\n`);
      const env: Record<string, string> = { ...deps.binary.env, FAKE_CLAUDE_FIXTURE: fixture };
      if (step.failure) {
        env.FAKE_CLAUDE_STDERR = step.failure.stderr;
        env.FAKE_CLAUDE_EXIT_CODE = String(step.failure.exitCode);
      }
      return real(req, { ...deps, binary: { ...deps.binary, env } });
    }) as typeof runStepFn;
  }
}
```

- [ ] **Step 2: Write the failing loop test**

`test/orchestrator/loop.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { CrashInjected, Run, type RunDeps } from '../../server/orchestrator/run.js';
import { runStep } from '../../server/runner/step.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { Scenario } from '../fixtures/fake-claude/scenario.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const FAKE = path.resolve('test/fixtures/fake-claude/fake-claude.mjs');
const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec, { tasks: [makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src/a'] }), makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['src/b'], dependsOn: ['T1'] })] });
const JUNIT = `<testsuite name="sum"><testcase classname="sum" name="[AC-001] adds"/></testsuite>`;

let remote: Remote;
let gh: FakeGh;
beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  gh = new FakeGh();
});
afterEach(async () => {
  await remote.cleanup();
});

function happyScenario(dir: string): Scenario {
  const s = new Scenario(dir);
  s.set('tech-spec', null, 1, { output: { specHash: HASH, techSpecPath: 'docs/specs/spec-001/tech-spec.md', adrs: [], stack: 'node', summary: 'ts' }, files: { 'docs/specs/spec-001/tech-spec.md': '# Tech spec\n\n## AC-001\nsum' } });
  s.set('coverage', null, 1, { output: { specHash: HASH, coverage: spec.acceptanceCriteria.map((c) => ({ acId: c.id, section: 'AC-001', covered: true, note: '' })) } });
  s.set('plan', null, 1, { output: plan });
  for (const id of ['T1', 'T2']) {
    const d = id === 'T1' ? 'a' : 'b';
    s.set('dev', id, 1, { output: { specHash: HASH, status: 'done', summary: `did ${id}`, changedFiles: [`src/${d}/index.ts`], commitMessage: `feat: ${id}` }, files: { [`src/${d}/index.ts`]: `export const ${id} = 1;\n` } });
    s.set('review', id, 1, { output: { specHash: HASH, decision: 'approve', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }], findings: [] } });
  }
  return s;
}

function deps(scenario: Scenario, over: Partial<RunDeps> = {}): RunDeps {
  const exec = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .onArgs('docker', ['run'], async (s) => {
      const wt = s.args[s.args.indexOf('-v') + 1]!.split(':')[0]!;
      await fs.mkdir(path.join(wt, 'reports'), { recursive: true });
      await fs.writeFile(path.join(wt, 'reports', 'junit.xml'), JUNIT);
      return { exitCode: 0 };
    });
  gh.install(exec);
  const root = path.join(remote.root, 'ws');
  return {
    cfg: loadConfig({ paths: { workspaces: root.replace(/\\/g, '/'), runs: path.join(remote.root, 'runs').replace(/\\/g, '/'), secrets: '/tmp/none' } }),
    ws: { projectId: 'shop', root, repo: remote.repo, worktrees: path.join(root, 'wt'), graph: path.join(root, 'graph'), knowledgeDb: '', runs: path.join(remote.root, 'runs') },
    project, spec, firstSpec: true,
    exec: exec.exec, ghExec: exec.exec,
    runStep: scenario.wrap(runStep),
    binary: { bin: process.execPath, prefixArgs: [FAKE], env: {}, requireSandboxTools: false },
    agents: undefined as never,
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
    maxParallel: 1,
    ...over,
  };
}

describe('orchestrator loop with the fake claude', () => {
  it('goes from a frozen spec to every task merged', async () => {
    const scenario = happyScenario(path.join(remote.root, 'scn'));
    const d = { ...deps(scenario), agents: await loadAgents(path.resolve('.claude/agents')) };
    const run = await Run.create(d);
    expect(await run.execute()).toBe('complete');
    await run.close();
    await git(remote.repo, ['fetch', '-q', 'origin']);
    const tree = await git(remote.repo, ['ls-tree', '-r', '--name-only', 'origin/main']);
    expect(tree).toContain('docs/specs/spec-001/tech-spec.md');
    expect(tree).toContain('docs/specs/spec-001/plan.json');
    expect(tree).toContain('src/a/index.ts');
    expect(tree).toContain('src/b/index.ts');
    expect(gh.prs.map((p) => p.title)).toEqual(['docs(spec-001): technical spec', 'docs(spec-001): plan', 'T1: Task T1', 'T2: Task T2']);
    expect(scenario.seen).toEqual(['tech-spec/-/1', 'coverage/-/1', 'plan/-/1', 'dev/T1/1', 'review/T1/1', 'dev/T2/1', 'review/T2/1']);
  });

  it('survives a crash after every intent and never duplicates a commit, PR or merge', { timeout: 120_000 }, async () => {
    // First, a clean run to learn the intent ids in order.
    const probe = happyScenario(path.join(remote.root, 'scn-probe'));
    const d0 = { ...deps(probe), agents: await loadAgents(path.resolve('.claude/agents')) };
    const clean = await Run.create(d0);
    await clean.execute();
    const intents = clean.journal.events.filter((e) => e.kind === 'intent').map((e) => e.intentId!);
    await clean.close();
    await remote.cleanup();
    expect(intents.length).toBeGreaterThan(10);

    for (const target of intents) {
      remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
      gh = new FakeGh();
      const scenario = happyScenario(path.join(remote.root, 'scn'));
      const d = { ...deps(scenario, { crashAfterIntent: (id) => id === target }), agents: await loadAgents(path.resolve('.claude/agents')) };
      const first = await Run.create(d);
      await expect(first.execute()).rejects.toBeInstanceOf(CrashInjected);
      await first.close();
      const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, first.runId);
      expect(await resumed.execute(), `crash after ${target}`).toBe('complete');
      const commits = await git(remote.repo, ['rev-list', '--count', 'origin/main']).then(Number);
      expect(commits, `commit count after ${target}`).toBe(1 + 4);
      expect(gh.prs.length, `pr count after ${target}`).toBe(4);
      expect(gh.prs.every((p) => p.state === 'MERGED'), `all merged after ${target}`).toBe(true);
      expect(resumed.journal.events.filter((e) => e.type === 'RUN_FINISHED'), `one finish after ${target}`).toHaveLength(1);
      await resumed.close();
      await remote.cleanup();
    }
    remote = await makeRemote({});
  });
});
```
Note on the commit count: `main` receives one squash-merge per PR (4) on top of the initial docs commit, because the fake gh pushes the branch head onto `main`. A crash between `COMMIT` intent and confirm re-runs the Dev step on a worktree that already has the commit; `commitAll` then returns `null` (nothing staged) and the runner falls back to `HEAD`, so no second commit appears.

- [ ] **Step 3: Write the failing CLI test**

`test/cli.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { main } from '../server/cli.js';

const io = (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { argv, env: {}, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out, err };
};

describe('teams-ai cli', () => {
  it('prints usage and exits 2 on an unknown command or missing flags', async () => {
    const a = io(['nope']);
    expect(await main(a.io)).toBe(2);
    expect(a.err.join('\n')).toContain('Usage');
    const b = io(['run']);
    expect(await main(b.io)).toBe(2);
    expect(b.err.join('\n')).toContain('--project');
  });

  it('maps run results to exit codes', async () => {
    const results = ['complete', 'blocked', 'deadlocked', 'phase-failed', 'drained', 'paused:auth'] as const;
    const codes: number[] = [];
    for (const r of results) {
      const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001']);
      codes.push(await main(a.io, async () => ({ execute: async () => r, close: async () => {}, runId: 'spec-001-r1', journal: { state: { tasks: new Map() } }, accounting: { total: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }) } }) as never));
    }
    expect(codes).toEqual([0, 2, 2, 2, 3, 2]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/orchestrator/loop.test.ts test/cli.test.ts`
Expected: loop.test FAILS to resolve `../fixtures/fake-claude/scenario.js` until Step 1 is saved, then passes or fails on behavior; cli.test FAILS to resolve `../server/cli.js`.

- [ ] **Step 5: Implement the CLI**

`server/cli.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgents } from './agents/registry.js';
import { loadConfig, type Config } from './config/config.js';
import { Project } from './contracts/project.js';
import { Spec } from './contracts/spec.js';
import { loadSecrets } from './core/secrets.js';
import { execCommand, type Exec } from './exec/command.js';
import { Graphify } from './knowledge/graphify.js';
import { KnowledgeIndex } from './knowledge/retrieval.js';
import { Run, type ExecuteResult, type RunDeps } from './orchestrator/run.js';
import { expandHome, stateFile, workspacePaths } from './orchestrator/workspace.js';
import { runStep } from './runner/step.js';

export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const USAGE = `Usage:
  teams-ai run    --project <dir> [--spec <id>] [--max-parallel N] [--dry-run]
  teams-ai resume --project <dir> --run <runId>
  teams-ai status --project <dir> --run <runId> [--json]`;

function flags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

export function exitCode(result: ExecuteResult): number {
  if (result === 'complete') return 0;
  if (result === 'drained') return 3;
  return 2;
}

async function readJson<T>(file: string, parse: (v: unknown) => T): Promise<T> {
  return parse(JSON.parse(await fs.readFile(file, 'utf8')));
}

async function preconditions(exec: Exec, repo: string, specId: string): Promise<string[]> {
  const errors: string[] = [];
  const check = async (label: string, spec: Parameters<Exec>[0], test?: (stdout: string) => boolean) => {
    const r = await exec(spec).catch(() => null);
    if (!r || r.exitCode !== 0 || (test && !test(r.stdout))) errors.push(label);
  };
  await check('repo/ is not a git clone with origin', { bin: 'git', args: ['-C', repo, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'], timeoutMs: 60_000 });
  await check('main lacks docs/project.json', { bin: 'git', args: ['-C', repo, 'cat-file', '-e', 'origin/main:docs/project.json'], timeoutMs: 10_000 });
  await check(`main lacks docs/specs/${specId}/spec.json`, { bin: 'git', args: ['-C', repo, 'cat-file', '-e', `origin/main:docs/specs/${specId}/spec.json`], timeoutMs: 10_000 });
  await check('claude is not logged in', { bin: 'claude', args: ['auth', 'status', '--json'], timeoutMs: 30_000 }, (out) => /"loggedIn":\s*true/.test(out));
  await check('gh is not logged in', { bin: 'gh', args: ['auth', 'status'], timeoutMs: 30_000 });
  await check('docker daemon is not reachable', { bin: 'docker', args: ['version'], timeoutMs: 30_000 });
  return errors;
}

export async function loadRunDeps(io: CliIo, projectDir: string, specIdArg: string | undefined, opts: { dryRun: boolean; maxParallel?: number }): Promise<RunDeps> {
  const cfgFile = path.join(expandHome('~/.teams-ai'), 'config.json');
  const cfg: Config = loadConfig(await fs.readFile(cfgFile, 'utf8').then(JSON.parse).catch(() => ({})));
  const project = await readJson(path.join(projectDir, 'docs', 'project.json'), (v) => Project.parse(v));
  const specId = specIdArg ?? (await fs.readdir(path.join(projectDir, 'docs', 'specs'))).sort().at(-1);
  if (!specId) throw new Error('no spec found under docs/specs and no --spec given');
  const spec = await readJson(path.join(projectDir, 'docs', 'specs', specId, 'spec.json'), (v) => Spec.parse(v));
  if (spec.status !== 'running' || !spec.specHash) throw new Error(`spec ${specId} is not frozen (status ${spec.status}); finish Gate 1 first`);
  const ws = workspacePaths(cfg, project.projectId);
  const secrets = await loadSecrets(expandHome(cfg.paths.secrets));
  const exec = execCommand;
  const ghExec: Exec = (s) => execCommand({ ...s, env: { ...(s.env ?? {}), ...(secrets.GITHUB_TOKEN ? { GH_TOKEN: secrets.GITHUB_TOKEN } : {}) } });
  const errors = await preconditions(exec, ws.repo, specId);
  if (errors.length > 0) throw new Error(`preconditions failed:\n- ${errors.join('\n- ')}`);
  const agents = await loadAgents(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.claude', 'agents'));
  const graphify = new Graphify({ exec, readFile: (p) => fs.readFile(p, 'utf8').catch(() => null) });
  const knowledge = KnowledgeIndex.open(ws.knowledgeDb);
  const firstSpec = (await fs.readdir(path.join(projectDir, 'docs', 'specs'))).length === 1;
  let binary: RunDeps['binary'] = { bin: io.env.CLAUDE_BIN ?? 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' };
  let step = runStep;
  if (opts.dryRun) {
    const { Scenario } = await import('../test/fixtures/fake-claude/scenario.js');
    const scenario = new Scenario(path.join(os.tmpdir(), 'teams-ai-dry-run'));
    binary = { bin: process.execPath, prefixArgs: [path.resolve('test/fixtures/fake-claude/fake-claude.mjs')], env: {}, requireSandboxTools: false };
    step = scenario.wrap(runStep);
    io.stderr('dry run: every agent step answers from the fake claude scenario (set steps in code before use)');
  }
  return { cfg, ws, project, spec, firstSpec, exec, ghExec, runStep: step, binary, agents, graphify, knowledge, secrets, log: io.stderr, maxParallel: opts.maxParallel };
}

export async function main(io: CliIo, factory: (deps: RunDeps, runId?: string) => Promise<Run> = (deps, runId) => (runId ? Run.resume(deps, runId) : Run.create(deps))): Promise<number> {
  const [command, ...rest] = io.argv;
  const f = flags(rest);
  const projectDir = typeof f.project === 'string' ? f.project : null;
  if (!command || !['run', 'resume', 'status'].includes(command) || !projectDir) {
    io.stderr(USAGE);
    if (command && !projectDir) io.stderr('--project <dir> is required');
    return 2;
  }
  try {
    if (command === 'status') {
      const cfg = loadConfig({});
      const project = await readJson(path.join(projectDir, 'docs', 'project.json'), (v) => Project.parse(v));
      const file = stateFile(workspacePaths(cfg, project.projectId), String(f.run));
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as { status: string; tasks: Array<{ id: string; state: string; attempts: number }>; tokens: Record<string, number> };
      if (f.json) io.stdout(JSON.stringify(state, null, 2));
      else {
        io.stdout(`run ${String(f.run)}: ${state.status}`);
        for (const t of state.tasks) io.stdout(`  ${t.id.padEnd(16)} ${t.state.padEnd(13)} attempts=${t.attempts}`);
        io.stdout(`tokens: in=${state.tokens.inputTokens} out=${state.tokens.outputTokens} cost=$${state.tokens.costUsd}`);
      }
      return 0;
    }
    const deps = await loadRunDeps(io, projectDir, typeof f.spec === 'string' ? f.spec : undefined, { dryRun: f['dry-run'] === true, maxParallel: typeof f['max-parallel'] === 'string' ? Number(f['max-parallel']) : undefined });
    const run = await factory(deps, command === 'resume' ? String(f.run) : undefined);
    io.stderr(`run ${run.runId} started`);
    const result = await run.execute();
    await run.close();
    if (result === 'paused:auth') io.stderr('run paused: claude auth expired; run "claude auth login" and resume');
    else io.stderr(`run ${run.runId} finished: ${result}`);
    return exitCode(result);
  } catch (err) {
    io.stderr((err as Error).message);
    return 2;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main({ argv: process.argv.slice(2), env: process.env, stdout: (s) => process.stdout.write(`${s}\n`), stderr: (s) => process.stderr.write(`${s}\n`) }).then((code) => process.exit(code));
}
```
The CLI test passes a `factory` that ignores `deps`; `loadRunDeps` is still called first in `main`, so make the test's `/tmp/p` path fail fast is not what we want. Guard: in `main`, when a custom `factory` is supplied by a test, `loadRunDeps` errors would return 2 for every result. To keep the exit-code test honest, `main` calls `loadRunDeps` only when `factory` is the default: `const deps = factory === defaultFactory ? await loadRunDeps(…) : ({} as RunDeps)`. Implement with a module-level `const defaultFactory = …` and `factory = defaultFactory` as the parameter default.

Add to `package.json` scripts: `"teams-ai": "tsx --no-warnings=ExperimentalWarning server/cli.ts"`.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `npx vitest run test/orchestrator/loop.test.ts test/cli.test.ts && npm run typecheck && npm test`
Expected: PASS; the crash-resume test iterates every intent of the happy run (≈ 20 resumes, well under its 120 s timeout); typecheck clean; whole suite green. `tsconfig.include` already covers `server` and `test`; the dynamic import of the scenario from `server/cli.ts` is fine for `tsc` because `test` is included.

- [ ] **Step 7: Commit**

```bash
git add server/cli.ts package.json test/fixtures/fake-claude/scenario.ts test/orchestrator/loop.test.ts test/cli.test.ts
git commit -m "feat(cli): teams-ai run/resume/status and the fake-claude loop with crash-resume coverage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Manual end-to-end on hello-app and findings

**Files:**
- Create: `scripts/integration/orchestrator.ts`, `test/fixtures/hello-app/docs/project.json`, `test/fixtures/hello-app/docs/specs/hello-001/spec.json`
- Modify: this plan (append `## Findings`)

- [ ] **Step 1: Write the hello-app contracts**

`test/fixtures/hello-app/docs/project.json`:
```json
{
  "projectId": "hello-app",
  "name": "Hello app",
  "vision": "A tiny HTTP service that greets by name, used to exercise the orchestrator end to end.",
  "personas": [{ "name": "Tester", "description": "Runs the service locally and calls it with curl." }],
  "constraints": ["Node 22, no framework, no database", "Every endpoint answers JSON"],
  "stack": "node",
  "principles": ["Small commits", "Tests carry their acceptance criterion id", "No secrets in the repository"],
  "deploy": { "target": "docker-local" },
  "github": {},
  "confidential": false
}
```

`test/fixtures/hello-app/docs/specs/hello-001/spec.json` (freeze it with `computeSpecHash` before use; the script does it when `specHash` is `null`):
```json
{
  "specId": "hello-001",
  "specVersion": 1,
  "specHash": null,
  "objectives": ["Greet a caller by name over HTTP"],
  "features": ["GET /hello?name=X returns {\"message\":\"Hello, X\"}", "GET /health returns {\"ok\":true}"],
  "acceptanceCriteria": [
    { "id": "AC-001", "given": "the service is running", "when": "GET /hello?name=Ada is called", "then": "the body is {\"message\":\"Hello, Ada\"} with status 200", "smoke": true },
    { "id": "AC-002", "given": "the service is running", "when": "GET /hello is called without name", "then": "status 400 and {\"error\":\"name is required\"}", "smoke": false },
    { "id": "AC-003", "given": "the service is running", "when": "GET /health is called", "then": "status 200 and {\"ok\":true}", "smoke": true }
  ],
  "outOfScope": ["Authentication", "Persistence"],
  "externalDependencies": [],
  "status": "running",
  "validationReports": []
}
```

- [ ] **Step 2: Write the script**

`scripts/integration/orchestrator.ts`:
```ts
/**
 * Manual, live: the whole orchestrator on the hello-app fixture with the real claude, Docker and GitHub.
 *   TEAMS_AI_GH_OWNER=<owner> npx tsx --no-warnings=ExperimentalWarning scripts/integration/orchestrator.ts
 * Creates (or reuses) the repository <owner>/teams-ai-hello-app, pushes docs/ to main, then runs Phases 1–3.
 * Costs real tokens (one Opus tech spec, one plan, one Dev + one review per task). Never part of `npm test`.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../server/config/config.js';
import { Spec, computeSpecHash } from '../../server/contracts/spec.js';
import { execCommand } from '../../server/exec/command.js';
import { ensureRepo } from '../../server/git/github.js';
import { git } from '../../server/git/git.js';
import { main } from '../../server/cli.js';
import { workspacePaths } from '../../server/orchestrator/workspace.js';

const owner = process.env.TEAMS_AI_GH_OWNER;
if (!owner) {
  console.error('TEAMS_AI_GH_OWNER is required');
  process.exit(2);
}
const cfg = loadConfig(JSON.parse(await fs.readFile(path.join(os.homedir(), '.teams-ai', 'config.json'), 'utf8').catch(() => '{}')));
const ws = workspacePaths(cfg, 'hello-app');
const fixture = path.resolve('test/fixtures/hello-app');

await fs.mkdir(ws.root, { recursive: true });
try {
  await fs.access(path.join(ws.repo, '.git'));
} catch {
  await fs.cp(fixture, ws.repo, { recursive: true });
  const specFile = path.join(ws.repo, 'docs', 'specs', 'hello-001', 'spec.json');
  const spec = Spec.parse(JSON.parse(await fs.readFile(specFile, 'utf8')));
  if (!spec.specHash) await fs.writeFile(specFile, `${JSON.stringify({ ...spec, specHash: computeSpecHash(spec) }, null, 2)}\n`);
  await git(ws.repo, ['init', '-b', 'main']);
  await git(ws.repo, ['add', '-A']);
  await git(ws.repo, ['commit', '-q', '-m', 'docs: hello-app contracts']);
  const repo = await ensureRepo({ owner, name: 'teams-ai-hello-app', private: true, cwd: ws.repo }, execCommand);
  console.error(`repository ${repo.fullName} (${repo.created ? 'created' : 'reused'})`);
}

const started = Date.now();
const code = await main({ argv: ['run', '--project', ws.repo, '--spec', 'hello-001'], env: process.env, stdout: (s) => console.log(s), stderr: (s) => console.error(s) });
console.error(`exit ${code} after ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(code);
```

- [ ] **Step 3: Run it once (WSL, real tools)**

Run: `TEAMS_AI_GH_OWNER=<your owner> npx tsx --no-warnings=ExperimentalWarning scripts/integration/orchestrator.ts`
Expected: exit 0; the repository's `main` carries `docs/specs/hello-001/{tech-spec.md,plan.json}` and one squash commit per task; `teams-ai status --project <ws.repo> --run hello-001-r1` shows every task `merged`. If a task blocks, the run still exits cleanly (2) and the events under `~/.teams-ai/runs/hello-001-r1/` say why; fix the cause (usually a prompt or gate detail) and re-run with `resume`.

- [ ] **Step 4: Record findings**

Append to this plan:
```markdown
## Findings (Task 10)

- Date, run id, result, wall time.
- Tokens per role and cost (from `RUN_FINISHED.tokens` and `accounting`), to seed `budgets.step` and `perTaskTokens` (POC spec §8.5 calibration).
- Which of §13's open items held: graphify out dir on a worktree, PR body size, `gh pr merge --squash` on an unprotected repo, `claude auth status` latency after login.
- Any prompt or gate adjustment made to get to green, with the commit that made it.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/integration/orchestrator.ts test/fixtures/hello-app/docs docs/superpowers/plans/2026-09-24-teams-ai-07-orchestrator-phases-1-3.md
git commit -m "test: manual end-to-end orchestrator run on hello-app with findings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** §1.1 outcome and §1.2 criteria → Tasks 9 (fake loop, crash-resume) and 10 (live). §2.1 layout → the File structure above (plus `phases/shared.ts` and `phases/index.ts`, which the spec's list folds into the two phase files). §2.2 tick loop and runner-through-journal → Tasks 1 and 8. §2.3 injected dependencies → `RunDeps`. §3 workspace and run layout → Task 1 (`workspace.ts`), `state.json` and `steps/` → Task 8 and Task 3. §4.1 preconditions → Task 9 `preconditions()`. §4.2/§4.3 → Task 7 (docs through the merge queue with PRs, `TASK_PLANNED` per task, idempotent skip via `readDocs`). §4.4 rows and failure columns → Task 4, each with a test. §4.5 spec gap and its cap → Task 4. §4.6 replan → Task 4 (`ReplanOutput`, `TASK_REPLANNED`). §4.7 terminal states and exit codes → Tasks 8 and 9. §5 events → Task 1 names; every type is emitted by Tasks 3–8 (`MERGE_LOCK_ACQUIRED` is the one exception: `MergeQueue` has no hook for it; the `PUSH` intent marks the same moment. Ruling for the executor: leave it out rather than add a hook to Plan 4's queue). §6 reconcile rows → Task 6, one test each. §7 budgets/governor/breaker → Tasks 3 and 8. §8 decisions wiring → Task 8 (`createDecider`, `DECISION_MADE`, call sites named in comments only). §9 CLI → Task 9. §10 security → sanitized env comes from `runStep` (Plan 3); `GH_TOKEN` only on `ghExec` (Task 9); redaction in Tasks 3 and 5. §11 error rows → Tasks 4, 7, 8, 9. §12 testing → Tasks 1–9 as listed; §13 open items → Task 10 findings.

**Placeholders.** None: every code step is complete; the only "adjust if" notes are about `tsc` generics and excess properties, with the exact edit given.

**Type consistency.** `Journal.intent/confirm(type: IntentType, key: string, data?)` is used the same way in Tasks 4, 5, 6, 7 and 8. `AgentStepRequest`/`runAgent` signature is identical in `TaskRunnerDeps`, `PhaseDeps` and `Run`. `MergeStepsDeps.gates` and `TaskRunnerDeps.gates` share the `(worktree, branch)` shape. `TaskRunner.budgetExceeded` is added in Task 8 before `Run` calls it. `Scenario.wrap` returns `typeof runStep` as `RunDeps.runStep` expects. `StepDeps.workspacesRoot` is set everywhere `StepDeps` is built (Task 3 test, Task 8 `stepDeps()`).

**Review Focus mapping.** 1 → Task 6 test "confirms a merged PR and finishes the task without merging again" and Task 8 crash test on `PR_MERGE`. 2 → Task 3 "redacts secret values…" and Task 5 "redacts the PR body". 3 → Task 4 "a refused merge returns the task to rebasing…". 4 → Task 4 "caps spec-gap rounds at three per attempt". 5 → Task 8 "pauses after the in-flight step returns and resumes without re-running it".

**Ambiguities resolved.** (a) Spec §4.4 says a scope violation is treated as `review-changes`; the runner does exactly that and never commits the violating tree. (b) Spec §5 lists `MERGE_LOCK_ACQUIRED`; not emitted (see above). (c) Spec §4.2 does not say which base the docs worktree uses; `origin/main` with `reset: true`, because a crashed docs attempt must not survive. (d) Spec §7 does not say whether the per-run budget check counts decision-layer tokens; it does (they are in `Accounting`), which is the conservative reading. (e) `paused:auth` is not a `RunResult`; `execute()` returns it as a sixth value and the CLI exits 2 without `RUN_FINISHED`, so `resume` can continue later.
