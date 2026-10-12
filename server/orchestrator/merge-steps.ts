import type { PlanTask } from '../contracts/plan.js';
import type { AcceptanceCriterion, Spec } from '../contracts/spec.js';
import { redactSecrets } from '../core/redact.js';
import type { Exec } from '../exec/command.js';
import type { GateResult } from '../exec/gate-runner.js';
import { changedFiles, fetch as gitFetch, git, headSha, push, rebaseOnto, remoteMainSha, removeWorktree, withCheckoutLock, withRepoLock } from '../git/git.js';
import { ensurePr, findMergedPr, mergePr } from '../git/github.js';
import type { MergeSteps } from '../git/merge-queue.js';
import type { HandoffSummary } from '../knowledge/context-pack.js';
import type { Graphify } from '../knowledge/graphify.js';
import { Intent, OrchEvent, type Journal } from './events.js';
import { graphDir, type Workspace } from './workspace.js';

export interface MergeStepsDeps {
  journal: Journal;
  ws: Workspace;
  /** Orchestrator tools without credentials (git). */
  exec: Exec;
  /** Same executor with GH_TOKEN for `gh`; never handed to agents. */
  ghExec: Exec;
  gates: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
  graphify: Graphify | null;
  secretValues: () => readonly string[];
  handoffs: HandoffSummary[];
  clock: () => Date;
}

const BODY_LIMIT = 8 * 1024;

export function prBody(input: { summary: string; criteria: readonly AcceptanceCriterion[]; gateLines: readonly string[]; specId: string }, secretValues: readonly string[]): string {
  const text = [
    '## Summary',
    input.summary,
    '',
    '## Acceptance criteria',
    ...input.criteria.map((c) => `- **${c.id}** Given ${c.given}, when ${c.when}, then ${c.then}`),
    '',
    '## Gates',
    ...input.gateLines.map((l) => `- ${l}`),
  ].join('\n');
  const clean = redactSecrets(text, secretValues);
  // The spec line comes last and survives the cap, so every pull request names its spec.
  const spec = `\n\nSpec: ${input.specId}`;
  const limit = BODY_LIMIT - spec.length;
  return `${clean.length > limit ? `${clean.slice(0, limit - 16)}\n[... truncated]` : clean}${spec}`;
}

const gateLine = (r: GateResult) => `${r.name}: ${r.passed ? 'passed' : `failed (${r.failure}, exit ${r.exitCode})`}`;
const tail = (s: string) => (s.length > 2000 ? s.slice(-2000) : s);

async function guarded(journal: Journal, type: (typeof Intent)[keyof typeof Intent], key: string, data: Record<string, unknown>, effect: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (journal.isConfirmed(type, key)) {
    const confirm = [...journal.events].reverse().find((e) => e.kind === 'confirm' && e.intentId === `${type}:${key}`);
    return confirm?.data ?? {};
  }
  await journal.intent(type, key, data);
  const result = await effect();
  await journal.confirm(type, key, result);
  return result;
}

function common(deps: MergeStepsDeps, worktree: string, branch: string, title: string, body: () => Promise<string>, runGates: boolean, taskId: string | null = null) {
  const repo = deps.ws.repo;
  return {
    alreadyMerged: async () => findMergedPr({ cwd: repo, head: branch, base: 'main', headSha: await headSha(worktree, deps.exec).catch(() => undefined) }, deps.ghExec),
    rebase: async () => {
      await gitFetch(repo, deps.exec);
      const r = await rebaseOnto(worktree, 'origin/main', deps.exec);
      // A worktree whose commit (or lack of one) left it exactly on baseSha has nothing to push or PR:
      // content already identical to main, typically a retry of a Phase 0 whose docs already merged.
      return r.ok && (await headSha(worktree, deps.exec)) === r.baseSha ? { ...r, empty: true } : r;
    },
    gates: async () => {
      if (!runGates) return { ok: true };
      const r = await deps.gates(worktree, branch);
      if (!r.blockingFailure) return { ok: true };
      const f = r.blockingFailure;
      return { ok: false, failure: f, detail: redactSecrets(`${gateLine(f)}\n${tail(f.stderrTail || f.stdoutTail)}`, deps.secretValues()) };
    },
    push: async () => {
      // Keyed by head sha: a second pass through the queue (merge refused, conflict resolved, resume)
      // has a new head and must push again; a plain branch key would skip it forever.
      const sha = await headSha(worktree, deps.exec);
      await guarded(deps.journal, Intent.Push, `${branch}@${sha}`, { worktree, branch, sha, repo }, async () => {
        await push(worktree, branch, deps.exec);
        return { sha };
      });
    },
    ensurePr: async () => {
      const data = await guarded(deps.journal, Intent.PrCreate, branch, { branch, title, repo }, async () => {
        const pr = await ensurePr({ cwd: repo, head: branch, base: 'main', title, body: await body() }, deps.ghExec);
        return { number: pr.number, url: pr.url, created: pr.created };
      });
      // The fact follows the confirm: it describes a PR whose existence is already recorded as reality.
      await deps.journal.fact(OrchEvent.PrCreated, { branch, number: Number(data.number), url: String(data.url), created: data.created === true });
      return { number: Number(data.number) };
    },
    remoteMainSha: () => remoteMainSha(repo, deps.exec),
    merge: async (number: number) => {
      const sha = await headSha(worktree, deps.exec);
      // A refusal is a confirmed outcome for this head sha; a thrown error (gh down, journal failure,
      // an injected crash) propagates so the caller sees it, never disguised as a refusal.
      // taskId travels with the intent so reconcile can finish the task after a crash between merge and confirm.
      const data = await guarded(deps.journal, Intent.PrMerge, `${branch}@${sha}`, { branch, number, sha, taskId, repo }, async () => {
        const r = await mergePr({ cwd: repo, number, headSha: sha, body: await body() }, deps.ghExec);
        return { merged: r.merged || r.already, already: r.already, reason: r.reason ?? null };
      });
      return data.merged ? { merged: true } : { merged: false, reason: String(data.reason ?? 'merge refused') };
    },
    cleanup: async () => {
      await guarded(deps.journal, Intent.WorktreeRemove, branch, { worktree, repo }, async () => {
        await removeWorktree(repo, worktree, deps.exec);
        return {};
      });
    },
  };
}

