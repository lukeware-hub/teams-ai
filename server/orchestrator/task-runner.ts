import type { z } from 'zod';
import { blockingFindings } from '../agents/outputs.js';
import type { DevOutput as DevOutputSchema, OutputOf, ReplanOutput, ReviewOutput as ReviewOutputSchema, SecurityOutput as SecurityOutputSchema, SpecGapOutput, StepKind } from '../agents/outputs.js';

type DevOutput = z.infer<typeof DevOutputSchema>;
type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { taskBranch } from '../core/ids.js';
import type { DecideContext, Decider } from '../decide/decider.js';
import { assessAttemptProgress } from '../decide/decisions/attempt-progress.js';
import { triageGateFailure } from '../decide/decisions/gate-triage.js';
import { chooseModelTier, type Effort, type ModelTier, type ModelTierResult } from '../decide/decisions/model-tier.js';
import { REVIEW_PROFILE_DEPTH, choosePrRisk } from '../decide/decisions/pr-risk.js';
import { assessScopeDrift } from '../decide/decisions/scope-drift.js';
import type { Role } from '../config/config.js';
import type { TestResult } from '../evidence/junit.js';
import { verifyClaimedEvidence } from '../evidence/matrix.js';
import type { Exec } from '../exec/command.js';
import type { GateResult } from '../exec/gate-runner.js';
import { changedFiles, commitAll, createWorktree, fetch as gitFetch, git, removeWorktree } from '../git/git.js';
import type { MergeQueue, MergeSteps } from '../git/merge-queue.js';
import type { CodeContext, HandoffSummary } from '../knowledge/context-pack.js';
import { RunEvent, type TaskRuntime } from '../pipeline/run-state.js';
import { TERMINAL_STATES, assertTransition, type TaskState } from '../pipeline/task-state.js';
import type { StepOutcome } from '../runner/step.js';
import { decideOnFailure, type Failure, type FailureKind, type PolicyConfig } from '../scheduler/retry-policy.js';
import { redactSecrets } from '../core/redact.js';
import { checkScope } from '../validators/diff-guard.js';
import { devopsOwnerErrors, findCycle } from '../validators/plan.js';
import type { RefContext } from '../validators/references.js';
import { Intent, OrchEvent, type Journal } from './events.js';
import { withMainSnapshot } from './phases/shared.js';
import { devPack, replanPack, reviewPack, securityPack, specGapPack, type AgentStepRequest, type PackBase } from './steps.js';
import { olderLiveRun, worktreeDir, type Workspace } from './workspace.js';

/** The diff is inlined into the sec prompt (the role has no Bash); the rest of a huge diff is read from the worktree. */
const SECURITY_DIFF_CHARS = 80_000;
/** The claude CLI's own sandbox (bubblewrap/socat) occasionally fails to start, denying every tool call for that
 * step; a transient infra flake, never a reason in the task's own files, so it is worth one more try instead of
 * blocking the task at once (spec 10A.5-adjacent: `environment` failures already retry without an attempt). */
const SANDBOX_INIT_FAILURE = /failed to create bridge sockets/i;

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
  /** A fresh worktree from origin/main has no node_modules; install before the Dev starts so its own self-verification
   * (running the project's test command, per its rules) does not fall through to a dependency tree outside the worktree. */
  installDeps: (worktree: string) => Promise<GateResult | null>;
  mergeQueue: MergeQueue;
  mergeSteps: (task: PlanTask, worktree: string, branch: string) => MergeSteps;
  code: (worktree: string, task: PlanTask) => Promise<CodeContext>;
  impact: (worktree: string, branch: string, changed: readonly string[], depth: number) => Promise<CodeContext>;
  decider: Pick<Decider, 'decide'>;
  /** Model name for a tier on this role's Claude profile; null when the role runs on another provider. */
  tierModel: (role: Role, tier: ModelTier) => string;
  policy: PolicyConfig;
  packBase: () => PackBase;
  handoffs: () => readonly HandoffSummary[];
  boundaries: () => Promise<readonly string[]>;
  maxSpecGapRounds?: number;
  /** Secret values to strip from gate tails and other process text before journaling (spec §5). */
  secretValues?: () => readonly string[];
  /** Refused merges tolerated per task before they count as an infra failure (default 3). */
  maxMergeRefusals?: number;
  /** Connection string for the ephemeral test database the orchestrator provisioned for this run, when one
   * was needed (spec declares a DATABASE_URL secret); null when none was provisioned. Sent as extraEnv to
   * Dev and Test so their own sandboxed processes can reach it without ever getting Docker access themselves. */
  testDatabaseUrl?: string | null;
}

