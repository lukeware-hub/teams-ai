# teams-ai Plan 5 — System 1 Decision Layer, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `decide` module: typed Choice / Score / Noul questions answered by a backend chain (Jev via OpenRouter → local stub → Claude escalation → deterministic default), with per-decision thresholds, cost accounting and outcome logging, and wire the first decision, gate failure triage (spec 10A.5 decision 1).

**Architecture:** A `Decider` walks a per-decision chain of `DecisionBackend`s and applies per-backend confidence thresholds; it never knows HTTP or processes. `JevOpenRouterBackend` is the only network client (injected `fetch`, injected `sleep`), `LocalStubBackend` always reports unavailable (phase 2 replaces it), `ClaudeEscalateBackend` turns the same questions into a `decide` agent step through an injected runner. Decision consumers (`triageGateFailure`) apply deterministic rules first, call the decider second, and fall back to a fixed default, so System 1 can route and triage but never waive a gate (spec 10A.5 rule).

**Tech Stack:** Node 22 (ESM), TypeScript 5.9.3, Vitest 5, zod 4, global `fetch` + `AbortSignal.timeout`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` — §3.2 (`decide` unit), §10 (confidential rule, `OPENROUTER_API_KEY`), §10A.0–10A.6, §12 (Jev unavailable, local unavailable, gate triage rows), §13 item 5, §14 (redaction).

## Global Constraints

- Everything from Plan 1's Global Constraints (pins, ESM, `.js` import suffix, English, ID patterns).
- `npm test` never touches the network or a `claude` process: the Jev client is tested with a fake `fetch` and a recorded response fixture; escalation is tested with a fake runner. The only live call is the manual smoke script in Task 8.
- The OpenRouter key is read from `<paths.secrets>/OPENROUTER_API_KEY` by the orchestrator only. It is never placed in `process.env` for a child process, never logged, and every error message that could carry it goes through `redactSecrets` with the key as a known value.
- Model pinned to `typesafe/jev-1.13` (config default). Never an alias such as `jev-latest`.
- System 1 answers may route, prioritize and triage. No code in this plan makes a gate pass, a review approve or evidence count as passed based on a decision.
- Thresholds are compared with `>=` (a confidence exactly at the threshold is accepted).
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TnQyb7zg5quttarqCZU6YU
  ```

## Review Focus

1. **State that carries a secret value.** A gate's stderr tail is already redacted by the gate runner, but a caller may build a state from other text. `Decider.decide` must redact every known secret value from the state before any backend sees it (Task 2 test "redacts known secret values from the state before calling a backend").
2. **A Jev answer whose probabilities do not describe the question.** A `choice` not among the options, a probability map with a missing option, or probabilities summing far from 1 must be rejected as `invalid` so the chain continues, never accepted as an answer (Task 4 tests "rejects a choice outside the options" and "rejects probabilities that do not sum to 1").
3. **Oversized state.** A 200 kB stdout tail pasted into a state must not produce a 422 from the API or a runaway bill: the decider truncates to `MAX_STATE_CHARS` and marks the truncation (Task 2 test "truncates an oversized state and marks it").
4. **HTTP 200 with a malformed body.** A proxy error page or a partial JSON body must become `invalid`, not an uncaught exception that kills the scheduler (Task 4 test "treats a 200 with an unparsable body as invalid").
5. **Escalation answers outside the type.** A Claude escalation that returns a choice value not among the options must be rejected as `invalid`, and the consumer's deterministic default applies (Task 6 test "rejects a choice value outside the options").

## File structure

```
server/decide/types.ts               Question/Answer types, DecisionBackend, DecisionConfig, DecisionRecord, IDs, answerConfidence()
server/decide/decider.ts             Decider: chain walk, confidential skip, thresholds, state cap + redaction, record callback
server/decide/jev-openrouter.ts      JevOpenRouterBackend: request mapping, response validation, backoff on 429/529/network
server/decide/local-stub.ts          LocalStubBackend: always unavailable (phase 2 replaces it)
server/decide/claude-escalate.ts     ClaudeEscalateBackend: prompt builder + answer mapping through an injected step runner
server/decide/create-decider.ts      createDecider(): wires config, secrets, backends, accounting and the record callback
server/decide/decisions/gate-triage.ts  decision 1: rules → decider → default; state builder and option descriptions
server/agents/outputs.ts             + 'decide' step kind and DecideOutput schema
server/budget/accounting.ts          UsageRecord.provider gains 'openrouter'; role gains 'system1'
server/config/config.ts              + decisions section (layer switch, OpenRouter client, per-decision config), resolveDecision()
server/core/redact.ts                + OpenRouter key pattern
server/core/secrets.ts               loadSecrets(dir): one file per secret name
scripts/integration/jev-smoke.ts     manual live call to Jev through OpenRouter (Task 8)
test/decide/*.test.ts, test/fixtures/jev/*.json, test/fixtures/fake-backend.ts
```

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Task 2 depends on Task 1 types; Tasks 4–6 depend on Task 1; Task 7 depends on 2–6; Task 8 depends on 7.

---

### Task 1: Types, decision IDs and the fake backend

**Files:**
- Create: `server/decide/types.ts`
- Create: `test/fixtures/fake-backend.ts`
- Test: `test/decide/types.test.ts`

**Interfaces:**
- Produces (used by every later task):
  ```ts
  export const BACKEND_NAMES = ['jev', 'local', 'claude'] as const;
  export type BackendName = (typeof BACKEND_NAMES)[number];
  export const DECISION_IDS = ['gate-triage'] as const;
  export type DecisionId = (typeof DECISION_IDS)[number];

  export interface ChoiceQuestion { type: 'choice'; instructions: string; options: Record<string, string> }
  export interface ScoreQuestion { type: 'score'; instructions: string; levels: string[] }
  export interface NoulQuestion { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
  export type Questions = Record<string, Question>;

  export interface ChoiceAnswer { type: 'choice'; value: string; probabilities: Record<string, number>; confidence: number | null }
  export interface ScoreAnswer { type: 'score'; value: number; probabilities: Record<string, number>; confidence: number | null }
  export interface NoulAnswer { type: 'noul'; value: number; probabilities: { yes: number; no: number }; confidence: number | null }
  export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
  export type Answers = Record<string, Answer>;

  export interface BackendUsage { inputTokens: number; outputTokens: number; costUsd: number | null }
  export type BackendResult =
    | { ok: true; answers: Answers; model: string; usage: BackendUsage }
    | { ok: false; reason: 'unavailable' | 'invalid'; message: string };
  export interface BackendInput { state: string; questions: Questions; escalateTo: Role }
  export interface DecisionBackend { readonly name: BackendName; evaluate(input: BackendInput): Promise<BackendResult> }

  export interface DecisionConfig { enabled: boolean; chain: BackendName[]; thresholds: { jev: number; local: number }; escalateTo: Role }

  export type AttemptOutcome = 'answered' | 'low-confidence' | 'unavailable' | 'invalid' | 'skipped-confidential' | 'missing-backend';
  export interface DecisionRecord {
    decisionId: DecisionId; backend: BackendName | null; model: string | null; escalated: boolean;
    answers: Answers | null; attempts: DecisionAttempt[];  // { backend, outcome, confidence, model, usage, message } — usage per answered attempt, redacted failure message per failed one
    usage: BackendUsage; stateChars: number; stateTruncated: boolean; durationMs: number; at: string;
  }
  export type DecisionOutcome =
    | { answered: true; answers: Answers; backend: BackendName; escalated: boolean }
    | { answered: false; reason: 'disabled' | 'exhausted' };

  export function answerConfidence(a: Answer): number;      // a.confidence ?? 0
  export function minConfidence(answers: Answers): number;   // min over answerConfidence; 0 for an empty map
  export function noulConfidence(p: number): number;         // Math.max(p, 1 - p)
  export function scoreConfidence(probabilities: Record<string, number>): number; // 1 - normalized entropy; 1 when a single level
  ```
- `test/fixtures/fake-backend.ts`:
  ```ts
  export class FakeBackend implements DecisionBackend {
    readonly calls: BackendInput[] = [];
    constructor(readonly name: BackendName, private readonly script: BackendResult[]) {}
    async evaluate(input: BackendInput): Promise<BackendResult> {
      this.calls.push(input);
      const next = this.script.shift();
      if (!next) throw new Error(`${this.name}: unscripted call`);
      return next;
    }
  }
  export const choiceAnswer = (value: string, probabilities: Record<string, number>, confidence: number | null = probabilities[value] ?? null): ChoiceAnswer => ({ type: 'choice', value, probabilities, confidence });
  export const ok = (answers: Answers, model = 'fake', usage: BackendUsage = { inputTokens: 100, outputTokens: 10, costUsd: 0.00001 }): BackendResult => ({ ok: true, answers, model, usage });
  export const unavailable = (message = 'down'): BackendResult => ({ ok: false, reason: 'unavailable', message });
  export const invalid = (message = 'bad'): BackendResult => ({ ok: false, reason: 'invalid', message });
  ```

- [ ] **Step 1: Write the failing test**

`test/decide/types.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { answerConfidence, minConfidence, noulConfidence, scoreConfidence } from '../../server/decide/types.js';

describe('confidence helpers', () => {
  it('noul confidence is the certainty of either answer', () => {
    expect(noulConfidence(0.98)).toBeCloseTo(0.98);
    expect(noulConfidence(0.02)).toBeCloseTo(0.98);
    expect(noulConfidence(0.5)).toBeCloseTo(0.5);
  });

  it('score confidence is 1 for a single-level distribution and 0 for a uniform one', () => {
    expect(scoreConfidence({ '0': 1, '1': 0, '2': 0 })).toBeCloseTo(1);
    expect(scoreConfidence({ '0': 1 / 3, '1': 1 / 3, '2': 1 / 3 })).toBeCloseTo(0);
    expect(scoreConfidence({ '0': 1 })).toBe(1);
    expect(scoreConfidence({ '0': 0.05, '1': 0.9, '2': 0.05 })).toBeGreaterThan(0.6);
  });

  it('answer confidence reads the field and treats null as zero', () => {
    expect(answerConfidence({ type: 'choice', value: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 })).toBe(0.9);
    expect(answerConfidence({ type: 'noul', value: 0.7, probabilities: { yes: 0.7, no: 0.3 }, confidence: null })).toBe(0);
  });

  it('min confidence is the weakest answer, zero for no answers', () => {
    expect(
      minConfidence({
        a: { type: 'choice', value: 'x', probabilities: { x: 0.95 }, confidence: 0.95 },
        b: { type: 'noul', value: 0.6, probabilities: { yes: 0.6, no: 0.4 }, confidence: 0.6 },
      }),
    ).toBe(0.6);
    expect(minConfidence({})).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decide/types.test.ts`
Expected: FAIL, cannot resolve `../../server/decide/types.js`.

- [ ] **Step 3: Write the types module**

