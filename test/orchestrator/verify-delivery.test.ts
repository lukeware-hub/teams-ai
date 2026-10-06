import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { Journal } from '../../server/orchestrator/events.js';
import { runPhase4, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/run.test.ts', readmeSections: ['Run'] };
const PINNED_DOCKERFILE = 'FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7';
const ALL = { Dockerfile: PINNED_DOCKERFILE, 'docker-compose.yml': 'services: {}', '.github/workflows/ci.yml': 'on: push', '.github/workflows/release.yml': 'on: push', 'e2e/run.test.ts': '//' };

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
    journal, ws: { repo: remote.repo }, spec, exec: execCommand, firstSpec: true,
    plan: makePlan(spec, withDelivery ? { delivery } : {}), tasks: () => [],
    gates: async () => { gateCalls++; return { results: [], blockingFailure: null }; },
  } as unknown as PhaseDeps;
}

describe('Phase 4 delivery contract', () => {
  it('fails with the missing files named, before any gate runs', async () => {
    const deps = await setup({ Dockerfile: PINNED_DOCKERFILE, 'docker-compose.yml': 'x' });
    const res = await runPhase4(deps, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('delivery contract not met on main, missing: ciWorkflow: .github/workflows/ci.yml, releaseWorkflow: .github/workflows/release.yml, e2eSuite: e2e/run.test.ts; fix tasks planned');
    expect(gateCalls).toBe(0);
  });

  it('plans a devops fix task for missing infra and a dev task for the e2e suite in round 1', async () => {
    const deps = await setup({ Dockerfile: PINNED_DOCKERFILE });
    const res = await runPhase4(deps, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fixTasks?.map((t) => [t.id, t.owner, t.origin])).toEqual([['T900-fix-1', 'devops', 'fix'], ['T900-fix-2', 'dev', 'fix']]);
    expect(res.fixTasks?.[0].affectedPaths).toEqual(['docker-compose.yml', '.github/workflows/ci.yml', '.github/workflows/release.yml']);
    expect(res.fixTasks?.[1].affectedPaths).toEqual(['e2e/run.test.ts']);
    expect(journal.events.some((e) => e.type === 'FIX_TASKS_PLANNED' || String(e.type).includes('FixTasks'))).toBe(true);
  });

  it('fails without fix tasks in round 2', async () => {
    const deps = await setup({ Dockerfile: 'FROM node' });
    const res = await runPhase4(deps, 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fixTasks).toBeUndefined();
  });

  it('skips the README check while docs/README.md does not exist (Phase 6 writes it later)', async () => {
    const deps = await setup(ALL);
    await runPhase4(deps, 1).catch(() => undefined);
    expect(gateCalls).toBeGreaterThan(0);
  });

  it('requires the planned README sections once docs/README.md exists on main', async () => {
    const deps = await setup({ ...ALL, 'docs/README.md': '# Project\n\n## Install\n' });
    const res = await runPhase4(deps, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.reason).toContain('readmeSections: Run'); expect(res.fixTasks?.[0]).toMatchObject({ owner: 'dev', affectedPaths: ['docs/README.md'] }); }
    expect(gateCalls).toBe(0);
  });

  it('accepts an existing README that carries the planned sections', async () => {
    const deps = await setup({ ...ALL, 'docs/README.md': '# Project\n\n## How to Run\n' });
    await runPhase4(deps, 1).catch(() => undefined);
    expect(gateCalls).toBeGreaterThan(0);
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

  it('plans a devops fix task for an unpinned base image (roadmap R10.2)', async () => {
    const deps = await setup({ ...ALL, Dockerfile: 'FROM node:latest' });
    const res = await runPhase4(deps, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('dockerfilePinning: Dockerfile');
      expect(res.fixTasks?.[0]).toMatchObject({ owner: 'devops', affectedPaths: ['Dockerfile'] });
      expect(res.fixTasks?.[0].description).toContain('unpinned base image(s): node:latest');
    }
    expect(gateCalls).toBe(0);
  });

  it('moves on to the gates when the base image is pinned', async () => {
    const deps = await setup(ALL);
    await runPhase4(deps, 1).catch(() => undefined);
    expect(gateCalls).toBeGreaterThan(0);
  });

  it('plans a dev fix task for a missing lockfile, with no fixed filename assumed', async () => {
    remote = await makeRemote(ALL);
    journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
    const deps = {
      journal, ws: { repo: remote.repo }, spec, exec: execCommand, firstSpec: true,
      plan: makePlan(spec, { delivery, lockfilePath: 'poetry.lock' }), tasks: () => [],
      gates: async () => { gateCalls++; return { results: [], blockingFailure: null }; },
    } as unknown as PhaseDeps;
    const res = await runPhase4(deps, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('lockfilePath: poetry.lock');
      expect(res.fixTasks?.[0]).toMatchObject({ owner: 'dev', affectedPaths: ['poetry.lock'] });
    }
  });

  it('accepts a plan whose lockfile is present on main', async () => {
    remote = await makeRemote({ ...ALL, 'poetry.lock': 'x' });
    journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
    gateCalls = 0;
    const deps = {
      journal, ws: { repo: remote.repo }, spec, exec: execCommand, firstSpec: true,
      plan: makePlan(spec, { delivery, lockfilePath: 'poetry.lock' }), tasks: () => [],
      gates: async () => { gateCalls++; return { results: [], blockingFailure: null }; },
    } as unknown as PhaseDeps;
    await runPhase4(deps, 1).catch(() => undefined);
    expect(gateCalls).toBeGreaterThan(0);
  });
});
