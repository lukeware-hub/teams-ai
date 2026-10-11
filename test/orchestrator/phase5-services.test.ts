import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { servicePlans, type ServicesPlan } from '../../server/contracts/plan.js';
import type { DeploymentIntent } from '../../server/deploy/target.js';
import { execCommand } from '../../server/exec/command.js';
import { Intent, Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runServicesPhase5 } from '../../server/orchestrator/phases/deploy.js';
import type { GateScope, PhaseDeps, ServiceRepo } from '../../server/orchestrator/phases/shared.js';
import { makeFrozenSpec, makeProject, makeServicesPlan } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
/** Each service deploys with its own compose file. */
const withCompose = (p: ServicesPlan): ServicesPlan => ({ ...p, services: Object.fromEntries(Object.entries(p.services).map(([name, s]) => [name, { ...s, delivery: { compose: 'docker-compose.yml' } }])) });
const plan = withCompose(makeServicesPlan(spec));
let remotes: Remote[] = [];
let dirs: string[] = [];
let journal: Journal;
afterEach(async () => {
  await journal.close();
  for (const r of remotes) await r.cleanup();
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  remotes = [];
  dirs = [];
});

interface TargetOpts {
  /** The step that fails, as `<action>:<service>`. */
  fail?: string;
  applyError?: string;
  /** The image each service ran before this deploy. */
  previous?: Record<string, string>;
  unhealthy?: string;
  urlThrows?: string;
}

/** A target that records what it does. */
function target(log: string[], o: TargetOpts = {}) {
  const step = (action: string, i: DeploymentIntent) => {
    log.push(`${action}:${i.shared?.alias ?? '-'}`);
    return o.fail === `${action}:${i.shared?.alias}`;
  };
  return {
    name: 'docker-local' as const,
    validate: async () => [],
    build: async () => undefined,
    apply: async (i: DeploymentIntent) => { if (step('apply', i)) throw new Error(o.applyError ?? 'apply failed'); return { previous: o.previous?.[i.shared!.alias] ?? null }; },
    verify: async (i: DeploymentIntent) => (o.unhealthy === i.shared?.alias ? { healthy: false, detail: 'no response after 60 attempts' } : { healthy: true, detail: 'HTTP 200' }),
    currentImage: async () => null,
    rollback: async (i: DeploymentIntent) => { if (step('rollback', i)) throw new Error('rollback up failed'); },
    destroy: async (i: DeploymentIntent) => { step('destroy', i); },
    serviceUrl: (i: DeploymentIntent) => `http://127.0.0.1:${i.port}`,
    gateServiceUrl: (i: DeploymentIntent) => { if (o.urlThrows === i.shared!.alias) throw new Error('no container port'); return `http://${i.shared!.alias}:${i.port}`; },
    gateNetwork: (i: DeploymentIntent) => i.shared!.network,
    startPlatform: async () => { log.push('platform'); return o.fail === 'platform' ? { ok: false, detail: 'nats did not start' } : { ok: true, detail: 'platform up' }; },
  };
}

