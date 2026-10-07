import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand, type CommandSpec } from '../../server/exec/command.js';
import { commitAll, createWorktree, git, headSha, withRepoLock } from '../../server/git/git.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Intent, Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { docsMergeSteps, prBody, taskMergeSteps, type MergeStepsDeps } from '../../server/orchestrator/merge-steps.js';
import type { HandoffSummary } from '../../server/knowledge/context-pack.js';
import { makeFrozenSpec, makePlanTask } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const task = makePlanTask({ id: 'T1', title: 'Add sum', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
let remote: Remote;
let journal: Journal;
let gh: FakeGh;
let handoffs: HandoffSummary[];
let worktree: string;

beforeEach(async () => {
  remote = await makeRemote({ 'docs/README.md': '# docs' });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  gh = new FakeGh();
  handoffs = [];
  worktree = path.join(remote.root, 'wt', 'task__spec-001-T1');
  await createWorktree(remote.repo, worktree, 'task/spec-001-T1', 'origin/main');
  await fs.mkdir(path.join(worktree, 'src'), { recursive: true });
  await fs.writeFile(path.join(worktree, 'src', 'sum.ts'), 'export const sum = (a: number, b: number) => a + b;\n');
  await commitAll(worktree, 'feat: sum');
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(over: Partial<MergeStepsDeps> = {}): MergeStepsDeps {
  const ghExec = new FakeExec();
  gh.install(ghExec);
  // git goes to the real binary; everything else to the fake.
  const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
  const ghRouted = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s)).on((s) => s.bin === 'gh', (s) => ghExec.exec(s));
  return {
    journal,
    ws: { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: path.join(remote.root, 'graph'), knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root },
    exec: exec.exec,
    ghExec: ghRouted.exec,
    gates: async () => ({ results: [], blockingFailure: null }),
    graphify: null,
    secretValues: () => ['hunter2'],
    handoffs,
    clock: () => new Date('2026-09-24T12:00:00Z'),
    ...over,
  };
}

describe('prBody', () => {
  it('lists summary, criteria and gate lines, redacts secrets and caps the size', () => {
    const body = prBody({ summary: 'token hunter2 used', criteria: spec.acceptanceCriteria, gateLines: ['unit-test: passed', 'x'.repeat(10_000)] }, ['hunter2']);
    expect(body).toContain('[REDACTED]');
    expect(body).toContain('AC-001');
    expect(body.length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe('taskMergeSteps', () => {
  it('rebases, pushes, opens the PR, merges it guarded by the head sha and records the handoff', async () => {
    const d = deps();
    const steps = taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 'did T1');
    const out = await new MergeQueue().enqueue('T1', steps);
    expect(out).toEqual({ ok: true, pr: 1 });
    expect(gh.prs[0]).toMatchObject({ state: 'MERGED', head: 'task/spec-001-T1', title: 'T1: Add sum' });
    expect(gh.prs[0]!.body).toContain('did T1');
    expect(await git(remote.repo, ['ls-remote', 'origin', 'refs/heads/main'])).toContain(gh.prs[0]!.headRefOid);
    const kinds = journal.events.map((e) => `${e.kind}:${e.type}`);
    expect(kinds).toEqual([
      `intent:${Intent.Push}`, `confirm:${Intent.Push}`,
      `intent:${Intent.PrCreate}`, `confirm:${Intent.PrCreate}`, `fact:${OrchEvent.PrCreated}`,
      `intent:${Intent.PrMerge}`, `confirm:${Intent.PrMerge}`,
      `intent:${Intent.WorktreeRemove}`, `confirm:${Intent.WorktreeRemove}`,
    ]);
    expect(handoffs).toEqual([{ taskId: 'T1', title: 'Add sum', summary: 'did T1', changedFiles: ['src/sum.ts'], mergedAt: '2026-09-24T12:00:00.000Z' }]);
    await expect(fs.access(worktree)).rejects.toThrow();
  });

  it('reports rebase conflicts when main moved on the same file', async () => {
    await fs.writeFile(path.join(remote.repo, 'src', 'sum.ts'), 'export const sum = () => 0;\n').catch(async () => {
      await fs.mkdir(path.join(remote.repo, 'src'), { recursive: true });
      await fs.writeFile(path.join(remote.repo, 'src', 'sum.ts'), 'export const sum = () => 0;\n');
    });
    await commitAll(remote.repo, 'chore: conflicting');
    await git(remote.repo, ['push', '-q', 'origin', 'main']);
    const out = await new MergeQueue().enqueue('T1', taskMergeSteps(deps(), task, worktree, 'task/spec-001-T1', spec, 's'));
    expect(out).toMatchObject({ ok: false, stage: 'rebase', conflicts: ['src/sum.ts'] });
  });

  it('short-circuits when the PR is already merged (crash between merge and confirm)', async () => {
    const d = deps();
    const first = await new MergeQueue().enqueue('T1', taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 's'));
    expect(first.ok).toBe(true);
    const again = await new MergeQueue().enqueue('T1', taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 's'));
    expect(again).toEqual({ ok: true, pr: 1, already: true });
  });

  it('redacts the PR body', async () => {
    const d = deps();
    await new MergeQueue().enqueue('T1', taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 'password hunter2 leaked'));
    expect(gh.prs[0]!.body).not.toContain('hunter2');
    expect(JSON.stringify(journal.events)).not.toContain('hunter2');
  });

  it('fails the gates stage with the failing gate as detail', async () => {
    const d = deps({ gates: async () => ({ results: [], blockingFailure: { name: 'lint', blocking: true, passed: false, exitCode: 1, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: 'semi', junit: null, failure: 'code' } }) });
    const out = await new MergeQueue().enqueue('T1', taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 's'));
    expect(out).toMatchObject({ ok: false, stage: 'gates', detail: expect.stringContaining('lint') });
  });
});

describe('docsMergeSteps', () => {
  it('merges a docs branch without gates and removes the worktree', async () => {
    const docsWt = path.join(remote.root, 'wt', 'docs__spec-001');
    await createWorktree(remote.repo, docsWt, 'docs/spec-001', 'origin/main');
    await fs.writeFile(path.join(docsWt, 'docs', 'tech-spec.md'), '# spec');
    await commitAll(docsWt, 'docs: tech spec');
    const gates = async () => { throw new Error('gates must not run for docs'); };
    const out = await new MergeQueue().enqueue('docs', docsMergeSteps(deps({ gates }), 'docs/spec-001', docsWt, 'docs(spec-001): technical spec'));
    expect(out).toEqual({ ok: true, pr: 1 });
    expect(gh.prs[0]!.title).toBe('docs(spec-001): technical spec');
    await expect(fs.access(docsWt)).rejects.toThrow();
  });
  it('a docs branch with identical content already on main needs no PR: rebase reports empty, the queue skips straight to cleanup', async () => {
    // Live finding (R11.2 program run, 2026-10-07): retrying a run whose Phase 0 docs were already merged
    // wrote the same spec.json bytes into a fresh worktree; commitAll returned null (nothing staged), so the
    // branch sat exactly on origin/main with zero commits ahead, and `gh pr create` refused with
    // "No commits between main and <branch>", failing the whole phase for a retry that had nothing new to do.
    const docsWt = path.join(remote.root, 'wt', 'docs__spec-001-retry');
    await createWorktree(remote.repo, docsWt, 'docs/spec-001-retry', 'origin/main');
    const mainSha = await headSha(remote.repo);
    expect(await commitAll(docsWt, 'docs: no-op retry')).toBeNull();
    expect(await headSha(docsWt)).toBe(mainSha);
    const gates = async () => { throw new Error('gates must not run for an empty docs branch'); };
    const steps = docsMergeSteps(deps({ gates }), 'docs/spec-001-retry', docsWt, 'docs(spec-001): retry');
    const out = await new MergeQueue().enqueue('docs-retry', steps);
    expect(out).toEqual({ ok: true, pr: 0, already: true });
    expect(gh.prs).toEqual([]);
    await expect(fs.access(docsWt)).rejects.toThrow();
  });

  it('pushes and merges again on a second pass when the head changed (merge refused, main moved)', async () => {
    const d = deps();
    const first = taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 'did T1');
    await first.push();
    const sha1 = await headSha(worktree);
    await fs.writeFile(path.join(worktree, 'src', 'sum.ts'), 'export const sum = (a: number, b: number) => a + b; // v2\n');
    await commitAll(worktree, 'feat: v2');
    const second = taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 'did T1');
    await second.push();
    const sha2 = await headSha(worktree);
    expect(sha2).not.toBe(sha1);
    expect(await git(remote.repo, ['ls-remote', 'origin', 'refs/heads/task/spec-001-T1'])).toContain(sha2);
    expect(journal.events.filter((e) => e.kind === 'intent' && e.type === Intent.Push)).toHaveLength(2);
  });
});

