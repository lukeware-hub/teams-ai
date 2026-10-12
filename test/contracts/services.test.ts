import { describe, expect, it } from 'vitest';
import { AnyPlan, parseAnyPlan, Plan, servicePlans, ServicesPlan } from '../../server/contracts/plan.js';
import type { PlatformService } from '../../server/contracts/project.js';
import { makeFrozenSpec, makePlan, makeProject, makeServicesPlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();

describe('Project.services', () => {
  it('is optional and holds unique lowercase names', () => {
    expect(makeProject().services).toBeUndefined();
    expect(makeProject({ services: ['orders', 'inventory'] }).services).toEqual(['orders', 'inventory']);
    expect(() => makeProject({ services: ['orders', 'orders'] })).toThrow('service names must be unique');
    expect(() => makeProject({ services: ['Orders'] })).toThrow();
  });

  const withPlatform = (platform: PlatformService[]) => makeProject({ services: ['orders'], platform });

  it('declares platform containers with a pinned image and unique names', () => {
    const nats = { name: 'nats', image: 'nats:2.10.22-alpine', command: ['-js', '-m', '8222'] };
    expect(withPlatform([nats]).platform).toEqual([nats]);
    expect(() => withPlatform([{ name: 'nats', image: 'nats:latest' }])).toThrow('pin the image');
    expect(() => withPlatform([{ name: 'nats', image: 'nats' }])).toThrow('pin the image');
    expect(() => withPlatform([nats, nats])).toThrow('platform names must be unique');
  });

  it('takes platform settings as written: dotted environment names, and a healthcheck that starts with CMD, CMD-SHELL or NONE', () => {
    const search = { name: 'search', image: 'elasticsearch:8.15.0', environment: { 'discovery.type': 'single-node' }, healthcheck: ['CMD-SHELL', 'curl -f localhost:9200'] };
    expect(withPlatform([search]).platform).toEqual([search]);
    expect(() => withPlatform([{ ...search, healthcheck: ['curl', '-f', 'localhost:9200'] }])).toThrow('CMD');
  });

  it('refuses a platform in a project without services: nothing would start it', () => {
    expect(() => makeProject({ platform: [{ name: 'nats', image: 'nats:2.10.22' }] })).toThrow('platform containers need services');
    expect(makeProject({ platform: [] }).platform).toEqual([]);
  });

  it('refuses a platform container named like a service: both would answer to that name on the shared network', () => {
    expect(() => makeProject({ services: ['orders'], platform: [{ name: 'orders', image: 'nats:2.10.22' }] })).toThrow('cannot share a name');
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

describe('parseAnyPlan', () => {
  it('parses a plan of either shape, and reports a broken services plan against its own shape only', () => {
    const plan = makeServicesPlan(makeFrozenSpec());
    expect(parseAnyPlan(plan)).toEqual(ServicesPlan.parse(plan));
    const single = makePlan(makeFrozenSpec());
    expect(parseAnyPlan(single)).toEqual(Plan.parse(single));
    const { tasks: _, ...noTasks } = plan;
    expect(() => parseAnyPlan(noTasks)).toThrow(/"tasks"/);
    expect(() => parseAnyPlan(noTasks)).not.toThrow(/gateImage/);
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