`server/decide/types.ts`:
```ts
import type { Role } from '../config/config.js';

/** Spec 10A.0: the chain order is jev → local → claude; a decision's config may drop entries. */
export const BACKEND_NAMES = ['jev', 'local', 'claude'] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

/** Spec 10A.5: phase 1 ships decision 1 only; decisions 2–9 append here in phase 3. */
export const DECISION_IDS = ['gate-triage'] as const;
export type DecisionId = (typeof DECISION_IDS)[number];

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option name → description; both reach the model, so descriptions must separate the options. */
  options: Record<string, string>;
}
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** Ordered low → high; 2–10 entries. */
  levels: string[];
}
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = Record<string, Question>;

export interface ChoiceAnswer {
  type: 'choice';
  value: string;
  probabilities: Record<string, number>;
  confidence: number | null;
}
export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level index; may fall between levels. */
  value: number;
  probabilities: Record<string, number>;
  confidence: number | null;
}
export interface NoulAnswer {
  type: 'noul';
  /** P(yes). */
  value: number;
  probabilities: { yes: number; no: number };
  confidence: number | null;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type Answers = Record<string, Answer>;

export interface BackendUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export type BackendResult =
  | { ok: true; answers: Answers; model: string; usage: BackendUsage }
  | { ok: false; reason: 'unavailable' | 'invalid'; message: string };

export interface BackendInput {
  state: string;
  questions: Questions;
  /** Role that answers when this input reaches the Claude backend (spec 10A.5 "Escalates to"). */
  escalateTo: Role;
}

export interface DecisionBackend {
  readonly name: BackendName;
  evaluate(input: BackendInput): Promise<BackendResult>;
}

export interface DecisionConfig {
  enabled: boolean;
  chain: BackendName[];
  /** Per backend because Jev is calibrated and the local model is not (spec 10A.0). */
  thresholds: { jev: number; local: number };
  escalateTo: Role;
}

export type AttemptOutcome = 'answered' | 'low-confidence' | 'unavailable' | 'invalid' | 'skipped-confidential' | 'missing-backend';

/** One line per decision in the event store; later joined with the real outcome (spec 10A.4). */
export interface DecisionRecord {
  decisionId: DecisionId;
  backend: BackendName | null;
  model: string | null;
  escalated: boolean;
  answers: Answers | null;
  attempts: DecisionAttempt[];  // { backend, outcome, confidence, model, usage, message } — usage per answered attempt, redacted failure message per failed one
  usage: BackendUsage;
  stateChars: number;
  stateTruncated: boolean;
  durationMs: number;
  at: string;
}

export type DecisionOutcome =
  | { answered: true; answers: Answers; backend: BackendName; escalated: boolean }
  | { answered: false; reason: 'disabled' | 'exhausted' };

export function noulConfidence(p: number): number {
  return Math.max(p, 1 - p);
}

/** 1 − normalized Shannon entropy over the levels (spec 10A.1); a single level is fully certain. */
export function scoreConfidence(probabilities: Record<string, number>): number {
  const ps = Object.values(probabilities).filter((p) => p > 0);
  const n = Object.keys(probabilities).length;
  if (n <= 1) return 1;
  const entropy = -ps.reduce((acc, p) => acc + p * Math.log(p), 0);
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(n)));
}

export function answerConfidence(a: Answer): number {
  return a.confidence ?? 0;
}

export function minConfidence(answers: Answers): number {
  const values = Object.values(answers);
  if (values.length === 0) return 0;
  return Math.min(...values.map(answerConfidence));
}
```

- [ ] **Step 4: Write the fake backend fixture**

`test/fixtures/fake-backend.ts`:
```ts
import type {
  Answers,
  BackendInput,
  BackendName,
  BackendResult,
  BackendUsage,
  ChoiceAnswer,
  DecisionBackend,
} from '../../server/decide/types.js';

/** Replays scripted results in order; throws on an unscripted call so a test sees every extra call. */
export class FakeBackend implements DecisionBackend {
  readonly calls: BackendInput[] = [];
  constructor(
    readonly name: BackendName,
    private readonly script: BackendResult[],
  ) {}

  async evaluate(input: BackendInput): Promise<BackendResult> {
    this.calls.push(input);
    const next = this.script.shift();
    if (!next) throw new Error(`${this.name}: unscripted call`);
    return next;
  }
}

export const choiceAnswer = (
  value: string,
  probabilities: Record<string, number>,
  confidence: number | null = probabilities[value] ?? null,
): ChoiceAnswer => ({ type: 'choice', value, probabilities, confidence });

export const ok = (
  answers: Answers,
  model = 'fake',
  usage: BackendUsage = { inputTokens: 100, outputTokens: 10, costUsd: 0.00001 },
): BackendResult => ({ ok: true, answers, model, usage });

export const unavailable = (message = 'down'): BackendResult => ({ ok: false, reason: 'unavailable', message });
export const invalid = (message = 'bad'): BackendResult => ({ ok: false, reason: 'invalid', message });
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx vitest run test/decide/types.test.ts && npm run typecheck`
Expected: 4 tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/decide/types.ts test/fixtures/fake-backend.ts test/decide/types.test.ts
git commit -m "feat(decide): question, answer and backend types with confidence helpers"
```

---

### Task 2: Decider chain

**Files:**
- Create: `server/decide/decider.ts`
- Test: `test/decide/decider.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  ```ts
  export const MAX_STATE_CHARS = 24_000;
  export const TRUNCATION_MARK = '\n[... state truncated by decide ...]';
  export function capState(state: string): { state: string; truncated: boolean };
  export interface DeciderDeps {
    backends: Partial<Record<BackendName, DecisionBackend>>;
    config: (id: DecisionId) => DecisionConfig;
    /** Secret values to strip from every state before it leaves the orchestrator. */
    knownSecrets?: () => readonly string[];
    onDecision?: (record: DecisionRecord) => void;
    clock?: () => Date;
  }
  export interface DecideContext { confidential: boolean }
  export class Decider {
    constructor(deps: DeciderDeps);
    decide(id: DecisionId, state: string, questions: Questions, ctx: DecideContext): Promise<DecisionOutcome>;
  }
  ```

Chain semantics (spec 10A.0):
- `config(id).enabled === false` or empty chain → `{answered: false, reason: 'disabled'}`; a record is still emitted with `attempts: []`.
- For each backend name in `chain`: `jev` with `ctx.confidential` → attempt `skipped-confidential`, continue. Backend missing in `deps.backends` → `missing-backend`, continue. `evaluate` result `ok: false` → attempt with its reason, continue. `evaluate` throws → treated as `unavailable`, continue.
- `ok: true` from `claude` → answered, `escalated: true`, no threshold.
- `ok: true` from `jev` or `local` → `minConfidence(answers) >= thresholds[name]` → answered, `escalated: false`; else attempt `low-confidence`, continue.
- Loop ends → `{answered: false, reason: 'exhausted'}`.
- Usage in the record sums every successful backend call (a low-confidence Jev answer still cost tokens).

- [ ] **Step 1: Write the failing test**

`test/decide/decider.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Decider, MAX_STATE_CHARS, TRUNCATION_MARK, capState, type DeciderDeps } from '../../server/decide/decider.js';
import type { DecisionConfig, DecisionRecord, Questions } from '../../server/decide/types.js';
import { FakeBackend, choiceAnswer, invalid, ok, unavailable } from '../fixtures/fake-backend.js';

const T0 = new Date('2026-09-24T10:00:00.000Z');
const questions: Questions = {
  kind: { type: 'choice', instructions: 'Why did the gate fail?', options: { code: 'a test failed', infra: 'docker broke' } },
};
const cfg = (over: Partial<DecisionConfig> = {}): DecisionConfig => ({
  enabled: true,
  chain: ['jev', 'local', 'claude'],
  thresholds: { jev: 0.8, local: 0.9 },
  escalateTo: 'test',
  ...over,
});

function decider(backends: DeciderDeps['backends'], over: Partial<DecisionConfig> = {}, extra: Partial<DeciderDeps> = {}) {
  const records: DecisionRecord[] = [];
  const d = new Decider({ backends, config: () => cfg(over), onDecision: (r) => records.push(r), clock: () => T0, ...extra });
  return { d, records };
}

describe('Decider', () => {
  it('answers from jev when every answer meets the jev threshold', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('infra', { infra: 0.85, code: 0.15 }) }, 'typesafe/jev-1.13')]);
    const { d, records } = decider({ jev });
    const out = await d.decide('gate-triage', 'docker: Cannot connect', questions, { confidential: false });
    expect(out).toEqual({ answered: true, backend: 'jev', escalated: false, answers: { kind: choiceAnswer('infra', { infra: 0.85, code: 0.15 }) } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      decisionId: 'gate-triage',
      backend: 'jev',
      model: 'typesafe/jev-1.13',
      escalated: false,
      attempts: [{ backend: 'jev', outcome: 'answered', confidence: 0.85 }],
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.00001 },
      stateTruncated: false,
      at: T0.toISOString(),
    });
    expect(jev.calls[0]).toMatchObject({ escalateTo: 'test', state: 'docker: Cannot connect' });
  });

  it('accepts a confidence exactly at the threshold', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('code', { code: 0.8, infra: 0.2 }) })]);
    const { d } = decider({ jev });
    const out = await d.decide('gate-triage', 's', questions, { confidential: false });
    expect(out.answered).toBe(true);
  });

  it('escalates to claude on low confidence and marks the answer escalated', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('code', { code: 0.55, infra: 0.45 }) })]);
    const local = new FakeBackend('local', [unavailable()]);
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('infra', { infra: 1 }, null) }, 'opus')]);
    const { d, records } = decider({ jev, local, claude });
    const out = await d.decide('gate-triage', 's', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'claude', escalated: true });
    expect(records[0]!.attempts).toEqual([
      { backend: 'jev', outcome: 'low-confidence', confidence: 0.55 },
      { backend: 'local', outcome: 'unavailable', confidence: null },
      { backend: 'claude', outcome: 'answered', confidence: null },
    ]);
    // Both calls that returned cost tokens; the low-confidence one is not free.
    expect(records[0]!.usage).toEqual({ inputTokens: 200, outputTokens: 20, costUsd: 0.00002 });
  });

  it('falls through jev → local → claude when the earlier backends are unavailable or invalid', async () => {
    const jev = new FakeBackend('jev', [invalid('probabilities do not sum to 1')]);
    const local = new FakeBackend('local', [unavailable('stub')]);
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('code', { code: 1 }, null) })]);
    const { d, records } = decider({ jev, local, claude });
    const out = await d.decide('gate-triage', 's', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'claude' });
    expect(records[0]!.attempts.map((a) => a.outcome)).toEqual(['invalid', 'unavailable', 'answered']);
  });

  it('skips jev for a confidential project without calling it', async () => {
    const jev = new FakeBackend('jev', []);
    const local = new FakeBackend('local', [unavailable()]);
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('code', { code: 1 }, null) })]);
    const { d, records } = decider({ jev, local, claude });
    await d.decide('gate-triage', 's', questions, { confidential: true });
    expect(jev.calls).toHaveLength(0);
    expect(records[0]!.attempts[0]).toEqual({ backend: 'jev', outcome: 'skipped-confidential', confidence: null });
  });

  it('reports exhausted when no backend answers, and disabled when the decision is off', async () => {
    const jev = new FakeBackend('jev', [unavailable()]);
    const claude = new FakeBackend('claude', [unavailable('step failed')]);
    const { d, records } = decider({ jev, claude });
    expect(await d.decide('gate-triage', 's', questions, { confidential: false })).toEqual({ answered: false, reason: 'exhausted' });
    expect(records[0]!.attempts.map((a) => a.outcome)).toEqual(['unavailable', 'missing-backend', 'unavailable']);

    const off = decider({ jev }, { enabled: false });
    expect(await off.d.decide('gate-triage', 's', questions, { confidential: false })).toEqual({ answered: false, reason: 'disabled' });
    expect(off.records[0]).toMatchObject({ backend: null, answers: null, attempts: [] });
    expect(jev.calls).toHaveLength(1);
  });

  it('treats a throwing backend as unavailable and keeps walking the chain', async () => {
    const jev = { name: 'jev' as const, evaluate: async () => { throw new Error('socket hang up'); } };
    const claude = new FakeBackend('claude', [ok({ kind: choiceAnswer('code', { code: 1 }, null) })]);
    const { d, records } = decider({ jev, claude }, { chain: ['jev', 'claude'] });
    expect(await d.decide('gate-triage', 's', questions, { confidential: false })).toMatchObject({ answered: true, backend: 'claude' });
    expect(records[0]!.attempts[0]!.outcome).toBe('unavailable');
  });

  it('truncates an oversized state and marks it', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('code', { code: 1 }) })]);
    const { d, records } = decider({ jev });
    const big = 'x'.repeat(MAX_STATE_CHARS + 5000);
    await d.decide('gate-triage', big, questions, { confidential: false });
    const sent = jev.calls[0]!.state;
    expect(sent.length).toBe(MAX_STATE_CHARS + TRUNCATION_MARK.length);
    expect(sent.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(records[0]).toMatchObject({ stateTruncated: true, stateChars: MAX_STATE_CHARS + 5000 });
    expect(capState('short')).toEqual({ state: 'short', truncated: false });
  });

  it('redacts known secret values from the state before calling a backend', async () => {
    const jev = new FakeBackend('jev', [ok({ kind: choiceAnswer('code', { code: 1 }) })]);
    const { d } = decider({ jev }, {}, { knownSecrets: () => ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'] });
    await d.decide('gate-triage', 'fatal: token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rejected', questions, { confidential: false });
    expect(jev.calls[0]!.state).toBe('fatal: token [REDACTED] rejected');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decide/decider.test.ts`
