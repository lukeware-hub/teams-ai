import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase5, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { deployStartAttempt } from '../../server/orchestrator/phases/deploy.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
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
  /** The run's earlier attempt: its failure, the fix task planned for it, and that fix's commit and final state. */
  async function earlierAttempt(attempt: number, stage: string, detail: string, fix: { id: string; state: 'merged' | 'blocked'; summary?: string; files?: string[] }, service?: string): Promise<void> {
    await journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail, rolledBack: false, rollbackHealthy: null, tag: 't', ...(service ? { service } : {}) });
    await journal.fact(RunEvent.FixTasksPlanned, { tasks: [makePlanTask({ id: fix.id, origin: 'deploy-fix', ...(service ? { service } : {}) })] });
    const states = fix.state === 'merged' ? ['ready', 'implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'merged'] : ['ready', 'implementing', 'blocked'];
    for (const to of states) await journal.fact(RunEvent.TaskStateChanged, { taskId: fix.id, to });
    if (fix.summary) await journal.fact(OrchEvent.DevCommitted, { taskId: fix.id, sha: 'abc', changedFiles: fix.files ?? [], summary: fix.summary });
  }

  it('a deploy fix lists every earlier failure of the run and what the fix after it changed', async () => {
    await earlierAttempt(1, 'smoke', 'AC-001: no smoke test\n' + 'gate log line\n'.repeat(2000), { id: 'T950-deploy-fix-1', state: 'merged', summary: 'added the smoke suite', files: ['smoke/smoke.test.mjs'] });
    const r = await runPhase5(deps('AC-002: smoke test failed'), 2);
    const task = r.ok ? null : r.fixTask;
    expect(task?.id).toBe('T950-deploy-fix-2');
    expect(task?.description).toContain('Earlier deploy attempts of this run:\n- attempt 1 failed at smoke: AC-001: no smoke test\n  then T950-deploy-fix-1 merged: added the smoke suite (files: smoke/smoke.test.mjs)');
    expect(task?.description).not.toContain('gate log line');
    expect(task?.description).not.toContain('did not change this failure');
  });

  it('says the previous fix did not change a failure that came back the same', async () => {
    await earlierAttempt(1, 'smoke', 'AC-001: no smoke test', { id: 'T950-deploy-fix-1', state: 'merged', summary: 'renamed the test', files: ['smoke/smoke.test.mjs'] });
    const r = await runPhase5(deps('AC-001: no smoke test'), 2);
    expect(r.ok ? null : r.fixTask?.description).toContain('The fix of attempt 1 (T950-deploy-fix-1) did not change this failure: look for another cause before changing the same lines again.');
  });

  it('lists an attempt replayed after a crash once, and an earlier fix that ended blocked by its state', async () => {
    await journal.fact(OrchEvent.DeployFailed, { attempt: 1, stage: 'verify', detail: 'unhealthy before the crash', rolledBack: false, rollbackHealthy: null, tag: 't' });
    await earlierAttempt(1, 'smoke', 'AC-001: no smoke test', { id: 'T950-deploy-fix-1', state: 'blocked' });
    const r = await runPhase5(deps('AC-002: smoke test failed'), 2);
    const description = r.ok ? '' : r.fixTask?.description ?? '';
    expect(description.match(/- attempt 1 failed/g)).toHaveLength(1);
    expect(description).toContain('- attempt 1 failed at smoke: AC-001: no smoke test\n  then T950-deploy-fix-1 blocked');
    expect(description).not.toContain('unhealthy before the crash');
  });

  it('a first deploy attempt gets today\'s fix task description, with no history', async () => {
    const r = await runPhase5(deps('AC-001: smoke test failed'), 1);
    expect(r.ok ? null : r.fixTask?.description).not.toContain('Earlier deploy attempts');
  });

  /** The fix of attempt 1, replanned once it ran out of attempts into one replacement that ends in `state`. */
  async function replannedFix(state: 'merged' | 'blocked' | 'implementing', summary = 'split the suite', files = ['smoke/a.mjs']): Promise<void> {
    await journal.fact(OrchEvent.DeployFailed, { attempt: 1, stage: 'smoke', detail: 'AC-001: no smoke test', rolledBack: false, rollbackHealthy: null, tag: 't' });
    await journal.fact(RunEvent.FixTasksPlanned, { tasks: [makePlanTask({ id: 'T950-deploy-fix-1', origin: 'deploy-fix' })] });
    for (const to of ['ready', 'implementing']) await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T950-deploy-fix-1', to });
    await journal.fact(RunEvent.TaskReplanned, { taskId: 'T950-deploy-fix-1', replacements: [makePlanTask({ id: 'T950-deploy-fix-1-r1', origin: 'deploy-fix' })] });
    const states = { merged: ['ready', 'implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'merged'], blocked: ['ready', 'implementing', 'blocked'], implementing: ['ready', 'implementing'] }[state];
    for (const to of states) await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T950-deploy-fix-1-r1', to });
    await journal.fact(OrchEvent.DevCommitted, { taskId: 'T950-deploy-fix-1-r1', sha: 'def', changedFiles: files, summary });
  }

  it('follows a replanned fix to its replacement, never to a fix whose id only starts the same', async () => {
    await replannedFix('merged');
    await journal.fact(OrchEvent.DevCommitted, { taskId: 'T950-deploy-fix-10', sha: 'fed', changedFiles: ['x'], summary: 'another fix' });
    const r = await runPhase5(deps('AC-001: no smoke test'), 2);
    const description = r.ok ? '' : r.fixTask?.description ?? '';
    expect(description).toContain('then T950-deploy-fix-1 replaced by T950-deploy-fix-1-r1 merged: split the suite (files: smoke/a.mjs)');
    expect(description).not.toContain('another fix');
    // Every replacement merged and the same failure came back: the note fires as for a fix that merged itself.
    expect(description).toContain('The fix of attempt 1 (T950-deploy-fix-1) did not change this failure');
  });

  it('counts a replanned fix as a finished attempt only once every replacement ended, so a resumed run moves on', async () => {
    await replannedFix('implementing');
    expect(deployStartAttempt(deps('x'))).toBe(1);
    for (const to of ['validating', 'reviewing', 'rebasing', 'merging', 'merged']) await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T950-deploy-fix-1-r1', to });
    expect(deployStartAttempt(deps('x'))).toBe(2);
  });

  it('never pairs a fix with an earlier failure when a resumed run deploys an attempt it had already reached', async () => {
    await earlierAttempt(1, 'smoke', 'AC-001: no smoke test', { id: 'T950-deploy-fix-1', state: 'merged', summary: 'renamed the test', files: ['smoke/a.mjs'] });
    // Attempt 2 failed and its fix was planned before the crash; the resumed run deploys attempt 2 again.
    await earlierAttempt(2, 'e2e', 'AC-002: failed', { id: 'T950-deploy-fix-2', state: 'merged', summary: 'fixed the e2e request', files: ['e2e/x.mjs'] });
    const r = await runPhase5(deps('AC-003: smoke test failed'), 2);
    const description = r.ok ? '' : r.fixTask?.description ?? '';
    expect(description).toContain('then T950-deploy-fix-1 merged: renamed the test');
    expect(description).not.toContain('fixed the e2e request');
  });

  it('gives a devops fix the history too', async () => {
    await earlierAttempt(1, 'verify', 'no response after 60 attempts', { id: 'T950-deploy-fix-1', state: 'merged', summary: 'fixed the healthcheck path', files: ['docker-compose.yml'] });
    const d = deps('unused');
    const r = await runPhase5({ ...d, target: { ...d.target!, verify: async () => ({ healthy: false, detail: 'no response after 60 attempts' }) } } as PhaseDeps, 2);
    const task = r.ok ? null : r.fixTask;
    expect(task?.owner).toBe('devops');
    expect(task?.description).toContain('- attempt 1 failed at verify: no response after 60 attempts\n  then T950-deploy-fix-1 merged: fixed the healthcheck path');
    expect(task?.description).toContain('did not change this failure');
  });

  it('reads the first line that has text, and keeps a long summary and file list short', async () => {
    const files = Array.from({ length: 30 }, (_, i) => `smoke/f${i}.mjs`);
    await earlierAttempt(1, 'smoke', '\n\n  AC-001: no smoke test', { id: 'T950-deploy-fix-1', state: 'merged', summary: 'x'.repeat(1000), files });
    const r = await runPhase5(deps('AC-002: smoke test failed'), 2);
    const description = r.ok ? '' : r.fixTask?.description ?? '';
    expect(description).toContain('- attempt 1 failed at smoke: AC-001: no smoke test');
    expect(description).not.toContain('x'.repeat(301));
    expect(description).toContain('smoke/f9.mjs and 20 more)');
    expect(description).not.toContain('smoke/f10.mjs');
  });

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

  it('a smoke deploy-fix covers the e2e suite too, which runs next against the same service and usually repeats its requests', async () => {
    // Live: the fix repaired the smoke test's request, and the next attempt failed at e2e on the same request.
    const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/e2e_test.go', readmeSections: ['Run'] };
    const r = await runPhase5({ ...deps('AC-013: failed'), plan: makePlan(spec, { delivery }) }, 1);
    const task = r.ok ? null : r.fixTask;
    expect(task?.affectedPaths).toEqual(expect.arrayContaining(['smoke/**', 'e2e/e2e_test.go']));
    expect(task?.description).toContain('The e2e suite (e2e/e2e_test.go) runs right after smoke against the same service');
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
