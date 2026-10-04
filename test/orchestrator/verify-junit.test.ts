import { describe, expect, it } from 'vitest';
import type { TestResult } from '../../server/evidence/junit.js';
import { dedupeJunit } from '../../server/orchestrator/phases/verify.js';

const t = (status: TestResult['status'], id = 'c::[AC-001] hello'): TestResult => ({ id, name: id, classname: 'c', status, acIds: status === 'skipped' ? [] : ['AC-001'] });

describe('dedupeJunit', () => {
  it('a skipped duplicate (smoke suite without SERVICE_URL) never hides the passed test of the same id', () => {
    expect(dedupeJunit([t('passed'), t('skipped')]).map((r) => r.status)).toEqual(['passed']);
    expect(dedupeJunit([t('skipped'), t('passed')]).map((r) => r.status)).toEqual(['passed']);
  });
  it('a failed duplicate wins over a passed one', () => {
    expect(dedupeJunit([t('passed'), t('failed')]).map((r) => r.status)).toEqual(['failed']);
  });
  it('keeps distinct ids', () => {
    expect(dedupeJunit([t('passed'), t('passed', 'c::other')])).toHaveLength(2);
  });
});