Expected: FAIL, cannot resolve `../../server/decide/decider.js`.

- [ ] **Step 3: Implement the decider**

`server/decide/decider.ts`:
```ts
import { redactSecrets } from '../core/redact.js';
import {
  minConfidence,
  type AttemptOutcome,
  type BackendName,
  type BackendResult,
  type BackendUsage,
  type DecisionBackend,
  type DecisionConfig,
  type DecisionId,
  type DecisionOutcome,
  type DecisionRecord,
  type Questions,
} from './types.js';

/** Well under Jev's 32k-token context even for dense text (spec 10A.2 state size cap). */
export const MAX_STATE_CHARS = 24_000;
export const TRUNCATION_MARK = '\n[... state truncated by decide ...]';

export function capState(state: string): { state: string; truncated: boolean } {
  if (state.length <= MAX_STATE_CHARS) return { state, truncated: false };
  return { state: state.slice(0, MAX_STATE_CHARS) + TRUNCATION_MARK, truncated: true };
}

export interface DeciderDeps {
  backends: Partial<Record<BackendName, DecisionBackend>>;
  config: (id: DecisionId) => DecisionConfig;
  /** Secret values to strip from every state before it leaves the orchestrator (spec §14). */
  knownSecrets?: () => readonly string[];
  onDecision?: (record: DecisionRecord) => void;
  clock?: () => Date;
}

export interface DecideContext {
  confidential: boolean;
}

const ZERO_USAGE: BackendUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };

function addUsage(a: BackendUsage, b: BackendUsage): BackendUsage {
  const cost = a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: cost === null ? null : Math.round(cost * 1e8) / 1e8,
  };
}

/**
 * Spec 10A.0: rules first (in the caller), then the configured chain, then the caller's default.
 * The decider never knows HTTP or processes; backends are injected.
 */
export class Decider {
  private readonly clock: () => Date;

  constructor(private readonly deps: DeciderDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async decide(id: DecisionId, rawState: string, questions: Questions, ctx: DecideContext): Promise<DecisionOutcome> {
    const started = this.clock();
    const cfg = this.deps.config(id);
    const redacted = redactSecrets(rawState, this.deps.knownSecrets?.() ?? []);
    const { state, truncated } = capState(redacted);
    const attempts: DecisionRecord['attempts'] = [];
    let usage = ZERO_USAGE;

    const emit = (outcome: DecisionOutcome, backend: BackendName | null, model: string | null) => {
      this.deps.onDecision?.({
        decisionId: id,
        backend,
        model,
        escalated: outcome.answered ? outcome.escalated : false,
        answers: outcome.answered ? outcome.answers : null,
        attempts,
        usage,
        stateChars: rawState.length,
        stateTruncated: truncated,
        durationMs: this.clock().getTime() - started.getTime(),
        at: started.toISOString(),
      });
      return outcome;
    };

    if (!cfg.enabled || cfg.chain.length === 0) return emit({ answered: false, reason: 'disabled' }, null, null);

    for (const name of cfg.chain) {
      if (name === 'jev' && ctx.confidential) {
        attempts.push({ backend: name, outcome: 'skipped-confidential', confidence: null });
        continue;
      }
      const backend = this.deps.backends[name];
      if (!backend) {
        attempts.push({ backend: name, outcome: 'missing-backend', confidence: null });
        continue;
      }
      let result: BackendResult;
      try {
        result = await backend.evaluate({ state, questions, escalateTo: cfg.escalateTo });
      } catch (err) {
        result = { ok: false, reason: 'unavailable', message: (err as Error).message };
      }
      if (!result.ok) {
        attempts.push({ backend: name, outcome: result.reason as AttemptOutcome, confidence: null });
        continue;
      }
      usage = addUsage(usage, result.usage);
      if (name === 'claude') {
        attempts.push({ backend: name, outcome: 'answered', confidence: null });
        return emit({ answered: true, answers: result.answers, backend: name, escalated: true }, name, result.model);
      }
      const confidence = minConfidence(result.answers);
      if (confidence >= cfg.thresholds[name]) {
        attempts.push({ backend: name, outcome: 'answered', confidence });
        return emit({ answered: true, answers: result.answers, backend: name, escalated: false }, name, result.model);
      }
      attempts.push({ backend: name, outcome: 'low-confidence', confidence });
    }
    return emit({ answered: false, reason: 'exhausted' }, null, null);
  }
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx vitest run test/decide/decider.test.ts && npm run typecheck`
Expected: 9 tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/decide/decider.ts test/decide/decider.test.ts
git commit -m "feat(decide): backend chain with per-backend thresholds, confidential skip and decision records"
```

---

### Task 3: Config section, accounting provider, redaction pattern and secrets loader

**Files:**
- Modify: `server/config/config.ts` (add `decisions`, `resolveDecision`)
- Modify: `server/budget/accounting.ts:5-12` (widen `role` and `provider`)
- Modify: `server/core/redact.ts:10-18` (OpenRouter key pattern)
- Create: `server/core/secrets.ts`
- Test: `test/config/decisions.test.ts`, `test/core/secrets.test.ts`, extend `test/core/redact.test.ts`

**Interfaces:**
- Consumes: `BACKEND_NAMES`, `DECISION_IDS`, `DecisionConfig` from Task 1.
- Produces:
  ```ts
  // config.ts
  export const DecisionConfigSchema: z.ZodType<DecisionConfig, ...>;   // zod with defaults
  Config.decisions: {
    enabled: boolean;                       // default false (runs 1 and 2)
    openrouter: { baseUrl: string; model: string; timeoutMs: number; maxTries: number; backoffMs: number };
    perDecision: Record<DecisionId, DecisionConfig>;
  }
  export function resolveDecision(cfg: Config, id: DecisionId): DecisionConfig; // layer off → enabled: false
  // accounting.ts
  UsageRecord.role: Role | 'system1';  UsageRecord.provider: 'claude' | 'omniroute' | 'openrouter';
  // secrets.ts
  export async function loadSecrets(dir: string): Promise<Record<string, string>>; // file name → trimmed content; missing dir → {}
  ```

- [ ] **Step 1: Write the failing config test**

`test/config/decisions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveDecision } from '../../server/config/config.js';

