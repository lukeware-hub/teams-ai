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
const spec = makeFrozenSpec({ specId: 'hello-001', repository: 'hello-api' });
const FIVE = ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md'];
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

/** A closing snapshot with the five documents and the spec's plan and task list, under the microservice folder. */
async function snapshot(): Promise<string> {
  const root = path.join(remote.root, 'snapshot');
  const files: Record<string, string> = {
    ...Object.fromEntries(FIVE.map((f) => [`docs/${f}`, `# ${f}`])),
    'docs/hello-api/specify/hello-001/plan.md': '# Plan',
    'docs/hello-api/specify/hello-001/task.md': '# Tasks',
  };
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}

function deps(exec: FakeExec, snap: string): RunDeps {
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
    docs: { style: 'microservices', snapshot: snap },
  };
}

describe('the central repository of a microservice project', () => {
  it('fails with PHASE_FAILED naming docs/project.md when the cloned repository has none on main', async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    const run = await Run.create(deps(exec, await snapshot()), 'hello-001-lane3-guard');
    const result = await run.executePhase0();
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('docs/project.md');
    expect(run.journal.events.some((e) => e.type === OrchEvent.PhaseFailed && String(e.data.reason).includes('docs/project.md'))).toBe(true);
    await run.close();
  });
});