const TAIL = 2000;

function dedupeById(results: readonly TestResult[]): TestResult[] {
  const byId = new Map<string, TestResult>();
  for (const r of results) byId.set(r.id, r);
  return [...byId.values()];
}
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);

async function porcelainNames(dir: string, exec: Exec): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=all'], exec);
  // git() trims stdout, so the first line may have lost the leading space of its XY status prefix.
  return out === '' ? [] : out.split('\n').map((l) => l.trimStart().replace(/^\S{1,2}\s+/, '').trim().replace(/^"|"$/g, ''));
}

/** Spec (orchestrator) §4.4: one state row per advance(); every effect is intent → effect → confirm. */
export class TaskRunner {
  readonly branch: string;
  readonly worktree: string;
  private schemaRetries = 0;
  private specGapRounds = 0;
  private junit: TestResult[] = [];
  private mergeRefusals = 0;
  private tierAttempt = 0;
  private tierChoice: ModelTierResult | null = null;
  private scopeJustification: string | undefined;
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

  private clean(text: string): string {
    return redactSecrets(text, this.deps.secretValues?.() ?? []);
  }

  /** Spec 10A.5 decisions 10/11: model tier and effort for one step; empty when unanswered or off-profile. */
  private async stepOverrides(role: Role, attempt: number): Promise<{ model?: string; effort?: Effort }> {
    // One decision per attempt serves both the Dev and the Test step (in-memory; a resume decides again).
    if (this.tierAttempt !== attempt) {
      this.tierChoice = await chooseModelTier(this.task.def, attempt, this.deps.decider, this.ctx);
      this.tierAttempt = attempt;
    }
    const chosen = this.tierChoice!;
    if (!chosen.tier || !chosen.effort) return {};
    const model = this.deps.tierModel(role, chosen.tier);
    return { model, effort: chosen.effort };
  }

  private get ctx(): DecideContext {
    return { confidential: this.deps.project.confidential };
  }