describe('afterMerge and the repo lock', () => {
  // git() prepends `-c key=value` pairs; the subcommand follows the last one.
  const subcommand = (s: CommandSpec) => s.args[s.args.lastIndexOf('-c') + 2];

  // checkout and reset --hard rewrite the index and work tree of ws.repo, which other runners read and
  // lock around (fetch, worktree add/remove). No other repo-lock holder may run during or between them.
  it.each(['task', 'docs'] as const)('%s steps run checkout and reset under the repo lock', async (kind) => {
    const timeline: string[] = [];
    const rivals: Promise<void>[] = [];
    const fake = new FakeExec().on((s) => s.bin === 'git', async (s) => {
      const name = subcommand(s);
      if (name !== 'checkout' && name !== 'reset') return {};
      timeline.push(`${name} start`);
      // A rival queues for the lock while the command is in flight; run unlocked, it gets in before the command ends.
      rivals.push(withRepoLock(remote.repo, async () => { timeline.push(`rival of ${name}`); }));
      await new Promise((r) => setImmediate(r));
      timeline.push(`${name} end`);
      return {};
    });
    const d = deps({ exec: fake.exec });
    const steps = kind === 'task' ? taskMergeSteps(d, task, worktree, 'task/spec-001-T1', spec, 's') : docsMergeSteps(d, 'docs/spec-001', worktree, 'docs');
    await steps.afterMerge!();
    await Promise.all(rivals);
    expect(timeline).toEqual(['checkout start', 'checkout end', 'reset start', 'reset end', 'rival of checkout', 'rival of reset']);
  });
});
