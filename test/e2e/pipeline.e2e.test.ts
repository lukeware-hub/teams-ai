import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import type { Accounting } from '../../server/budget/accounting.js';
import { main } from '../../server/cli.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { Run, type RunDeps } from '../../server/orchestrator/run.js';
import type { StepRequest } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

// End to end through the CLI entry (server/cli.ts `main`) against a temp git remote. Everything that needs
// Docker, GitHub or a real claude is faked (FakeExec/FakeGh/scripted steps); git and the orchestrator are real.
// Gap: `run --dry-run` itself cannot go past its preconditions without claude, gh and Docker on the host, so
// the full-pipeline test injects the Run through main's factory seam instead (see the plan file).

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec, { tasks: [makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src/a'] }), makePlanTask({ id: 'T2', criteriaRefs: ['AC-001'], affectedPaths: ['src/b'] })] });
const JUNIT = `<testsuite name="sum"><testcase classname="sum" name="[AC-001] adds"/></testsuite>`;
const summary = (): ResultSummary => ({ found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 5, costUsd: 0.001, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 });

let remote: Remote;

beforeEach(async () => {
  remote = await makeRemote({
    'docs/project.json': JSON.stringify(project),
    'docs/specs/spec-001/spec.json': JSON.stringify(spec),
    'docs/specs/spec-001/tech-spec.md': '# Tech spec\n\n## AC-001\nsum',
    'docs/specs/spec-001/plan.json': JSON.stringify(plan),
  });
});
afterEach(async () => {
  await remote.cleanup();
});

async function runDeps(): Promise<RunDeps> {
  const gh = new FakeGh();
  const cfg = loadConfig({ paths: { workspaces: path.join(remote.root, 'ws').replace(/\\/g, '/'), runs: path.join(remote.root, 'runs').replace(/\\/g, '/'), secrets: path.join(remote.root, 'none').replace(/\\/g, '/') }, budgets: { observeOnly: false, perTaskTokens: 50_000, perRunTokens: 1_000_000 } });
  const exec = new FakeExec()
    .on((s) => s.bin === 'git', (s) => execCommand(s))
    .onArgs('docker', ['run'], async (s) => {
      const mount = s.args.find((a) => a.startsWith('type=bind,source=') && a.endsWith(',target=/work'))!;
      const wt = mount.slice('type=bind,source='.length, mount.length - ',target=/work'.length);
      await fs.mkdir(path.join(wt, 'reports'), { recursive: true });
      await fs.writeFile(path.join(wt, 'reports', 'junit.xml'), JUNIT);
      return { exitCode: 0 };
    });
  gh.install(exec);
  const ws = { projectId: 'shop', root: path.join(remote.root, 'ws'), repo: remote.repo, worktrees: path.join(remote.root, 'ws', 'wt'), graph: path.join(remote.root, 'ws', 'graph'), knowledgeDb: '', secrets: path.join(remote.root, 'ws', 'secrets'), runs: path.join(remote.root, 'runs') };
  const script = async (req: StepRequest) => {
    switch (req.kind) {
      case 'dev': {
        const sub = req.taskId === 'T1' ? 'a' : 'b';
        await fs.mkdir(path.join(req.cwd, 'src', sub), { recursive: true });
        await fs.writeFile(path.join(req.cwd, 'src', sub, 'index.ts'), `export const ${req.taskId} = 1;\n`);
        return { ok: true as const, value: { specHash: HASH, status: 'done', summary: `did ${req.taskId}`, changedFiles: [`src/${sub}/index.ts`], commitMessage: `feat: ${req.taskId}` }, summary: summary() };
      }
      case 'review':
        return { ok: true as const, value: { specHash: HASH, decision: 'approve', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }], findings: [] }, summary: summary() };
      case 'security':
        return { ok: true as const, value: { specHash: HASH, decision: 'approve', findings: [] }, summary: summary() };
      default:
        throw new Error(`unexpected step ${req.kind}`);
    }
  };
  return {
    cfg, ws, project, spec, firstSpec: false,
    exec: exec.exec, ghExec: exec.exec,
    runStep: (async (req: StepRequest, stepDeps: { accounting: Accounting }) => {
      const out = await script(req);
      stepDeps.accounting.record({ role: req.role, phase: req.phase, taskId: req.taskId, attempt: req.attempt, stepKind: req.kind, provider: 'claude', model: req.model, usage: out.summary.usage, costUsd: out.summary.costUsd, durationMs: out.summary.durationMs, numTurns: out.summary.numTurns, at: new Date().toISOString() });
      return out;
    }) as RunDeps['runStep'],
    binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
    agents: await loadAgents(path.resolve('.claude/agents')),
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
  };
}

describe('pipeline e2e (CLI entry, temp git remote)', () => {
  it('teams-ai run reaches complete with every task merged and a journal', async () => {
    const deps = await runDeps();
    const err: string[] = [];
    let run: Run | undefined;
    const code = await main(
      { argv: ['run', '--project', remote.repo, '--spec', 'spec-001', '--run-id', 'spec-001-e2e'], env: {}, stdout: () => {}, stderr: (s) => err.push(s) },
      async (_d, _runId, explicitId) => (run = await Run.create(deps, explicitId)),
      { signals: () => () => {} },
    );
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('run spec-001-e2e finished: complete');
    const state = run!.journal.state;
    expect([...state.tasks.values()].map((t) => t.state)).toEqual(['merged', 'merged']);
    const last = run!.journal.events.at(-1)!;
    expect(last.type).toBe(OrchEvent.RunFinished);
    expect(last.data).toMatchObject({ result: 'complete', merged: ['T1', 'T2'], blocked: [] });
    await git(remote.repo, ['fetch', '-q', 'origin']);
    const tree = await git(remote.repo, ['ls-tree', '-r', '--name-only', 'origin/main', 'src/']);
    expect(tree).toContain('src/a/index.ts');
    expect(tree).toContain('src/b/index.ts');
  }, 60_000);

  it('run --dry-run loads the project and spec from the remote, then stops at the host preconditions', async () => {
    // No claude/gh/docker on PATH and a throwaway HOME: the furthest honest milestone of the dry-run entry.
    const home = path.join(remote.root, 'home');
    const bin = path.join(home, 'empty-bin');
    await fs.mkdir(bin, { recursive: true });
    const saved = { PATH: process.env.PATH, Path: process.env.Path, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.PATH = process.env.Path = bin;
    process.env.HOME = process.env.USERPROFILE = home;
    const err: string[] = [];
    try {
      const code = await main({ argv: ['run', '--project', remote.repo, '--spec', 'spec-001', '--dry-run', '--draft'], env: {}, stdout: () => {}, stderr: (s) => err.push(s) });
      expect(code).toBe(2);
      const text = err.join('\n');
      expect(text).toContain('preconditions failed');
      expect(text).toContain('claude is not logged in');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 30_000);
});
