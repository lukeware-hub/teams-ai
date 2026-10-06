import { describe, expect, it } from 'vitest';
import { Gate } from '../../server/contracts/plan.js';
import { validatePlan } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlan, REQUIRED_GATES } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const coverageGate = Gate.parse({ name: 'coverage', command: 'npx vitest run --coverage', blocking: true });
const plan = (over: Record<string, unknown> = {}) => makePlan(spec, { gates: [...REQUIRED_GATES, coverageGate], coveragePath: 'reports/coverage-summary.json', ...over });
const check = (p: ReturnType<typeof plan>) => validatePlan(p, spec, { firstSpec: true, requireCoverage: true });

describe('validatePlan requireCoverage', () => {
  it('accepts a blocking coverage gate with coveragePath set', () => {
    expect(check(plan())).toEqual([]);
  });

  it('legacy mode: a plan without a coverage gate stays valid', () => {
    expect(validatePlan(makePlan(spec), spec, { firstSpec: true })).toEqual([]);
    expect(validatePlan(makePlan(spec), spec, { firstSpec: true, requireCoverage: false })).toEqual([]);
  });

  it('rejects a plan with no coverage gate', () => {
    expect(check(makePlan(spec, { coveragePath: 'reports/coverage-summary.json' }))).toEqual(expect.arrayContaining([expect.stringContaining('missing blocking gate coverage')]));
  });

  it('rejects a non-blocking coverage gate', () => {
    expect(check(plan({ gates: [...REQUIRED_GATES, Gate.parse({ ...coverageGate, blocking: false })] }))).toEqual(expect.arrayContaining([expect.stringContaining('gate coverage must be blocking')]));
  });

  it('rejects a plan with no coveragePath', () => {
    expect(check(plan({ coveragePath: undefined }))).toEqual(expect.arrayContaining([expect.stringContaining('coveragePath is required')]));
  });

  it('accepts any coverage command (no tool prescribed - stack-agnostic by contract, not by tool)', () => {
    expect(check(plan({ gates: [...REQUIRED_GATES, Gate.parse({ ...coverageGate, command: 'go test -coverprofile=c.out ./... && go tool cover -func=c.out | tail -1 > reports/coverage-summary.json' })] }))).toEqual([]);
  });
});

describe('validatePlan coverageExemptions', () => {
  it('accepts an exemption with a reason', () => {
    expect(check(plan({ coverageExemptions: [{ path: 'src/generated/**', reason: 'generated client code, never hand-edited' }] }))).toEqual([]);
  });

  it('rejects duplicates and short reasons', () => {
    const errors = check(plan({ coverageExemptions: [{ path: 'src/generated/**', reason: 'long enough reason' }, { path: 'src/generated/**', reason: 'x' }] }));
    expect(errors).toContain('coverageExemptions: duplicate src/generated/**');
    expect(errors.some((e) => e.includes('needs a reason'))).toBe(true);
  });
});
