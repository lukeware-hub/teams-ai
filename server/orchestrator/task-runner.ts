import type { OutputOf, ReplanOutput, SpecGapOutput, StepKind } from '../agents/outputs.js';

type DevOutput = OutputOf<'dev'>;
type ReviewOutput = OutputOf<'review'>;
import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { stepId, taskBranch } from '../core/ids.js';
import type { DecideContext, Decider } from '../decide/decider.js';
import { triageGateFailure } from '../decide/decisions/gate-triage.js';
import type { TestResult } from '../evidence/junit.js';
import { verifyClaimedEvidence } from '../evidence/matrix.js';
import type { Exec } from '../exec/command.js';
import type { GateResult } from '../exec/gate-runner.js';
import { changedFiles, commitAll, createWorktree, fetch as gitFetch, git } from '../git/git.js';
import type { MergeQueue, MergeSteps } from '../git/merge-queue.js';
import type { CodeContext, HandoffSummary } from '../knowledge/context-pack.js';
import { RunEvent, type TaskRuntime } from '../pipeline/run-state.js';
import { TERMINAL_STATES, type TaskState } from '../pipeline/task-state.js';
import type { StepOutcome } from '../runner/step.js';
import { decideOnFailure, type Failure, type FailureKind, type PolicyConfig } from '../scheduler/retry-policy.js';
import { checkScope } from '../validators/diff-guard.js';
import type { RefContext } from '../validators/references.js';
import { Intent, OrchEvent, type Journal } from './events.js';
import { devPack, replanPack, reviewPack, specGapPack, type AgentStepRequest, type PackBase } from './steps.js';
import { worktreeDir, type Workspace } from './workspace.js';

export interface TaskRunnerDeps {
  journal: Journal;
  ws: Workspace;
  spec: Spec;
  project: Project;
  plan: Plan;
  specHash: string;
  firstSpec: boolean;
  exec: Exec;
  runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => Promise<StepOutcome<OutputOf<K>>>;
  gates: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
  mergeQueue: MergeQueue;
  mergeSteps: (task: PlanTask, worktree: string, branch: string) => MergeSteps;
  code: (worktree: string, task: PlanTask) => Promise<CodeContext>;
  impact: (worktree: string, branch: string, changed: readonly string[]) => Promise<CodeContext>;
  decider: Pick<Decider, 'decide'>;
  policy: PolicyConfig;
  packBase: () => PackBase;
  handoffs: () => readonly HandoffSummary[];
  boundaries: () => Promise<readonly string[]>;
  maxSpecGapRounds?: number;
}

const TAIL = 2000;
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);

async function porcelainNames(dir: string, exec: Exec): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=all'], exec);
  return out === '' ? [] : out.split('\n').map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
}

/** Spec (orchestrator) §4.4: one state row per advance(); every effect is intent → effect → confirm. */
export class TaskRunner {
  readonly branch: string;
  readonly worktree: string;
  private schemaRetries = 0;
  private specGapRounds = 0;
  private junit: TestResult[] = [];
  private readonly maxSpecGapRounds: number;

  constructor(
    readonly taskId: string,
    private readonly deps: TaskRunnerDeps,
  ) {
    this.branch = taskBranch(deps.spec.specId, taskId);
    this.worktree = worktreeDir(deps.ws, this.branch);
    this.maxSpecGapRounds = deps.maxSpecGapRounds ?? 3;
  }

  get task(): TaskRuntime {
    const t = this.deps.journal.state.tasks.get(this.taskId);
    if (!t) throw new Error(`unknown task ${this.taskId}`);
    return t;
  }

  get done(): boolean {
    return TERMINAL_STATES.has(this.task.state);
  }

  private get ctx(): DecideContext {
    return { confidential: this.deps.project.confidential };
  }

  async advance(): Promise<void> {
    switch (this.task.state) {
      case 'ready':
        await this.transition('implementing');
        return this.implement();
      case 'implementing':
        return this.implement();
      case 'validating':
        return this.validate();
      case 'reviewing':
        return this.review();
      case 'rebasing':
      case 'merging':
        return this.merge();
      default:
        return;
    }
  }

  private async transition(to: TaskState): Promise<void> {
    if (this.task.state === to) return;
    await this.deps.journal.fact(RunEvent.TaskStateChanged, { taskId: this.taskId, to });
  }

  private feedback(text: string): Promise<unknown> {
    return this.deps.journal.fact(OrchEvent.Feedback, { taskId: this.taskId, text });
  }

  private async ensureWorktree(): Promise<void> {
    const { journal, ws, exec } = this.deps;
    await gitFetch(ws.repo, exec);
    const confirmed = journal.isConfirmed(Intent.WorktreeCreate, this.taskId);
    if (!confirmed) await journal.intent(Intent.WorktreeCreate, this.taskId, { worktree: this.worktree, branch: this.branch });
    await createWorktree(ws.repo, this.worktree, this.branch, 'origin/main', exec);
    if (!confirmed) await journal.confirm(Intent.WorktreeCreate, this.taskId, {});
  }

