import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import { makeFrozenSpec, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const phases = vi.hoisted(() => ({ runPhase6: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../server/orchestrator/phases/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/orchestrator/phases/index.js')>()),
  runPhase4: async () => ({ ok: true }),
  runPhase6: phases.runPhase6,
  deployStartAttempt: () => 1,
}));

let root = '';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-deploy-fix-'));
  phases.runPhase6.mockClear();
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

function deps(): RunDeps {
  const ws = { projectId: 'shop', root, repo: path.join(root, 'repo'), worktrees: path.join(root, 'wt'), graph: path.join(root, 'graph'), knowledgeDb: '', secrets: path.join(root, 'secrets'), runs: path.join(root, 'runs') };
  return {
    cfg: loadConfig({ paths: { workspaces: root, runs: ws.runs, secrets: '/tmp/none' } }),
    ws, project: makeProject(), spec: makeFrozenSpec(), firstSpec: false,
    exec: new FakeExec().exec, ghExec: new FakeExec().exec,
    runStep: (async () => { throw new Error('no agent step expected'); }) as never,
    binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: undefined as never, graphify: null, knowledge: null, secrets: {},
    target: {} as never, log: () => {},
  };
}

describe('deploy fix-task path', () => {
  it('returns what the fix loop ended with (a stop drained it) instead of running Phase 6 and finishing the run a second time', async () => {
    const run = await Run.create(deps());
    const internals = run as unknown as { phase5: () => Promise<unknown>; loop: () => Promise<unknown>; finish: (r: string) => Promise<unknown>; postPhases: () => Promise<unknown> };
    internals.phase5 = async () => ({ ok: false, reason: 'smoke failed', fixTask: makePlanTask({ id: 'T950-deploy-fix-1', origin: 'deploy-fix' }) });
    internals.loop = () => internals.finish('drained');
    expect(await internals.postPhases()).toBe('drained');
    expect(phases.runPhase6).not.toHaveBeenCalled();
    expect(run.journal.events.filter((e) => e.type === OrchEvent.RunFinished)).toHaveLength(1);
    await run.close();
  });
});
