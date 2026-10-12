# Plan 66 - Autonomy hardening (R11.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a run recovers on its own from the failures that today end it or waste its attempts: a rebase conflict, a deploy fix that repeats itself, a backlog whose keys or dependencies break, docs that lose what earlier specs wrote, a missing link from a spec to its pull requests, and criteria that pass while their work is blocked.

**Architecture:** each failure gets the smallest fix where it starts, one slice per failure, in the order of the harm it does to an unattended run. A slice ships on its own, with its own plan, after the one before it lands; this document holds the design of all of them and the tasks of the first slice.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest, git and the GitHub CLI.

**Spec:** this document, sections "Human decisions" and "Design"; roadmap item R11.5 in `docs/superpowers/ROADMAP.md`; the repair loop decision under R11.3 of the same file.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- A single-repository run and a services run behave as before except where a slice says otherwise.
- Git work that adds or removes a worktree runs under `withRepoLock(repo)`, as every worktree change in `server/git/git.ts` does.
- Agent prompts stay in English; everything a human reads stays in Brazilian Portuguese.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Slice R11.5.1 only; each later slice writes its own.

1. Both sides created the same file (an add/add conflict): the three-way apply still writes markers, so the Dev resolves it like any other conflict.
2. One side deleted a file the other edited, or the change is binary: git cannot replay it, so the task must stay exactly as it was and keep today's feedback.
3. The process dies between the replay and the next Dev attempt: the task branch already holds the replay commit and the journal holds the previous head, so nothing is lost and no marker can merge.
4. Main moves again while the Dev resolves: the next rebase may conflict again, and the task replays again within its attempt budget.
5. The Dev reports done with a marker left in a file no gate parses (Markdown, YAML): the run refuses it before the gates and before any merge.

## Human decisions