/**
 * Moves the main checkout of ws.repo to origin/main. checkout and reset --hard rewrite its index and work tree,
 * so they run under the repo lock and never interleave with another locked git operation on that repo.
 * Only the two raw git calls sit inside it: gitFetch and removeWorktree take the (non-reentrant) lock themselves.
 * Callers hold the checkout lock around it, so it never moves the tree under another spec's deploy.
 */
function resetMainCheckout(deps: MergeStepsDeps): Promise<void> {
  return withRepoLock(deps.ws.repo, async () => {
    await git(deps.ws.repo, ['checkout', '-q', 'main'], deps.exec);
    await git(deps.ws.repo, ['reset', '-q', '--hard', 'origin/main'], deps.exec);
  });
}

/** Spec (orchestrator) §4.4 last row: the real MergeSteps for a task branch. */
export function taskMergeSteps(deps: MergeStepsDeps, task: PlanTask, worktree: string, branch: string, spec: Spec, summary: string): MergeSteps {
  let gateResults: GateResult[] = [];
  let changed: string[] = [];
  const base = common(deps, worktree, branch, `${task.id}: ${task.title}`, async () => prBody({ summary, criteria: spec.acceptanceCriteria.filter((c) => task.criteriaRefs.includes(c.id)), gateLines: gateResults.map(gateLine), specId: spec.specId }, deps.secretValues()), true, task.id);
  return {
    ...base,
    rebase: async () => {
      const r = await base.rebase();
      // Captured here: after the merge, origin/main already contains this branch and the diff would be empty.
      if (r.ok) changed = await changedFiles(worktree, 'origin/main', deps.exec).catch(() => [] as string[]);
      return r;
    },
    gates: async () => {
      const r = await deps.gates(worktree, branch);
      gateResults = r.results;
      if (!r.blockingFailure) return { ok: true };
      const f = r.blockingFailure;
      return { ok: false, failure: f, detail: redactSecrets(`[${f.failure ?? 'code'}] ${gateLine(f)}\n${tail(f.stderrTail || f.stdoutTail)}`, deps.secretValues()) };
    },
    afterMerge: async () => {
      await gitFetch(deps.ws.repo, deps.exec);
      await withCheckoutLock(deps.ws.repo, async () => {
        await resetMainCheckout(deps);
        if (deps.graphify) await deps.graphify.update(deps.ws.repo, graphDir(deps.ws, null));
      });
      await base.cleanup();
      deps.handoffs.push({ taskId: task.id, title: task.title, summary: redactSecrets(summary, deps.secretValues()), changedFiles: changed, mergedAt: deps.clock().toISOString() });
    },
  };
}

/** Docs branches (Phase 1 and 2) take the same path, minus gates and graph update (spec (orchestrator) §4.2). */
export function docsMergeSteps(deps: MergeStepsDeps, branch: string, worktree: string, title: string, specId: string): MergeSteps {
  const base = common(deps, worktree, branch, title, async () => `Documentation update for the orchestrator run.\n\nSpec: ${specId}`, false);
  return {
    ...base,
    afterMerge: async () => {
      await gitFetch(deps.ws.repo, deps.exec);
      await withCheckoutLock(deps.ws.repo, () => resetMainCheckout(deps));
      await base.cleanup();
    },
  };
}
