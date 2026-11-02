import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import type { StepRequest, StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject({ stack: 'node-typescript' });
const plan = makePlan(spec, { tasks: [makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'] })] });
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null } as ResultSummary;

type Script = (req: StepRequest) => Promise<StepOutcome<any>>;
const JUNIT = `<testsuite name="sum"><testcase classname="sum" name="[AC-001] adds"/></testsuite>`;

let remote: Remote;
let gh: FakeGh;
let ws: { projectId: string; root: string; repo: string; worktrees: string; graph: string; knowledgeDb: string; secrets: string; runs: string };

beforeEach(async () => {
  // main carries the plan too, so a reader that still asks main would find it: the mirror decides here.
  remote = await makeRemote({
    'docs/project.json': JSON.stringify(project),
    'docs/specs/spec-001/spec.json': JSON.stringify(spec),
    'docs/specs/spec-001/plan.json': JSON.stringify(plan),
    'docs/adr/ADR-001-stack.md': '# ADR-001 Stack\n\nThe stack is fixed.\n',
  });
  gh = new FakeGh();
  const root = path.join(remote.root, 'ws');
  ws = { projectId: 'shop', root, repo: remote.repo, worktrees: path.join(root, 'wt'), graph: path.join(root, 'graph'), knowledgeDb: '', secrets: path.join(root, 'secrets'), runs: path.join(remote.root, 'runs') };
});
afterEach(async () => {
  await remote.cleanup();
});

/** The run deps of a docs-repo project: its workspace is bound, so its machine files live in the mirror of `ws`. */
function docsRepoDeps(script: Script, over: Partial<RunDeps> = {}): RunDeps {
  const cfg = loadConfig({ paths: { workspaces: path.join(remote.root, 'ws').replace(/\\/g, '/'), runs: path.join(remote.root, 'runs').replace(/\\/g, '/'), secrets: '/tmp/none' } });
  const exec = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .onArgs('docker', ['run'], async (s) => {
      // Every gate passes; the gate runner mounts the worktree at /work and reads its JUnit report from there.
      const mount = s.args.find((a) => a.startsWith('type=bind,source=') && a.endsWith(',target=/work'))!;
      const wt = mount.slice('type=bind,source='.length, mount.length - ',target=/work'.length);
      await fs.mkdir(path.join(wt, 'reports'), { recursive: true });
      await fs.writeFile(path.join(wt, 'reports', 'junit.xml'), JUNIT);
      return { exitCode: 0 };
    });
  gh.install(exec);
  return {
    cfg, ws, project, spec, firstSpec: false, docsRepo: true,
    exec: exec.exec, ghExec: exec.exec,
    runStep: (async (req: StepRequest) => script(req)) as RunDeps['runStep'],
    binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: undefined as never,
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
    sleep: async () => {},
    ...over,
  };
}

async function withAgents(d: RunDeps): Promise<RunDeps> {
  return { ...d, agents: await loadAgents(path.resolve('.claude/agents')) };
}

/** Binds the project to a documentation repository: its marker is written and its mirror starts empty. */
async function bind(): Promise<void> {
  await writeDocsMarker(ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'shop' }, firstSha: null });
}

const noAgent: Script = async (req) => {
  throw new Error(`deploy-only ran an agent step: ${req.kind}`);
};

const target = {
  name: 'kind' as const,
  validate: async () => [] as string[],
  build: async () => undefined,
  apply: async () => ({ previous: null }),
  verify: async () => ({ healthy: true, detail: 'HTTP 200' }),
  currentImage: async () => null,
  rollback: async () => undefined,
  destroy: async () => undefined,
  serviceUrl: async () => 'http://127.0.0.1:3000',
};

describe('readers of a docs-repo project', () => {
  it('deploys from the plan of the mirror, not from main', async () => {
    await bind();
    await writeState(ws, `specs/${spec.specId}/plan.json`, JSON.stringify(plan));
    const run = await Run.create(docsRepoDeps(noAgent, { target: target as never }), 'spec-001-deploy-m1');
    expect(await run.deployOnly()).toBe('done');
    expect(run.journal.events.some((e) => e.type === OrchEvent.DeployVerified)).toBe(true);
    await run.close();
  });

  it('refuses a deploy when the mirror lacks the plan, even though main has it', async () => {
    await bind();
    const run = await Run.create(docsRepoDeps(noAgent, { target: target as never }), 'spec-001-deploy-m2');
    expect(await run.deployOnly()).toBe('phase-failed');
    expect(String(run.journal.events.find((e) => e.type === OrchEvent.RunFinished)!.data.reason)).toContain('main has no docs/specs/spec-001/plan.json');
    await run.close();
  });

  it('plans without a technical spec and without ADRs, and names the stack in the plan pack', async () => {
    await bind();
    const kinds: string[] = [];
    const prompts: string[] = [];
    const script: Script = async (req) => {
      kinds.push(req.kind);
      if (req.kind === 'plan') prompts.push(req.prompt);
      return { ok: false, failure: 'code', errors: ['not scripted'], summary, sandboxDisabled: false } as StepOutcome<any>;
    };
    const run = await Run.create(await withAgents(docsRepoDeps(script)), 'spec-001-plan-m1');
    expect(await run.execute()).toBe('phase-failed');
    expect(kinds).not.toContain('tech-spec');
    expect(prompts[0]).toContain(`stack: ${project.stack}`);
    expect(prompts[0]).not.toContain('ADR-001');
    await run.close();
  });

  it('lists the tasks of the mirror plan in the readme pack', async () => {
    await bind();
    await writeState(ws, `specs/${spec.specId}/plan.json`, JSON.stringify(plan));
    const prompts: string[] = [];
    const script: Script = async (req) => {
      prompts.push(req.prompt);
      return { ok: false, failure: 'code', errors: ['not scripted'], summary, sandboxDisabled: false } as StepOutcome<any>;
    };
    const run = await Run.create(await withAgents(docsRepoDeps(script)), 'spec-001-readme-m1');
    expect(await run.writeReadme()).toBe('phase-failed');
    expect(prompts[0]).toContain('- T1: Task T1');
    await run.close();
  });
});
