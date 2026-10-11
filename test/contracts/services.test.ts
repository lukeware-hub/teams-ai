import { describe, expect, it } from 'vitest';
import { AnyPlan, servicePlans } from '../../server/contracts/plan.js';
import { makeFrozenSpec, makePlan, makeProject, makeServicesPlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();

describe('Project.services', () => {
  it('is optional and holds unique lowercase names', () => {
    expect(makeProject().services).toBeUndefined();
    expect(makeProject({ services: ['orders', 'inventory'] }).services).toEqual(['orders', 'inventory']);
    expect(() => makeProject({ services: ['orders', 'orders'] })).toThrow('service names must be unique');
    expect(() => makeProject({ services: ['Orders'] })).toThrow();
  });
});

describe('ServicesPlan', () => {
  it('needs at least one service', () => {
    expect(() => makeServicesPlan(spec, { services: {} })).toThrow('a services plan needs at least one service');
  });

  it('is told apart from a single-repository plan by AnyPlan', () => {
    expect('services' in AnyPlan.parse(makePlan(spec))).toBe(false);
    const parsed = AnyPlan.parse(makeServicesPlan(spec));
    expect('services' in parsed && Object.keys(parsed.services)).toEqual(['orders', 'inventory']);
  });
});

describe('servicePlans', () => {
  it('gives a single-repository plan as the one view of the project repository', () => {
    const plan = makePlan(spec);
    expect(servicePlans(plan)).toEqual([{ service: null, plan }]);
  });

  it('gives each service its settings, its tasks and only the dependencies inside it', () => {
    const plan = makeServicesPlan(spec);
    const [orders, inventory] = servicePlans(plan);
    expect(orders!.service).toBe('orders');
    expect(orders!.plan.deploy.image).toBe('orders');
    expect(orders!.plan.tasks.map((t) => t.id)).toEqual(['T1-publish-order']);
    expect(inventory!.plan.deploy.port).toBe(3001);
    expect(inventory!.plan.specHash).toBe(plan.specHash);
    expect(inventory!.plan.tasks.find((t) => t.id === 'T2-reserve-stock')!.dependsOn).toEqual(['T0-scaffold-inventory']);
  });
});