  async advance(): Promise<void> {
    try {
      await this.step();
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal === true) throw err;
      // git/worktree trouble is infrastructure: retried per the policy, never charged to the Dev.
      await this.fail('infra', this.clean(`Orchestrator step failed: ${(err as Error).message}`), 'worktree');
    }
  }

  private async step(): Promise<void> {
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
    assertTransition(this.task.state, to);
    await this.deps.journal.fact(RunEvent.TaskStateChanged, { taskId: this.taskId, to });
  }

  /** `attempt: true` marks the delta that closed a Dev attempt (spec 10A.5 decision 6 reads only those). */
  private feedback(text: string, opts: { attempt?: boolean } = {}): Promise<unknown> {
    return this.deps.journal.fact(OrchEvent.Feedback, { taskId: this.taskId, text, ...(opts.attempt ? { attempt: true } : {}) });
  }

  private attemptDeltas(): string[] {
    return this.deps.journal.events.filter((e) => e.type === OrchEvent.Feedback && e.data.taskId === this.taskId && e.data.attempt === true).map((e) => String(e.data.text));
  }

  /** False when the task was blocked instead: an older run of this spec is live and owns the worktree. */
  private async ensureWorktree(): Promise<boolean> {
    const { journal, ws, exec } = this.deps;
    await gitFetch(ws.repo, exec);
    const confirmed = journal.isConfirmed(Intent.WorktreeCreate, this.taskId);
    if (confirmed) {
      // This run already created it (resume after a crash): keep whatever the Dev committed there.
      await createWorktree(ws.repo, this.worktree, this.branch, 'origin/main', exec);
      return true;
    }
    // Branch and worktree are named after the spec, not the run, so the reset below would wipe the live work of an
    // older run of it. Checked before the intent: on resume an unconfirmed one over an existing worktree is taken as ours.
    const older = await olderLiveRun(ws, this.deps.spec.specId, journal.events[0]!.runId);
    if (older !== null) {
      await this.block(`Run ${older} of spec ${this.deps.spec.specId} is still live and owns ${this.worktree}; not resetting it.`);
      return false;
    }
    await journal.intent(Intent.WorktreeCreate, this.taskId, { worktree: this.worktree, branch: this.branch });
    // First touch by this run: a worktree or branch of the same name is a leftover from an earlier run of
    // this spec (they are not cleaned up when a run ends blocked), and its commits must not leak into
    // this run - seen live when a new run picked up a superseded scaffold branch with the changes a
    // review had just rejected. Start from origin/main.
    await removeWorktree(ws.repo, this.worktree, exec);
    await createWorktree(ws.repo, this.worktree, this.branch, 'origin/main', exec, { reset: true });
    await journal.confirm(Intent.WorktreeCreate, this.taskId, {});
    return true;
  }

  private async refContext(): Promise<RefContext> {
    const tracked = (await git(this.worktree, ['ls-files'], this.deps.exec)).split('\n').filter((f) => f !== '');
    const untracked = await porcelainNames(this.worktree, this.deps.exec);
    return {
      acIds: new Set(this.deps.spec.acceptanceCriteria.map((c) => c.id)),
      taskIds: new Set(this.deps.plan.tasks.map((t) => t.id)),
      // The JUnit report is ignored by most .gitignore files yet present in the worktree; reviewers cite it.
      files: new Set([...tracked, ...untracked, this.deps.plan.junitPath]),
      tests: new Set(this.junit.map((t) => t.id)),
      adrIds: new Set(this.deps.plan.adrRefs),
    };
  }

  private async implement(): Promise<void> {
    if (!(await this.ensureWorktree())) return;
    const install = await this.deps.installDeps(this.worktree);
    if (install) {
      const triage = await triageGateFailure({ name: install.name, command: this.deps.plan.commands.install, blocking: true, network: 'none', secrets: [] }, install, this.deps.decider, this.ctx);
      const delta = [
        `Gate ${install.name} failed (${triage.kind}, exit ${install.exitCode})`,
        install.stderrTail ? `stderr (tail):\n${this.clean(tail(install.stderrTail))}` : '',
        install.stdoutTail ? `stdout (tail):\n${this.clean(tail(install.stdoutTail))}` : '',
      ]
        .filter((s) => s !== '')
        .join('\n\n');
      return this.fail(triage.kind, delta, install.name);
    }
    const task = this.task;
    const attempt = task.attempts + 1;
    const commitKey = `${this.taskId}:a${attempt}`;
    if (this.deps.journal.isConfirmed(Intent.Commit, commitKey)) {
      // Crash between the commit confirm and the state change: the work is committed, do not run Dev again.
      return this.transition('validating');
    }
    const owner = task.def.owner;
    const pack = devPack(this.deps.packBase(), task.def, { code: await this.deps.code(this.worktree, task.def), handoffs: this.deps.handoffs(), feedback: this.deps.journal.lastFeedback(this.taskId) }, owner);
    const outcome = await this.deps.runAgent<'dev'>({
      kind: 'dev',
      role: owner,
      pack,
      cwd: this.worktree,
      ...(await this.stepOverrides(owner, attempt)),
      phase: 'phase3',
      taskId: this.taskId,
      attempt,
      extraEnv: this.deps.testDatabaseUrl ? { DATABASE_URL: this.deps.testDatabaseUrl } : undefined,
      refContext: () => this.refContext(),
      refs: ((v: DevOutput) => ({ files: v.changedFiles })) as never,
    });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as DevOutput;
    if (value.status === 'spec-gap') return this.specGap(task.def, value.question);
    if (value.status === 'blocked') {
      if (SANDBOX_INIT_FAILURE.test(value.reason)) return this.fail('environment', value.reason, 'dev-sandbox-init');
      return this.block(value.reason);
    }
    this.specGapRounds = 0;
    // Gate artifacts (the JUnit report) are written by the orchestrator, not by the Dev, and are never committed.
    const touched = (await porcelainNames(this.worktree, this.deps.exec)).filter((f) => f !== this.deps.plan.junitPath);
    const scope = checkScope({ changedFiles: touched, affectedPaths: task.def.affectedPaths, frozenPaths: this.deps.plan.frozenPaths, scopeJustification: value.scopeJustification, allowFrozen: this.deps.firstSpec && task.bootstrapsFrozenPaths });
    if (!scope.ok) return this.fail('review-changes', `Scope violation:\n${scope.errors.join('\n')}`);
    this.scopeJustification = value.scopeJustification;
    // baseSha lets reconcile tell "committed, then crashed" from "crashed before committing" (spec §6).
    const baseSha = await git(this.worktree, ['rev-parse', 'HEAD'], this.deps.exec);
    await this.deps.journal.intent(Intent.Commit, commitKey, { taskId: this.taskId, worktree: this.worktree, message: value.commitMessage, baseSha });
    const sha = (await commitAll(this.worktree, value.commitMessage, {}, this.deps.exec)) ?? (await git(this.worktree, ['rev-parse', 'HEAD'], this.deps.exec));
    await this.deps.journal.confirm(Intent.Commit, commitKey, { sha });
    const changed = await changedFiles(this.worktree, 'origin/main', this.deps.exec);
    if (changed.length === 0) {
      // Nothing to gate, review or open a PR for; GitHub would refuse the PR anyway. Charge the attempt now.
      return this.fail('code', 'Dev reported done but produced no changes against origin/main. Implement the task or return spec-gap.');
    }
    await this.deps.journal.fact(OrchEvent.DevCommitted, { taskId: this.taskId, sha, changedFiles: changed, summary: value.summary });
    await this.transition('validating');
  }

  private async specGap(task: PlanTask, question: string): Promise<void> {
    this.specGapRounds += 1;
    if (this.specGapRounds > this.maxSpecGapRounds) {
      this.specGapRounds = 0;
      return this.fail('code', `spec-gap rounds exhausted (${this.maxSpecGapRounds}); last question: ${question}`);
    }
    // The SM only reads the repo. It reads a snapshot of origin/main, so another task's merge cannot rewrite the tree under it.
    const outcome = await withMainSnapshot(this.deps.ws, this.deps.exec, (cwd) => this.deps.runAgent<'spec-gap'>({ kind: 'spec-gap', role: 'sm', pack: specGapPack(this.deps.packBase(), task, { question }), cwd, phase: 'phase3', taskId: this.taskId, attempt: this.task.attempts + 1 }));
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as SpecGapOutput;
    await this.deps.journal.fact(OrchEvent.SpecGapAnswered, { taskId: this.taskId, question, answer: value.answer, assumption: value.assumption });
    await this.feedback(`Spec-gap answer from SM:\nQ: ${question}\nA: ${value.answer}`);
    return this.implement();
  }

  private async validate(): Promise<void> {
    const { results, blockingFailure } = await this.deps.gates(this.worktree, this.branch);
    for (const r of results) {
      await this.deps.journal.fact(r.passed ? OrchEvent.GatePassed : OrchEvent.GateFailed, {
        taskId: this.taskId,
        gate: r.name,
        failure: r.failure,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        // Kept so a resume in `reviewing` can verify evidence without re-running the gates.
        junit: (r.junit ?? []).map((t) => ({ id: t.id, name: t.name, classname: t.classname, status: t.status, acIds: t.acIds })),
      });
    }
    // Every gate that leaves a report is read; the same test id from a later gate replaces the earlier one.
    this.junit = dedupeById(results.flatMap((r) => r.junit ?? []));
    if (!blockingFailure) return this.transition('reviewing');
    const gateDef = this.deps.plan.gates.find((g) => g.name === blockingFailure.name) ?? { name: blockingFailure.name, command: '', blocking: true, network: 'none' as const, secrets: [] };
    const triage = await triageGateFailure(gateDef, blockingFailure, this.deps.decider, this.ctx);
    const failedIds = (blockingFailure.junit ?? []).filter((t) => t.status === 'failed').map((t) => t.id);
    const delta = [
      `Gate ${blockingFailure.name} failed (${triage.kind}, exit ${blockingFailure.exitCode})`,
      failedIds.length > 0 ? `Failed tests:\n${failedIds.join('\n')}` : '',
      blockingFailure.stderrTail ? `stderr (tail):\n${this.clean(tail(blockingFailure.stderrTail))}` : '',
      blockingFailure.stdoutTail ? `stdout (tail):\n${this.clean(tail(blockingFailure.stdoutTail))}` : '',
    ]
      .filter((s) => s !== '')
      .join('\n\n');
    return this.fail(triage.kind, delta, blockingFailure.name);
  }

  private junitFromJournal(): TestResult[] {
    const events = this.deps.journal.events.filter((e) => (e.type === OrchEvent.GatePassed || e.type === OrchEvent.GateFailed) && e.data.taskId === this.taskId);
    const lastRound = new Map<string, TestResult[]>();
    for (const e of events) lastRound.set(String(e.data.gate), (e.data.junit as TestResult[] | undefined) ?? []);
    return dedupeById([...lastRound.values()].flat());
  }

  private async review(): Promise<void> {
    if (this.junit.length === 0) this.junit = this.junitFromJournal();
    const changed = await changedFiles(this.worktree, 'origin/main', this.deps.exec);
    const diffStat = await git(this.worktree, ['diff', '--stat', 'origin/main...HEAD'], this.deps.exec);
    // Spec 10A.5 decision 5: risk picks the review profile (context depth); the review itself always runs.
    const risk = await choosePrRisk(this.task.def, { changedFiles: changed, diffStat }, this.deps.decider, this.ctx);
    // Spec 10A.5 decision 9: high scope drift forces the deep profile; it never blocks the task.
    const outOfScope = checkScope({ changedFiles: changed, affectedPaths: this.task.def.affectedPaths, frozenPaths: this.deps.plan.frozenPaths, scopeJustification: this.scopeJustification, allowFrozen: true }).outOfScope;
    const drift = await assessScopeDrift(this.task.def, { changedFiles: changed, outOfScope, scopeJustification: this.scopeJustification, diffStat }, this.deps.decider, this.ctx);
    await this.deps.journal.fact(OrchEvent.ScopeDriftScored, { taskId: this.taskId, drift: drift.drift, unrequired: drift.unrequired, source: drift.source });
    const profile = drift.drift === 'high' ? 'deep' : risk.profile;
    await this.deps.journal.fact(OrchEvent.ReviewProfileChosen, { taskId: this.taskId, risk: risk.risk, profile, source: risk.source, forcedBy: profile === risk.profile ? null : 'scope-drift' });
    const depth = REVIEW_PROFILE_DEPTH[profile];
    const code: CodeContext = depth === 0 ? { source: 'none' } : await this.deps.impact(this.worktree, this.branch, changed, depth);
    const pack = reviewPack(this.deps.packBase(), this.task.def, { diffStat, changedFiles: changed, code, profile });
    const outcome = await this.deps.runAgent<'review'>({
      kind: 'review',
      role: 'test',
      pack,
      cwd: this.worktree,
      ...(await this.stepOverrides('test', this.task.attempts + 1)),
      phase: 'phase3',
      taskId: this.taskId,
      attempt: this.task.attempts + 1,
      extraEnv: this.deps.testDatabaseUrl ? { DATABASE_URL: this.deps.testDatabaseUrl } : undefined,
      refContext: () => this.refContext(),
      refs: ((v: ReviewOutput) => ({ acIds: v.criteria.map((c) => c.id), files: v.findings.map((f) => f.file) })) as never,
    });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as ReviewOutput;
    const evidenceErrors = verifyClaimedEvidence(value.criteria, this.junit);
    if (evidenceErrors.length > 0) return this.fail('schema', `Review evidence rejected:\n${evidenceErrors.join('\n')}`);
    if (value.decision === 'changes') {
      await this.deps.journal.fact(OrchEvent.ReviewChanges, { taskId: this.taskId, findings: value.findings });
      const text = value.findings.map((f) => `- ${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.problem} (fix: ${f.fix})`).join('\n');
      return this.fail('review-changes', `Review requested changes:\n${text}`);
    }
    await this.deps.journal.fact(OrchEvent.ReviewApproved, { taskId: this.taskId, criteria: value.criteria });
    if (!(await this.securityReview(changed, diffStat, code))) return;
    await this.transition('rebasing');
  }

  /** Runs after Test approves: critical/high findings go back to Dev like review changes; medium/low are journaled only. */
  private async securityReview(changed: readonly string[], diffStat: string, code: CodeContext): Promise<boolean> {
    const full = await git(this.worktree, ['diff', 'origin/main...HEAD'], this.deps.exec);
    // sec has no Bash and cannot tell a short diff from a cut one: say so, or it approves code it never saw.
    const diff = full.length > SECURITY_DIFF_CHARS
      ? `${full.slice(0, SECURITY_DIFF_CHARS)}\n[diff truncated: first ${SECURITY_DIFF_CHARS} of ${full.length} characters shown. The changes after the cut were not shown: read the changed files and the task's affectedPaths to review them.]`
      : full;
    const attempt = this.task.attempts + 1;
    const outcome = await this.deps.runAgent<'security'>({
      kind: 'security',
      role: 'sec',
      pack: securityPack(this.deps.packBase(), this.task.def, { diffStat, changedFiles: changed, diff, code }),
      cwd: this.worktree,
      phase: 'phase3',
      taskId: this.taskId,
      attempt,
      refContext: () => this.refContext(),
      refs: ((v: SecurityOutputSchema) => ({ files: v.findings.map((f) => f.file) })) as never,
    });
    if (!outcome.ok) {
      await this.fail(outcome.failure, outcome.errors.join('\n'));
      return false;
    }
    const value = outcome.value as SecurityOutputSchema;
    // One rule: the severities decide. `decision` is the reviewer's own label and neither adds to this nor lifts it.
    const blocking = blockingFindings(value);
    if (blocking.length > 0) {
      await this.deps.journal.fact(OrchEvent.SecurityChanges, { taskId: this.taskId, findings: value.findings });
      const text = blocking.map((f) => `- ${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.category}: ${f.problem} (fix: ${f.fix})`).join('\n');
      await this.fail('review-changes', `Security review requested changes:\n${text}`);
      return false;
    }
    await this.deps.journal.fact(OrchEvent.SecurityApproved, { taskId: this.taskId, findings: value.findings });
    return true;
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
      // The queue short-circuits an already-merged PR before afterMerge; the cleanup still has to happen.
      if (outcome.already && steps.afterMerge) await steps.afterMerge();
      const handoff = this.deps.handoffs().find((h) => h.taskId === this.taskId) ?? null;
      const sha = await git(this.worktree, ['rev-parse', 'HEAD'], this.deps.exec).catch(() => null);
      await this.deps.journal.fact(OrchEvent.PrMerged, { taskId: this.taskId, pr: outcome.pr, sha, already: outcome.already ?? false, warning: outcome.warning ?? null, handoff });
      if (this.task.state === 'rebasing') await this.transition('merging');
      return this.transition('merged');
    }
    if (outcome.stage === 'merge') {
      this.mergeRefusals += 1;
      if (this.mergeRefusals <= (this.deps.maxMergeRefusals ?? 3)) return this.transition('rebasing');
      this.mergeRefusals = 0;
      if (this.task.state === 'merging') await this.transition('rebasing');
      return this.fail('infra', `Merge refused ${this.deps.maxMergeRefusals ?? 3} times: ${this.clean(outcome.detail ?? '')}`, 'merge');
    }
    if (this.task.state === 'merging') await this.transition('rebasing');
    switch (outcome.stage) {
      case 'rebase':
        return this.fail('rebase-conflict', `Rebase conflicts on origin/main:\n${(outcome.conflicts ?? []).join('\n')}`);
      case 'gates': {
        const f = outcome.gateFailure;
        // Fakes and older steps give only the detail; the prefix is the gate runner's own classification.
        const kind = f
          ? (await triageGateFailure(this.deps.plan.gates.find((g) => g.name === f.name) ?? { name: f.name, command: '', blocking: true, network: 'none' as const, secrets: [] }, f, this.deps.decider, this.ctx)).kind
          : /^\[infra\]/.test(outcome.detail ?? '') ? 'infra' : 'code';
        await this.deps.journal.fact(OrchEvent.GateFailed, { taskId: this.taskId, gate: 'merge-gates', failure: f?.failure ?? (kind === 'infra' ? 'infra' : 'code'), exitCode: f?.exitCode ?? null, durationMs: f?.durationMs ?? 0, junit: [] });
        return this.fail(kind, `Gates failed after rebase (${kind}):\n${this.clean(outcome.detail ?? '')}`, 'merge-gates');
      }
      default:
        return this.fail('infra', `Merge queue ${outcome.stage} failed: ${this.clean(outcome.detail ?? '')}`, 'merge');
    }
  }

  /** Spec (orchestrator) §7: the task's token budget is spent; counts as a failed attempt (POC spec §8.5). */
  budgetExceeded(tokens: number, cap: number): Promise<void> {
    return this.fail('budget', `Task token budget exceeded: ${tokens} tokens used, cap ${cap}. Finish with a smaller change set.`);
  }

  private async fail(kind: FailureKind, text: string, gate?: string): Promise<void> {
    const failure: Failure = { kind, gate, schemaRetriesUsed: this.schemaRetries };
    const decision = decideOnFailure(failure, this.task, this.deps.policy);
    switch (decision.action) {
      case 'retry-dev': {
        this.schemaRetries = 0;
        // `merging` cannot go straight to `implementing`; step back through `rebasing` first.
        if (this.task.state === 'merging') await this.transition('rebasing');
        // Spec 10A.5 decision 6: once two attempts have failed, stalled or diverging progress replans early
        // instead of spending the remaining attempts; a replacement task is never replanned again.
        const next = this.task.attempts + 2;
        if (next >= 3 && !this.task.replanned) {
          const { progress, source } = await assessAttemptProgress(this.task.def, next, [...this.attemptDeltas(), text], this.deps.decider, this.ctx);
          if (progress !== 'converging') {
            await this.feedback(`${text}\n\nAttempt progress judged ${progress} (${source}); replanning early.`, { attempt: true });
            await this.deps.journal.fact(RunEvent.AttemptConsumed, { taskId: this.taskId });
            // A System 1 verdict may route to the SM but never end the task: if the SM cannot replan, retry as usual.
            if (await this.replan({ early: true })) return;
            await this.transition('implementing');
            return;
          }
        }
        // State first, attempt second: a crash in between under-counts one attempt and never charges an
        // interrupted step twice (spec §6 "an interrupted LLM step is re-run and not counted").
        await this.feedback(text, { attempt: true });
        await this.transition('implementing');
        await this.deps.journal.fact(RunEvent.AttemptConsumed, { taskId: this.taskId });
        return;
      }
      case 'rerun-gate':
        await this.deps.journal.fact(kind === 'flaky-test' ? RunEvent.FlakyRetry : RunEvent.InfraRetry, { taskId: this.taskId, gate });
        return;
      case 'rerun-step':
        this.schemaRetries += 1;
        await this.feedback(text);
        return;
      case 'replan':
        await this.feedback(text, { attempt: true });
        await this.replan();
        return;
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

  /** Returns false only for an early replan the SM could not produce; the policy path blocks instead. */
  private async replan(opts: { early?: boolean } = {}): Promise<boolean> {
    const history = this.deps.journal.events.filter((e) => e.type === OrchEvent.Feedback && e.data.taskId === this.taskId).map((e) => String(e.data.text));
    const boundaries = await this.deps.boundaries();
    // Same as the spec-gap step: the SM reads a snapshot of origin/main, not the main checkout that afterMerge rewrites.
    const outcome = await withMainSnapshot(this.deps.ws, this.deps.exec, (cwd) => this.deps.runAgent<'replan'>({ kind: 'replan', role: 'sm', pack: replanPack(this.deps.packBase(), this.task.def, { history, boundaries, atomic: this.task.bootstrapsFrozenPaths }), cwd, phase: 'phase3', taskId: this.taskId, attempt: this.task.attempts }));
    if (!outcome.ok) {
      if (outcome.failure === 'quota' || outcome.failure === 'auth') {
        await this.fail(outcome.failure, outcome.errors.join('\n'));
        return true;
      }
      if (opts.early) return false;
      await this.block(`replan failed: ${outcome.errors.join('; ')}`);
      return true;
    }
    const value = outcome.value as ReplanOutput;
    // Validate before the journal reduces the replan: a bad replacement would be rejected by the reducer
    // after it was written, corrupting the log. Structural checks only; AC coverage of the whole plan is
    // not the replan's concern (spec §4.6: the replacements cover the original task's criteria).
    const errors = this.replanErrors(value.replacements);
    if (errors.length > 0) {
      if (opts.early) return false;
      await this.block(`replan rejected: ${errors.join('; ')}`);
      return true;
    }
    await this.deps.journal.fact(RunEvent.TaskReplanned, { taskId: this.taskId, replacements: value.replacements });
    return true;
  }

  private replanErrors(replacements: readonly PlanTask[]): string[] {
    const errors: string[] = [];
    const known = new Set(this.deps.journal.state.tasks.keys());
    const newIds = new Set(replacements.map((r) => r.id));
    if (newIds.size !== replacements.length) errors.push('duplicate replacement ids');
    // The scaffold makes the gates runnable; a piece of it cannot pass them (seen live: a scripts-only
    // replacement failed lint/typecheck/build for lack of the toolchain its sibling task owned).
    if (this.task.bootstrapsFrozenPaths && replacements.length !== 1) errors.push(`${this.taskId} is the scaffold task and must be replanned into exactly one task, got ${replacements.length}`);
    errors.push(...devopsOwnerErrors(replacements, this.deps.plan.deploy.manifests));
    for (const r of replacements) {
      if (known.has(r.id)) errors.push(`replacement ${r.id} reuses an existing task id`);
      for (const d of r.dependsOn) {
        if (d === this.taskId) errors.push(`${r.id} depends on the superseded task ${this.taskId}`);
        else if (!known.has(d) && !newIds.has(d)) errors.push(`${r.id} depends on unknown task ${d}`);
      }
    }
    const wanted = new Set(this.task.def.criteriaRefs);
    const covered = new Set(replacements.flatMap((r) => r.criteriaRefs));
    for (const id of wanted) if (!covered.has(id)) errors.push(`criterion ${id} of ${this.taskId} is not covered by any replacement`);
    const all = [...[...this.deps.journal.state.tasks.values()].map((t) => t.def).filter((t) => t.id !== this.taskId), ...replacements];
    const cycle = findCycle(all);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
    return errors;
  }

  private async block(reason: string): Promise<void> {
    await this.transition('blocked');
    await this.deps.journal.fact(OrchEvent.TaskBlocked, { taskId: this.taskId, reason });
  }
}
