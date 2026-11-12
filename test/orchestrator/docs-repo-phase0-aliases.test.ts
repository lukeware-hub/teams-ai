import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import { runStep } from '../../server/runner/step.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const project = makeProject({ projectId: 'hello-app' });
const spec = makeFrozenSpec({ specId: 'hello-001' });
const FIVE = ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md'];
const OTHER = 'docs/specify/other-002';
let remote: Remote;
let draftDocs: string;

beforeEach(async () => {
  remote = await makeRemote({ 'README.md': 'seed' });
  draftDocs = path.join(remote.root, 'draft', 'docs');
  const files: Record<string, string> = {
    'project.json': JSON.stringify(project),
    'specs/hello-001/spec.json': JSON.stringify(spec),
    'specs/hello-001/implementation-plan.md': '# Plan',
    'specs/hello-001/task.md': '# Tasks',
    ...Object.fromEntries(FIVE.map((f) => [f, `# ${f}`])),
  };
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(draftDocs, rel)), { recursive: true });
    await fs.writeFile(path.join(draftDocs, rel), text);
  }
});
afterEach(() => remote.cleanup());

function deps(exec: FakeExec, snapshot: string): RunDeps {
  const root = path.join(remote.root, 'ws').replace(/\\/g, '/');
  return {
    cfg: loadConfig({ paths: { workspaces: root, runs: `${root}/runs`, secrets: '/tmp/none' } }),
    ws: { projectId: 'hello-app', root, repo: remote.repo, worktrees: `${root}/wt`, graph: `${root}/graph`, knowledgeDb: '', secrets: `${root}/secrets`, runs: `${root}/runs` },
    project, spec, firstSpec: true, docsRepo: true,
    exec: exec.exec, ghExec: exec.exec,
    runStep,
    binary: { bin: process.execPath, prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: undefined as never,
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
    claudeJsonPath: path.join(remote.root, '.claude.json'),
    bootstrap: { docsDir: draftDocs, owner: 'o' },
    docs: { style: 'monolith', snapshot },
  };
}

/** A closing snapshot with the five documents and two specs, each with its plan and task list; `omit` leaves files out. */
async function writeSnapshot(omit: string[] = []): Promise<string> {
  const snapshot = path.join(remote.root, 'snapshot');
  const files: Record<string, string> = {
    ...Object.fromEntries(FIVE.map((f) => [`docs/${f}`, `# ${f}`])),
    'docs/specify/hello-001/spec.md': '# Spec',
    'docs/specify/hello-001/plan.md': '# Plan',
    'docs/specify/hello-001/task.md': '# Tasks',
    [`${OTHER}/spec.md`]: '# Spec',
    [`${OTHER}/plan.md`]: '# Plan',
    [`${OTHER}/task.md`]: '# Tasks',
  };
  for (const [rel, text] of Object.entries(files)) {
    if (omit.includes(rel)) continue;
    await fs.mkdir(path.dirname(path.join(snapshot, rel)), { recursive: true });
    await fs.writeFile(path.join(snapshot, rel), text);
  }
  return snapshot;
}

describe('the graph experiment arm of a run', () => {
  const started = (run: Run) => run.journal.events.find((e) => e.type === OrchEvent.RunStarted)!.data.graphArm;

  it('is journaled with the start of a run in a project that has an experiment, and left out of one that has none', async () => {
    const exec = new FakeExec();
    const plain = await Run.create(deps(exec, await writeSnapshot()), 'hello-001-arm-1');
    expect(started(plain)).toBeUndefined();
    await plain.close();
    const d = deps(exec, await writeSnapshot());
    d.cfg = { ...d.cfg, graphAb: { 'hello-app': ['dev'] } };
    const inExperiment = await Run.create(d, 'hello-001-arm-2');
    expect(['control', 'graph']).toContain(started(inExperiment));
    await inExperiment.close();
  });
});

describe('phase 0 of a docs-repo project checks every alias', () => {
  it('fails with PHASE_FAILED that names the task list of a second alias the snapshot lacks', async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const run = await Run.create(deps(exec, await writeSnapshot([`${OTHER}/task.md`])), 'hello-001-p0-alias-1');
    expect(await run.executePhase0()).toEqual({ ok: false, reason: `the document ${OTHER}/task.md is not in the closing snapshot` });
    expect(run.journal.events.some((e) => e.type === OrchEvent.PhaseFailed && String(e.data.reason).includes(`${OTHER}/task.md`))).toBe(true);
    await run.close();
  });

  it('ignores a stale copy of a spec that moved to another service', async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const moved = makeFrozenSpec({ specId: 'hello-001', repository: 'billing-api' });
    const d = { ...deps(exec, await writeSnapshot()), spec: moved };
    d.docs = { style: 'microservices', snapshot: d.docs!.snapshot };
    const snapshot = d.docs.snapshot;
    await fs.rm(path.join(snapshot, 'docs/specify'), { recursive: true });
    const own = 'docs/billing-api/specify/hello-001';
    const stale = 'docs/old-api/specify/hello-001';
    for (const [rel, text] of Object.entries({ [`${own}/spec.md`]: '#', [`${own}/plan.md`]: '#', [`${own}/task.md`]: '#', [`${stale}/spec.md`]: '#' })) {
      await fs.mkdir(path.dirname(path.join(snapshot, rel)), { recursive: true });
      await fs.writeFile(path.join(snapshot, rel), text);
    }
    const run = await Run.create(d, 'hello-001-p0-alias-3');
    const result = await run.executePhase0();
    expect(result.ok === false ? result.reason : '').not.toContain('closing snapshot');
    await run.close();
  });

  it('passes when every alias of the snapshot has its plan and task list', async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const run = await Run.create(deps(exec, await writeSnapshot()), 'hello-001-p0-alias-2');
    expect(await run.executePhase0()).toEqual({ ok: true });
    await run.close();
  });
});
