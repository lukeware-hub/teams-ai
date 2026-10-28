import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, decideOnFailure } from '../../server/scheduler/retry-policy.js';
import { runtime } from '../fixtures/run-state.js';

const task = (extra = {}) => runtime({ id: 'T1-a' }, 'validating', extra);

describe('decideOnFailure', () => {
  it('uses the spec defaults', () => {
    expect(DEFAULT_POLICY).toEqual({
      maxAttempts: 3,
      maxInfraRetriesPerGate: 3,
      maxFlakyRetriesPerGate: 1,
      maxSchemaRetriesPerStep: 2,
    });
  });

  it('retries the dev on the first two code failures, then replans, then blocks', () => {
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 0 }))).toEqual({ action: 'retry-dev', consumeAttempt: true });
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 1 }))).toEqual({ action: 'retry-dev', consumeAttempt: true });
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 2 }))).toEqual({ action: 'replan', consumeAttempt: true });
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 2, replanned: true }))).toEqual({ action: 'block', consumeAttempt: true });
  });

  it('gives a replacement task a fresh attempt budget but never a second replan', () => {
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 0, replanned: true })).action).toBe('retry-dev');
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 2, replanned: true })).action).toBe('block');
  });

  it('treats review changes, rebase conflicts, timeouts, budget and dependency errors as attempts', () => {
    for (const kind of ['review-changes', 'rebase-conflict', 'timeout', 'aborted', 'budget', 'dependency'] as const) {
      expect(decideOnFailure({ kind }, task()).consumeAttempt).toBe(true);
    }
  });

  it('re-runs infra and environment failures without consuming attempts until the per-gate cap', () => {
    expect(decideOnFailure({ kind: 'infra', gate: 'unit-test' }, task())).toEqual({ action: 'rerun-gate', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'environment', gate: 'unit-test' }, task({ infraRetries: { 'unit-test': 2 } }))).toEqual({
      action: 'rerun-gate',
      consumeAttempt: false,
    });
    expect(decideOnFailure({ kind: 'infra', gate: 'unit-test' }, task({ infraRetries: { 'unit-test': 3 } }))).toEqual({
      action: 'retry-dev',
      consumeAttempt: true,
    });
  });

  it('counts infra retries per gate', () => {
    const t = task({ infraRetries: { lint: 3 } });
    expect(decideOnFailure({ kind: 'infra', gate: 'unit-test' }, t).action).toBe('rerun-gate');
  });

  it('re-runs a flaky test once, then treats it as code', () => {
    expect(decideOnFailure({ kind: 'flaky-test', gate: 'unit-test' }, task())).toEqual({ action: 'rerun-gate', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'flaky-test', gate: 'unit-test' }, task({ flakyRetries: { 'unit-test': 1 } })).action).toBe('retry-dev');
  });

  it('requires a gate for gate-scoped failures', () => {
    expect(() => decideOnFailure({ kind: 'infra' }, task())).toThrow(/gate/);
    expect(() => decideOnFailure({ kind: 'environment' }, task())).toThrow(/gate/);
    expect(() => decideOnFailure({ kind: 'flaky-test' }, task())).toThrow(/gate/);
  });

  it('re-runs the step on schema failures up to the limit, then consumes an attempt', () => {
    expect(decideOnFailure({ kind: 'schema', schemaRetriesUsed: 0 }, task())).toEqual({ action: 'rerun-step', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'schema', schemaRetriesUsed: 1 }, task()).action).toBe('rerun-step');
    expect(decideOnFailure({ kind: 'schema', schemaRetriesUsed: 2 }, task())).toEqual({ action: 'retry-dev', consumeAttempt: true });
  });

  it('replans on compaction without consuming an attempt, and blocks if already replanned', () => {
    expect(decideOnFailure({ kind: 'compaction' }, task())).toEqual({ action: 'replan', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'compaction' }, task({ replanned: true }))).toEqual({ action: 'block', consumeAttempt: false });
  });

  it('pauses on quota and auth, and routes spec gaps, without consuming attempts', () => {
    expect(decideOnFailure({ kind: 'quota' }, task())).toEqual({ action: 'pause-quota', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'auth' }, task())).toEqual({ action: 'pause-auth', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'spec-gap' }, task())).toEqual({ action: 'route-spec-gap', consumeAttempt: false });
  });
});

describe('decideOnFailure with a task token budget', () => {
  const budget = { ...DEFAULT_POLICY, taskTokenBudget: 1000 };
  const code = (extra = {}) => ({ kind: 'code' as const, spentTokens: 100, ...extra });

  it('keeps retrying past the attempt count while the task is under budget', () => {
    expect(decideOnFailure(code(), task({ attempts: 3 }), budget)).toEqual({ action: 'retry-dev', consumeAttempt: true });
    expect(decideOnFailure(code(), task({ attempts: 9 }), budget).action).toBe('retry-dev');
  });

  it('stops once the task has spent its budget: replans, then blocks', () => {
    expect(decideOnFailure(code({ spentTokens: 1000 }), task({ attempts: 1 }), budget)).toEqual({ action: 'replan', consumeAttempt: true });
    expect(decideOnFailure(code({ spentTokens: 1500 }), task({ attempts: 1, replanned: true }), budget)).toEqual({ action: 'block', consumeAttempt: true });
  });

  it('stops on a repeated identical failure even while under budget', () => {
    expect(decideOnFailure(code({ repeated: true }), task({ attempts: 1 }), budget).action).toBe('replan');
    expect(decideOnFailure(code({ repeated: true }), task({ attempts: 1, replanned: true }), budget).action).toBe('block');
  });

  it('applies the budget to budget-kind failures too', () => {
    expect(decideOnFailure({ kind: 'budget', spentTokens: 1200 }, task({ attempts: 0 }), budget).action).toBe('replan');
  });

  it('ignores the budget when it is unset: the attempt count alone decides, as before', () => {
    expect(decideOnFailure(code({ spentTokens: 0 }), task({ attempts: 3 }), DEFAULT_POLICY).action).toBe('replan');
    expect(decideOnFailure(code({ spentTokens: 0, repeated: true }), task({ attempts: 1 }), DEFAULT_POLICY).action).toBe('retry-dev');
    expect(decideOnFailure(code({ spentTokens: 999_999 }), task({ attempts: 2 }), DEFAULT_POLICY).action).toBe('replan');
  });
});