- 2026-10-06: on a failure the system isolates it, reviews, fixes, adjusts and continues; Jev classifies the cause and the SM replans (ROADMAP R11.3, "Repair loop on failure").
- 2026-10-07: Jev's classification is the backbone of refinement; each Jev decision gets its own plan and an eval before it is switched on (ROADMAP R11.5a).
- 2026-10-11: during a run nobody asks the human; the run resolves what it can and reports the rest (this session's "resolva tudo, não pergunte").

## Where autonomy breaks today

- **Rebase conflicts never resolve.** `rebaseOnto` aborts a conflicting rebase (`server/git/git.ts:150-168`), the task goes back to the Dev with the file list (`server/orchestrator/task-runner.ts:539`), and the retry reuses the same worktree on the old base (`task-runner.ts:222-226`). The Dev cannot rebase (its Bash allows only `git status`, `git diff` and `git log`, `server/runner/role-settings.ts:34-53`) and each attempt adds a commit, so the next rebase replays the same conflicting commit and conflicts again. Only a replacement task, cut fresh from main after the SM replans, escapes (`task-runner.ts:235-241`).
- **A deploy fix sees only its own attempt.** `fixTask` (`server/orchestrator/phases/deploy.ts:54-73`) describes the current failure alone; nothing compares attempts, so a fix can repeat or undo the one before it (ROADMAP R11.3 finding 3; R12.7 `cancelar-pedido` run 1, where the smoke fix left the same request in the e2e suite).
- **Backlog keys collide on branches, and dependencies never resolve.** `RESERVED_KEY` (`server/validators/backlog.ts:7-8`) blocks only a key equal to a suffix, but spec ids are now the bare key (`server/refine/specs-index.ts:8`), so the keys `user-login` and `user-login-plan` share the branch `docs/user-login-plan`; and `specs-index.ts:46` maps `dependsOn` to `<draft>-<dep>` while item ids are `<dep>`, so the program controller (`server/program/controller.ts:187`) never starts an item that has a dependency.
- **Each spec's report overwrites the shared docs.** Phase 6 writes `docs/README.md`, `docs/RUNBOOK.md` and `docs/API.md` from the report step alone (`server/orchestrator/phases/report.ts:71-73`); `reportPack` (`server/orchestrator/steps.ts:365-383`) never sees the current files, and the API check covers only the current spec's endpoints (`server/validators/docs.ts:50-61`), so an earlier spec's sections and endpoints disappear.
- **No spec to pull request ledger.** Pull request bodies carry no spec id (`server/orchestrator/merge-steps.ts:30-43,160`), `report.json` lists no pull requests (`report.ts:15`), and the run page joins pull requests to tasks with `branch.endsWith('/' + taskId)` (`web/src/run/selectors.ts:461-474`) while task branches are `task/<specId>-<taskId>` (`server/core/ids.ts:37`), so task links come out empty.
- **Blocked work passes verification.** A criterion whose every task is blocked counts as covered (`server/evidence/matrix.ts:36,57-58`), so Phase 4 passes and Phase 5 deploys code that does not exist yet (R12.7, both specs).
- **Jev answers nothing yet.** `question-routing` classifies blocking refinement questions in shadow mode only (`server/refine/cycle.ts:325-330`) and is off by default; there is no labelled data to evaluate it (`server/decide/evals.ts` has the harness, no labels exist).

## Design

**R11.5.1 Rebase conflicts resolve.** When the merge queue reports a conflict, the task runner fetches main and replays the task onto it as one commit: the task's whole change since its merge base is applied with `git apply --3way` in a scratch worktree, the result is committed there, and only then is the task branch reset to that commit. A conflicting hunk stays in its file between `<<<<<<<` and `>>>>>>>` markers; every other change lands clean. Three outcomes follow, checked against git on 2026-10-12 (same hunk, separate hunks, delete against edit, add against add): markers (a Dev attempt with the list of files to resolve), clean (the task stays in `rebasing` and merges again without spending an attempt), or no replay possible (git refuses a delete against an edit; the task is untouched and gets today's feedback). The journal records `REBASE_REPLAYED` with the previous head. Before the gates, and again before a merge, a change that adds an opening or closing marker line sends the task back to the Dev. After the independent review: the patch travels as a file (a JavaScript string cut it at 1 MiB and re-encoded it as UTF-8), git runs with flags that ignore the operator's diff and whitespace config, only a real conflict is replayed (a failed GitHub call in the rebase stage would otherwise loop on clean replays), a binary file both sides changed counts as not replayable, and paths are never quoted.

**R11.5.2 Deploy fixes remember.** A deploy fix task's description lists every earlier failure of the run (attempt, stage, service, the first lines of the detail) and every earlier fix that merged (its id, summary and files). When a failure repeats the previous attempt's stage and detail after a fix merged, the description says that fix did not change the outcome, so the next one looks for another cause.

**R11.5.3 Backlog keys and dependencies hold.** A key may not end in a branch suffix (`-plan`, `-report`, `-done`, `-readme`, `-workflows`, `-v<n>`) nor equal another key plus one; `specs-index` maps `dependsOn` with the same rule as the item ids, so a dependency names the spec id the controller waits for.

**R11.5.4 Docs accumulate.** The report step receives the current `docs/README.md`, `docs/RUNBOOK.md` and `docs/API.md` and the rule to keep what earlier specs wrote that is still true; the API check also keeps every endpoint the current `docs/API.md` already documents.

**R11.5.5 A spec knows its pull requests.** Every pull request body ends with `Spec: <specId>`; `report.json` gets `prs` (task, number, url, repository) from the `PR_CREATED` and `PR_MERGED` facts; the run page joins pull requests to tasks by the real branch name.

**R11.5.6 Blocked work does not pass.** Phase 4 counts a criterion whose every task is blocked as missing, so it plans a fix task for it (the repair loop inside the run) instead of passing to the deploy.

