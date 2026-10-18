import { describe, expect, it } from 'vitest';
import { scaffoldId, type ServicesPlan } from '../../server/contracts/plan.js';
import { validateServicesPlan, type ServicesPlanCheckOptions } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlanTask, makeServicesPlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const opts: ServicesPlanCheckOptions = { services: ['orders-api', 'inventory-api'], newServices: new Set(['inventory-api']) };
const check = (plan: ServicesPlan, over: Partial<ServicesPlanCheckOptions> = {}) => validateServicesPlan(plan, spec, { ...opts, ...over });
const withTasks = (edit: (tasks: ServicesPlan['tasks']) => ServicesPlan['tasks']): ServicesPlan => {
  const plan = makeServicesPlan(spec);
  return { ...plan, tasks: edit(plan.tasks) };
};

describe('scaffoldId', () => {
  it('keeps T0-scaffold for the project repository and suffixes a service', () => {
    expect(scaffoldId(null)).toBe('T0-scaffold');
    expect(scaffoldId('inventory-api')).toBe('T0-scaffold-inventory-api');
  });
});

describe('validateServicesPlan', () => {
  it('accepts criteria each delivered by one service and a dependency across services', () => {
    expect(check(makeServicesPlan(spec))).toEqual([]);
  });

  it('holds each service to the port the orchestrator assigned it: swapped ports pass every other check', () => {
    const plan = makeServicesPlan(spec);
    expect(check(plan, { ports: { 'orders-api': 3000, 'inventory-api': 3001 } })).toEqual([]);
    expect(check(plan, { ports: { 'orders-api': 3001, 'inventory-api': 3000 } })).toEqual([
      'service orders-api: deploy.port 3000 is not 3001, the port the orchestrator assigned it',
      'service inventory-api: deploy.port 3001 is not 3000, the port the orchestrator assigned it',
    ]);
  });

  it('reports a dependency cycle that crosses services', () => {
    const plan = withTasks((tasks) => tasks.map((t) => (t.id === 'T1-publish-order' ? { ...t, dependsOn: ['T2-reserve-stock'] } : t)));
    expect(check(plan).join()).toContain('dependency cycle');
  });

  it('rejects a service the project does not have, a task without a known service and a service without tasks', () => {
    const plan = makeServicesPlan(spec);
    expect(check(plan, { services: ['orders-api'] })).toContain("service inventory-api is not one of the project's services (project.json lists orders-api)");
    const orphans = withTasks((tasks) => [...tasks, makePlanTask({ id: 'T4-ghost', service: 'billing-api' }), makePlanTask({ id: 'T5-none' })]);
    expect(check(orphans)).toEqual(
      expect.arrayContaining(["task T4-ghost must name one of the plan's services (orders-api, inventory-api)", "task T5-none must name one of the plan's services (orders-api, inventory-api)"]),
    );
    const idle = { ...plan, services: { ...plan.services, 'billing-api': plan.services['orders-api']! } };
    expect(check(idle, { services: ['orders-api', 'inventory-api', 'billing-api'] })).toContain('service billing-api has no task');
  });

  it('rejects two services on the same host port', () => {
    const plan = makeServicesPlan(spec);
    const inventory = { ...plan.services['inventory-api']!, deploy: { ...plan.services['inventory-api']!.deploy, port: 3000 } };
    expect(check({ ...plan, services: { ...plan.services, 'inventory-api': inventory } })).toContain('services orders-api and inventory-api both use deploy.port 3000');
  });

  it('prefixes a repository error with its service', () => {
    const plan = makeServicesPlan(spec);
    const inventory = { ...plan.services['inventory-api']!, gates: plan.services['inventory-api']!.gates.filter((g) => g.name !== 'secret-scan') };
    expect(check({ ...plan, services: { ...plan.services, 'inventory-api': inventory } })).toEqual(['service inventory-api: missing blocking gate secret-scan']);
  });

  it('asks each new service for its own scaffold, which every task of that service reaches', () => {
    expect(check(makeServicesPlan(spec), { newServices: new Set(['orders-api', 'inventory-api']) })).toEqual(
      expect.arrayContaining(['service orders-api: first spec requires task T0-scaffold-orders-api', 'service orders-api: first spec requires a deploy-infrastructure task owned by devops']),
    );
    const loose = withTasks((tasks) => tasks.map((t) => (t.id === 'T2-reserve-stock' ? { ...t, dependsOn: ['T1-publish-order'] } : t)));
    expect(check(loose)).toContain('service inventory-api: task T2-reserve-stock must depend on T0-scaffold-inventory-api');
  });

  it('asks for commands.smoke only in the service that delivers a smoke criterion', () => {
    const plan = makeServicesPlan(spec);
    const noSmoke = (name: 'orders-api' | 'inventory-api') => ({ ...plan.services[name]!, commands: { ...plan.services[name]!.commands, smoke: undefined } });
    expect(check({ ...plan, services: { ...plan.services, 'inventory-api': noSmoke('inventory-api') } })).toEqual([]);
    expect(check({ ...plan, services: { ...plan.services, 'orders-api': noSmoke('orders-api') } })).toEqual(['service orders-api: commands.smoke is required: AC-001 is a smoke criterion']);
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
