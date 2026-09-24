import { describe, expect, it } from 'vitest';
import { Gate } from '../../server/contracts/plan.js';
import { GATE_TRIAGE_OPTIONS, gateTriageQuestions, gateTriageState, triageGateFailure } from '../../server/decide/decisions/gate-triage.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { choiceAnswer } from '../fixtures/fake-backend.js';

const gate = Gate.parse({ name: 'unit-test', command: 'npm test', blocking: true });
const failed = (over: Partial<GateResult> = {}): GateResult => ({
  name: 'unit-test',
  blocking: true,
  passed: false,
  exitCode: 1,
  timedOut: false,
  durationMs: 4200,
  stdoutTail: 'FAIL src/a.test.ts',
  stderrTail: 'Error: expected 2 to be 3',
  junit: [
    { id: 'a::adds', name: 'adds', classname: 'a', status: 'failed', acIds: ['AC-001'] },
    { id: 'a::subtracts', name: 'subtracts', classname: 'a', status: 'passed', acIds: [] },
  ],
  failure: 'code',
  ...over,
});
function fakeDecider(outcome: DecisionOutcome) {
  const calls: unknown[][] = [];
  return {
    calls,
    decide: async (...args: unknown[]) => {
      calls.push(args);
      return outcome;
    },
  };
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
    expect(s).toMatch(/junit: 1 passed, 1 failed, 0 skipped/);
    expect(s).toContain('a::adds');
    expect(s).toContain('stderr (tail):\nError: expected 2 to be 3');
    expect(s).toContain('stdout (tail):\nFAIL src/a.test.ts');
    expect(gateTriageState(gate, failed({ junit: null }))).toContain('junit: no report');
  });

  it('applies the infra rule without consulting the decider', async () => {
    const d = fakeDecider({ answered: false, reason: 'disabled' });
    expect(await triageGateFailure(gate, failed({ failure: 'infra', exitCode: 137 }), d, { confidential: false })).toEqual({
      kind: 'infra',
      source: 'rule',
    });
    expect(d.calls).toHaveLength(0);
  });

  it('uses the decider answer and reports which backend answered', async () => {
    const d = fakeDecider({
      answered: true,
      backend: 'jev',
      escalated: false,
      answers: { kind: choiceAnswer('flaky-test', { 'flaky-test': 0.9, code: 0.1 }) },
    });
    expect(await triageGateFailure(gate, failed(), d, { confidential: false })).toEqual({ kind: 'flaky-test', source: 'jev' });
    expect(d.calls[0]![0]).toBe('gate-triage');
    expect(d.calls[0]![3]).toEqual({ confidential: false });
  });

  it('falls back to code when the layer is disabled or exhausted, and refuses a passed gate', async () => {
    expect(await triageGateFailure(gate, failed(), fakeDecider({ answered: false, reason: 'disabled' }), { confidential: true })).toEqual({
      kind: 'code',
      source: 'default',
    });
    expect(await triageGateFailure(gate, failed(), fakeDecider({ answered: false, reason: 'exhausted' }), { confidential: false })).toEqual({
      kind: 'code',
      source: 'default',
    });
    await expect(
      triageGateFailure(gate, failed({ passed: true, exitCode: 0, failure: null }), fakeDecider({ answered: false, reason: 'disabled' }), {
        confidential: false,
      }),
    ).rejects.toThrow(/passed/);
  });
});
