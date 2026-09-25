import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Exec } from '../../exec/command.js';
import { commitAll, fetch as gitFetch, git } from '../../git/git.js';
import { ensureRepo } from '../../git/github.js';
import { Intent, OrchEvent } from '../events.js';
import { commitAndMergeDocs, docsWorktree, type PhaseDeps, type PhaseResult } from './shared.js';

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
    await fs.mkdir(ws.repo, { recursive: true });
    if (!(await isRepo(ws.repo))) await git(ws.repo, ['init', '-b', 'main'], deps.exec);
    await fs.cp(opts.docsDir, path.join(ws.repo, 'docs'), { recursive: true, force: true });
    const key = `${spec.specId}-0`;
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
  }

  const { url } = JSON.parse(view.stdout) as { url: string };
  if (!(await isRepo(ws.repo))) {
    await fs.mkdir(path.dirname(ws.repo), { recursive: true });
    await git(path.dirname(ws.repo), ['clone', url, path.basename(ws.repo)], deps.exec);
  }
  const branch = `docs/${spec.specId}-v${version}`;
  const wt = await docsWorktree(deps, branch);
  for (const rel of ['project.md', 'project.json', `specs/${spec.specId}/brief.md`, `specs/${spec.specId}/spec.json`]) {
    await fs.mkdir(path.dirname(path.join(wt, 'docs', rel)), { recursive: true });
    await fs.copyFile(path.join(opts.docsDir, rel), path.join(wt, 'docs', rel));
  }
  return commitAndMergeDocs(deps, 0, branch, wt, `docs(${spec.specId}): spec v${version}`);
}
