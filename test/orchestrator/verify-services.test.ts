import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { servicePlans, type ServicesPlan } from '../../server/contracts/plan.js';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase4, type PhaseDeps, type ServiceRepo } from '../../server/orchestrator/phases/index.js';
import { makeFrozenSpec, makeServicesPlan } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/run.test.ts', readmeSections: ['Run'] };
const unitGate = (ac: string, passed: boolean): GateResult => ({
  name: 'unit-test', blocking: true, passed, exitCode: passed ? 0 : 1, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: '',
  junit: [{ id: `t::[${ac}] works`, name: `[${ac}] works`, classname: 't', status: passed ? 'passed' : 'failed', acIds: [ac] }], failure: passed ? null : 'code',
});

let remotes: Remote[] = [];
let journal: Journal;
afterEach(async () => {
  await journal.close();
  for (const r of remotes) await r.cleanup();
  remotes = [];
});

/** orders-api delivers AC-001 and inventory-api, a new repository, delivers AC-002 (makeServicesPlan). */
async function setup(plan: ServicesPlan, passed: Record<string, boolean>): Promise<PhaseDeps> {
  const repos: ServiceRepo[] = [];
  for (const view of servicePlans(plan)) {
    const remote = await makeRemote({ 'README.md': '#\n' });
    remotes.push(remote);
    const result = unitGate(view.service === 'orders-api' ? 'AC-001' : 'AC-002', passed[view.service!]!);
    repos.push({ ...view, ws: { repo: remote.repo } as ServiceRepo['ws'], firstSpec: view.service === 'inventory-api', gates: async () => ({ results: [result], blockingFailure: result.passed ? null : result }) });
  }
  journal = await Journal.open({ file: path.join(remotes[0]!.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
  return { journal, ws: { repo: remotes[0]!.repo }, spec, exec: execCommand, firstSpec: false, tasks: () => [], services: { plan, repos } } as unknown as PhaseDeps;
}

describe('Phase 4 with several services', () => {
  it('passes once with one matrix when each criterion is proven in the repository of the service that delivers it', async () => {
    const res = await runPhase4(await setup(makeServicesPlan(spec), { 'orders-api': true, 'inventory-api': true }), 1);
    expect(res.ok).toBe(true);
    const passed = journal.events.filter((e) => e.type === OrchEvent.VerificationPassed);
    expect(passed).toHaveLength(1);
    expect((passed[0]!.data.matrix as Array<{ criterion: string; status: string }>).map((r) => [r.criterion, r.status])).toEqual([['AC-001', 'passed'], ['AC-002', 'passed']]);
    expect(journal.events.filter((e) => e.type === OrchEvent.GatePassed).map((e) => e.data.service)).toEqual(['orders-api', 'inventory-api']);
  });

  it("fails the spec when one service's tests fail", async () => {
    const res = await runPhase4(await setup(makeServicesPlan(spec), { 'orders-api': true, 'inventory-api': false }), 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('verification failed in round 2: 1 failing tests, 0 uncovered criteria; gate unit-test failed');
  });

  it("plans the delivery fix tasks in the service whose repository misses files, after that service's scaffold", async () => {
    const base = makeServicesPlan(spec);
    const plan = { ...base, services: { ...base.services, 'inventory-api': { ...base.services['inventory-api']!, delivery } } };
    const res = await runPhase4(await setup(plan, { 'orders-api': true, 'inventory-api': true }), 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('inventory-api: dockerfile: Dockerfile');
    expect(res.fixTasks?.map((t) => [t.id, t.service, t.dependsOn])).toEqual([
      ['T900-fix-1', 'inventory-api', ['T0-scaffold-inventory-api']],
      ['T900-fix-2', 'inventory-api', ['T0-scaffold-inventory-api']],
    ]);
  });
});
