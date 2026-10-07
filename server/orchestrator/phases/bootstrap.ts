import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Exec } from '../../exec/command.js';
import { commitAll, fetch as gitFetch, git } from '../../git/git.js';
import { ensureRepo, NOT_FOUND } from '../../git/github.js';
import type { Plan } from '../../contracts/plan.js';
import { Intent, OrchEvent } from '../events.js';
import { renderWorkflows, validateWorkflow } from '../workflows.js';
import { commitAndMergeDocs, docsCommitKey, docsWorktree, type PhaseDeps, type PhaseResult } from './shared.js';

const isRepo = (dir: string) => fs.access(path.join(dir, '.git')).then(() => true, () => false);

/** Spec (refinement) §4: put the draft's docs on main — by creating the repository or by a docs PR. */
export async function runPhase0(deps: PhaseDeps & { ghExec: Exec }, opts: { docsDir: string; owner: string | undefined }): Promise<PhaseResult> {
  const { journal, ws, spec, project } = deps;
  if (!journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 0)) await journal.fact(OrchEvent.PhaseStarted, { phase: 0 });
  const gh = (args: string[]) => deps.ghExec({ bin: 'gh', args, cwd: ws.root, timeoutMs: 60_000 });
  const owner = opts.owner ?? (JSON.parse((await gh(['api', 'user'])).stdout) as { login: string }).login;
  const fullName = `${owner}/${project.projectId}`;
  const view = await gh(['repo', 'view', fullName, '--json', 'nameWithOwner,url']);
  const version = spec.specVersion;

  if (view.exitCode !== 0) {
    // A `gh repo view` failure only means "no repository" when it says so; anything else (auth,
    // network, rate limit) is a hard failure, never a silent switch to creating one.
    if (!NOT_FOUND.test(view.stderr)) {
      const reason = `gh repo view failed: ${view.stderr.trim()}`;
      await journal.fact(OrchEvent.PhaseFailed, { phase: 0, reason });
      return { ok: false, reason };
    }
    try {
      await fs.mkdir(ws.repo, { recursive: true });
      if (!(await isRepo(ws.repo))) await git(ws.repo, ['init', '-b', 'main'], deps.exec);
      await fs.cp(opts.docsDir, path.join(ws.repo, 'docs'), { recursive: true, force: true });
      const key = docsCommitKey(deps, 0);
      const message = `docs: ${project.projectId} ${spec.specId} v${version}`;
      if (!journal.isConfirmed(Intent.DocsCommit, key)) {
        await journal.intent(Intent.DocsCommit, key, { worktree: ws.repo, branch: 'main', message });
        const sha = (await commitAll(ws.repo, message, {}, deps.exec)) ?? (await git(ws.repo, ['rev-parse', 'HEAD'], deps.exec));
        await journal.confirm(Intent.DocsCommit, key, { sha });
      }
      if (!journal.isConfirmed(Intent.RepoCreate, project.projectId)) {
        await journal.intent(Intent.RepoCreate, project.projectId, { owner, name: project.projectId });
        const created = await ensureRepo({ owner, name: project.projectId, private: true, cwd: ws.repo }, deps.ghExec);
        await journal.confirm(Intent.RepoCreate, project.projectId, created);
        await journal.fact(OrchEvent.RepoBootstrapped, created);
      }
      await gitFetch(ws.repo, deps.exec);
      return { ok: true };
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err; // CrashInjected (test hook) must still kill the process
      const reason = (err as Error).message;
      await journal.fact(OrchEvent.PhaseFailed, { phase: 0, reason });
      return { ok: false, reason };
    }
  }

  const { url } = JSON.parse(view.stdout) as { url: string };
  if (!(await isRepo(ws.repo))) {
    await fs.mkdir(path.dirname(ws.repo), { recursive: true });
    await git(path.dirname(ws.repo), ['clone', url, path.basename(ws.repo)], deps.exec);
  }
  const branch = `docs/${spec.specId}-v${version}`;
  // A crash after the commit is confirmed but before it merges must never let a resumed
  // recreate-worktree silently reset the branch and lose it (spec (orchestrator) §6 crash recovery).
  const wt = await docsWorktree(deps, branch, { keepCommits: journal.isConfirmed(Intent.DocsCommit, docsCommitKey(deps, 0)) });
  // The project docs and this run's own spec directory always go (main may hold its planned copy: the frozen one replaces it);
  // everything else the draft has (briefing, stack, flow, design, backlog, the index, the other planned specs) only when main
  // lacks it, so a spec already delivered keeps the status main gave it.
  const own = `specs/${spec.specId}/`;
  for (const rel of await listFiles(opts.docsDir)) {
    const target = path.join(wt, 'docs', rel);
    const owned = rel === 'project.md' || rel === 'project.json' || rel.startsWith(own);
    if (!owned && (await exists(target))) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(opts.docsDir, rel), target);
  }
  return commitAndMergeDocs(deps, 0, branch, wt, `docs(${spec.specId}): spec v${version}`);
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** Every file under `dir`, as `/`-separated relative paths. */
async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(dir, child)));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/**
 * R8.3: once the plan exists, commit the rendered CI and release workflows to main through a docs PR.
 * Files main already carries are never overwritten. The plan only exists after Phase 2, so this runs
 * right after it rather than inside `runPhase0`.
 */
export async function runWorkflowBootstrap(deps: PhaseDeps, plan: Plan): Promise<PhaseResult> {
  const { journal, spec } = deps;
  const branch = `docs/${spec.specId}-workflows`;
  const resumed = journal.isConfirmed(Intent.DocsCommit, docsCommitKey(deps, 7));
  const wt = await docsWorktree(deps, branch, { keepCommits: resumed });
  if (!resumed) {
    let wrote = 0;
    for (const f of renderWorkflows(plan)) {
      if (await fs.access(path.join(wt, f.path)).then(() => true, () => false)) continue;
      const errors = validateWorkflow(f.kind, f.text, plan);
      if (errors.length > 0) {
        const reason = `rendered ${f.path} is invalid: ${errors.join('; ')}`;
        await journal.fact(OrchEvent.PhaseFailed, { phase: 7, reason });
        return { ok: false, reason };
      }
      await fs.mkdir(path.dirname(path.join(wt, f.path)), { recursive: true });
      await fs.writeFile(path.join(wt, f.path), f.text);
      wrote += 1;
    }
    if (wrote === 0) return { ok: true };
  }
  return commitAndMergeDocs(deps, 7, branch, wt, `ci(${spec.specId}): GitHub Actions workflows`);
}
