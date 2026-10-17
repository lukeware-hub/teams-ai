import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { CrashInjected, Run, type RunDeps } from '../../server/orchestrator/run.js';
import { KnowledgeIndex } from '../../server/knowledge/retrieval.js';
import { runStep } from '../../server/runner/step.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { Scenario } from '../fixtures/fake-claude/scenario.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const FAKE = path.resolve('test/fixtures/fake-claude/fake-claude.mjs');
const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec, { tasks: [makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001'], affectedPaths: ['src/a'] }), makePlanTask({ id: 'T2-b', criteriaRefs: ['AC-002'], affectedPaths: ['src/b'], dependsOn: ['T1-a'] })] });
const JUNIT = `<testsuite name="sum"><testcase classname="sum" name="[AC-001] adds"/></testsuite>`;

let remote: Remote;
let gh: FakeGh;
beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  gh = new FakeGh();
});
afterEach(async () => {
  await remote.cleanup();
});

function happyScenario(dir: string): Scenario {
  const s = new Scenario(dir);
  s.set('tech-spec', null, 1, { output: { specHash: HASH, techSpecPath: 'docs/specs/spec-001/tech-spec.md', adrs: [], stack: 'node', summary: 'ts' }, files: { 'docs/specs/spec-001/tech-spec.md': '# Tech spec\n\n## AC-001\nsum' } });
  s.set('coverage', null, 1, { output: { specHash: HASH, coverage: spec.acceptanceCriteria.map((c) => ({ acId: c.id, section: 'AC-001', covered: true, note: '' })) } });
  s.set('plan', null, 1, { output: plan });
  for (const id of ['T1-a', 'T2-b']) {
    const d = id === 'T1-a' ? 'a' : 'b';
    s.set('dev', id, 1, { output: { specHash: HASH, status: 'done', summary: `did ${id}`, changedFiles: [`src/${d}/index.ts`], commitMessage: `feat: ${id}` }, files: { [`src/${d}/index.ts`]: `export const ${id} = 1;\n` } });
    s.set('review', id, 1, { output: { specHash: HASH, decision: 'approve', criteria: [{ id: 'AC-001', status: 'passed', evidence: ['sum::[AC-001] adds'] }], findings: [] } });
    s.set('security', id, 1, { output: { specHash: HASH, decision: 'approve', findings: [] } });
  }
  return s;
}

function deps(scenario: Scenario, over: Partial<RunDeps> = {}): RunDeps {
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
  const root = path.join(remote.root, 'ws');
  return {
    cfg: loadConfig({ paths: { workspaces: root.replace(/\\/g, '/'), runs: path.join(remote.root, 'runs').replace(/\\/g, '/'), secrets: '/tmp/none' } }),
    ws: { projectId: 'shop', root, repo: remote.repo, worktrees: path.join(root, 'wt'), graph: path.join(root, 'graph'), knowledgeDb: '', secrets: path.join(root, 'secrets'), runs: path.join(remote.root, 'runs') },
    // Not the first spec: the fixture plan has no T0-scaffold / deploy-infrastructure tasks, which validatePlan requires on a first spec.
    project, spec, firstSpec: false,
    exec: exec.exec, ghExec: exec.exec,
    runStep: scenario.wrap(runStep),
    binary: { bin: process.execPath, prefixArgs: [FAKE], env: {}, requireSandboxTools: false },
    agents: undefined as never,
    graphify: null, knowledge: null, secrets: {},
    log: () => {},
    maxParallel: 1,
    claudeJsonPath: path.join(remote.root, '.claude.json'),
    ...over,
  };
}