  private async refContext(): Promise<RefContext> {
    const tracked = (await git(this.worktree, ['ls-files'], this.deps.exec)).split('\n').filter((f) => f !== '');
    const untracked = await porcelainNames(this.worktree, this.deps.exec);
    return {
      acIds: new Set(this.deps.spec.acceptanceCriteria.map((c) => c.id)),
      taskIds: new Set(this.deps.plan.tasks.map((t) => t.id)),
      files: new Set([...tracked, ...untracked]),
      tests: new Set(this.junit.map((t) => t.id)),
      adrIds: new Set(this.deps.plan.adrRefs),
    };
  }

  private async implement(): Promise<void> {
    await this.ensureWorktree();
    const task = this.task;
    const attempt = task.attempts + 1;
    const pack = devPack(this.deps.packBase(), task.def, { code: await this.deps.code(this.worktree, task.def), handoffs: this.deps.handoffs(), feedback: this.deps.journal.lastFeedback(this.taskId) });
    const seq = this.deps.journal.nextStepSeq();
    const outcome = await this.deps.runAgent<'dev'>({
      kind: 'dev',
      role: 'dev',
      pack,
      cwd: this.worktree,
      phase: 'phase3',
      taskId: this.taskId,
      attempt,
      refContext: await this.refContext(),
      refs: ((v: DevOutput) => ({ files: v.changedFiles })) as never,
    });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as DevOutput;
    if (value.status === 'spec-gap') return this.specGap(task.def, value.question);
    this.specGapRounds = 0;
    const touched = await porcelainNames(this.worktree, this.deps.exec);
    const scope = checkScope({ changedFiles: touched, affectedPaths: task.def.affectedPaths, frozenPaths: this.deps.plan.frozenPaths, scopeJustification: value.scopeJustification, allowFrozen: this.deps.firstSpec && this.taskId === 'T0-scaffold' });
    if (!scope.ok) return this.fail('review-changes', `Scope violation:\n${scope.errors.join('\n')}`);
    const key = stepId(seq);
    await this.deps.journal.intent(Intent.Commit, key, { taskId: this.taskId, worktree: this.worktree, message: value.commitMessage });
    const sha = (await commitAll(this.worktree, value.commitMessage, {}, this.deps.exec)) ?? (await git(this.worktree, ['rev-parse', 'HEAD'], this.deps.exec));
    await this.deps.journal.confirm(Intent.Commit, key, { sha });
    const changed = await changedFiles(this.worktree, 'origin/main', this.deps.exec);
    await this.deps.journal.fact(OrchEvent.DevCommitted, { taskId: this.taskId, sha, changedFiles: changed, summary: value.summary });
    await this.transition('validating');
  }

  private async specGap(task: PlanTask, question: string): Promise<void> {
    this.specGapRounds += 1;
    if (this.specGapRounds > this.maxSpecGapRounds) {
      this.specGapRounds = 0;
      return this.fail('code', `spec-gap rounds exhausted (${this.maxSpecGapRounds}); last question: ${question}`);
    }
    const outcome = await this.deps.runAgent<'spec-gap'>({ kind: 'spec-gap', role: 'sm', pack: specGapPack(this.deps.packBase(), task, { question }), cwd: this.deps.ws.repo, phase: 'phase3', taskId: this.taskId, attempt: this.task.attempts + 1 });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as SpecGapOutput;
    await this.deps.journal.fact(OrchEvent.SpecGapAnswered, { taskId: this.taskId, question, answer: value.answer, assumption: value.assumption });
    await this.feedback(`Spec-gap answer from SM:\nQ: ${question}\nA: ${value.answer}`);
    return this.implement();
  }

  private async validate(): Promise<void> {
    const { results, blockingFailure } = await this.deps.gates(this.worktree, this.branch);
    for (const r of results) {
      await this.deps.journal.fact(r.passed ? OrchEvent.GatePassed : OrchEvent.GateFailed, { taskId: this.taskId, gate: r.name, failure: r.failure, exitCode: r.exitCode, durationMs: r.durationMs });
    }
    this.junit = results.flatMap((r) => r.junit ?? []);
    if (!blockingFailure) return this.transition('reviewing');
    const gateDef = this.deps.plan.gates.find((g) => g.name === blockingFailure.name) ?? { name: blockingFailure.name, command: '', blocking: true, network: 'none' as const, secrets: [] };
    const triage = await triageGateFailure(gateDef, blockingFailure, this.deps.decider, this.ctx);
    const failedIds = (blockingFailure.junit ?? []).filter((t) => t.status === 'failed').map((t) => t.id);
    const delta = [
      `Gate ${blockingFailure.name} failed (${triage.kind}, exit ${blockingFailure.exitCode})`,
      failedIds.length > 0 ? `Failed tests:\n${failedIds.join('\n')}` : '',
      blockingFailure.stderrTail ? `stderr (tail):\n${tail(blockingFailure.stderrTail)}` : '',
      blockingFailure.stdoutTail ? `stdout (tail):\n${tail(blockingFailure.stdoutTail)}` : '',
    ]
      .filter((s) => s !== '')
      .join('\n\n');
    return this.fail(triage.kind, delta, blockingFailure.name);
  }

