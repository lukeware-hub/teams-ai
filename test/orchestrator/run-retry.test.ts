import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { eventsFile } from '../../server/orchestrator/workspace.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import { runStep } from '../../server/runner/step.js';
import { EventStore } from '../../server/store/event-store.js';
import { makeFrozenSpec, makePlan, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const project = makeProject({ projectId: 'hello-app' });
const spec = makeFrozenSpec({ specId: 'hello-001' });
const plan = makePlan(spec);
let remote: Remote;

beforeEach(async () => {
  remote = await makeRemote({
    'docs/project.json': JSON.stringify(project),
    'docs/specs/hello-001/spec.json': JSON.stringify(spec),
    'docs/specs/hello-001/tech-spec.md': '# Tech spec\n\n## AC-001\nsum',
    'docs/specs/hello-001/plan.json': JSON.stringify(plan),
  });
});
afterEach(() => remote.cleanup());

function deps(exec: FakeExec, over: Partial<RunDeps> = {}): RunDeps {
  const root = path.join(remote.root, 'ws').replace(/\\/g, '/');
  gh.install(exec);
  return {
    cfg: loadConfig({ paths: { workspaces: root, runs: `${root}/runs`, secrets: '/tmp/none' } }),
    ws: { projectId: 'hello-app', root, repo: remote.repo, worktrees: `${root}/wt`, graph: `${root}/graph`, knowledgeDb: '', secrets: `${root}/secrets`, runs: `${root}/runs` },
    project, spec, firstSpec: true,
    exec: exec.exec, ghExec: exec.exec,
    runStep,
    binary: { bin: process.execPath, prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: undefined as never, // never reached when every task is already inherited as merged
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
    claudeJsonPath: path.join(remote.root, '.claude.json'),
    ...over,
  };
}
let gh: FakeGh;

describe('R11.4 retry: a second run of a spec inherits what an earlier run already merged', () => {
  it('seeds every task an earlier run merged as already merged, so the run completes without touching an agent', async () => {
    gh = new FakeGh();
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
    const d = deps(exec);
    // A prior run (r1) merged every task of the plan, then the spec failed at verification (the scenario this fixes).
    const prior = await EventStore.open({ file: eventsFile(d.ws, 'hello-001-r1'), runId: 'hello-001-r1', specHash: spec.specHash! });
    await prior.append({ type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } });
    await prior.append({ type: 'RUN_FINISHED', data: { result: 'verification-failed', reason: 'AC-003 missing', merged: plan.tasks.map((t) => t.id), blocked: [], tokens: {} } });
    await prior.close();

    const run = await Run.create(d, 'hello-001-r2');
    const result = await run.execute();
    expect(result).toBe('complete');
    for (const t of plan.tasks) expect(run.journal.state.tasks.get(t.id)?.state).toBe('merged');
    await run.close();
  });
});