describe('orchestrator loop with the fake claude', () => {
  it('goes from a frozen spec to every task merged', { timeout: 300_000 }, async () => {
    const scenario = happyScenario(path.join(remote.root, 'scn'));
    const d = { ...deps(scenario), agents: await loadAgents(path.resolve('.claude/agents')) };
    const run = await Run.create(d);
    expect(await run.execute()).toBe('complete');
    await run.close();
    await git(remote.repo, ['fetch', '-q', 'origin']);
    const tree = await git(remote.repo, ['ls-tree', '-r', '--name-only', 'origin/main']);
    expect(tree).toContain('docs/specs/spec-001/tech-spec.md');
    expect(tree).toContain('docs/specs/spec-001/plan.json');
    expect(tree).toContain('src/a/index.ts');
    expect(tree).toContain('src/b/index.ts');
    expect(gh.prs.map((p) => p.title)).toEqual(['docs(spec-001): technical spec', 'docs(spec-001): plan', 'T1-a: Task T1-a', 'T2-b: Task T2-b']);
    const steps = ['tech-spec/-/1', 'coverage/-/1', 'plan/-/1', 'dev/T1-a/1', 'security/T1-a/1', 'review/T1-a/1', 'dev/T2-b/1', 'security/T2-b/1', 'review/T2-b/1'];
    expect([...scenario.seen].sort()).toEqual([...steps].sort());
    // A task's security and review steps run side by side (R11.13 slice 5): only the place of the pair is fixed.
    const paired = (seen: readonly string[]) => seen.map((s) => s.replace(/^(security|review)\//, 'check/'));
    expect(paired(scenario.seen)).toEqual(paired(steps));
  });

  it('gives the agents the earlier docs that match the spec objectives', { timeout: 300_000 }, async () => {
    const scenario = happyScenario(path.join(remote.root, 'scn-knowledge'));
    const knowledge = KnowledgeIndex.open(':memory:');
    knowledge.index({ id: 'docs/specs/old-001/spec.md', kind: 'spec', title: 'Old spec', text: '# Old spec\nUsers keep todo items per account, marker zebracorn-7741.\n' });
    const wrapped = scenario.wrap(runStep);
    const prompts: string[] = [];
    const captured: RunDeps['runStep'] = (req, ...rest) => {
      prompts.push(req.prompt);
      return wrapped(req, ...rest);
    };
    const d = { ...deps(scenario, { knowledge, runStep: captured }), agents: await loadAgents(path.resolve('.claude/agents')) };
    const run = await Run.create(d);
    expect(await run.execute()).toBe('complete');
    await run.close();
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((p) => p.includes('zebracorn-7741'))).toBe(true);
  });

  it('survives a crash after every intent and never duplicates a commit, PR or merge', { timeout: 3_600_000 }, async () => {
    // First, a clean run to learn the intent ids in order.
    const probe = happyScenario(path.join(remote.root, 'scn-probe'));
    const d0 = { ...deps(probe), agents: await loadAgents(path.resolve('.claude/agents')) };
    const clean = await Run.create(d0);
    await clean.execute();
    const intents = clean.journal.events.filter((e) => e.kind === 'intent').map((e) => e.intentId!);
    await clean.close();
    await remote.cleanup();
    expect(intents.length).toBeGreaterThan(10);

    for (const [index, target] of intents.entries()) {
      remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
      gh = new FakeGh();
      const scenario = happyScenario(path.join(remote.root, 'scn'));
      // Push/merge intent ids carry the head sha, which differs per run; the intent order does not, so crash by ordinal.
      let appended = 0;
      const d = { ...deps(scenario, { crashAfterIntent: () => ++appended === index + 1 }), agents: await loadAgents(path.resolve('.claude/agents')) };
      const first = await Run.create(d);
      const crashed = await first.execute().then(
        (r) => new Error(`no crash at #${index} (${target}); run finished ${r}`),
        (err: unknown) => err,
      );
      expect(crashed, `crash at #${index} (${target})`).toBeInstanceOf(CrashInjected);
      await first.close();
      const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, first.runId);
      expect(await resumed.execute(), `crash after ${target}`).toBe('complete');
      const commits = await git(remote.repo, ['rev-list', '--count', 'origin/main']).then(Number);
      expect(commits, `commit count after ${target}`).toBe(1 + 4);
      expect(gh.prs.length, `pr count after ${target}`).toBe(4);
      expect(gh.prs.every((p) => p.state === 'MERGED'), `all merged after ${target}`).toBe(true);
      expect(resumed.journal.events.filter((e) => e.type === 'RUN_FINISHED'), `one finish after ${target}`).toHaveLength(1);
      await resumed.close();
      await remote.cleanup();
    }
    // Leave something for afterEach to clean up (an empty file set would make the initial commit fail).
    remote = await makeRemote({ '.keep': '' });
  });
});