describe('decisions config', () => {
  it('defaults: layer off, Jev pinned, gate-triage chain and thresholds from spec 10A.0', () => {
    expect(DEFAULT_CONFIG.decisions.enabled).toBe(false);
    expect(DEFAULT_CONFIG.decisions.openrouter).toEqual({
      baseUrl: 'https://openrouter.ai/api',
      model: 'typesafe/jev-1.13',
      timeoutMs: 15_000,
      maxTries: 3,
      backoffMs: 500,
    });
    expect(DEFAULT_CONFIG.decisions.perDecision['gate-triage']).toEqual({
      enabled: true,
      chain: ['jev', 'local', 'claude'],
      thresholds: { jev: 0.8, local: 0.9 },
      escalateTo: 'test',
    });
  });

  it('resolveDecision turns every decision off while the layer is disabled', () => {
    expect(resolveDecision(DEFAULT_CONFIG, 'gate-triage').enabled).toBe(false);
    const on = loadConfig({ decisions: { enabled: true } });
    expect(resolveDecision(on, 'gate-triage').enabled).toBe(true);
    const oneOff = loadConfig({ decisions: { enabled: true, perDecision: { 'gate-triage': { enabled: false } } } });
    expect(resolveDecision(oneOff, 'gate-triage').enabled).toBe(false);
  });

  it('rejects an alias model, an out-of-range threshold and an unknown backend', () => {
    expect(() => loadConfig({ decisions: { openrouter: { model: 'jev-latest' } } })).toThrow(ConfigError);
    expect(() => loadConfig({ decisions: { perDecision: { 'gate-triage': { thresholds: { jev: 1.5 } } } } })).toThrow(ConfigError);
    expect(() => loadConfig({ decisions: { perDecision: { 'gate-triage': { chain: ['gpt'] } } } })).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Write the failing secrets and redact tests**

`test/core/secrets.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSecrets } from '../../server/core/secrets.js';

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe('loadSecrets', () => {
  it('reads one file per secret name and trims the trailing newline', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-secrets-'));
    await fs.writeFile(path.join(dir, 'OPENROUTER_API_KEY'), 'sk-or-v1-abc\n');
    await fs.writeFile(path.join(dir, 'DB_PASSWORD'), '  p@ss  ');
    await fs.writeFile(path.join(dir, 'lowercase'), 'ignored');
    await fs.mkdir(path.join(dir, 'SUBDIR'));
    expect(await loadSecrets(dir)).toEqual({ OPENROUTER_API_KEY: 'sk-or-v1-abc', DB_PASSWORD: 'p@ss' });
  });

  it('returns an empty map when the directory does not exist', async () => {
    expect(await loadSecrets(path.join(os.tmpdir(), 'teams-ai-none-' + Date.now()))).toEqual({});
  });
});
```

Append to `test/core/redact.test.ts` inside its top-level `describe`:
```ts
  it('masks an OpenRouter key even when it was not registered', () => {
    const key = 'sk-or-v1-' + 'a1'.repeat(32);
    expect(redactSecrets(`401 for ${key}`)).toBe('401 for [REDACTED]');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/config/decisions.test.ts test/core/secrets.test.ts test/core/redact.test.ts`
Expected: decisions and secrets FAIL to resolve modules/exports; the redact test FAILS with the key left in place.

- [ ] **Step 4: Add the config section**

In `server/config/config.ts`, add the import after the existing imports:
```ts
import { BACKEND_NAMES, DECISION_IDS, type DecisionConfig, type DecisionId } from '../decide/types.js';
```
Add after `StepBudget`:
```ts
const unit = z.number().min(0).max(1);

/** Spec 10A.0: one entry per decision; thresholds are per backend. */
export const DecisionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  chain: z.array(z.enum(BACKEND_NAMES)).default([...BACKEND_NAMES]),
  thresholds: z.object({ jev: unit.default(0.8), local: unit.default(0.9) }).prefault({}),
  escalateTo: z.enum(ROLES).default('test'),
});

const PerDecisionSchema = z
  .object(
    Object.fromEntries(DECISION_IDS.map((id) => [id, DecisionConfigSchema.prefault({})])) as Record<
      DecisionId,
      z.ZodDefault<typeof DecisionConfigSchema>
    >,
  )
  .strict();

/** Spec 10A.2: the model is pinned; aliases such as `jev-latest` would make attempts irreproducible. */
const pinnedModel = z
  .string()
  .min(1)
  .refine((m) => !/latest|auto/i.test(m), { message: 'decision model must be pinned (no latest/auto alias)' });
```
Add to the `Config` object, after `omniroute`:
```ts
  decisions: z
    .object({
      /** Off for runs 1 and 2 (spec §1.3); every decision then takes its System 2 path or default. */
      enabled: z.boolean().default(false),
      openrouter: z
        .object({
          baseUrl: z.string().url().default('https://openrouter.ai/api'),
          model: pinnedModel.default('typesafe/jev-1.13'),
          timeoutMs: positive.default(15_000),
          maxTries: positive.default(3),
          backoffMs: positive.default(500),
        })
        .prefault({}),
      perDecision: PerDecisionSchema.prefault({}),
    })
    .prefault({}),
```
Add at the end of the file:
```ts
/** A disabled layer switches every decision off without touching its other settings (spec 10A.0). */
export function resolveDecision(cfg: Config, id: DecisionId): DecisionConfig {
  const d = cfg.decisions.perDecision[id];
  return { ...d, chain: [...d.chain], thresholds: { ...d.thresholds }, enabled: cfg.decisions.enabled && d.enabled };
}
```

- [ ] **Step 5: Widen the accounting record**

In `server/budget/accounting.ts` replace the two fields:
```ts
  /** `system1` is the decision layer (spec 10A.2); it is not an agent role. */
  role: Role | 'system1';
```
```ts
  provider: 'claude' | 'omniroute' | 'openrouter';
```

- [ ] **Step 6: Add the redaction pattern and the secrets loader**

In `server/core/redact.ts`, insert as the second entry of `CREDENTIAL_PATTERNS` (after the `sk-ant-` line):
```ts
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
```
and shift the replacement indexes so the new pattern is a plain `REDACTED` replacement. The function body becomes:
```ts
  out = out.replace(CREDENTIAL_PATTERNS[0]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[1]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[2]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[3]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[4]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[5]!, `$1 ${REDACTED}`);
  out = out.replace(CREDENTIAL_PATTERNS[6]!, `$1=${REDACTED}`);
  out = out.replace(CREDENTIAL_PATTERNS[7]!, `$1${REDACTED}@`);
```

`server/core/secrets.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Spec §10/§14: `~/.teams-ai/secrets/<NAME>` holds one secret per file. Only upper-case names are
 * secrets; anything else in the directory is ignored. Values are trimmed so an editor's trailing
 * newline never becomes part of a token.
 */
export async function loadSecrets(dir: string): Promise<Record<string, string>> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (!e.isFile() || !SECRET_NAME.test(e.name)) continue;
    out[e.name] = (await fs.readFile(path.join(dir, e.name), 'utf8')).trim();
  }
  return out;
}
```

- [ ] **Step 7: Run the tests and the full suite**

Run: `npx vitest run test/config test/core && npm run typecheck && npm test`
Expected: all PASS. The existing redact tests still pass because only the index shift changed; the existing config test still passes because `decisions` has defaults.

- [ ] **Step 8: Commit**

```bash
git add server/config/config.ts server/budget/accounting.ts server/core/redact.ts server/core/secrets.ts test/config/decisions.test.ts test/core/secrets.test.ts test/core/redact.test.ts
git commit -m "feat(config): decision layer settings, openrouter provider, key redaction and secrets loader"
```

---

### Task 4: Jev via OpenRouter backend

**Files:**
- Create: `server/decide/jev-openrouter.ts`
- Create: `test/fixtures/jev/choice-response.json`, `test/fixtures/jev/mixed-response.json`
- Test: `test/decide/jev-openrouter.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  ```ts
  export interface JevDeps {
    fetch: typeof fetch;
    apiKey: string;
    baseUrl: string;      // 'https://openrouter.ai/api'
    model: string;        // 'typesafe/jev-1.13'
    timeoutMs: number;
    maxTries: number;
    backoffMs: number;
    sleep: (ms: number) => Promise<void>;
  }
  export function toJevRequest(model: string, state: string, questions: Questions): JevRequest;
  export function fromJevResponse(body: unknown, questions: Questions): { ok: true; answers: Answers; model: string; usage: BackendUsage } | { ok: false; message: string };
  export class JevOpenRouterBackend implements DecisionBackend { readonly name = 'jev'; constructor(deps: JevDeps); evaluate(input): Promise<BackendResult> }
  export const RETRYABLE_STATUS: ReadonlySet<number>; // 408, 429, 500, 502, 503, 504, 529
  ```

Request mapping (docs.typesafe.ai/api, openrouter typesafe guide):
- `choice` → `{ type: 'choice', instructions, criteria: options }`
- `score` → `{ type: 'score', instructions, criteria: levels }`
- `noul` → `{ type: 'noul', instructions, criteria? }`
- Body `{ model, state, questions }`, `POST ${baseUrl}/v1/systemone`, headers `Authorization: Bearer <key>`, `Content-Type: application/json`.

Response mapping:
- `choice` answer `{ type: 'choice', choice, probabilities, confidence }` → `ChoiceAnswer` as is. Invalid when `choice` is not an option, a probability key is not an option, an option is missing from the map, or the sum is outside `[0.98, 1.02]`.
- `score` answer `{ type: 'score', score, legend, probabilities, confidence }` → `ScoreAnswer { value: score, probabilities, confidence }`. Invalid when a key is not an index `0..levels.length-1` or the sum is outside `[0.98, 1.02]`.
- `noul` answer `{ type: 'noul', noul }` → `NoulAnswer { value: noul, probabilities: { yes: noul, no: 1 - noul }, confidence: noulConfidence(noul) }`.
- Answer missing for a question id or with a type different from the question → invalid.
- `usage` → `{ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costUsd: usage.cost ?? null }`.

- [ ] **Step 1: Write the fixtures**

`test/fixtures/jev/choice-response.json` (shape recorded from the OpenRouter System One API; values are illustrative):
```json
{
  "id": "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "kind": {
      "type": "choice",
      "choice": "infra",
      "probabilities": { "code": 0.06, "flaky-test": 0.02, "infra": 0.88, "environment": 0.03, "dependency": 0.01 },
      "confidence": 0.86
    }
  },
  "usage": { "input_tokens": 412, "output_tokens": 34, "cost": 0.0000173 }
}
```

`test/fixtures/jev/mixed-response.json`:
```json
{
  "id": "gen-dec-1789738400-Aq9",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "risk": {
      "type": "score",
      "score": 1.05,
      "legend": { "0": "trivial", "1": "moderate", "2": "high" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
      "confidence": 0.92
    },
    "drift": { "type": "noul", "noul": 0.98 }
  },
  "usage": { "input_tokens": 304, "output_tokens": 18, "cost": 0.0000128 }
}
```

- [ ] **Step 2: Write the failing test**

`test/decide/jev-openrouter.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  JevOpenRouterBackend,
  RETRYABLE_STATUS,
  fromJevResponse,
  toJevRequest,
  type JevDeps,
} from '../../server/decide/jev-openrouter.js';
import type { Questions } from '../../server/decide/types.js';

const choiceFixture = JSON.parse(readFileSync(new URL('../fixtures/jev/choice-response.json', import.meta.url), 'utf8'));
const mixedFixture = JSON.parse(readFileSync(new URL('../fixtures/jev/mixed-response.json', import.meta.url), 'utf8'));

const triage: Questions = {
  kind: {
    type: 'choice',
    instructions: 'Why did the gate fail?',
    options: { code: 'a test or build step failed', 'flaky-test': 'a test failed nondeterministically', infra: 'docker or host broke', environment: 'missing tool or image', dependency: 'registry or package resolution failed' },
  },
};
const mixed: Questions = {
  risk: { type: 'score', instructions: 'How risky is this diff?', levels: ['trivial', 'moderate', 'high'] },
  drift: { type: 'noul', instructions: 'Does the diff change files outside its declared scope?' },
};

const KEY = 'sk-or-v1-' + 'ab'.repeat(32);

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unscripted fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function backend(responses: Array<Response | Error>, over: Partial<JevDeps> = {}) {
  const { fetch, calls } = fakeFetch(responses);
  const sleeps: number[] = [];
  const b = new JevOpenRouterBackend({
    fetch,
    apiKey: KEY,
    baseUrl: 'https://openrouter.ai/api',
    model: 'typesafe/jev-1.13',
    timeoutMs: 1000,
    maxTries: 3,
    backoffMs: 100,
    sleep: async (ms) => { sleeps.push(ms); },
    ...over,
  });
  return { b, calls, sleeps };
}

describe('toJevRequest', () => {
  it('maps the three primitives onto the System One request shape', () => {
    expect(toJevRequest('typesafe/jev-1.13', 'S', { ...triage, ...mixed })).toEqual({
      model: 'typesafe/jev-1.13',
      state: 'S',
      questions: {
        kind: { type: 'choice', instructions: 'Why did the gate fail?', criteria: (triage.kind as { options: Record<string, string> }).options },
        risk: { type: 'score', instructions: 'How risky is this diff?', criteria: ['trivial', 'moderate', 'high'] },
        drift: { type: 'noul', instructions: 'Does the diff change files outside its declared scope?' },
      },
    });
  });
});

describe('fromJevResponse', () => {
  it('maps a choice answer and the usage', () => {
    const r = fromJevResponse(choiceFixture, triage);
    expect(r).toEqual({
      ok: true,
      model: 'typesafe/jev-1.13-20260917',
      usage: { inputTokens: 412, outputTokens: 34, costUsd: 0.0000173 },
      answers: { kind: { type: 'choice', value: 'infra', probabilities: choiceFixture.answers.kind.probabilities, confidence: 0.86 } },
    });
  });

  it('maps score and noul answers; noul confidence is the certainty of either side', () => {
    const r = fromJevResponse(mixedFixture, mixed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers.risk).toEqual({ type: 'score', value: 1.05, probabilities: { '0': 0, '1': 0.95, '2': 0.05 }, confidence: 0.92 });
    expect(r.answers.drift).toEqual({ type: 'noul', value: 0.98, probabilities: { yes: 0.98, no: 0.02 }, confidence: 0.98 });
  });

  it('rejects a choice outside the options', () => {
    const body = structuredClone(choiceFixture);
    body.answers.kind.choice = 'network';
    expect(fromJevResponse(body, triage)).toMatchObject({ ok: false, message: expect.stringContaining('network') });
  });

  it('rejects probabilities that do not sum to 1 or that miss an option', () => {
    const low = structuredClone(choiceFixture);
    low.answers.kind.probabilities = { code: 0.1, 'flaky-test': 0.1, infra: 0.1, environment: 0.1, dependency: 0.1 };
    expect(fromJevResponse(low, triage)).toMatchObject({ ok: false, message: expect.stringContaining('sum') });
    const missing = structuredClone(choiceFixture);
    delete missing.answers.kind.probabilities.dependency;
    missing.answers.kind.probabilities.infra = 0.89;
    expect(fromJevResponse(missing, triage)).toMatchObject({ ok: false, message: expect.stringContaining('dependency') });
  });

  it('rejects a missing answer, a type mismatch and a malformed body', () => {
    expect(fromJevResponse({ model: 'm', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }, triage)).toMatchObject({ ok: false, message: expect.stringContaining('kind') });
    const swapped = structuredClone(choiceFixture);
    swapped.answers.kind = { type: 'noul', noul: 0.5 };
    expect(fromJevResponse(swapped, triage)).toMatchObject({ ok: false });
    expect(fromJevResponse('<html>bad gateway</html>', triage)).toMatchObject({ ok: false });
  });
});

describe('JevOpenRouterBackend', () => {
  it('posts to /v1/systemone with the bearer key and returns the mapped answers', async () => {
    const { b, calls } = backend([json(choiceFixture)]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r).toMatchObject({ ok: true, model: 'typesafe/jev-1.13-20260917' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(toJevRequest('typesafe/jev-1.13', 'S', triage));
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries 429 and 529 with exponential backoff, then reports unavailable', async () => {
    const { b, calls, sleeps } = backend([json({ error: 'busy' }, 429), json({ error: 'overloaded' }, 529), json({ error: 'busy' }, 429)]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('429') });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
    expect([...RETRYABLE_STATUS].sort()).toEqual([408, 429, 500, 502, 503, 504, 529]);
  });

  it('retries a network error and a timeout, and succeeds on a later try', async () => {
    const abort = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { b, calls } = backend([new TypeError('fetch failed'), abort, json(choiceFixture)]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('does not retry 401 or 422 and never echoes the key in the message', async () => {
    const { b, calls } = backend([new Response(`invalid key ${KEY}`, { status: 401 })]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('401') });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('treats a 200 with an unparsable body as invalid', async () => {
    const { b } = backend([new Response('<html>proxy error</html>', { status: 200 })]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses to start with an empty key', () => {
    expect(() => backend([], { apiKey: '  ' })).toThrow(/OPENROUTER_API_KEY/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/decide/jev-openrouter.test.ts`
Expected: FAIL, cannot resolve `../../server/decide/jev-openrouter.js`.

- [ ] **Step 4: Implement the backend**

`server/decide/jev-openrouter.ts`:
```ts
import { z } from 'zod';
import { redactSecrets } from '../core/redact.js';
import {
  noulConfidence,
  type Answers,
  type BackendInput,
  type BackendResult,
  type BackendUsage,
  type DecisionBackend,
  type Question,
  type Questions,
} from './types.js';

/**
 * Spec 10A.2: Jev through OpenRouter's System One API. Same request/response shapes as TypeSafe's
 * own API; not an OpenAI-compatible chat endpoint, so it is called directly, never through
 * OmniRoute or a Claude Code process.
 */
export interface JevDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTries: number;
  backoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };

export interface JevRequest {
  model: string;
  state: string;
  questions: Record<string, JevQuestion>;
}

export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529]);

const SUM_TOLERANCE = 0.02;

function toJevQuestion(q: Question): JevQuestion {
  switch (q.type) {
    case 'choice':
      return { type: 'choice', instructions: q.instructions, criteria: q.options };
    case 'score':
      return { type: 'score', instructions: q.instructions, criteria: q.levels };
    case 'noul':
      return q.criteria ? { type: 'noul', instructions: q.instructions, criteria: q.criteria } : { type: 'noul', instructions: q.instructions };
  }
}

export function toJevRequest(model: string, state: string, questions: Questions): JevRequest {
  return { model, state, questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toJevQuestion(q)])) };
}

const probabilities = z.record(z.string(), z.number().min(0).max(1));
const ChoiceAnswerWire = z.object({ type: z.literal('choice'), choice: z.string(), probabilities, confidence: z.number().min(0).max(1) });
const ScoreAnswerWire = z.object({ type: z.literal('score'), score: z.number(), probabilities, confidence: z.number().min(0).max(1) });
const NoulAnswerWire = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const ResponseWire = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.discriminatedUnion('type', [ChoiceAnswerWire, ScoreAnswerWire, NoulAnswerWire])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), cost: z.number().nonnegative().optional() }),
});

function checkDistribution(id: string, probs: Record<string, number>, expectedKeys: readonly string[]): string | null {
  for (const k of Object.keys(probs)) if (!expectedKeys.includes(k)) return `${id}: probability for unknown key "${k}"`;
  for (const k of expectedKeys) if (!(k in probs)) return `${id}: probability for "${k}" missing`;
  const sum = Object.values(probs).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return `${id}: probabilities sum to ${sum.toFixed(3)}, expected 1`;
  return null;
}

export function fromJevResponse(
  body: unknown,
  questions: Questions,
): { ok: true; answers: Answers; model: string; usage: BackendUsage } | { ok: false; message: string } {
  const parsed = ResponseWire.safeParse(body);
  if (!parsed.success) return { ok: false, message: `response does not match the System One shape: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  const answers: Answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = parsed.data.answers[id];
    if (!a) return { ok: false, message: `answer for "${id}" missing` };
    if (a.type !== q.type) return { ok: false, message: `${id}: answer type ${a.type} does not match question type ${q.type}` };
    if (a.type === 'choice' && q.type === 'choice') {
      const options = Object.keys(q.options);
      if (!options.includes(a.choice)) return { ok: false, message: `${id}: choice "${a.choice}" is not an option` };
      const bad = checkDistribution(id, a.probabilities, options);
      if (bad) return { ok: false, message: bad };
      answers[id] = { type: 'choice', value: a.choice, probabilities: a.probabilities, confidence: a.confidence };
    } else if (a.type === 'score' && q.type === 'score') {
      const keys = q.levels.map((_, i) => String(i));
      const bad = checkDistribution(id, a.probabilities, keys);
      if (bad) return { ok: false, message: bad };
      answers[id] = { type: 'score', value: a.score, probabilities: a.probabilities, confidence: a.confidence };
    } else if (a.type === 'noul') {
      const yes = a.noul;
      answers[id] = { type: 'noul', value: yes, probabilities: { yes, no: Math.round((1 - yes) * 1e6) / 1e6 }, confidence: noulConfidence(yes) };
    }
  }
  const u = parsed.data.usage;
  return { ok: true, answers, model: parsed.data.model, usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd: u.cost ?? null } };
}

export class JevOpenRouterBackend implements DecisionBackend {
  readonly name = 'jev' as const;

  constructor(private readonly deps: JevDeps) {
    if (deps.apiKey.trim() === '') throw new Error('OPENROUTER_API_KEY is empty; the jev backend cannot start');
  }

  async evaluate(input: BackendInput): Promise<BackendResult> {
    const url = `${this.deps.baseUrl.replace(/\/+$/, '')}/v1/systemone`;
    const body = JSON.stringify(toJevRequest(this.deps.model, input.state, input.questions));
    const clean = (s: string) => redactSecrets(s, [this.deps.apiKey]);
    let lastMessage = 'no attempt made';
    for (let attempt = 0; attempt < this.deps.maxTries; attempt++) {
      if (attempt > 0) await this.deps.sleep(this.deps.backoffMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await this.deps.fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.deps.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.deps.timeoutMs),
        });
      } catch (err) {
        // Network failure or timeout: retryable.
        lastMessage = clean(`request failed: ${(err as Error).name}: ${(err as Error).message}`);
        continue;
      }
      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          return { ok: false, reason: 'invalid', message: `HTTP ${res.status} with a body that is not JSON` };
        }
        const mapped = fromJevResponse(json, input.questions);
        if (!mapped.ok) return { ok: false, reason: 'invalid', message: mapped.message };
        return { ok: true, answers: mapped.answers, model: mapped.model, usage: mapped.usage };
      }
      const text = clean((await res.text().catch(() => '')).slice(0, 300));
      lastMessage = `HTTP ${res.status}: ${text}`;
      if (!RETRYABLE_STATUS.has(res.status)) return { ok: false, reason: 'unavailable', message: lastMessage };
    }
    return { ok: false, reason: 'unavailable', message: `${lastMessage} (after ${this.deps.maxTries} tries)` };
  }
}
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `npx vitest run test/decide/jev-openrouter.test.ts && npm run typecheck`
Expected: 13 tests PASS; typecheck clean. If `DOMException` is not defined in the test runtime, replace the timeout fixture with `Object.assign(new Error('timeout'), { name: 'TimeoutError' })`.

- [ ] **Step 6: Commit**

```bash
git add server/decide/jev-openrouter.ts test/fixtures/jev test/decide/jev-openrouter.test.ts
git commit -m "feat(decide): Jev backend through OpenRouter System One API with validation and backoff"
```

---

### Task 5: Local stub backend

**Files:**
- Create: `server/decide/local-stub.ts`
- Test: `test/decide/local-stub.test.ts`

**Interfaces:**
- Produces: `export class LocalStubBackend implements DecisionBackend { readonly name = 'local'; evaluate(): Promise<BackendResult> }` — always `{ ok: false, reason: 'unavailable', message: 'local-logprobs backend is not built yet (spec 10A.2a, phase 2)' }`.

- [ ] **Step 1: Write the failing test**

`test/decide/local-stub.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { LocalStubBackend } from '../../server/decide/local-stub.js';

describe('LocalStubBackend', () => {
  it('is named local and always reports unavailable', async () => {
    const b = new LocalStubBackend();
    expect(b.name).toBe('local');
    const r = await b.evaluate({ state: 's', questions: {}, escalateTo: 'test' });
    expect(r).toEqual({ ok: false, reason: 'unavailable', message: expect.stringContaining('phase 2') });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decide/local-stub.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`server/decide/local-stub.ts`:
```ts
import type { BackendResult, DecisionBackend } from './types.js';

/**
 * Spec 10A.2a: phase 1 ships the slot in the chain, not the model. Reporting "unavailable" makes
 * the decider fall through to claude-escalate exactly as it will when the real llama.cpp server is down.
 */
export class LocalStubBackend implements DecisionBackend {
  readonly name = 'local' as const;

  async evaluate(): Promise<BackendResult> {
    return { ok: false, reason: 'unavailable', message: 'local-logprobs backend is not built yet (spec 10A.2a, phase 2)' };
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/decide/local-stub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/decide/local-stub.ts test/decide/local-stub.test.ts
git commit -m "feat(decide): local backend stub that always reports unavailable"
```

---

### Task 6: Claude escalation backend and the `decide` step kind

**Files:**
- Modify: `server/agents/outputs.ts` (add `'decide'` to `STEP_KINDS`, add `DecideOutput`, register in `OUTPUT_SCHEMAS`)
- Create: `server/decide/claude-escalate.ts`
- Test: `test/decide/claude-escalate.test.ts`; `test/agents/outputs.test.ts` keeps passing (it iterates `STEP_KINDS`)

**Interfaces:**
- Consumes: Task 1 types; `StepOutcome` from `server/runner/step.ts`.
- Produces:
  ```ts
  // outputs.ts
  export const DecideOutput = z.object({ specHash, answers: z.record(z.string(), z.discriminatedUnion('type', [
    z.object({ type: z.literal('choice'), value: z.string().min(1) }),
    z.object({ type: z.literal('score'), value: z.number().min(0) }),
    z.object({ type: z.literal('noul'), value: z.number().min(0).max(1) }),
  ])) });
  export type DecideOutput = z.infer<typeof DecideOutput>;
  // claude-escalate.ts
  export interface EscalationRequest { role: Role; prompt: string }
  export type EscalationRunner = (req: EscalationRequest) => Promise<StepOutcome<DecideOutput>>;
  export function buildEscalationPrompt(state: string, questions: Questions): string;
  export function fromEscalation(output: DecideOutput, questions: Questions): { ok: true; answers: Answers } | { ok: false; message: string };
  export class ClaudeEscalateBackend implements DecisionBackend { readonly name = 'claude'; constructor(run: EscalationRunner); evaluate(input): Promise<BackendResult> }
  ```
- Answer mapping (spec 10A.3, System 2 has no calibrated probabilities): choice → `probabilities: { [value]: 1, others: 0 }`, `confidence: null`; score → `probabilities: { [String(Math.round(value))]: 1 }` (other levels 0), `confidence: null`; value must be within `[0, levels.length - 1]`; noul → `probabilities: { yes: value, no: 1 - value }`, `confidence: null`.
- Usage: `{ inputTokens: summary.usage.inputTokens, outputTokens: summary.usage.outputTokens, costUsd: summary.costUsd }`; model: `'claude'` (the runner's step records the real model in accounting).
- A runner outcome with `ok: false` → `{ ok: false, reason: 'unavailable', message: errors.join('; ') }`. A runner that throws → the decider already treats a throw as unavailable; the backend does not catch it.

- [ ] **Step 1: Write the failing test**

`test/decide/claude-escalate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DecideOutput } from '../../server/agents/outputs.js';
import { ClaudeEscalateBackend, buildEscalationPrompt, fromEscalation, type EscalationRequest } from '../../server/decide/claude-escalate.js';
import type { Questions } from '../../server/decide/types.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';

const HASH = 'sha256:' + 'a'.repeat(64);
const questions: Questions = {
  kind: { type: 'choice', instructions: 'Why did the gate fail?', options: { code: 'test failed', infra: 'docker broke' } },
  risk: { type: 'score', instructions: 'How risky?', levels: ['trivial', 'moderate', 'high'] },
  drift: { type: 'noul', instructions: 'Out of scope changes?' },
};
const summary: ResultSummary = {
  found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1200, costUsd: 0.012,
  usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null,
  apiErrorStatus: null, rateLimit: null, compactions: 0,
};

describe('buildEscalationPrompt', () => {
  it('carries the state, every question with its options or levels, and the answer rules', () => {
    const p = buildEscalationPrompt('docker: Cannot connect', questions);
    expect(p).toContain('docker: Cannot connect');
    expect(p).toContain('"kind"');
    expect(p).toContain('infra');
    expect(p).toContain('"levels"');
    expect(p).toContain('moderate');
    expect(p).toMatch(/choice.*one of the option names/i);
    expect(p).toMatch(/score.*index/i);
    expect(p).toMatch(/noul.*probability/i);
  });
});

describe('fromEscalation', () => {
  it('maps typed values to answers without calibrated confidence', () => {
    const out = DecideOutput.parse({ specHash: HASH, answers: { kind: { type: 'choice', value: 'infra' }, risk: { type: 'score', value: 1.4 }, drift: { type: 'noul', value: 0.2 } } });
    expect(fromEscalation(out, questions)).toEqual({
      ok: true,
      answers: {
        kind: { type: 'choice', value: 'infra', probabilities: { code: 0, infra: 1 }, confidence: null },
        risk: { type: 'score', value: 1.4, probabilities: { '0': 0, '1': 1, '2': 0 }, confidence: null },
        drift: { type: 'noul', value: 0.2, probabilities: { yes: 0.2, no: 0.8 }, confidence: null },
      },
    });
  });

  it('rejects a choice value outside the options, a score outside the levels, a type mismatch and a missing answer', () => {
    const base = { specHash: HASH };
    expect(fromEscalation({ ...base, answers: { kind: { type: 'choice', value: 'network' }, risk: { type: 'score', value: 1 }, drift: { type: 'noul', value: 0.5 } } }, questions)).toMatchObject({ ok: false, message: expect.stringContaining('network') });
    expect(fromEscalation({ ...base, answers: { kind: { type: 'choice', value: 'code' }, risk: { type: 'score', value: 2.6 }, drift: { type: 'noul', value: 0.5 } } }, questions)).toMatchObject({ ok: false, message: expect.stringContaining('risk') });
    expect(fromEscalation({ ...base, answers: { kind: { type: 'noul', value: 0.5 }, risk: { type: 'score', value: 1 }, drift: { type: 'noul', value: 0.5 } } }, questions)).toMatchObject({ ok: false });
    expect(fromEscalation({ ...base, answers: { kind: { type: 'choice', value: 'code' } } }, questions)).toMatchObject({ ok: false, message: expect.stringContaining('risk') });
  });
});

describe('ClaudeEscalateBackend', () => {
  it('runs a decide step for the escalation role and maps the result and usage', async () => {
    const calls: EscalationRequest[] = [];
    const b = new ClaudeEscalateBackend(async (req) => {
      calls.push(req);
      return { ok: true, value: { specHash: HASH, answers: { kind: { type: 'choice', value: 'code' }, risk: { type: 'score', value: 0 }, drift: { type: 'noul', value: 0.1 } } }, summary };
    });
    const r = await b.evaluate({ state: 'S', questions, escalateTo: 'test' });
    expect(calls[0]!.role).toBe('test');
    expect(calls[0]!.prompt).toContain('S');
    expect(r).toMatchObject({ ok: true, model: 'claude', usage: { inputTokens: 900, outputTokens: 60, costUsd: 0.012 } });
  });

  it('reports unavailable when the step fails and invalid when the step answers outside the type', async () => {
    const failing = new ClaudeEscalateBackend(async () => ({ ok: false, failure: 'timeout', errors: ['killed after 20m'], summary, sandboxDisabled: false }));
    expect(await failing.evaluate({ state: 'S', questions, escalateTo: 'test' })).toEqual({ ok: false, reason: 'unavailable', message: 'timeout: killed after 20m' });
    const wrong = new ClaudeEscalateBackend(async () => ({ ok: true, value: { specHash: HASH, answers: { kind: { type: 'choice', value: 'nope' }, risk: { type: 'score', value: 0 }, drift: { type: 'noul', value: 0.1 } } }, summary }));
    expect(await wrong.evaluate({ state: 'S', questions, escalateTo: 'test' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decide/claude-escalate.test.ts`
Expected: FAIL, `DecideOutput` is not exported / module not found.

- [ ] **Step 3: Add the step kind and output schema**

In `server/agents/outputs.ts`:
```ts
export const STEP_KINDS = ['refine', 'tech-spec', 'coverage', 'plan', 'dev', 'review', 'deployment', 'report', 'decide'] as const;
```
Add before `OUTPUT_SCHEMAS`:
```ts
/** Spec 10A.3: a System 2 answer to typed questions; no probabilities, the value only. */
export const DecideOutput = z.object({
  specHash,
  answers: z.record(
    z.string(),
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('choice'), value: z.string().min(1) }),
      z.object({ type: z.literal('score'), value: z.number().min(0) }),
      z.object({ type: z.literal('noul'), value: z.number().min(0).max(1) }),
    ]),
  ),
});
export type DecideOutput = z.infer<typeof DecideOutput>;
```
Add `decide: DecideOutput,` to `OUTPUT_SCHEMAS`.

- [ ] **Step 4: Implement the backend**

`server/decide/claude-escalate.ts`:
```ts
import type { DecideOutput } from '../agents/outputs.js';
import type { Role } from '../config/config.js';
import type { StepOutcome } from '../runner/step.js';
import type { Answers, BackendInput, BackendResult, DecisionBackend, Questions } from './types.js';

export interface EscalationRequest {
  role: Role;
  prompt: string;
}

/** Runs one `decide` agent step (`claude -p --json-schema`); wired by createDecider from runStep. */
export type EscalationRunner = (req: EscalationRequest) => Promise<StepOutcome<DecideOutput>>;

export function buildEscalationPrompt(state: string, questions: Questions): string {
  const shaped = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      if (q.type === 'choice') return [id, { type: q.type, instructions: q.instructions, options: q.options }];
      if (q.type === 'score') return [id, { type: q.type, instructions: q.instructions, levels: q.levels }];
      return [id, { type: q.type, instructions: q.instructions, criteria: q.criteria ?? null }];
    }),
  );
  return [
    'You are answering typed decision questions about the STATE below. Return only the JSON output the schema requires.',
    'Rules:',
    '- For a "choice" question, `value` is exactly one of the option names.',
    '- For a "score" question, `value` is the level index (0 = first level); use a fraction between two indexes only when the state sits between them.',
    '- For a "noul" question, `value` is the probability (0 to 1) that the statement is true.',
    '- Answer every question id. Do not add ids.',
    '',
    'STATE:',
    state,
    '',
    'QUESTIONS (JSON):',
    JSON.stringify(shaped, null, 2),
  ].join('\n');
}

export function fromEscalation(output: DecideOutput, questions: Questions): { ok: true; answers: Answers } | { ok: false; message: string } {
  const answers: Answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = output.answers[id];
    if (!a) return { ok: false, message: `answer for "${id}" missing` };
    if (a.type !== q.type) return { ok: false, message: `${id}: answer type ${a.type} does not match question type ${q.type}` };
    if (a.type === 'choice' && q.type === 'choice') {
      const options = Object.keys(q.options);
      if (!options.includes(a.value)) return { ok: false, message: `${id}: choice "${a.value}" is not an option` };
      answers[id] = { type: 'choice', value: a.value, probabilities: Object.fromEntries(options.map((o) => [o, o === a.value ? 1 : 0])), confidence: null };
    } else if (a.type === 'score' && q.type === 'score') {
      const max = q.levels.length - 1;
      if (a.value > max) return { ok: false, message: `${id}: score ${a.value} exceeds the last level index ${max}` };
      const nearest = String(Math.round(a.value));
      answers[id] = { type: 'score', value: a.value, probabilities: Object.fromEntries(q.levels.map((_, i) => [String(i), String(i) === nearest ? 1 : 0])), confidence: null };
    } else if (a.type === 'noul') {
      answers[id] = { type: 'noul', value: a.value, probabilities: { yes: a.value, no: Math.round((1 - a.value) * 1e6) / 1e6 }, confidence: null };
    }
  }
  return { ok: true, answers };
}

/** Spec 10A.3: System 2 answers are final and carry `confidence: null`. */
export class ClaudeEscalateBackend implements DecisionBackend {
  readonly name = 'claude' as const;

  constructor(private readonly run: EscalationRunner) {}

  async evaluate(input: BackendInput): Promise<BackendResult> {
    const outcome = await this.run({ role: input.escalateTo, prompt: buildEscalationPrompt(input.state, input.questions) });
    if (!outcome.ok) return { ok: false, reason: 'unavailable', message: `${outcome.failure}: ${outcome.errors.join('; ')}` };
    const mapped = fromEscalation(outcome.value, input.questions);
    if (!mapped.ok) return { ok: false, reason: 'invalid', message: mapped.message };
    const u = outcome.summary.usage;
    return { ok: true, answers: mapped.answers, model: 'claude', usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: outcome.summary.costUsd } };
  }
}
```

- [ ] **Step 5: Run the tests, the outputs test and the typecheck**

Run: `npx vitest run test/decide/claude-escalate.test.ts test/agents/outputs.test.ts && npm run typecheck`
Expected: PASS. The outputs test iterates `STEP_KINDS` and checks `OUTPUT_SCHEMAS` keys, so the new kind is covered. If `npm run typecheck` reports another exhaustive `Record<StepKind, …>`, add a `decide` entry there with the same shape as `report`.

- [ ] **Step 6: Commit**

```bash
git add server/agents/outputs.ts server/decide/claude-escalate.ts test/decide/claude-escalate.test.ts
git commit -m "feat(decide): Claude escalation backend and the decide step kind"
```

---

### Task 7: Gate failure triage (decision 1) and the decider factory

**Files:**
- Create: `server/decide/decisions/gate-triage.ts`
- Create: `server/decide/create-decider.ts`
- Test: `test/decide/gate-triage.test.ts`, `test/decide/create-decider.test.ts`

**Interfaces:**
- Consumes: `Gate` (`server/contracts/plan.ts`), `GateResult` (`server/exec/gate-runner.ts`), `Decider` (Task 2), backends (Tasks 4–6), `Config`/`resolveDecision` (Task 3), `Accounting`, `loadSecrets`.
- Produces:
  ```ts
  // gate-triage.ts
  export const GATE_TRIAGE_OPTIONS: Record<GateTriage, string>;   // option → description
  export type GateTriage = 'code' | 'flaky-test' | 'infra' | 'environment' | 'dependency';  // every value is a FailureKind
  export const GATE_TRIAGE_DEFAULT: GateTriage = 'code';
  export function gateTriageState(gate: Gate, result: GateResult): string;
  export function gateTriageQuestions(): Questions;   // { kind: ChoiceQuestion }
  export interface TriageResult { kind: GateTriage; source: 'rule' | 'default' | BackendName }
  export async function triageGateFailure(gate: Gate, result: GateResult, decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<TriageResult>;
  // create-decider.ts
  export interface CreateDeciderDeps {
    cfg: Config;
    secrets: Record<string, string>;         // from loadSecrets(cfg.paths.secrets)
    accounting: Accounting;
    runEscalation: EscalationRunner;
    fetch?: typeof fetch;                    // default globalThis.fetch
    sleep?: (ms: number) => Promise<void>;   // default setTimeout
    onDecision?: (record: DecisionRecord) => void;
    clock?: () => Date;
  }
  export function createDecider(deps: CreateDeciderDeps): Decider;
  ```
- `triageGateFailure` rules (spec 10A.5 row 1, deterministic first): throws if `result.passed`; `result.failure === 'infra'` → `{ kind: 'infra', source: 'rule' }` without calling the decider; otherwise calls `decider.decide('gate-triage', gateTriageState(gate, result), gateTriageQuestions(), ctx)`; answered → `{ kind: answers.kind.value, source: backend }`; not answered → `{ kind: 'code', source: 'default' }`.
- `gateTriageState` includes: gate name, command, `network`, exit code, timed out flag, duration, JUnit summary (`passed/failed/error/skipped` counts and up to 5 failed test ids) or "no JUnit report", then `stderr (tail)` and `stdout (tail)` sections. The secret values were already redacted by the gate runner; the decider redacts again with `knownSecrets`.
- `createDecider`: builds `jev` only when `secrets.OPENROUTER_API_KEY` is a non-empty string (otherwise the chain records `missing-backend`), `local` = `LocalStubBackend`, `claude` = `ClaudeEscalateBackend(runEscalation)`; `config: (id) => resolveDecision(cfg, id)`; `knownSecrets: () => Object.values(secrets)`; `onDecision` books one `UsageRecord` per attempt that has `usage` and whose backend is not `claude` (a Claude escalation is a `runStep`, which already books its own usage), as `{ role: 'system1', phase: 'decide', taskId: null, attempt: 0, stepKind: 'decide', provider: 'openrouter', model: attempt.model ?? 'unknown', usage: {inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0}, costUsd: attempt.usage.costUsd, durationMs: record.durationMs, numTurns: 0, at: record.at }`, then forwards the record to `deps.onDecision`. (Review fix: the original per-record booking double-counted Claude and attributed a low-confidence Jev call to the final backend.)

- [ ] **Step 1: Write the failing triage test**

`test/decide/gate-triage.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Gate } from '../../server/contracts/plan.js';
import { GATE_TRIAGE_OPTIONS, gateTriageQuestions, gateTriageState, triageGateFailure } from '../../server/decide/decisions/gate-triage.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { choiceAnswer } from '../fixtures/fake-backend.js';

const gate = Gate.parse({ name: 'unit-test', command: 'npm test', blocking: true });
const failed = (over: Partial<GateResult> = {}): GateResult => ({
  name: 'unit-test', blocking: true, passed: false, exitCode: 1, timedOut: false, durationMs: 4200,
  stdoutTail: 'FAIL src/a.test.ts', stderrTail: 'Error: expected 2 to be 3',
  junit: [
    { id: 'a::adds', name: 'adds', classname: 'a', status: 'failed', acIds: ['AC-001'] },
    { id: 'a::subtracts', name: 'subtracts', classname: 'a', status: 'passed', acIds: [] },
  ],
  failure: 'code',
  ...over,
});
function fakeDecider(outcome: DecisionOutcome) {
  const calls: unknown[][] = [];
  return { calls, decide: async (...args: unknown[]) => { calls.push(args); return outcome; } };
}

describe('gate triage', () => {
  it('has the five options from spec 10A.5 row 1 with distinct descriptions', () => {
    expect(Object.keys(GATE_TRIAGE_OPTIONS).sort()).toEqual(['code', 'dependency', 'environment', 'flaky-test', 'infra']);
    expect(new Set(Object.values(GATE_TRIAGE_OPTIONS)).size).toBe(5);
    const q = gateTriageQuestions();
    expect(q.kind).toMatchObject({ type: 'choice', options: GATE_TRIAGE_OPTIONS });
  });

  it('builds a state with the gate, the exit, the JUnit summary and both tails', () => {
    const s = gateTriageState(gate, failed());
    expect(s).toContain('gate: unit-test');
    expect(s).toContain('command: npm test');
    expect(s).toContain('exit code: 1');
    expect(s).toContain('timed out: no');
    expect(s).toMatch(/junit: 1 passed, 1 failed, 0 errors, 0 skipped/);
    expect(s).toContain('a::adds');
    expect(s).toContain('stderr (tail):\nError: expected 2 to be 3');
    expect(s).toContain('stdout (tail):\nFAIL src/a.test.ts');
    expect(gateTriageState(gate, failed({ junit: null }))).toContain('junit: no report');
  });

  it('applies the infra rule without consulting the decider', async () => {
    const d = fakeDecider({ answered: false, reason: 'disabled' });
    expect(await triageGateFailure(gate, failed({ failure: 'infra', exitCode: 137 }), d, { confidential: false })).toEqual({ kind: 'infra', source: 'rule' });
    expect(d.calls).toHaveLength(0);
  });

  it('uses the decider answer and reports which backend answered', async () => {
    const d = fakeDecider({ answered: true, backend: 'jev', escalated: false, answers: { kind: choiceAnswer('flaky-test', { 'flaky-test': 0.9, code: 0.1 }) } });
    expect(await triageGateFailure(gate, failed(), d, { confidential: false })).toEqual({ kind: 'flaky-test', source: 'jev' });
    expect(d.calls[0]![0]).toBe('gate-triage');
    expect(d.calls[0]![3]).toEqual({ confidential: false });
  });

  it('falls back to code when the layer is disabled or exhausted, and refuses a passed gate', async () => {
    expect(await triageGateFailure(gate, failed(), fakeDecider({ answered: false, reason: 'disabled' }), { confidential: true })).toEqual({ kind: 'code', source: 'default' });
    expect(await triageGateFailure(gate, failed(), fakeDecider({ answered: false, reason: 'exhausted' }), { confidential: false })).toEqual({ kind: 'code', source: 'default' });
    await expect(triageGateFailure(gate, failed({ passed: true, exitCode: 0, failure: null }), fakeDecider({ answered: false, reason: 'disabled' }), { confidential: false })).rejects.toThrow(/passed/);
  });
});
```

- [ ] **Step 2: Write the failing factory test**

`test/decide/create-decider.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Accounting } from '../../server/budget/accounting.js';
import { loadConfig } from '../../server/config/config.js';
import { createDecider } from '../../server/decide/create-decider.js';
import type { DecisionRecord, Questions } from '../../server/decide/types.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';

const HASH = 'sha256:' + 'b'.repeat(64);
const questions: Questions = { kind: { type: 'choice', instructions: 'why?', options: { code: 'c', infra: 'i' } } };
const summary: ResultSummary = {
  found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 800, costUsd: 0.01,
  usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null,
  apiErrorStatus: null, rateLimit: null, compactions: 0,
};
const jevBody = {
  model: 'typesafe/jev-1.13-20260917',
  answers: { kind: { type: 'choice', choice: 'infra', probabilities: { code: 0.1, infra: 0.9 }, confidence: 0.88 } },
  usage: { input_tokens: 300, output_tokens: 20, cost: 0.0000126 },
};
const okFetch = (async () => new Response(JSON.stringify(jevBody), { status: 200 })) as typeof fetch;
const KEY = 'sk-or-v1-' + 'cd'.repeat(32);

describe('createDecider', () => {
  it('answers from Jev with the key from secrets and books the cost under system1/openrouter', async () => {
    const accounting = new Accounting();
    const records: DecisionRecord[] = [];
    const d = createDecider({
      cfg: loadConfig({ decisions: { enabled: true } }),
      secrets: { OPENROUTER_API_KEY: KEY },
      accounting,
      runEscalation: async () => { throw new Error('must not escalate'); },
      fetch: okFetch,
      sleep: async () => {},
      onDecision: (r) => records.push(r),
    });
    const out = await d.decide('gate-triage', 'S', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'jev' });
    expect(accounting.records()).toHaveLength(1);
    expect(accounting.records()[0]).toMatchObject({ role: 'system1', provider: 'openrouter', stepKind: 'decide', model: 'typesafe/jev-1.13-20260917', costUsd: 0.0000126 });
    expect(accounting.total({ provider: 'openrouter' })).toMatchObject({ inputTokens: 300, outputTokens: 20, steps: 1 });
    expect(records).toHaveLength(1);
  });

  it('without a key the chain skips jev as missing and escalates to Claude, booked under claude', async () => {
    const accounting = new Accounting();
    const d = createDecider({
      cfg: loadConfig({ decisions: { enabled: true } }),
      secrets: {},
      accounting,
      runEscalation: async (req) => {
        expect(req.role).toBe('test');
        return { ok: true, value: { specHash: HASH, answers: { kind: { type: 'choice', value: 'code' } } }, summary };
      },
      fetch: okFetch,
    });
    const records: DecisionRecord[] = [];
    const out = await d.decide('gate-triage', 'S', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'claude', escalated: true });
    expect(accounting.records()[0]).toMatchObject({ role: 'system1', provider: 'claude', costUsd: 0.01 });
    void records;
  });

  it('books nothing when the layer is disabled', async () => {
    const accounting = new Accounting();
    const d = createDecider({ cfg: loadConfig({}), secrets: { OPENROUTER_API_KEY: KEY }, accounting, runEscalation: async () => { throw new Error('no'); }, fetch: okFetch });
    expect(await d.decide('gate-triage', 'S', questions, { confidential: false })).toEqual({ answered: false, reason: 'disabled' });
    expect(accounting.records()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/decide/gate-triage.test.ts test/decide/create-decider.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement gate triage**

`server/decide/decisions/gate-triage.ts`:
```ts
import type { Gate } from '../../contracts/plan.js';
import type { GateResult } from '../../exec/gate-runner.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 1. Every option is a FailureKind the retry policy already understands. */
export type GateTriage = 'code' | 'flaky-test' | 'infra' | 'environment' | 'dependency';

export const GATE_TRIAGE_OPTIONS: Record<GateTriage, string> = {
  code: 'A test, compile or lint step failed because of the code under test; running again without changes would fail the same way.',
  'flaky-test': 'A test failed for a nondeterministic reason (timing, ordering, random data, port in use) and would likely pass on a re-run.',
  infra: 'The container runtime or host broke: Docker daemon errors, out of memory kill, disk full, container killed; the code was not exercised.',
  environment: 'A tool, binary, image or environment variable the command needs is missing or misconfigured inside the gate image.',
  dependency: 'Package installation or resolution failed: registry unreachable, lockfile mismatch, version not found, checksum error.',
};

export const GATE_TRIAGE_DEFAULT: GateTriage = 'code';

export function gateTriageQuestions(): Questions {
  return {
    kind: {
      type: 'choice',
      instructions: 'A quality gate ran inside a container and failed. From the command, exit status, JUnit summary and output tails, classify why it failed.',
      options: GATE_TRIAGE_OPTIONS,
    },
  };
}

function junitSummary(result: GateResult): string {
  if (!result.junit) return 'junit: no report';
  const count = (status: string) => result.junit!.filter((t) => t.status === status).length;
  const failedIds = result.junit.filter((t) => t.status === 'failed' || t.status === 'error').slice(0, 5).map((t) => t.id);
  const head = `junit: ${count('passed')} passed, ${count('failed')} failed, ${count('error')} errors, ${count('skipped')} skipped`;
  return failedIds.length > 0 ? `${head}\nfailed tests: ${failedIds.join(', ')}` : head;
}

/** Tails are already secret-redacted by the gate runner; the decider redacts again before sending. */
export function gateTriageState(gate: Gate, result: GateResult): string {
  return [
    `gate: ${gate.name}`,
    `command: ${gate.command}`,
    `network: ${gate.network}`,
    `exit code: ${result.exitCode ?? 'none (process did not start)'}`,
    `timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `duration: ${result.durationMs} ms`,
    junitSummary(result),
    '',
    `stderr (tail):\n${result.stderrTail || '(empty)'}`,
    '',
    `stdout (tail):\n${result.stdoutTail || '(empty)'}`,
  ].join('\n');
}

export interface TriageResult {
  kind: GateTriage;
  source: 'rule' | 'default' | BackendName;
}

/**
 * Spec 10A.0/10A.5: deterministic rules first (the gate runner's own infra classification), System 1
 * second, and `code` as the default so an unanswered triage still consumes an attempt (spec §12).
 */
export async function triageGateFailure(gate: Gate, result: GateResult, decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<TriageResult> {
  if (result.passed) throw new Error(`gate ${gate.name} passed; nothing to triage`);
  if (result.failure === 'infra') return { kind: 'infra', source: 'rule' };
  const outcome = await decider.decide('gate-triage', gateTriageState(gate, result), gateTriageQuestions(), ctx);
  if (!outcome.answered) return { kind: GATE_TRIAGE_DEFAULT, source: 'default' };
  const answer = outcome.answers.kind;
  if (!answer || answer.type !== 'choice' || !(answer.value in GATE_TRIAGE_OPTIONS)) return { kind: GATE_TRIAGE_DEFAULT, source: 'default' };
  return { kind: answer.value as GateTriage, source: outcome.backend };
}
```

- [ ] **Step 5: Implement the factory**

`server/decide/create-decider.ts`:
```ts
import type { Accounting } from '../budget/accounting.js';
import { resolveDecision, type Config } from '../config/config.js';
import { ClaudeEscalateBackend, type EscalationRunner } from './claude-escalate.js';
import { Decider } from './decider.js';
import { JevOpenRouterBackend } from './jev-openrouter.js';
import { LocalStubBackend } from './local-stub.js';
import type { BackendName, DecisionBackend, DecisionRecord } from './types.js';

export interface CreateDeciderDeps {
  cfg: Config;
  /** From loadSecrets(cfg.paths.secrets); only OPENROUTER_API_KEY is read here, every value is redacted from states. */
  secrets: Record<string, string>;
  accounting: Accounting;
  runEscalation: EscalationRunner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onDecision?: (record: DecisionRecord) => void;
  clock?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spec 10A.0 chain: jev (when a key exists) → local stub → claude. Cost lands in accounting under system1. */
export function createDecider(deps: CreateDeciderDeps): Decider {
  const backends: Partial<Record<BackendName, DecisionBackend>> = {
    local: new LocalStubBackend(),
    claude: new ClaudeEscalateBackend(deps.runEscalation),
  };
  const key = deps.secrets.OPENROUTER_API_KEY;
  if (typeof key === 'string' && key.trim() !== '') {
    const o = deps.cfg.decisions.openrouter;
    backends.jev = new JevOpenRouterBackend({
      fetch: deps.fetch ?? globalThis.fetch,
      apiKey: key,
      baseUrl: o.baseUrl,
      model: o.model,
      timeoutMs: o.timeoutMs,
      maxTries: o.maxTries,
      backoffMs: o.backoffMs,
      sleep: deps.sleep ?? defaultSleep,
    });
  }
  return new Decider({
    backends,
    config: (id) => resolveDecision(deps.cfg, id),
    knownSecrets: () => Object.values(deps.secrets),
    clock: deps.clock,
    onDecision: (record) => {
      if (record.usage.inputTokens + record.usage.outputTokens > 0) {
        deps.accounting.record({
          role: 'system1',
          phase: 'decide',
          taskId: null,
          attempt: 0,
          stepKind: 'decide',
          provider: record.backend === 'claude' ? 'claude' : 'openrouter',
          model: record.model ?? 'unknown',
          usage: { inputTokens: record.usage.inputTokens, outputTokens: record.usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: record.usage.costUsd,
          durationMs: record.durationMs,
          numTurns: 0,
          at: record.at,
        });
      }
      deps.onDecision?.(record);
    },
  });
}
```

- [ ] **Step 6: Run the tests, the typecheck and the full suite**

Run: `npx vitest run test/decide && npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/decide/decisions/gate-triage.ts server/decide/create-decider.ts test/decide/gate-triage.test.ts test/decide/create-decider.test.ts
git commit -m "feat(decide): gate failure triage decision and decider factory with cost accounting"
```

---

### Task 8: Manual smoke against the live API and spec cross-check

**Files:**
- Create: `scripts/integration/jev-smoke.ts`
- Modify: `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` only if the live response shape differs from the fixtures (then also update `test/fixtures/jev/*.json`).

**Interfaces:**
- Consumes: `loadSecrets`, `JevOpenRouterBackend`, `gateTriageQuestions`, `gateTriageState`, `DEFAULT_CONFIG`.

- [ ] **Step 1: Write the script**

`scripts/integration/jev-smoke.ts`:
```ts
/**
 * Manual, live: one Jev call through OpenRouter (costs well under a cent). Run from WSL or Windows:
 *   npx tsx scripts/integration/jev-smoke.ts
 * Reads OPENROUTER_API_KEY from ~/.teams-ai/secrets (override with TEAMS_AI_SECRETS_DIR).
 * Never part of `npm test`.
 */
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../server/config/config.js';
import { Gate } from '../../server/contracts/plan.js';
import { loadSecrets } from '../../server/core/secrets.js';
import { gateTriageQuestions, gateTriageState } from '../../server/decide/decisions/gate-triage.js';
import { JevOpenRouterBackend } from '../../server/decide/jev-openrouter.js';
import type { GateResult } from '../../server/exec/gate-runner.js';

const secretsDir = process.env.TEAMS_AI_SECRETS_DIR ?? path.join(os.homedir(), '.teams-ai', 'secrets');
const secrets = await loadSecrets(secretsDir);
const key = secrets.OPENROUTER_API_KEY;
if (!key) {
  console.error(`OPENROUTER_API_KEY not found in ${secretsDir}`);
  process.exit(2);
}

const o = DEFAULT_CONFIG.decisions.openrouter;
const jev = new JevOpenRouterBackend({
  fetch: globalThis.fetch,
  apiKey: key,
  baseUrl: o.baseUrl,
  model: o.model,
  timeoutMs: o.timeoutMs,
  maxTries: o.maxTries,
  backoffMs: o.backoffMs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const gate = Gate.parse({ name: 'unit-test', command: 'npm test', blocking: true });
const cases: Array<{ label: string; result: GateResult }> = [
  {
    label: 'expect code',
    result: { name: 'unit-test', blocking: true, passed: false, exitCode: 1, timedOut: false, durationMs: 3100, junit: [{ id: 'sum::adds', name: 'adds', classname: 'sum', status: 'failed', acIds: [] }], failure: 'code',
      stdoutTail: 'FAIL test/sum.test.ts > adds\nAssertionError: expected 3 to be 4', stderrTail: '' },
  },
  {
    label: 'expect dependency',
    result: { name: 'unit-test', blocking: true, passed: false, exitCode: 1, timedOut: false, durationMs: 12000, junit: null, failure: 'code',
      stdoutTail: '', stderrTail: 'npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for left-pad@9.9.9' },
  },
  {
    label: 'expect flaky-test',
    result: { name: 'unit-test', blocking: true, passed: false, exitCode: 1, timedOut: false, durationMs: 9000, junit: [{ id: 'server::listens', name: 'listens', classname: 'server', status: 'failed', acIds: [] }], failure: 'code',
      stdoutTail: 'FAIL test/server.test.ts > listens\nError: listen EADDRINUSE: address already in use :::3000', stderrTail: '' },
  },
];

for (const c of cases) {
  const started = Date.now();
  const r = await jev.evaluate({ state: gateTriageState(gate, c.result), questions: gateTriageQuestions(), escalateTo: 'test' });
  console.log(`== ${c.label} (${Date.now() - started} ms)`);
  console.log(JSON.stringify(r, null, 2));
}
```

- [ ] **Step 2: Run it once with the real key**

Run: `npx tsx scripts/integration/jev-smoke.ts`
Expected: three `ok: true` results, model `typesafe/jev-1.13-…`, each `costUsd` under 0.0001, latency well under 2 s, and the top choice matching each label (a mismatch is information for thresholds, not a failure of this task; note it in the commit body).

- [ ] **Step 3: Reconcile the fixtures with the live shape**

If any field name, nesting or type in the live response differs from `test/fixtures/jev/*.json`, update the fixtures and `ResponseWire` in `server/decide/jev-openrouter.ts` to the live shape, re-run `npm test`, and amend spec §10A.2 with the corrected shape. If nothing differs, skip this step.

- [ ] **Step 4: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean; the smoke script compiles because `scripts/integration` is in `tsconfig.include`.

- [ ] **Step 5: Commit**

```bash
git add scripts/integration/jev-smoke.ts
git commit -m "test: manual Jev smoke through OpenRouter for gate triage"
```
If Step 3 changed files, add them too and mention the reconciled fields in the commit body.

---

## Self-review

**Spec coverage.** §3.2 `decide` unit → Tasks 1, 2, 7 (`{value, probabilities, confidence, backend, escalated}` appear as `Answer` + `DecisionOutcome.backend/escalated`). §10 confidential + key placement → Task 2 (skip), Task 3 (secrets loader, redaction), Task 7 (factory reads the key from secrets only). §10A.0 chain, thresholds `>=`, disabled mode, logging → Task 2. §10A.1 primitives and confidence definitions → Task 1. §10A.2 endpoint, pinned model, direct call, retries, cost accounting, state cap → Tasks 3, 4, 2, 7. §10A.2a stub → Task 5. §10A.3 escalation with `confidence: null` → Task 6. §10A.4 outcome logging → `DecisionRecord` via `onDecision` (Task 2); joining with the real outcome is a consumer concern for the orchestrator plan, noted below. §10A.5 decision 1 + rule "never waive" → Task 7 (triage only routes). §10A.6 evals → out of phase 1 (spec says phase 2). §12 rows → Task 2 fall-through, Task 4 retries. §13 item 5 → fakes in Tasks 2, 6, 7; recorded fixture in Task 4.

**Not in this plan (explicit).** Wiring `triageGateFailure` into the task loop and writing `DecisionRecord` to the event store belong to the orchestrator plan that consumes gate results; there is no such loop in the repo yet. `createDecider` and the record callback are the seam for it. The `EscalationRunner` implementation over `runStep` (kind `'decide'`, cwd, `expectedSpecHash`) is also wired there.

**Type consistency.** `BackendResult`, `Answers`, `DecisionOutcome`, `DecisionRecord`, `DecisionConfig`, `EscalationRunner`, `TriageResult` are used with the same names and fields across Tasks 2–8. `AttemptOutcome` includes both `invalid` and `unavailable` from `BackendResult.reason`. `UsageRecord.role` `'system1'` and `provider` `'openrouter'` (Task 3) are what Task 7 records.

**Review Focus mapping.** 1 → Task 2 redaction test. 2 → Task 4 choice/probability tests. 3 → Task 2 truncation test. 4 → Task 4 unparsable-body test. 5 → Task 6 out-of-options test.
