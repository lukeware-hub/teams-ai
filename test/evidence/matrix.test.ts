import { describe, expect, it } from 'vitest';
import type { TestResult } from '../../server/evidence/junit.js';
import { buildEvidenceMatrix, evidenceGate, readyForValidation, verifyClaimedEvidence } from '../../server/evidence/matrix.js';
import type { TaskState } from '../../server/pipeline/task-state.js';
import { makeFrozenSpec, makePlanTask } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const result = (name: string, status: TestResult['status'], acIds: string[]): TestResult => ({
  id: `t::${name}`,
  name,
  classname: 't',
  status,
  acIds,
});
const task = (id: string, criteriaRefs: string[], state: TaskState) => ({ def: makePlanTask({ id, criteriaRefs }), state });

describe('buildEvidenceMatrix', () => {
  it('marks criteria passed, failed or missing from test results', () => {
    const rows = buildEvidenceMatrix(
      spec,
      [task('T1-create', ['AC-001'], 'merged'), task('T2-list', ['AC-002'], 'merged')],
      [result('[AC-001] a', 'passed', ['AC-001'])],
    );
    expect(rows).toEqual([
      { criterion: 'AC-001', tasks: ['T1-create'], tests: ['t::[AC-001] a'], status: 'passed' },
      { criterion: 'AC-002', tasks: ['T2-list'], tests: [], status: 'missing' },
    ]);
  });

  it('lets any failing test fail the criterion', () => {
    const rows = buildEvidenceMatrix(
      spec,
      [task('T1-create', ['AC-001'], 'merged')],
      [result('[AC-001] a', 'passed', ['AC-001']), result('[AC-001] b', 'failed', ['AC-001'])],
    );
    expect(rows[0]!.status).toBe('failed');
  });

  it('marks a criterion blocked when all of its tasks are blocked and it has no tests', () => {
    const rows = buildEvidenceMatrix(spec, [task('T1-create', ['AC-001'], 'merged'), task('T2-list', ['AC-002'], 'blocked')], [
      result('[AC-001] a', 'passed', ['AC-001']),
    ]);
    expect(rows[1]!.status).toBe('blocked');
  });

  it('ignores superseded tasks when attributing criteria', () => {
    const rows = buildEvidenceMatrix(
      spec,
      [task('T1-create', ['AC-001'], 'superseded'), task('T4-create2', ['AC-001'], 'merged'), task('T2-list', ['AC-002'], 'merged')],
      [],
    );
    expect(rows[0]!.tasks).toEqual(['T4-create2']);
  });
});

describe('evidenceGate', () => {
  it('fails when the report has no test cases', () => {
    expect(evidenceGate([])).toEqual(['JUnit report contains no test cases']);
  });

  it('fails when every test was skipped', () => {
    expect(evidenceGate([result('x', 'skipped', [])])).toEqual(['JUnit report contains no executed tests']);
  });

  it('passes when at least one test executed', () => {
    expect(evidenceGate([result('x', 'failed', [])])).toEqual([]);
  });
});

describe('readyForValidation', () => {
  it('requires every criterion to be passed or blocked', () => {
    expect(readyForValidation([{ criterion: 'AC-001', tasks: [], tests: [], status: 'passed' }, { criterion: 'AC-002', tasks: [], tests: [], status: 'blocked' }])).toBe(true);
    expect(readyForValidation([{ criterion: 'AC-001', tasks: [], tests: [], status: 'missing' }])).toBe(false);
  });
});

describe('verifyClaimedEvidence', () => {
  const results = [result('[AC-001] a', 'passed', ['AC-001']), result('[AC-002] b', 'failed', ['AC-002'])];

  it('accepts a passed claim backed by a passing tagged test', () => {
    expect(verifyClaimedEvidence([{ id: 'AC-001', status: 'passed', evidence: ['t::[AC-001] a'] }], results)).toEqual([]);
  });

  it('rejects a passed claim whose test failed', () => {
    expect(verifyClaimedEvidence([{ id: 'AC-002', status: 'passed', evidence: ['t::[AC-002] b'] }], results)).toEqual([
      'AC-002: claimed passed but t::[AC-002] b is failed',
    ]);
  });

  it('rejects unknown tests, untagged tests and passed claims without evidence', () => {
    expect(
      verifyClaimedEvidence(
        [
          { id: 'AC-001', status: 'passed', evidence: ['t::ghost'] },
          { id: 'AC-002', status: 'failed', evidence: ['t::[AC-001] a'] },
          { id: 'AC-001', status: 'passed', evidence: [] },
        ],
        results,
      ),
    ).toEqual([
      'AC-001: cited test not found in JUnit report: t::ghost',
      'AC-002: cited test is not tagged with this criterion: t::[AC-001] a',
      'AC-001: claimed passed without evidence',
    ]);
  });

  it('accepts a not-covered claim with no evidence', () => {
    expect(verifyClaimedEvidence([{ id: 'AC-002', status: 'not-covered', evidence: [] }], results)).toEqual([]);
  });
});
