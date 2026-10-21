import { describe, expect, it } from 'vitest';
import type { EvidenceRow } from '../../server/evidence/matrix.js';
import { explainGaps, gapCause, type GapContext } from '../../server/orchestrator/phases/gaps.js';
import { DEPENDENCY_BLOCKED } from '../../server/pipeline/task-state.js';

const row = (criterion: string, status: EvidenceRow['status'], tasks: string[]): EvidenceRow => ({ criterion, status, tasks, tests: [] });

function ctx(over: Partial<GapContext> = {}): GapContext {
  return {
    evidence: [],
    tasks: new Map(),
    reasonOf: () => 'blocked',
    result: 'awaiting-validation',
    ...over,
  };
}

describe('gap causes', () => {
  it('names no cause for a delivered section', () => {
    const [item] = explainGaps([{ status: 'delivered' as const, acIds: ['AC1'] }], ctx({ evidence: [row('AC1', 'passed', ['T1'])] }));
    expect(item!.cause).toBeNull();
  });

  it('says no task covers a section when none of its criteria has a task', () => {
    expect(gapCause({ acIds: ['AC9'] }, ctx({ evidence: [row('AC1', 'passed', ['T1'])] }))).toEqual({ kind: 'no-task' });
    expect(gapCause({ acIds: [] }, ctx())).toEqual({ kind: 'no-task' });
  });

  it('reports the real block, following dependency blocks back to their root', () => {
    const tasks = new Map([
      ['T1', { state: 'blocked' as const, dependsOn: [] }],
      ['T2', { state: 'blocked' as const, dependsOn: ['T1'] }],
    ]);
    const reasons: Record<string, string> = { T1: 'Dev reported done but produced no changes.', T2: DEPENDENCY_BLOCKED };
    const cause = gapCause({ acIds: ['AC1'] }, ctx({ evidence: [row('AC1', 'blocked', ['T2'])], tasks, reasonOf: (id) => reasons[id]! }));
    expect(cause).toEqual({ kind: 'blocked', roots: [{ taskId: 'T1', reason: 'Dev reported done but produced no changes.' }] });
  });

  it('says tests fail when a criterion of the section has a failing test', () => {
    const tasks = new Map([['T1', { state: 'merged' as const, dependsOn: [] }]]);
    expect(gapCause({ acIds: ['AC1', 'AC2'] }, ctx({ evidence: [row('AC1', 'passed', ['T1']), row('AC2', 'failed', ['T1'])], tasks }))).toEqual({ kind: 'tests-failing', acIds: ['AC2'] });
  });

  it('says the run stopped when it ended without a validation-ready result', () => {
    const tasks = new Map([['T1', { state: 'merged' as const, dependsOn: [] }]]);
    expect(gapCause({ acIds: ['AC1'] }, ctx({ evidence: [row('AC1', 'missing', ['T1'])], tasks, result: 'deploy-failed' }))).toEqual({ kind: 'run-stopped', result: 'deploy-failed' });
  });

  it('says the code was not built when its tasks merged and nothing failed or stopped', () => {
    const tasks = new Map([['T1', { state: 'merged' as const, dependsOn: [] }]]);
    expect(gapCause({ acIds: ['AC1'] }, ctx({ evidence: [row('AC1', 'missing', ['T1'])], tasks }))).toEqual({ kind: 'not-built' });
  });
});
