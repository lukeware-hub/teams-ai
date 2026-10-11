import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { servicePlans, type ServicesPlan } from '../../server/contracts/plan.js';
import type { DeploymentIntent } from '../../server/deploy/target.js';
import { execCommand } from '../../server/exec/command.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runServicesPhase5 } from '../../server/orchestrator/phases/deploy.js';
import type { GateScope, PhaseDeps, ServiceRepo } from '../../server/orchestrator/phases/shared.js';
import { makeFrozenSpec, makeProject, makeServicesPlan } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const plan: ServicesPlan = makeServicesPlan(spec);
let remotes: Remote[] = [];
let journal: Journal;
afterEach(async () => {
  await journal.close();
  for (const r of remotes) await r.cleanup();
  remotes = [];
});

/** A target that records what it does; `fail` names the step that fails, as `<action>:<service>`. */
function target(log: string[], fail?: string) {
  const step = (action: string, i: DeploymentIntent) => {
    log.push(`${action}:${i.shared?.alias ?? '-'}`);
    return fail === `${action}:${i.shared?.alias}`;
  };
  return {
    name: 'docker-local' as const,
    validate: async () => [],
    build: async () => undefined,
    apply: async (i: DeploymentIntent) => { if (step('apply', i)) throw new Error('apply failed'); return { previous: null }; },
    verify: async () => ({ healthy: true, detail: 'HTTP 200' }),
    currentImage: async () => null,
    rollback: async (i: DeploymentIntent) => { step('rollback', i); },
    destroy: async (i: DeploymentIntent) => { step('destroy', i); },
    serviceUrl: (i: DeploymentIntent) => `http://127.0.0.1:${i.port}`,
    gateServiceUrl: (i: DeploymentIntent) => `http://${i.shared!.alias}:${i.port}`,
    gateNetwork: (i: DeploymentIntent) => i.shared!.network,
    startPlatform: async () => { log.push('platform'); return fail === 'platform' ? { ok: false, detail: 'nats did not start' } : { ok: true, detail: 'platform up' }; },
  };
}

async function setup(log: string[], opts: { fail?: string; e2eFails?: string; detail?: string } = {}): Promise<{ deps: PhaseDeps; scopes: GateScope[] }> {
  const repos: ServiceRepo[] = [];
  for (const view of servicePlans(plan)) {
    const remote = await makeRemote({ 'README.md': '#\n' });
    remotes.push(remote);
    repos.push({ ...view, ws: { repo: remote.repo } as ServiceRepo['ws'], firstSpec: false, gates: async () => ({ results: [], blockingFailure: null }) });
  }
  journal = await Journal.open({ file: path.join(remotes[0]!.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
  const scopes: GateScope[] = [];
  const gate = (kind: string) => async (_dir: string, _url: string, _gate?: string, _net?: string, scope?: GateScope) => {
    scopes.push(scope!);
    log.push(`${kind}:${scope!.service}`);
    const ok = opts.e2eFails !== `${kind}:${scope!.service}`;
    return { ok, rows: [], detail: ok ? 'passed' : opts.detail ?? `${kind} failed` };
  };
  const deps = {
    journal, ws: { repo: remotes[0]!.repo, projectId: 'shop' }, spec, project: makeProject({ projectId: 'shop', services: ['orders', 'inventory'], platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] }),
    exec: new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s)).exec,
    target: target(log, opts.fail), smoke: gate('smoke'), e2e: gate('e2e'), requireE2e: true,
    services: { plan, repos },
  } as unknown as PhaseDeps;
  return { deps, scopes };
}

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
    expect(journal.events.find((e) => e.type === OrchEvent.DeployFailed)!.data).toMatchObject({ attempt: 1, stage: 'e2e', service: 'inventory' });
  });

  it('ends without a fix task when the platform does not start', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { fail: 'platform' });
    const res = await runServicesPhase5(deps, 1);
    expect(res).toEqual({ ok: false, reason: 'deploy failed on attempt 1 at platform: nats did not start' });
    expect(log).toEqual(['platform']);
  });

  it('ends without a fix task when a service plan lacks the suite command, which no Dev may add', async () => {
    const log: string[] = [];
    const { deps } = await setup(log, { e2eFails: 'e2e:inventory', detail: 'plan.commands.e2e missing' });
    const res = await runServicesPhase5(deps, 1);
    expect(res).toEqual({ ok: false, reason: 'deploy failed at e2e (inventory): plan.commands.e2e missing' });
  });
});
