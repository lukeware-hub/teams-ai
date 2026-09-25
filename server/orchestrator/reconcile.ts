import { promises as fs } from 'node:fs';
import type { Exec } from '../exec/command.js';
import type { DeploymentIntent } from '../deploy/target.js';
import { git, headSha, removeWorktree } from '../git/git.js';
import { findMergedPr, prState } from '../git/github.js';
import { RunEvent } from '../pipeline/run-state.js';
import type { StoredEvent } from '../store/event-store.js';
import { Intent, OrchEvent, type IntentType, type Journal } from './events.js';
import type { Workspace } from './workspace.js';

export interface ReconcileDeps {
  journal: Journal;
  ws: Workspace;
  exec: Exec;
  ghExec: Exec;
  afterMerge: (taskId: string, branch: string) => Promise<void>;
  log: (line: string) => void;
  currentImage?: (intent: DeploymentIntent) => Promise<string | null>;
}

export interface ReconcileReport {
  confirmed: string[];
  redo: string[];
}

const keyOf = (e: StoredEvent) => e.intentId!.slice(e.intentId!.indexOf(':') + 1);

async function insideWorktree(dir: string, exec: Exec): Promise<boolean> {
  try {
    await fs.access(dir);
    await git(dir, ['rev-parse', '--is-inside-work-tree'], exec);
    return true;
  } catch {
    return false;
  }
}

/** Spec (orchestrator) §6: an intent without a confirm is checked against reality, never replayed blindly. */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const { journal, exec, ghExec } = deps;
  const report: ReconcileReport = { confirmed: [], redo: [] };
  const confirm = async (e: StoredEvent, data: Record<string, unknown>) => {
    await journal.confirm(e.type as IntentType, keyOf(e), data);
    report.confirmed.push(e.intentId!);
    deps.log(`reconcile: confirmed ${e.intentId}`);
  };
  const redo = (e: StoredEvent) => {
    report.redo.push(e.intentId!);
    deps.log(`reconcile: redo ${e.intentId}`);
  };

  for (const e of journal.unconfirmed()) {
    const d = e.data as Record<string, string | number | undefined>;
    switch (e.type) {
      case Intent.WorktreeCreate: {
        (await insideWorktree(String(d.worktree), exec)) ? await confirm(e, {}) : redo(e);
        break;
      }
      case Intent.Commit:
      case Intent.DocsCommit: {
        const wt = String(d.worktree);
        if (!(await insideWorktree(wt, exec))) {
          redo(e);
          break;
        }
        const dirty = (await git(wt, ['status', '--porcelain', '--untracked-files=all'], exec)) !== '';
        // A repository without commits yet (Phase 0 bootstrap) has no HEAD: the commit never happened.
        const head = await headSha(wt, exec).catch(() => null);
        if (head === null) {
          redo(e);
          break;
        }
        const moved = d.baseSha === undefined || head !== d.baseSha;
        !dirty && moved ? await confirm(e, { sha: head }) : redo(e);
        break;
      }
      case Intent.Push: {
        const wt = String(d.worktree);
        const branch = String(d.branch);
        if (!(await insideWorktree(wt, exec))) {
          redo(e);
          break;
        }
        const local = await headSha(wt, exec);
        const remote = (await git(deps.ws.repo, ['ls-remote', 'origin', `refs/heads/${branch}`], exec)).split(/\s+/)[0] ?? '';
        remote === local ? await confirm(e, { sha: local }) : redo(e);
        break;
      }
      case Intent.RepoCreate: {
        const view = await ghExec({ bin: 'gh', args: ['repo', 'view', `${String(d.owner)}/${String(d.name)}`, '--json', 'nameWithOwner,url'], cwd: deps.ws.root, timeoutMs: 60_000 });
        view.exitCode === 0 ? await confirm(e, JSON.parse(view.stdout) as Record<string, unknown>) : redo(e);
        break;
      }
      case Intent.PrCreate: {
        const branch = String(d.branch);
        const list = await deps.ghExec({ bin: 'gh', args: ['pr', 'list', '--head', branch, '--base', 'main', '--state', 'all', '--json', 'number,url'], cwd: deps.ws.repo, timeoutMs: 60_000 });
        const rows = list.exitCode === 0 ? (JSON.parse(list.stdout || '[]') as Array<{ number: number; url: string }>) : [];
        if (rows[0]) {
          await confirm(e, { number: rows[0].number, url: rows[0].url });
          await journal.fact(OrchEvent.PrCreated, { branch, number: rows[0].number, url: rows[0].url, created: false });
        } else redo(e);
        break;
      }
      case Intent.PrMerge: {
        const branch = String(d.branch);
        const number = Number(d.number);
        let merged = (await findMergedPr({ cwd: deps.ws.repo, head: branch, base: 'main' }, ghExec)) !== null;
        if (!merged && Number.isFinite(number)) merged = (await prState({ cwd: deps.ws.repo, number }, ghExec).catch(() => ({ state: 'OPEN' as const }))).state === 'MERGED';
        if (!merged) {
          redo(e);
          break;
        }
        await confirm(e, { merged: true, already: true });
        const taskId = String(d.taskId);
        await deps.afterMerge(taskId, branch);
        const handoff = journal.handoffs().find((h) => h.taskId === taskId) ?? null;
        await journal.fact(OrchEvent.PrMerged, { taskId, pr: number, sha: null, already: true, warning: null, handoff });
        const task = journal.state.tasks.get(taskId);
        if (task && task.state === 'rebasing') await journal.fact(RunEvent.TaskStateChanged, { taskId, to: 'merging' });
        if (task && (task.state === 'merging' || task.state === 'rebasing')) await journal.fact(RunEvent.TaskStateChanged, { taskId, to: 'merged' });
        break;
      }
      case Intent.WorktreeRemove: {
        const wt = String(d.worktree);
        if (await insideWorktree(wt, exec)) await removeWorktree(deps.ws.repo, wt, exec);
        await confirm(e, {});
        break;
      }
      case Intent.DeployApply: {
        const intent = d.intent as unknown as DeploymentIntent | undefined;
        const running = intent && deps.currentImage ? await deps.currentImage(intent) : null;
        running !== null && running === `${String(d.image)}:${String(d.tag)}` ? await confirm(e, { previous: null, reconciled: true }) : redo(e);
        break;
      }
      default:
        redo(e);
    }
  }

  const finished = new Set(journal.events.filter((e) => e.type === OrchEvent.StepFinished).map((e) => String(e.data.stepId)));
  for (const e of journal.events) {
    if (e.type === OrchEvent.StepStarted && !finished.has(String(e.data.stepId))) {
      report.redo.push(`STEP:${String(e.data.stepId)}`);
      deps.log(`reconcile: step ${String(e.data.stepId)} was interrupted; it re-runs without an attempt`);
    }
  }
  return report;
}