**R11.5.7 Jev answers from the docs.** Three steps, each switched on only after the one before it is measured: question routing is journaled even when switched off, so labelled data builds up; an eval over that data sets the confidence floor; then a question routed `auto` with enough confidence is answered by its owner role from the docs and recorded as an assumption instead of reaching the human.

## Slices (roadmap R11.5)

| Slice | What it fixes | Why in this order |
|-------|---------------|-------------------|
| R11.5.1 | Rebase conflicts resolve | Every parallel task can hit it, and today it burns three attempts and a replan on a conflict no retry can clear |
| R11.5.2 | Deploy fixes remember | Seen live twice; a run ends `deploy-failed` on a defect a fix already found once |
| R11.5.3 | Backlog keys and dependencies | A program with dependencies never starts its dependent items (a bug found by reading, no live case yet) |
| R11.5.4 | Docs accumulate | Every second spec of a project loses the first one's docs |
| R11.5.5 | Spec to pull request ledger | Traceability, and the empty task links on the run page |
| R11.5.6 | Blocked work does not pass | Changes evidence semantics, so it comes after the fixes that make blocks rarer |
| R11.5.7 | Jev answers from the docs | Needs labelled data and an eval before anything is switched on |

## Risks and open points

- A replay rewrites the task branch; the previous head stays reachable through the reflog and the `REBASE_REPLAYED` fact, never through a branch.
- The scratch worktree lives in the system temporary directory and is removed in a `finally`; a crash can leave one behind, a detached checkout no branch points to, until the system cleans its temporary directory, and `git worktree prune` then drops its registration.
- A replay that is clean still changes the code the review approved; the merge queue runs the gates again after its own rebase, so a break still fails there.
- The run page shows no activity line for `REBASE_REPLAYED` yet; the feedback text carries it, and R11.5.5 can add the line with the ledger.

## Slice R11.5.1 tasks

### Task 1: Replay a branch onto main and find leftover markers

**Files:**
- Modify: `server/git/git.ts` (after `rebaseOnto`, around line 168)
- Test: `test/git/git.test.ts` (in the `describe` that holds `rebaseOnto`, around line 123)

