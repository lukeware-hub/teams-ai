import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase5, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { makeFrozenSpec, makePlan, makeProject } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
let remote: Remote;
let journal: Journal;

beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(smokeDetail: string, destroyed: string[] = []): PhaseDeps {
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  const target = {
    name: 'docker-local' as const,
    validate: async () => [],
    build: async () => undefined,
    apply: async () => ({ previous: null }),
    verify: async () => ({ healthy: true, detail: 'HTTP 200' }),
    currentImage: async () => null,
    rollback: async () => undefined,
    destroy: async () => { destroyed.push('destroyed'); },
    serviceUrl: async () => 'http://127.0.0.1:3000',
  };
  return { journal, ws, spec, project, specHash: HASH, firstSpec: true, exec: execCommand, plan: makePlan(spec), target, smoke: async () => ({ ok: false, rows: [], detail: smokeDetail, result: null }) } as unknown as PhaseDeps;
}

describe('Phase 5', () => {
  it('a smoke failure caused by a missing plan.commands.smoke plans no deploy-fix task (the Dev cannot edit the plan)', async () => {
    const r = await runPhase5(deps('plan.commands.smoke missing'), 1);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.fixTask).toBeUndefined();
    expect(journal.events.some((e) => e.type === OrchEvent.DeployFailed && e.data.stage === 'smoke')).toBe(true);
    expect(journal.events.some((e) => e.type === 'FIX_TASKS_PLANNED')).toBe(false);
  });

  it('any other smoke failure still plans a deploy-fix task for the Dev', async () => {
    const r = await runPhase5(deps('AC-001: smoke test failed'), 1);
    expect(r.ok ? null : r.fixTask?.origin).toBe('deploy-fix');
  });

  it('a first deploy (no previous image) that fails the smoke takes its stack down, so it cannot hold the port for the next attempt or project', async () => {
    const destroyed: string[] = [];
    const r = await runPhase5(deps('AC-001: smoke test failed', destroyed), 1);
    expect(r.ok).toBe(false);
    expect(destroyed).toEqual(['destroyed']);
  });

  it('with fixTasks off (deploy-only runs) a failure plans no deploy-fix task', async () => {
    const r = await runPhase5(deps('AC-001: smoke test failed'), 1, { fixTasks: false });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.fixTask).toBeUndefined();
    expect(r.ok ? '' : r.reason).toContain('AC-001: smoke test failed');
    expect(journal.events.some((e) => e.type === 'FIX_TASKS_PLANNED')).toBe(false);
  });
});