  private async review(): Promise<void> {
    const changed = await changedFiles(this.worktree, 'origin/main', this.deps.exec);
    const diffStat = await git(this.worktree, ['diff', '--stat', 'origin/main...HEAD'], this.deps.exec);
    const pack = reviewPack(this.deps.packBase(), this.task.def, { diffStat, changedFiles: changed, code: await this.deps.impact(this.worktree, this.branch, changed) });
    const outcome = await this.deps.runAgent<'review'>({
      kind: 'review',
      role: 'test',
      pack,
      cwd: this.worktree,
      phase: 'phase3',
      taskId: this.taskId,
      attempt: this.task.attempts + 1,
      refContext: await this.refContext(),
      refs: ((v: ReviewOutput) => ({ acIds: v.criteria.map((c) => c.id), files: v.findings.map((f) => f.file) })) as never,
    });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as ReviewOutput;
    const evidenceErrors = verifyClaimedEvidence(value.criteria, this.junit);
    if (evidenceErrors.length > 0) return this.fail('schema', `Review evidence rejected:\n${evidenceErrors.join('\n')}`);
    if (value.decision === 'changes') {
      await this.deps.journal.fact(OrchEvent.ReviewChanges, { taskId: this.taskId, findings: value.findings });
      const text = value.findings.map((f) => `- ${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.text}`).join('\n');
      return this.fail('review-changes', `Review requested changes:\n${text}`);
    }
    await this.deps.journal.fact(OrchEvent.ReviewApproved, { taskId: this.taskId, criteria: value.criteria });
    await this.transition('rebasing');
  }

  private async merge(): Promise<void> {
    const steps = this.deps.mergeSteps(this.task.def, this.worktree, this.branch);
    const wrapped: MergeSteps = {
      ...steps,
      push: async () => {
        await steps.push();
        await this.transition('merging');
      },
    };
    const outcome = await this.deps.mergeQueue.enqueue(this.taskId, wrapped);
    if (outcome.ok) {
      await this.deps.journal.fact(OrchEvent.PrMerged, { taskId: this.taskId, pr: outcome.pr, already: outcome.already ?? false, warning: outcome.warning ?? null });
      if (this.task.state === 'rebasing') await this.transition('merging');
      return this.transition('merged');
    }
    if (outcome.stage === 'merge') return this.transition('rebasing');
    if (this.task.state === 'merging') await this.transition('rebasing');
    switch (outcome.stage) {
      case 'rebase':
        return this.fail('rebase-conflict', `Rebase conflicts on origin/main:\n${(outcome.conflicts ?? []).join('\n')}`);
      case 'gates':
        return this.fail('code', `Gates failed after rebase:\n${outcome.detail ?? ''}`, 'merge-gates');
      default:
        return this.fail('infra', `Merge queue ${outcome.stage} failed: ${outcome.detail ?? ''}`, 'merge');
    }
  }

  private async fail(kind: FailureKind, text: string, gate?: string): Promise<void> {
    const failure: Failure = { kind, gate, schemaRetriesUsed: this.schemaRetries };
    const decision = decideOnFailure(failure, this.task, this.deps.policy);
    switch (decision.action) {
      case 'retry-dev':
        this.schemaRetries = 0;
        await this.deps.journal.fact(RunEvent.AttemptConsumed, { taskId: this.taskId });
        await this.feedback(text);
        return this.transition('implementing');
      case 'rerun-gate':
        await this.deps.journal.fact(kind === 'flaky-test' ? RunEvent.FlakyRetry : RunEvent.InfraRetry, { taskId: this.taskId, gate });
        return;
      case 'rerun-step':
        this.schemaRetries += 1;
        await this.feedback(text);
        return;
      case 'replan':
        await this.feedback(text);
        return this.replan();
      case 'block':
        return this.block(text);
      case 'pause-quota':
      case 'pause-auth':
        if (this.deps.journal.state.status === 'running') {
          await this.deps.journal.fact(RunEvent.RunPaused, { reason: decision.action === 'pause-quota' ? 'quota' : 'auth' });
        }
        return;
      case 'route-spec-gap':
        return;
    }
  }

  private async replan(): Promise<void> {
    const history = this.deps.journal.events.filter((e) => e.type === OrchEvent.Feedback && e.data.taskId === this.taskId).map((e) => String(e.data.text));
    const outcome = await this.deps.runAgent<'replan'>({ kind: 'replan', role: 'sm', pack: replanPack(this.deps.packBase(), this.task.def, { history, boundaries: await this.deps.boundaries() }), cwd: this.deps.ws.repo, phase: 'phase3', taskId: this.taskId, attempt: this.task.attempts });
    if (!outcome.ok) return this.block(`replan failed: ${outcome.errors.join('; ')}`);
    const value = outcome.value as ReplanOutput;
    await this.deps.journal.fact(RunEvent.TaskReplanned, { taskId: this.taskId, replacements: value.replacements });
  }

  private async block(reason: string): Promise<void> {
    await this.transition('blocked');
    await this.deps.journal.fact(OrchEvent.TaskBlocked, { taskId: this.taskId, reason });
  }
}