**Interfaces:**
- Consumes: `run`, `git`, `headSha`, `withRepoLock`, `SAFE_CONFIG`, `GIT_IDENTITY`, `TIMEOUT` (all in `server/git/git.ts`).
- Produces:
  - `replayOnto(repo: string, dir: string, base: string, message: string, exec?: Exec): Promise<{ previous: string; files: string[] } | null>`
  - `conflictMarkerFiles(dir: string, files: readonly string[], exec?: Exec): Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

Add these cases after the `rebaseOnto` conflict test in `test/git/git.test.ts` (it already has `root`, `repo`, `write`, `commitAll`, `createWorktree`, `headSha` and `git`), and add `replayOnto` and `conflictMarkerFiles` to its import from `../../server/git/git.js`:

```ts
  it('replays a conflicting branch onto the base as one commit, with markers where both sides changed the same lines', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'README.md', 'from task\n');
    await write(wt, 'src/a.ts', 'task only\n');
    await commitAll(wt, 'docs: task');
    const previous = await headSha(wt);
    await write(repo, 'README.md', 'from main\n');
    await commitAll(repo, 'docs: main');
    expect(await replayOnto(repo, wt, 'main', 'T1: replay onto main')).toEqual({ previous, files: ['README.md'] });
    expect(await git(wt, ['log', '-1', '--format=%s'])).toBe('T1: replay onto main');
    expect(await git(wt, ['rev-parse', 'HEAD~1'])).toBe(await headSha(repo));
    expect(await fs.readFile(path.join(wt, 'README.md'), 'utf8')).toMatch(/^<<<<<<< [\s\S]*from main[\s\S]*from task[\s\S]*^>>>>>>> /m);
    expect(await fs.readFile(path.join(wt, 'src/a.ts'), 'utf8')).toBe('task only\n');
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
  });

  it('replays clean when the two sides changed different lines', async () => {
    await write(repo, 'notes.txt', 'one\ntwo\nthree\nfour\nfive\n');
    await commitAll(repo, 'docs: notes');
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'notes.txt', 'ONE\ntwo\nthree\nfour\nfive\n');
    await commitAll(wt, 'docs: task');
    await write(repo, 'notes.txt', 'one\ntwo\nthree\nfour\nFIVE\n');
    await commitAll(repo, 'docs: main');
    expect((await replayOnto(repo, wt, 'main', 'T1: replay'))!.files).toEqual([]);
    expect(await fs.readFile(path.join(wt, 'notes.txt'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
  });

  it('leaves the branch untouched when git cannot replay the change, such as a file deleted on one side and edited on the other', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await git(wt, ['rm', '-q', 'README.md']);
    await git(wt, ['commit', '-q', '-m', 'docs: drop readme']);
    const before = await headSha(wt);
    await write(repo, 'README.md', 'edited on main\n');
    await commitAll(repo, 'docs: main');
    expect(await replayOnto(repo, wt, 'main', 'T1: replay')).toBeNull();
    expect(await headSha(wt)).toBe(before);
    expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('teams-ai-replay-');
  });

  it('lists the changed files that still hold conflict markers, skipping binary and deleted ones', async () => {
    await write(repo, 'a.md', 'title\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n');
    await write(repo, 'b.md', 'clean\n=======\n');
    await commitAll(repo, 'docs: files');
    expect(await conflictMarkerFiles(repo, ['a.md', 'b.md', 'gone.md'])).toEqual(['a.md']);
    expect(await conflictMarkerFiles(repo, [])).toEqual([]);
  });
```


- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/git/git.test.ts`
Expected: FAIL, `replayOnto is not a function` (the import resolves to undefined).

- [ ] **Step 3: Implement**

In `server/git/git.ts`, replace the first line `import { realpathSync } from 'node:fs';` with these three imports:

```ts
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
```

Then add after `rebaseOnto`:

```ts
/**
 * Moves a branch whose rebase conflicted onto `base` as one commit. Its whole change since the merge base is applied
 * three-way in a scratch worktree, so a hunk both sides changed stays in its file between conflict markers, and the
 * branch moves only once that commit exists. Returns the previous head and the files holding markers, or null when git
 * cannot replay the change at all (a file deleted on one side and edited on the other); the branch is then untouched.
 */
export async function replayOnto(repo: string, dir: string, base: string, message: string, exec: Exec = execCommand): Promise<{ previous: string; files: string[] } | null> {
  const previous = await headSha(dir, exec);
  const mergeBase = await git(dir, ['merge-base', 'HEAD', base], exec);
  // Raw output: git() trims, and a patch without its final newline is corrupt.
  const patch = (await run(dir, ['diff', '--binary', mergeBase, 'HEAD'], exec)).stdout;
  if (patch === '') return null;
  const scratch = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-replay-')), 'wt');
  await withRepoLock(repo, () => git(repo, ['worktree', 'add', '--detach', scratch, base], exec));
  try {
    const applied = await exec({ bin: 'git', args: [...SAFE_CONFIG, 'apply', '--3way'], cwd: scratch, env: GIT_IDENTITY, timeoutMs: TIMEOUT, stdin: patch });
    const unmerged = await git(scratch, ['diff', '--name-only', '--diff-filter=U'], exec);
    const files = unmerged === '' ? [] : unmerged.split('\n');
    if (applied.exitCode !== 0 && files.length === 0) return null;
    await git(scratch, ['add', '-A'], exec);
    await git(scratch, ['commit', '-q', '-m', message], exec);
    await git(dir, ['reset', '-q', '--hard', await headSha(scratch, exec)], exec);
    return { previous, files };
  } finally {
    await withRepoLock(repo, () => git(repo, ['worktree', 'remove', '--force', scratch], exec)).catch(() => undefined);
    await fs.rm(path.dirname(scratch), { recursive: true, force: true });
  }
}

/** The files among `files` that still hold a conflict marker line; binary and missing files never count. */
export async function conflictMarkerFiles(dir: string, files: readonly string[], exec: Exec = execCommand): Promise<string[]> {
  if (files.length === 0) return [];
  const r = await run(dir, ['grep', '-I', '-l', '-E', '^(<<<<<<<|>>>>>>>)( |$)', '--', ...files], exec);
  return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim().split('\n') : [];
}
```


- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/git/git.test.ts && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/git/git.ts test/git/git.test.ts
git commit -m "feat(git): replay a conflicting branch onto main with conflict markers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The task runner replays a conflicting task and refuses leftover markers

**Files:**
- Modify: `server/orchestrator/events.ts` (the `OrchEvent` map, after `PrMerged`)
- Modify: `server/orchestrator/task-runner.ts` (the `case 'rebase':` branch around line 539, the Dev commit path around lines 336-348, and `merge()` around line 510)
- Test: `test/orchestrator/task-runner.test.ts` (next to "sends rebase conflicts back to Dev as an attempt", around line 553)

**Interfaces:**
- Consumes: `replayOnto`, `conflictMarkerFiles` (Task 1); `fetch as gitFetch`, `changedFiles` (already imported by `task-runner.ts`).
- Produces: `OrchEvent.RebaseReplayed = 'REBASE_REPLAYED'`, journaled as `{ taskId: string; previous: string; files: string[] }`.

- [ ] **Step 1: Write the failing tests**

Add to the merge `describe` of `test/orchestrator/task-runner.test.ts`, which already has `reviewed`, `state`, `journal`, `remote`, `git`, `headSha`, `fs` and `path`:

```ts
  /** Main gets `content` for `file`, committed and pushed, as another task's merge would leave it. */
  async function mainWrites(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(remote.repo, file)), { recursive: true });
    await fs.writeFile(path.join(remote.repo, file), content);
    await git(remote.repo, ['add', '-A']);
    await git(remote.repo, ['commit', '-q', '-m', `main: ${file}`]);
    await git(remote.repo, ['push', '-q', 'origin', 'HEAD:main']);
  }

  it('moves a conflicting task onto the current main with conflict markers, so the next Dev attempt can resolve them', async () => {
    await mainWrites('src/a.ts', 'base\n');
    const r = await reviewed({ merge: { rebase: async () => ({ ok: false, conflicts: ['src/a.ts'] }) } });
    const previous = await headSha(r.worktree);
    await mainWrites('src/a.ts', 'from main\n');
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(await fs.readFile(path.join(r.worktree, 'src', 'a.ts'), 'utf8')).toMatch(/^<<<<<<< [\s\S]*from main/m);
    expect(await git(r.worktree, ['rev-parse', 'HEAD~1'])).toBe(await git(remote.repo, ['rev-parse', 'HEAD']));
    expect(journal.events.find((e) => e.type === OrchEvent.RebaseReplayed)!.data).toEqual({ taskId: 'T1', previous, files: ['src/a.ts'] });
    expect(journal.lastFeedback('T1')).toContain('moved this task onto the current origin/main');
  });

  it('merges again without spending an attempt when the replay onto main is clean', async () => {
    await mainWrites('src/a.ts', 'base\n');
    let calls = 0;
    const r = await reviewed({ merge: { rebase: async () => (calls++ === 0 ? { ok: false, conflicts: ['src/a.ts'] } : { ok: true, baseSha: 'base' }) } });
    await mainWrites('src/other.ts', 'unrelated\n');
    await r.advance();
    expect(state()).toMatchObject({ state: 'rebasing', attempts: 0 });
    expect(journal.events.find((e) => e.type === OrchEvent.RebaseReplayed)!.data).toMatchObject({ files: [] });
    await r.advance();
    expect(state().state).toBe('merged');
  });

  it('keeps the conflict list as feedback when git cannot replay the task, such as an edit of a file main deleted', async () => {
    await mainWrites('src/a.ts', 'base\n');
    const r = await reviewed({ merge: { rebase: async () => ({ ok: false, conflicts: ['src/a.ts'] }) } });
    const previous = await headSha(r.worktree);
    await git(remote.repo, ['rm', '-q', 'src/a.ts']);
    await git(remote.repo, ['commit', '-q', '-m', 'main: drop a']);
    await git(remote.repo, ['push', '-q', 'origin', 'HEAD:main']);
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toBe('Rebase conflicts on origin/main:\nsrc/a.ts');
    expect(await headSha(r.worktree)).toBe(previous);
    expect(journal.events.some((e) => e.type === OrchEvent.RebaseReplayed)).toBe(false);
  });

  it('refuses a Dev result that leaves conflict markers, before any gate runs', async () => {
    const gatesRun: string[] = [];
    const markers: Agent = async (req) => {
      // A Markdown file: no gate would fail on the markers, so only the guard stops them.
      await fs.mkdir(path.join(req.cwd, 'src'), { recursive: true });
      await fs.writeFile(path.join(req.cwd, 'src', 'notes.md'), '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> task\n');
      return ok({ specHash: HASH, status: 'done', summary: 'notes', changedFiles: ['src/notes.md'], commitMessage: 'docs: notes' });
    };
    const r = new TaskRunner('T1', deps({ agent: markers, gates: async (wt) => { gatesRun.push(wt); return { results: [], blockingFailure: null }; } }));
    await r.advance();
    expect(state()).toMatchObject({ state: 'implementing', attempts: 1 });
    expect(journal.lastFeedback('T1')).toContain('src/notes.md');
    expect(gatesRun).toEqual([]);
  });
```

The task fixture `T1` may change only `src` (`affectedPaths: ['src']`), so every file these cases write lives under `src/`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/task-runner.test.ts`
Expected: the four new cases FAIL (no `REBASE_REPLAYED`, markers reach the gates); every existing case passes.

- [ ] **Step 3: Implement**

In `server/orchestrator/events.ts`, add to `OrchEvent` after `PrMerged`:

```ts
  /** A conflicting task moved onto origin/main as one commit, conflict markers where both sides changed the same lines. */
  RebaseReplayed: 'REBASE_REPLAYED',
```

In `server/orchestrator/task-runner.ts`, change the import on line 25 to:

```ts
import { changedFiles, commitAll, conflictMarkerFiles, createWorktree, fetch as gitFetch, git, removeWorktree, replayOnto } from '../git/git.js';
```

Then add this method to `TaskRunner`:

```ts
  /** Feedback when a changed file still holds conflict markers, or null. */
  private async markersLeft(): Promise<string | null> {
    const marked = await conflictMarkerFiles(this.worktree, await changedFiles(this.worktree, 'origin/main', this.deps.exec), this.deps.exec);
    return marked.length > 0 ? `Conflict markers remain in these files; resolve every <<<<<<< and >>>>>>> block, then run the project's tests:\n${marked.join('\n')}` : null;
  }
```

In the Dev commit path, right after the `if (changed.length === 0) { ... }` block and before `DevCommitted`:

```ts
    const markers = await this.markersLeft();
    if (markers) return this.fail('code', markers);
```

At the start of `merge()`, before the merge steps are built:

```ts
    // A resume can reach the merge with the replay's markers still in place; they must never merge.
    const markers = this.task.state === 'rebasing' ? await this.markersLeft() : null;
    if (markers) return this.fail('code', markers);
```

Replace the `case 'rebase':` branch with:

```ts
      case 'rebase': {
        // A retry on the old base replays the same conflicting commit (the Dev cannot rebase), so move the task onto main first.
        await gitFetch(this.deps.ws.repo, this.deps.exec);
        const replay = await replayOnto(this.deps.ws.repo, this.worktree, 'origin/main', `${this.taskId}: replay onto origin/main`, this.deps.exec).catch(() => null);
        if (!replay) return this.fail('rebase-conflict', `Rebase conflicts on origin/main:\n${(outcome.conflicts ?? []).join('\n')}`);
        await this.deps.journal.fact(OrchEvent.RebaseReplayed, { taskId: this.taskId, previous: replay.previous, files: replay.files });
        // Clean: the task stays in rebasing and the next advance merges it, no attempt spent.
        if (replay.files.length === 0) return;
        return this.fail('rebase-conflict', `Rebase conflicts on origin/main. The orchestrator moved this task onto the current origin/main; these files hold conflict markers where both sides changed the same lines. In each, keep main's change and this task's intent and remove every marker, then run the project's tests:\n${replay.files.join('\n')}`);
      }
```


- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/orchestrator/task-runner.test.ts test/orchestrator/loop.test.ts && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/events.ts server/orchestrator/task-runner.ts test/orchestrator/task-runner.test.ts
git commit -m "fix(merge): a conflicting task moves onto main with conflict markers the Dev resolves

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The Dev resolves conflict markers

**Files:**
- Modify: `.claude/agents/dev.md` (the "Rules you never break" list)
- Test: `test/agents/prompts.test.ts`

**Interfaces:**
- Consumes: the feedback text of Task 2.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing test**

Add to the `describe` of `test/agents/prompts.test.ts`:

```ts
  it('tell the Dev how to resolve the conflict markers of a task the orchestrator moved onto main', () => {
    expect(agent('dev')).toContain('When the feedback says the orchestrator moved the task onto origin/main');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/agents/prompts.test.ts`
Expected: FAIL on the new case.

- [ ] **Step 3: Implement**

Add this rule to `.claude/agents/dev.md`, after the rule about a command Bash refuses:

```md
- When the feedback says the orchestrator moved the task onto origin/main, each listed file holds conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) where main and this task changed the same lines: read main's side and yours, write one version that keeps main's change and this task's intent, remove every marker line, then run the project's tests; never resolve by dropping one side whole.
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/agents`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/agents/dev.md test/agents/prompts.test.ts
git commit -m "docs(agents): the Dev resolves the conflict markers of a replayed task

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Record R11.5.1 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (section `### R11.5 Autonomy hardening`)
- Modify: `docs/superpowers/plans/README.md` (the table, after row 65)

- [ ] **Step 1: Update the roadmap**

Change the heading to `### R11.5 Autonomy hardening - \`partial\` (plan 66, 2026-10-12)` and add after its first bullet:

```md
- Design and slices: `plans/2026-10-12-teams-ai-66-autonomy-hardening.md` (R11.5.1 rebase conflicts, R11.5.2 deploy fixes remember, R11.5.3 backlog keys and dependencies, R11.5.4 docs accumulate, R11.5.5 spec to pull request ledger, R11.5.6 blocked work does not pass, R11.5.7 Jev answers from the docs).
- Built R11.5.1 (plan 66): a task whose rebase conflicts moves onto the current main as one commit, with conflict markers where both sides changed the same lines (`replayOnto` in `server/git/git.ts`, `REBASE_REPLAYED`); a clean replay merges again without spending an attempt, markers go to the Dev with the files to resolve, and a change git cannot replay keeps today's feedback; a changed file that still holds a marker never reaches the gates or a merge (`conflictMarkerFiles`).
```

- [ ] **Step 2: Update the plans index**

Add after row 65 of `docs/superpowers/plans/README.md`:

```md
| 66 | [`2026-10-12-teams-ai-66-autonomy-hardening.md`](2026-10-12-teams-ai-66-autonomy-hardening.md) | Slice R11.5.1 done (rebase conflicts resolve) — a run recovers from the failures that end it or waste its attempts; ROADMAP R11.5. |
```

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.5.1 rebase conflicts resolve

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
