import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { Journal } from '../../server/orchestrator/events.js';
import { runPhase4, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/run.test.ts', readmeSections: ['Run'] };
const ALL = { Dockerfile: 'FROM node', 'docker-compose.yml': 'services: {}', '.github/workflows/ci.yml': 'on: push', '.github/workflows/release.yml': 'on: push', 'e2e/run.test.ts': '//' };

let remote: Remote;
let journal: Journal;
let gateCalls = 0;
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

async function setup(files: Record<string, string>, withDelivery = true) {
  remote = await makeRemote(files);
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
  gateCalls = 0;
  return {
    journal, ws: { repo: remote.repo }, spec, exec: execCommand, firstSpec: false,
    plan: makePlan(spec, withDelivery ? { delivery } : {}), tasks: () => [],
    gates: async () => { gateCalls++; return { results: [], blockingFailure: null }; },
  } as unknown as PhaseDeps;
}

describe('Phase 4 delivery contract', () => {
  it('fails with the missing files named, before any gate runs', async () => {
    const deps = await setup({ Dockerfile: 'FROM node', 'docker-compose.yml': 'x' });
    const res = await runPhase4(deps, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('delivery contract not met on main, missing: ciWorkflow: .github/workflows/ci.yml, releaseWorkflow: .github/workflows/release.yml, e2eSuite: e2e/run.test.ts');
    expect(gateCalls).toBe(0);
  });

  it('moves on to the gates when every listed file is on main', async () => {
    const deps = await setup(ALL);
    await runPhase4(deps, 1).catch(() => undefined);
    expect(gateCalls).toBeGreaterThan(0);
  });

  it('ignores the contract for a plan without delivery', async () => {
    const deps = await setup({ 'a.txt': 'a' }, false);
    await runPhase4(deps, 1).catch(() => undefined);
    expect(gateCalls).toBeGreaterThan(0);
  });
});