async function setup(log: string[], opts: TargetOpts & { e2eFails?: string; detail?: string; plan?: ServicesPlan; services?: string[]; ports?: Record<string, number> } = {}): Promise<{ deps: PhaseDeps; scopes: GateScope[]; root: string }> {
  const repos: ServiceRepo[] = [];
  for (const view of servicePlans(opts.plan ?? plan)) {
    const remote = await makeRemote({ 'README.md': '#\n' });
    remotes.push(remote);
    repos.push({ ...view, ws: { repo: remote.repo } as ServiceRepo['ws'], firstSpec: false, gates: async () => ({ results: [], blockingFailure: null }) });
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-p5s-'));
  dirs.push(root);
  if (opts.ports) await fs.writeFile(path.join(root, '.ports.json'), JSON.stringify(opts.ports));
  journal = await Journal.open({ file: path.join(remotes[0]!.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
  const scopes: GateScope[] = [];
  const gate = (kind: string) => async (_dir: string, _url: string, _gate?: string, _net?: string, scope?: GateScope) => {
    scopes.push(scope!);
    log.push(`${kind}:${scope!.service}`);
    const ok = opts.e2eFails !== `${kind}:${scope!.service}`;
    return { ok, rows: [], detail: ok ? 'passed' : opts.detail ?? `${kind} failed` };
  };
  const deps = {
    journal, ws: { repo: remotes[0]!.repo, projectId: 'shop' }, spec, workspacesRoot: root,
    project: makeProject({ projectId: 'shop', services: opts.services ?? ['orders', 'inventory'], platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] }),
    exec: new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s)).exec,
    target: target(log, opts), smoke: gate('smoke'), e2e: gate('e2e'), requireE2e: true,
    services: { plan: opts.plan ?? plan, repos },
  } as unknown as PhaseDeps;
  return { deps, scopes, root };
}

const failure = () => journal.events.find((e) => e.type === OrchEvent.DeployFailed)!.data;

describe('Phase 5 with several services', () => {
  it('starts the platform, deploys every service, then proves each one with the addresses of the others', async () => {
    const log: string[] = [];
    const { deps, scopes } = await setup(log);
    expect(await runServicesPhase5(deps, 1)).toEqual({ ok: true });
    expect(log).toEqual(['platform', 'apply:orders', 'apply:inventory', 'smoke:orders', 'e2e:orders', 'smoke:inventory', 'e2e:inventory']);
    expect(scopes.find((s) => s.service === 'inventory')!.urls).toEqual({ SERVICE_URL_ORDERS: 'http://orders:3000' });
    expect(scopes.find((s) => s.service === 'orders')!.spec.acceptanceCriteria.map((ac) => ac.id)).toEqual(['AC-001']);
    const verified = journal.events.find((e) => e.type === OrchEvent.DeployVerified)!.data;
    expect(verified).toMatchObject({ attempt: 1, url: 'http://127.0.0.1:3000', port: 3000, smoke: [] });
    expect((verified.services as Array<{ service: string }>).map((s) => s.service)).toEqual(['orders', 'inventory']);
  });

  it('rolls back every applied service when one fails, and plans the fix in the failing service', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { e2eFails: 'e2e:inventory' });
    const res = await runServicesPhase5(deps, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(log.slice(-2)).toEqual(['destroy:inventory', 'destroy:orders']);
    expect(res.fixTask).toMatchObject({ service: 'inventory', owner: 'dev', origin: 'deploy-fix' });
    expect(failure()).toMatchObject({ attempt: 1, stage: 'e2e', service: 'inventory' });
  });

  it('ends without a fix task when the platform does not start', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { fail: 'platform' });
    const res = await runServicesPhase5(deps, 1);
    expect(res).toEqual({ ok: false, reason: 'deploy failed on attempt 1 at platform: nats did not start' });
    expect(log).toEqual(['platform']);
  });

  it('ends without a fix task when a service plan lacks the suite command, which no Dev may add', async () => {
    const { deps } = await setup([], { e2eFails: 'e2e:inventory', detail: 'plan.commands.e2e missing' });
    expect(await runServicesPhase5(deps, 1)).toEqual({ ok: false, reason: 'deploy failed at e2e (inventory): plan.commands.e2e missing' });
  });

  it('checks a resumed service still answers before its suites run', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { unhealthy: 'orders' });
    for (const s of ['orders', 'inventory']) {
      await journal.intent(Intent.DeployApply, `deploy-${s}-1`, { attempt: 1, service: s });
      await journal.confirm(Intent.DeployApply, `deploy-${s}-1`, { previous: null });
    }
    expect((await runServicesPhase5(deps, 1)).ok).toBe(false);
    expect(log.filter((l) => /^(apply|smoke|e2e):/.test(l))).toEqual([]);
    expect(failure()).toMatchObject({ stage: 'verify', service: 'orders' });
  });

  it('says when a rollback failed instead of reporting the service restored', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { e2eFails: 'e2e:inventory', previous: { orders: 'orders:old' }, fail: 'rollback:orders' });
    expect((await runServicesPhase5(deps, 1)).ok).toBe(false);
    expect(log.slice(-2)).toEqual(['destroy:inventory', 'rollback:orders']);
    expect(failure()).toMatchObject({ rolledBack: false, rollbackHealthy: false });
    expect(String(failure().detail)).toContain('rollback failed for orders: rollback up failed');
    expect(journal.events.some((e) => e.type === OrchEvent.RollbackDone)).toBe(false);
  });

  it('journals the services that went back to their previous image', async () => {
    const { deps } = await setup([], { e2eFails: 'e2e:inventory', previous: { orders: 'orders:old' } });
    await runServicesPhase5(deps, 1);
    expect(failure()).toMatchObject({ rolledBack: true });
    expect(journal.events.find((e) => e.type === OrchEvent.RollbackDone)!.data).toEqual({ attempt: 1, services: ['orders'] });
  });

  it('moves a taken port to one no sibling service plans, only when a fix task follows, and deploys there next', async () => {
    const ported = { ...plan, services: { orders: { ...plan.services.orders!, deploy: { ...plan.services.orders!.deploy, port: 20051 } }, inventory: { ...plan.services.inventory!, deploy: { ...plan.services.inventory!.deploy, port: 20050 } } } };
    // Every port of the range is another project's but 20050 (inventory's), 20051 (orders', held by a stranger) and 20052.
    const ports = Object.fromEntries(Array.from({ length: 100 }, (_, i) => 20000 + i).filter((p) => p < 20050 || p > 20052).map((p) => [`other-${p}`, p]));
    const log: string[] = [];
    const quiet = await setup(log, { plan: ported, ports, fail: 'apply:orders', applyError: 'Bind for 0.0.0.0:20051 failed: port is already allocated' });
    await runServicesPhase5(quiet.deps, 3);
    expect(journal.events.some((e) => e.type === OrchEvent.DeployPortReassigned)).toBe(false);
    await journal.close();
    const { deps } = await setup(log, { plan: ported, ports, fail: 'apply:orders', applyError: 'Bind for 0.0.0.0:20051 failed: port is already allocated' });
    const res = await runServicesPhase5(deps, 1);
    expect(res.ok ? null : res.fixTask).toMatchObject({ service: 'orders', owner: 'devops' });
    expect(journal.events.find((e) => e.type === OrchEvent.DeployPortReassigned)!.data).toEqual({ from: 20051, to: 20052, service: 'orders' });
    (deps as { target: unknown }).target = target(log);
    expect(await runServicesPhase5(deps, 2)).toEqual({ ok: true });
    const verified = [...journal.events].reverse().find((e) => e.type === OrchEvent.DeployVerified)!.data;
    expect((verified.services as Array<{ service: string; port: number }>).map((s) => [s.service, s.port])).toEqual([['orders', 20052], ['inventory', 20050]]);
  });

  it('gives the suites the address of a service this spec does not change, from its registered port', async () => {
    const { deps, scopes } = await setup([], { services: ['orders', 'inventory', 'ledger'], ports: { 'shop/ledger': 20009 } });
    await runServicesPhase5(deps, 1);
    expect(scopes.find((s) => s.service === 'orders')!.urls).toEqual({ SERVICE_URL_INVENTORY: 'http://inventory:3001', SERVICE_URL_LEDGER: 'http://ledger:20009' });
  });

  it("refuses a service without a compose file, which would replace the project's single container", async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { plan: makeServicesPlan(spec) });
    const res = await runServicesPhase5(deps, 1);
    expect(res.ok ? null : res.fixTask).toBeUndefined();
    expect(log).toEqual([]);
    expect(failure()).toMatchObject({ stage: 'validate', service: 'orders' });
  });

  it('rolls back what it applied when a service address cannot be read', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { urlThrows: 'inventory' });
    expect((await runServicesPhase5(deps, 1)).ok).toBe(false);
    expect(log.slice(-2)).toEqual(['destroy:inventory', 'destroy:orders']);
    expect(failure()).toMatchObject({ stage: 'verify', service: 'inventory', detail: 'no container port' });
  });
});
