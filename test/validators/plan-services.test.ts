import { describe, expect, it } from 'vitest';
import type { ServicesPlan } from '../../server/contracts/plan.js';
import { scaffoldId, validateServicesPlan, type ServicesPlanCheckOptions } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlanTask, makeServicesPlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const opts: ServicesPlanCheckOptions = { services: ['orders', 'inventory'], newServices: new Set(['inventory']) };
const check = (plan: ServicesPlan, over: Partial<ServicesPlanCheckOptions> = {}) => validateServicesPlan(plan, spec, { ...opts, ...over });
const withTasks = (edit: (tasks: ServicesPlan['tasks']) => ServicesPlan['tasks']): ServicesPlan => {
  const plan = makeServicesPlan(spec);
  return { ...plan, tasks: edit(plan.tasks) };
};

describe('scaffoldId', () => {
  it('keeps T0-scaffold for the project repository and suffixes a service', () => {
    expect(scaffoldId(null)).toBe('T0-scaffold');
    expect(scaffoldId('inventory')).toBe('T0-scaffold-inventory');
  });
});

describe('validateServicesPlan', () => {
  it('accepts criteria each delivered by one service and a dependency across services', () => {
    expect(check(makeServicesPlan(spec))).toEqual([]);
  });

  it('reports a dependency cycle that crosses services', () => {
    const plan = withTasks((tasks) => tasks.map((t) => (t.id === 'T1-publish-order' ? { ...t, dependsOn: ['T2-reserve-stock'] } : t)));
    expect(check(plan).join()).toContain('dependency cycle');
  });

  it('rejects a service the project does not have, a task without a known service and a service without tasks', () => {
    const plan = makeServicesPlan(spec);
    expect(check(plan, { services: ['orders'] })).toContain("service inventory is not one of the project's services (project.json lists orders)");
    const orphans = withTasks((tasks) => [...tasks, makePlanTask({ id: 'T4-ghost', service: 'billing' }), makePlanTask({ id: 'T5-none' })]);
    expect(check(orphans)).toEqual(
      expect.arrayContaining(["task T4-ghost must name one of the plan's services (orders, inventory)", "task T5-none must name one of the plan's services (orders, inventory)"]),
    );
    const idle = { ...plan, services: { ...plan.services, billing: plan.services.orders! } };
    expect(check(idle, { services: ['orders', 'inventory', 'billing'] })).toContain('service billing has no task');
  });

  it('rejects two services on the same host port', () => {
    const plan = makeServicesPlan(spec);
    const inventory = { ...plan.services.inventory!, deploy: { ...plan.services.inventory!.deploy, port: 3000 } };
    expect(check({ ...plan, services: { ...plan.services, inventory } })).toContain('services orders and inventory both use deploy.port 3000');
  });

  it('prefixes a repository error with its service', () => {
    const plan = makeServicesPlan(spec);
    const inventory = { ...plan.services.inventory!, gates: plan.services.inventory!.gates.filter((g) => g.name !== 'secret-scan') };
    expect(check({ ...plan, services: { ...plan.services, inventory } })).toEqual(['service inventory: missing blocking gate secret-scan']);
  });

  it('asks each new service for its own scaffold, which every task of that service reaches', () => {
    expect(check(makeServicesPlan(spec), { newServices: new Set(['orders', 'inventory']) })).toEqual(
      expect.arrayContaining(['service orders: first spec requires task T0-scaffold-orders', 'service orders: first spec requires a deploy-infrastructure task owned by devops']),
    );
    const loose = withTasks((tasks) => tasks.map((t) => (t.id === 'T2-reserve-stock' ? { ...t, dependsOn: ['T1-publish-order'] } : t)));
    expect(check(loose)).toContain('service inventory: task T2-reserve-stock must depend on T0-scaffold-inventory');
  });

  it('asks for commands.smoke only in the service that delivers a smoke criterion', () => {
    const plan = makeServicesPlan(spec);
    const noSmoke = (name: 'orders' | 'inventory') => ({ ...plan.services[name]!, commands: { ...plan.services[name]!.commands, smoke: undefined } });
    expect(check({ ...plan, services: { ...plan.services, inventory: noSmoke('inventory') } })).toEqual([]);
    expect(check({ ...plan, services: { ...plan.services, orders: noSmoke('orders') } })).toEqual(['service orders: commands.smoke is required: AC-001 is a smoke criterion']);
  });

  it('checks e2e exemptions once for the whole plan', () => {
    const exemptions = [
      { acId: 'AC-002', reason: 'long enough reason' },
      { acId: 'AC-002', reason: 'long enough reason' },
    ];
    const errors = check({ ...makeServicesPlan(spec), e2eExemptions: exemptions }, { requireE2e: true });
    expect(errors.filter((e) => e.includes('duplicate AC-002'))).toEqual(['e2eExemptions: duplicate AC-002']);
  });
});
