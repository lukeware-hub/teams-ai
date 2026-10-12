import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { commitAll, createWorktree, git, headSha, push } from '../../server/git/git.js';
import { Intent, Journal, OrchEvent, intentId } from '../../server/orchestrator/events.js';
import { reconcile, type ReconcileDeps } from '../../server/orchestrator/reconcile.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import { makeFrozenSpec, makePlanTask } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const HASH = makeFrozenSpec().specHash!;
const BRANCH = 'task/spec-001-T1';
let remote: Remote;
let journal: Journal;
let gh: FakeGh;
let worktree: string;
let afterMergeCalls: string[];

beforeEach(async () => {
  remote = await makeRemote({ 'docs/README.md': '# docs' });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  await journal.fact(RunEvent.TaskPlanned, { task: makePlanTask({ id: 'T1' }) });
  for (const to of ['ready', 'implementing', 'validating', 'reviewing', 'rebasing'] as const) await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to });
  gh = new FakeGh();
  worktree = path.join(remote.root, 'wt', 'task__spec-001-T1');
  afterMergeCalls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(): ReconcileDeps {
  const ghExec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
  gh.install(ghExec);
  return {
    journal,
    ws: { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root },
    exec: execCommand,
    ghExec: ghExec.exec,
    afterMerge: async (taskId, branch) => { afterMergeCalls.push(`${taskId}:${branch}`); },
    log: () => {},
  };
}
async function implemented() {
  await createWorktree(remote.repo, worktree, BRANCH, 'origin/main');
  await fs.writeFile(path.join(worktree, 'a.txt'), 'a');
  return commitAll(worktree, 'feat: a');
}

describe('reconcile', () => {
  it('confirms a worktree that exists and marks a missing one for redo', async () => {
    await journal.intent(Intent.WorktreeCreate, 'T1', { worktree, branch: BRANCH });
    let r = await reconcile(deps());
    expect(r).toEqual({ confirmed: [], redo: [intentId(Intent.WorktreeCreate, 'T1')] });
    await createWorktree(remote.repo, worktree, BRANCH, 'origin/main');
    r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.WorktreeCreate, 'T1')]);
    expect(journal.isConfirmed(Intent.WorktreeCreate, 'T1')).toBe(true);
  });

  it('confirms a commit that landed with its sha and flags a dirty or unchanged tree for redo', async () => {
    const base = await git(remote.repo, ['rev-parse', 'origin/main']);
    await journal.intent(Intent.Commit, 's00001', { taskId: 'T1', worktree, baseSha: base });
    await createWorktree(remote.repo, worktree, BRANCH, 'origin/main');
    expect((await reconcile(deps())).redo).toEqual([intentId(Intent.Commit, 's00001')]);
    const sha = await implemented();
    const r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.Commit, 's00001')]);
    expect(journal.events.at(-1)!.data).toEqual({ sha });
  });

  it('confirms a push whose remote sha matches and redoes one that is behind', async () => {
    await implemented();
    await journal.intent(Intent.Push, BRANCH, { worktree, branch: BRANCH });
    expect((await reconcile(deps())).redo).toEqual([intentId(Intent.Push, BRANCH)]);
    await push(worktree, BRANCH);
    expect((await reconcile(deps())).confirmed).toEqual([intentId(Intent.Push, BRANCH)]);
  });

  it('confirms a PR that exists and journals PR_CREATED', async () => {
    await implemented();
    await push(worktree, BRANCH);
    await journal.intent(Intent.PrCreate, BRANCH, { branch: BRANCH, title: 'T1' });
    expect((await reconcile(deps())).redo).toEqual([intentId(Intent.PrCreate, BRANCH)]);
    gh.prs.push({ number: 4, head: BRANCH, base: 'main', state: 'OPEN', headRefOid: await headSha(worktree), title: 'T1', body: '' });
    const r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.PrCreate, BRANCH)]);
    expect(journal.events.find((e) => e.type === OrchEvent.PrCreated)!.data).toMatchObject({ number: 4 });
  });

  it('confirms a merged PR and finishes the task without merging again', async () => {
    await implemented();
    await push(worktree, BRANCH);
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'merging' });
    await journal.intent(Intent.PrMerge, BRANCH, { branch: BRANCH, number: 4, taskId: 'T1' });
    gh.prs.push({ number: 4, head: BRANCH, base: 'main', state: 'MERGED', headRefOid: await headSha(worktree), title: 'T1', body: '' });
    const r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.PrMerge, BRANCH)]);
    expect(afterMergeCalls).toEqual([`T1:${BRANCH}`]);
    expect(journal.state.tasks.get('T1')!.state).toBe('merged');
    expect(journal.events.find((e) => e.type === OrchEvent.PrMerged)!.data).toMatchObject({ taskId: 'T1', pr: 4, already: true, branch: BRANCH });
  });

  it("checks a service task's push, pull request and merge in the repository the intent names", async () => {
    const service = await makeRemote({ 'README.md': '# orders\n' });
    const wt = path.join(service.root, 'wt', 'task__spec-001-T1');
    await createWorktree(service.repo, wt, BRANCH, 'origin/main');
    await fs.writeFile(path.join(wt, 'a.txt'), 'a');
    await commitAll(wt, 'feat: a');
    await push(wt, BRANCH);
    const serviceGh = new FakeGh();
    serviceGh.prs.push({ number: 9, head: BRANCH, base: 'main', state: 'MERGED', headRefOid: await headSha(wt), title: 'T1', body: '' });
    const routed = new FakeExec();
    serviceGh.install(routed);
    const d = deps();
    const ghExec: ReconcileDeps['ghExec'] = (s) => (s.cwd === service.repo ? routed.exec(s) : d.ghExec(s));
    await journal.intent(Intent.Push, `${BRANCH}@x`, { worktree: wt, branch: BRANCH, repo: service.repo });
    await journal.intent(Intent.PrCreate, BRANCH, { branch: BRANCH, title: 'T1', repo: service.repo });
    await journal.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'merging' });
    await journal.intent(Intent.PrMerge, `${BRANCH}@y`, { branch: BRANCH, number: 9, taskId: 'T1', repo: service.repo });
    await journal.intent(Intent.WorktreeRemove, BRANCH, { worktree: wt, repo: service.repo });
    const r = await reconcile({ ...d, ghExec });
    expect(r.redo).toEqual([]);
    expect(journal.state.tasks.get('T1')!.state).toBe('merged');
    await expect(fs.access(wt)).rejects.toThrow();
    await service.cleanup();
  });

  it('removes a worktree whose removal never confirmed', async () => {
    await createWorktree(remote.repo, worktree, BRANCH, 'origin/main');
    await journal.intent(Intent.WorktreeRemove, BRANCH, { worktree });
    const r = await reconcile(deps());
    expect(r.confirmed).toEqual([intentId(Intent.WorktreeRemove, BRANCH)]);
    await expect(fs.access(worktree)).rejects.toThrow();
  });

  it('reports an interrupted step for redo', async () => {
    await journal.fact(OrchEvent.StepStarted, { stepId: 's00003', kind: 'dev', taskId: 'T1' });
    expect((await reconcile(deps())).redo).toEqual(['STEP:s00003']);
  });
});
