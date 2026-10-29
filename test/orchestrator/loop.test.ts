import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { loadConfig } from '../../server/config/config.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { CrashInjected, Run, type RunDeps } from '../../server/orchestrator/run.js';
import { readOwnerDecisions, recordOwnerDecisions } from '../../server/orchestrator/owner-decisions.js';
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

/** The text of every prompt a run sent to an agent, read back from its step folders. */
async function promptsOf(runDir: string): Promise<string[]> {
  const files = (await fs.readdir(runDir, { recursive: true })).filter((f) => f.endsWith('prompt.md'));
  return Promise.all(files.map((f) => fs.readFile(path.join(runDir, f), 'utf8')));
}

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

/**
 * Crash points: every intent with TEAMS_AI_CRASH_SWEEP=full, the listed ones with TEAMS_AI_CRASH_POINTS=13,14,
 * else the first intent of each kind and the last one.
 */
const FULL_SWEEP = process.env.TEAMS_AI_CRASH_SWEEP === 'full';
const crashPoints = (intents: readonly string[]): number[] => {
  if (FULL_SWEEP) return intents.map((_, i) => i);
  if (process.env.TEAMS_AI_CRASH_POINTS) return process.env.TEAMS_AI_CRASH_POINTS.split(',').map(Number);
  const firstOfKind = new Map<string, number>();
  intents.forEach((id, i) => {
    const kind = id.split(':')[0]!;
    if (!firstOfKind.has(kind)) firstOfKind.set(kind, i);
  });
  return [...new Set([...firstOfKind.values(), intents.length - 1])].sort((a, b) => a - b);
};

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
    expect(() => knowledge.search('todo')).toThrow();
  });

  it('a block the owner decides: the question is journaled, the answer is stored, and the next run\'s Dev reads it', { timeout: 600_000 }, async () => {
    const asked = 'Qual versão do Go?';
    const blocked = happyScenario(path.join(remote.root, 'scn-blocked'));
    blocked.set('dev', 'T1-a', 1, { output: { specHash: HASH, status: 'blocked', summary: 'no toolchain', changedFiles: [], reason: 'the gate has no Go 1.27.2' } });
    blocked.set('block-options', 'T1-a', 1, { output: { specHash: HASH, question: asked, options: [{ label: 'Go 1.26.9', detail: 'O gate já tem essa versão.', recommended: true }, { label: 'Go 1.27.2', detail: 'Exige outra imagem.' }] } });
    const first = await Run.create({ ...deps(blocked), agents: await loadAgents(path.resolve('.claude/agents')) });
    await first.execute();
    const asks = first.journal.events.filter((e) => e.type === 'DECISION_REQUESTED');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.data).toMatchObject({ taskId: 'T1-a', question: asked });
    expect(first.journal.events.some((e) => e.type === 'TASK_BLOCKED' && e.data.taskId === 'T1-a')).toBe(true);
    await first.close();

    // The owner picks the recommended choice; the answer is stored per spec, as the run screen stores it.
    const projectDir = path.join(remote.root, 'project');
    await recordOwnerDecisions(projectDir, 'spec-001', [{ runId: first.runId, taskId: 'T1-a', question: asked, answer: 'Go 1.26.9' }]);

    const next = await Run.create({ ...deps(happyScenario(path.join(remote.root, 'scn-next'))), agents: await loadAgents(path.resolve('.claude/agents')), ownerDecisions: await readOwnerDecisions(projectDir, 'spec-001') });
    expect(await next.execute()).toBe('complete');
    const prompts = await promptsOf(path.join(remote.root, 'runs', next.runId));
    expect(prompts.some((p) => p.includes('Owner decision (binding) for T1-a: Qual versão do Go? → Go 1.26.9'))).toBe(true);
    await next.close();
  });

  it(FULL_SWEEP ? 'survives a crash after every intent and never duplicates a commit, PR or merge' : 'survives a crash after one intent of each kind and the last, and never duplicates a commit, PR or merge', { timeout: 3_600_000 }, async () => {
    // First, a clean run to learn the intent ids in order.
    const probe = happyScenario(path.join(remote.root, 'scn-probe'));
    const d0 = { ...deps(probe), agents: await loadAgents(path.resolve('.claude/agents')) };
    const clean = await Run.create(d0);
    await clean.execute();
    const intents = clean.journal.events.filter((e) => e.kind === 'intent').map((e) => e.intentId!);
    await clean.close();
    await remote.cleanup();
    expect(intents.length).toBeGreaterThan(10);

    for (const index of crashPoints(intents)) {
      const target = intents[index]!;
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
