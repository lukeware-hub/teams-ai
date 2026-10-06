import { describe, expect, it } from 'vitest';
import { Plan } from '../../server/contracts/plan.js';
import { validatePlan } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const full = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/run.test.ts', readmeSections: ['Run', 'Test'] };

describe('Plan.delivery contract', () => {
  it('is optional: a plan without it parses and has no delivery', () => {
    expect(makePlan(spec).delivery).toBeUndefined();
  });

  it('rejects unsafe delivery paths', () => {
    const plan = makePlan(spec);
    expect(() => Plan.parse({ ...plan, delivery: { dockerfile: '../Dockerfile' } })).toThrow();
    expect(Plan.parse({ ...plan, delivery: { dockerfile: 'Dockerfile' } }).delivery).toEqual({ dockerfile: 'Dockerfile' });
  });
});

describe('validatePlan delivery', () => {
  it('legacy mode: a plan without delivery stays valid', () => {
    expect(validatePlan(makePlan(spec), spec, { firstSpec: true })).toEqual([]);
  });

  it('required mode: a plan without delivery is rejected', () => {
    expect(validatePlan(makePlan(spec), spec, { firstSpec: true, requireDelivery: true })).toEqual(
      expect.arrayContaining([expect.stringContaining('delivery is required'), expect.stringContaining('lockfilePath is required')]),
    );
  });

  it('both modes accept a complete delivery with a lockfile', () => {
    const plan = makePlan(spec, { delivery: full, lockfilePath: 'package-lock.json' });
    expect(validatePlan(plan, spec, { firstSpec: true })).toEqual([]);
    expect(validatePlan(plan, spec, { firstSpec: true, requireDelivery: true })).toEqual([]);
  });

  it('required mode also rejects a complete delivery with no lockfilePath', () => {
    const plan = makePlan(spec, { delivery: full });
    expect(validatePlan(plan, spec, { firstSpec: true, requireDelivery: true })).toEqual([expect.stringContaining('lockfilePath is required')]);
  });

  it('both modes reject a delivery that omits an artifact', () => {
    const { releaseWorkflow: _r, readmeSections: _s, ...partial } = full;
    const plan = makePlan(spec, { delivery: partial, lockfilePath: 'package-lock.json' });
    for (const requireDelivery of [false, true]) {
      expect(validatePlan(plan, spec, { firstSpec: true, requireDelivery })).toEqual(['delivery.releaseWorkflow is required', 'delivery.readmeSections is required (at least one section)']);
    }
  });
});
