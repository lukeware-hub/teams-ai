import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { readState } from '../../server/docs/project-state.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import { serviceWorkspace } from '../../server/orchestrator/workspace.js';
import { git } from '../../server/git/git.js';
import { runStep } from '../../server/runner/step.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const project = makeProject({ projectId: 'hello-app' });
const spec = makeFrozenSpec({ specId: 'hello-001' });
const FIVE = ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md'];
let remote: Remote;
let draftDocs: string;

/** A draft docs folder with the five documents, the spec's plan and task list, and its machine files. */
async function writeDraft(omit: string[] = []): Promise<void> {
  const files: Record<string, string> = {
    'project.json': JSON.stringify(project),
    'specs/hello-001/spec.json': JSON.stringify(spec),
    'specs/hello-001/implementation-plan.md': '# Plan',
    'specs/hello-001/task.md': '# Tasks',
    ...Object.fromEntries(FIVE.map((f) => [f, `# ${f}`])),
  };
  for (const [rel, text] of Object.entries(files)) {
    if (omit.includes(rel)) continue;
    await fs.mkdir(path.dirname(path.join(draftDocs, rel)), { recursive: true });
    await fs.writeFile(path.join(draftDocs, rel), text);
  }
}

beforeEach(async () => {
  remote = await makeRemote({ 'README.md': 'seed' });
  draftDocs = path.join(remote.root, 'draft', 'docs');
});
afterEach(() => remote.cleanup());

function deps(exec: FakeExec, over: Partial<RunDeps> = {}): RunDeps {
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
    ...over,
  };
}

describe('phase 0 of a docs-repo project', () => {
  it('writes the machine files of the draft to the mirror, and no document to the repository', async () => {
    await writeDraft();
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const d = deps(exec);
    const run = await Run.create(d, 'hello-001-p0-1');
    expect(await run.executePhase0()).toEqual({ ok: true });
    expect(await readState(d.ws, 'project.json')).toEqual(JSON.parse(JSON.stringify(project)));
    expect(await readState(d.ws, `specs/${spec.specId}/spec.json`)).toEqual(JSON.parse(JSON.stringify(spec)));
    expect(exec.calls.some((c) => c.bin === 'gh')).toBe(false);
    await expect(fs.access(path.join(remote.repo, 'docs'))).rejects.toThrow();
    await run.close();
  });

  it('creates each service repository without copying a document into it', { timeout: 60_000 }, async () => {
    await writeDraft();
    const orders = await makeRemote({ 'src/index.ts': 'x' });
    try {
      const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
      exec.onArgs('gh', ['repo', 'view'], (s) => ({ stdout: JSON.stringify(s.args[2] === 'o/orders-api' ? { nameWithOwner: 'o/orders-api', url: orders.origin } : { nameWithOwner: 'o/hello-app', url: remote.origin }) }));
      new FakeGh().install(exec);
      const d = deps(exec, { project: makeProject({ projectId: 'hello-app', services: ['orders-api'] }) });
      const run = await Run.create(d, 'hello-001-p0-5');
      expect(await run.executePhase0()).toEqual({ ok: true });
      expect(await git(serviceWorkspace(d.ws, 'orders-api').repo, ['ls-tree', '--name-only', 'origin/main'], execCommand)).toBe('src');
      await run.close();
    } finally {
      await orders.cleanup();
    }
  });

  it('fails with PHASE_FAILED that names a missing document of the five', async () => {
    await writeDraft(['design.md']);
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const run = await Run.create(deps(exec), 'hello-001-p0-2');
    expect((await run.executePhase0()).ok).toBe(false);
    expect(run.journal.events.some((e) => e.type === OrchEvent.PhaseFailed && String(e.data.reason).includes('docs/design.md'))).toBe(true);
    await run.close();
  });

  it('fails with PHASE_FAILED that names a missing plan of the spec', async () => {
    await writeDraft(['specs/hello-001/implementation-plan.md']);
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const run = await Run.create(deps(exec), 'hello-001-p0-3');
    expect(await run.executePhase0()).toEqual({ ok: false, reason: 'the document docs/specs/hello-001/implementation-plan.md is not in the draft docs' });
    await run.close();
  });

  it('fails with PHASE_FAILED that names a missing task list of the spec', async () => {
    await writeDraft(['specs/hello-001/task.md']);
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const run = await Run.create(deps(exec), 'hello-001-p0-4');
    expect((await run.executePhase0()).ok).toBe(false);
    expect(run.journal.events.some((e) => e.type === OrchEvent.PhaseFailed && String(e.data.reason).includes('docs/specs/hello-001/task.md'))).toBe(true);
    await run.close();
  });
});
