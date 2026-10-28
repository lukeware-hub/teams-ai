import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { blockingFindings } from '../agents/outputs.js';
import type { DevOutput as DevOutputSchema, OutputOf, ReplanOutput, ReviewOutput as ReviewOutputSchema, SecurityOutput as SecurityOutputSchema, SkillSelectionOutput, SpecGapOutput, StepKind } from '../agents/outputs.js';

type DevOutput = z.infer<typeof DevOutputSchema>;
type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
import { findCycle, taskPlanIds, type Plan, type PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { taskBranch } from '../core/ids.js';
import { devChangedFiles } from './sandbox-placeholders.js';
import type { DecideContext, Decider } from '../decide/decider.js';
import { assessAttemptProgress } from '../decide/decisions/attempt-progress.js';
import { triageGateFailure } from '../decide/decisions/gate-triage.js';
import { chooseModelTier, heuristicTier, type Effort, type ModelTier, type ModelTierResult } from '../decide/decisions/model-tier.js';
import { REVIEW_PROFILE_DEPTH, choosePrRisk } from '../decide/decisions/pr-risk.js';
import { assessScopeDrift } from '../decide/decisions/scope-drift.js';
import type { Role } from '../config/config.js';
import type { TestResult } from '../evidence/junit.js';
import { verifyClaimedEvidence } from '../evidence/matrix.js';
import type { Exec } from '../exec/command.js';
import type { GateResult } from '../exec/gate-runner.js';
import { changedFiles, commitAll, commitExcludes, conflictMarkerFiles, createWorktree, fetch as gitFetch, git, removeWorktree, replayOnto } from '../git/git.js';
import type { MergeQueue, MergeSteps } from '../git/merge-queue.js';
import type { CodeContext, HandoffSummary } from '../knowledge/context-pack.js';
import { RunEvent, type TaskRuntime } from '../pipeline/run-state.js';
import { TERMINAL_STATES, assertTransition, type TaskState } from '../pipeline/task-state.js';
import type { StepOutcome } from '../runner/step.js';
import { decideOnFailure, type Failure, type FailureKind, type PolicyConfig } from '../scheduler/retry-policy.js';
import { redactSecrets } from '../core/redact.js';
import { normalizePath } from '../core/paths.js';
import { checkScope } from '../validators/diff-guard.js';
import { devopsOwnerErrors } from '../validators/plan.js';
import type { RefContext } from '../validators/references.js';
import { Intent, OrchEvent, type Journal } from './events.js';
import { withMainSnapshot } from './phases/shared.js';
import { devPack, devResumePrompt, replanPack, reviewPack, securityPack, skillSelectPack, sourceFiles, specGapPack, type AgentStepRequest, type PackBase } from './steps.js';
import { olderLiveRun, worktreeDir, type Workspace } from './workspace.js';
import { acceptReuseSkill, assignSkill, capabilityKey, createDraftSkill, syncSkill } from '../skills/store.js';

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
  /** R11.13 slice 6: when the decision layer gives no tier, the task's own size picks one (config `routing`); absent means off. */
  routing?: { tiers: 'off' | 'shadow' | 'on'; models: Record<ModelTier, string> };
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
  /** Ids of the plan tasks an earlier run of this spec delivered: an empty diff on one of them means its work is on main. */
  deliveredBefore: ReadonlySet<string>;
  skillsRoot: string;
  /** Runs the skill fetches: a public skill needs no token, so the orchestrator's git exec is not used for it. */
  skillExec?: Exec;
}

const TAIL = 2000;
/** Which side of a replay's conflict block is which: git applies the task's change onto main, so main is "ours". */
const MARKER_SIDES = "main's side sits between <<<<<<< ours and =======, this task's between ======= and >>>>>>> theirs";

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
  private skillRounds = 0;
  private junit: TestResult[] = [];
  private mergeRefusals = 0;
  private tierAttempt = 0;
  private routedAttempt = 0;
  /** The Dev's CLI session for the current task definition and step settings; a retry resumes it (R11.13 slice 7). */
  private devSession: { key: string; id: string } | null = null;
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
  /**
   * A new definition (replan) or another model or effort starts a new session: the old context no longer matches the work,
   * or its cache would not be reused anyway. The runner resumes only when the first attempt's session was actually saved.
   */
  private sessionFor(role: Role, overrides: { model?: string; effort?: Effort }, feedback: string | null): { id: string; resumePrompt: string } {
    const key = createHash('sha256').update(JSON.stringify([role, overrides, this.task.def])).digest('hex');
    if (this.devSession?.key !== key) this.devSession = { key, id: randomUUID() };
    return { id: this.devSession.id, resumePrompt: devResumePrompt(feedback) };
  }

  private async stepOverrides(role: Role, attempt: number): Promise<{ model?: string; effort?: Effort }> {
    // One decision per attempt serves both the Dev and the Test step (in-memory; a resume decides again).
    if (this.tierAttempt !== attempt) {
      this.tierChoice = await chooseModelTier(this.task.def, attempt, this.deps.decider, this.ctx);
      this.tierAttempt = attempt;
    }
    const chosen = this.tierChoice!;
    if (chosen.tier && chosen.effort) return { model: this.deps.tierModel(role, chosen.tier), effort: chosen.effort };
    const routing = this.deps.routing;
    if (!routing || routing.tiers === 'off') return {};
    // The router sizes the implementing step; reviews keep their own role profile.
    const routed = heuristicTier(this.task.def, attempt);
    if (this.routedAttempt !== attempt) {
      this.routedAttempt = attempt;
      await this.deps.journal.fact(OrchEvent.ModelTierChosen, { taskId: this.taskId, attempt, tier: routed.tier, model: routing.models[routed.tier!], applied: routing.tiers === 'on', source: routed.source });
    }
    return routing.tiers === 'on' && role !== 'test' ? { model: routing.models[routed.tier!] } : {};
  }

  private get ctx(): DecideContext {
    return { confidential: this.deps.project.confidential };
  }

  private get skillsRoot(): string {
    return this.deps.skillsRoot;
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

  /** Feedback when the task's changes add conflict marker lines, or null. */
  private async markersLeft(): Promise<string | null> {
    const marked = await conflictMarkerFiles(this.worktree, 'origin/main', this.deps.exec);
    return marked.length > 0 ? `These files hold conflict markers (${MARKER_SIDES}); resolve every block and remove each marker line, then run the project's tests:\n${marked.join('\n')}` : null;
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

  /** The Dev's own sandbox has no tool to remove a file (Bash's rm/git rm are denied), so it asks the orchestrator instead. */
  private async deleteFiles(paths: string[]): Promise<void> {
    const base = path.resolve(this.worktree);
    for (const p of paths) {
      const resolved = path.resolve(base, p);
      const rel = path.relative(base, resolved);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`deletedFiles path escapes the worktree: ${p}`);
      }
      // The worktree's .git file links it to the repository; without it every later git call fails.
      if (rel.split(path.sep)[0]!.toLowerCase() === '.git') throw new Error(`deletedFiles path is inside .git: ${p}`);
      await fs.rm(resolved, { force: true });
    }
  }

  private async implement(): Promise<void> {
    if (!(await this.ensureWorktree())) return;
    // The scaffold task's job is to create the manifest and lockfile from nothing: on its first attempts the
    // worktree has neither, so the install command fails deterministically (e.g. `npm ci` prints its own usage
    // text) before the Dev is ever invoked to write one, and nothing can change between attempts because the
    // Dev never ran (live, R11.P, 2026-10-08: a zero-dependency project's scaffold task died this way, identically,
    // across every attempt and its one replan). Skip the pre-Dev call for it; `gates()` still installs for real
    // once the Dev has committed the manifest it wrote.
    const install = this.task.bootstrapsFrozenPaths ? null : await this.deps.installDeps(this.worktree);
    // The Dev is the one who can fix a failing install (a lock file out of step with the manifest), so it runs with the
    // install output as its feedback, and the attempt is not spent on a failure the Dev has not seen yet (live: T1 was
    // blocked after three attempts that never let the Dev run).
    const installNote = install
      ? [
          `Gate ${install.name} failed (exit ${install.exitCode}) before you ran. Fix the dependencies with the package manager so the lock file matches the manifest, then commit.`,
          install.stderrTail ? `stderr (tail):\n${this.clean(tail(install.stderrTail))}` : '',
          install.stdoutTail ? `stdout (tail):\n${this.clean(tail(install.stdoutTail))}` : '',
        ]
          .filter((s) => s !== '')
          .join('\n\n')
      : null;
    const task = this.task;
    const attempt = task.attempts + 1;
    const commitKey = `${this.taskId}:a${attempt}`;
    if (this.deps.journal.isConfirmed(Intent.Commit, commitKey)) {
      // Crash between the commit confirm and the state change: the work is committed, do not run Dev again.
      return this.transition('validating');
    }
    const owner = task.def.owner;
    const priorFeedback = this.deps.journal.lastFeedback(this.taskId);
    const feedback = installNote ? [installNote, priorFeedback].filter((s) => s).join('\n\n') : priorFeedback;
    // A task of a spec with an implementation plan builds the plan tasks it names, test-first; the rest of the run is unchanged.
    const planFile = this.deps.packBase().planFile;
    const plan = planFile && taskPlanIds(task.def).length ? { file: planFile, ids: taskPlanIds(task.def) } : undefined;
    const env: Record<string, string> = this.deps.testDatabaseUrl ? { DATABASE_URL: this.deps.testDatabaseUrl } : {};
    const pack = devPack(this.deps.packBase(), task.def, { code: await this.deps.code(this.worktree, task.def), handoffs: this.deps.handoffs(), feedback, e2eSuite: this.deps.plan.delivery?.e2eSuite, plan }, owner);
    const sources = await sourceFiles(this.worktree, planFile, this.deps.spec.specId);
    const overrides = await this.stepOverrides(owner, attempt);
    const outcome = await this.deps.runAgent<'dev'>({
      kind: 'dev',
      role: owner,
      pack,
      cwd: this.worktree,
      ...overrides,
      session: this.sessionFor(owner, overrides, feedback),
      phase: 'phase3',
      taskId: this.taskId,
      attempt,
      extraEnv: Object.keys(env).length > 0 ? env : undefined,
      refContext: () => this.refContext(),
      refs: ((v: DevOutput) => ({ files: v.changedFiles })) as never,
    });
    if (!outcome.ok) return this.fail(outcome.failure, outcome.errors.join('\n'));
    const value = outcome.value as DevOutput;
    if (value.skillDraft) await this.reviewDraft(owner, task.def, value.skillDraft);
    if (value.skillRequest) return this.selectSkill(owner, task.def, value.skillRequest);
    if (value.status === 'spec-gap') return this.specGap(task.def, value.question);
    if (value.status === 'blocked') {
      if (SANDBOX_INIT_FAILURE.test(value.reason) || outcome.summary.profile?.sandboxInitFailed) return this.fail('environment', value.reason, 'dev-sandbox-init');
      return this.block(value.reason);
    }
    // A source file the list leaves out sends the step back; an absolute path counts by its ending.
    const unread = sources.filter((f) => !value.filesRead.some((r) => `/${normalizePath(r)}`.endsWith(`/${f}`)));
    if (unread.length > 0) return this.fail('schema', `filesRead leaves out source files this worktree holds; read each one before changing code, then list it: ${unread.join(', ')}`);
    this.specGapRounds = 0;
    await this.deleteFiles(value.deletedFiles ?? []);
    // Gate artifacts (the JUnit report) are written by the orchestrator, not by the Dev, and are never committed.
    const touched = devChangedFiles(await porcelainNames(this.worktree, this.deps.exec)).filter((f) => f !== this.deps.plan.junitPath && f !== this.deps.plan.coveragePath);
    const scope = checkScope({ changedFiles: touched, affectedPaths: task.def.affectedPaths, frozenPaths: this.deps.plan.frozenPaths, scopeJustification: value.scopeJustification, allowFrozen: this.deps.firstSpec && task.bootstrapsFrozenPaths });
    if (!scope.ok) return this.fail('review-changes', `Scope violation:\n${scope.errors.join('\n')}`);
    this.scopeJustification = value.scopeJustification;
    // baseSha lets reconcile tell "committed, then crashed" from "crashed before committing" (spec §6).
    const baseSha = await git(this.worktree, ['rev-parse', 'HEAD'], this.deps.exec);
    await this.deps.journal.intent(Intent.Commit, commitKey, { taskId: this.taskId, worktree: this.worktree, message: value.commitMessage, baseSha });
    const sha = (await commitAll(this.worktree, value.commitMessage, { exclude: commitExcludes(this.deps.plan.junitPath, this.deps.plan.coveragePath) }, this.deps.exec)) ?? (await git(this.worktree, ['rev-parse', 'HEAD'], this.deps.exec));
    await this.deps.journal.confirm(Intent.Commit, commitKey, { sha });
    const changed = await changedFiles(this.worktree, 'origin/main', this.deps.exec);
    if (changed.length === 0) {
      // An earlier run already delivered it (live: a replanned task whose pieces merged across two runs, or a new
      // version re-planning a delivered task); Phase 4 still proves its criteria.
      if (this.deps.deliveredBefore.has(this.taskId) || (await this.alreadyOnMain(task.def))) {
        await this.deps.journal.fact(OrchEvent.AlreadyOnMain, { taskId: this.taskId, paths: task.def.affectedPaths, summary: value.summary });
        await removeWorktree(this.deps.ws.repo, this.worktree, this.deps.exec);
        return this.transition('merged');
      }
      // Nothing to gate, review or open a PR for; GitHub would refuse the PR anyway. Charge the attempt now.
      return this.fail('code', 'Dev reported done but produced no changes against origin/main. Implement the task or return spec-gap.');
    }
    const markers = await this.markersLeft();
    if (markers) return this.fail('code', markers);
    await this.deps.journal.fact(OrchEvent.DevCommitted, { taskId: this.taskId, sha, changedFiles: changed, summary: value.summary, deviations: value.deviations });
    await this.transition('validating');
  }

  private cachedSkill(capability: string, role: Role): { action: 'reuse' | 'create' | 'reject'; skill?: Extract<SkillSelectionOutput, { action: 'reuse' }>['skill']; draftId?: string; reason: string } | null {
    const key = capabilityKey(capability);
    if (!this.deps.journal.events.some((e) => e.type === OrchEvent.SkillRequested && e.data.role === role && capabilityKey(String(e.data.capability ?? '')) === key)) return null;
    for (let i = this.deps.journal.events.length - 1; i >= 0; i--) {
      const e = this.deps.journal.events[i]!;
      if (e.data.role !== role) continue;
      if (e.data.capability && capabilityKey(String(e.data.capability)) !== key) continue;
      if (e.type === OrchEvent.SkillSelected) return { action: e.data.action as 'reuse' | 'create' | 'reject', skill: e.data.skill as Extract<SkillSelectionOutput, { action: 'reuse' }>['skill'] | undefined, reason: String(e.data.reason ?? '') };
      if (e.type === OrchEvent.SkillCreated) return { action: 'create', draftId: String(e.data.id), reason: String(e.data.reason ?? '') };
    }
    return null;
  }

  private async applySelection(role: Role, request: { capability: string; reason: string }, selection: SkillSelectionOutput): Promise<string> {
    if (selection.action === 'reuse') {
      const skill = { ...selection.skill, roles: [role] as const, purpose: request.capability };
      const errors = acceptReuseSkill(skill);
      if (errors.length > 0) {
        await this.deps.journal.fact(OrchEvent.SkillSelected, { taskId: this.taskId, role, action: 'reject', capability: request.capability, reason: errors.join('; ') });
        return `Skill request rejected: ${errors.join('; ')}. Continue with the capabilities already available.`;
      }
      try {
        await syncSkill(this.skillsRoot, skill, this.deps.skillExec ?? this.deps.exec);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.deps.journal.fact(OrchEvent.SkillSelected, { taskId: this.taskId, role, action: 'reject', capability: request.capability, reason });
        return `Skill request rejected: ${reason}. Continue with the capabilities already available.`;
      }
      await assignSkill(this.skillsRoot, this.deps.project.projectId, role, skill);
      await this.deps.journal.fact(OrchEvent.SkillSelected, { taskId: this.taskId, role, action: selection.action, capability: request.capability, skill: selection.skill, reason: selection.reason });
      return `Skill selected by SM: ${selection.skill.id}. Retry the task and use it for ${request.capability}.`;
    }
    if (selection.action === 'create') {
      try {
        await createDraftSkill(this.skillsRoot, this.deps.project.projectId, role, selection.draft);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.deps.journal.fact(OrchEvent.SkillSelected, { taskId: this.taskId, role, action: 'reject', capability: request.capability, reason });
        return `Skill request rejected: ${reason}. Continue with the capabilities already available.`;
      }
      await this.deps.journal.fact(OrchEvent.SkillCreated, { taskId: this.taskId, role, id: selection.draft.id, source: 'sm', capability: request.capability, reason: selection.reason });
      return `Skill created by SM: ${selection.draft.id}. Retry the task and use it for ${request.capability}.`;
    }
    await this.deps.journal.fact(OrchEvent.SkillSelected, { taskId: this.taskId, role, action: selection.action, capability: request.capability, reason: selection.reason });
    return `Skill request rejected by SM: ${selection.reason}. Continue with the capabilities already available.`;
  }

  private async askSkillSelect(role: Role, task: PlanTask, request: { capability: string; reason: string }, draft?: { id: string; whenToUse: string; rules: readonly string[] }): Promise<SkillSelectionOutput | null> {
    if (this.deps.project.confidential) {
      await this.deps.journal.fact(OrchEvent.SkillSelected, { taskId: this.taskId, role, action: 'reject', capability: request.capability, reason: 'confidential project' });
      return { specHash: this.deps.specHash, action: 'reject', reason: 'confidential project' };
    }
    const cached = this.cachedSkill(request.capability, role);
    if (cached?.action === 'reject') return { specHash: this.deps.specHash, action: 'reject', reason: cached.reason || 'cached rejection' };
    const outcome = await withMainSnapshot(this.deps.ws, this.deps.exec, (cwd) => this.deps.runAgent<'skill-select'>({
      kind: 'skill-select',
      role: 'sm',
      pack: skillSelectPack(this.deps.packBase(), task, { role, ...request, ...(draft ? { draft } : {}) }),
      cwd,
      phase: 'phase3',
      taskId: this.taskId,
      attempt: this.task.attempts + 1,
    }));
    if (!outcome.ok) return null;
    return outcome.value as SkillSelectionOutput;
  }

  private async selectSkill(role: Role, task: PlanTask, request: { capability: string; reason: string }): Promise<void> {
    this.skillRounds += 1;
    if (this.skillRounds > 1) return this.fail('code', `skill request repeated after selection: ${request.capability}`);
    await this.deps.journal.fact(OrchEvent.SkillRequested, { taskId: this.taskId, role, ...request });
    const cached = this.cachedSkill(request.capability, role);
    if (cached?.action === 'reuse' && cached.skill) {
      await this.feedback(await this.applySelection(role, request, { specHash: this.deps.specHash, action: 'reuse', skill: cached.skill, reason: cached.reason || 'cached' }));
      return this.implement();
    }
    if (cached?.action === 'create') {
      await this.feedback(`Skill already created by SM: ${cached.draftId ?? request.capability}. Retry the task and use it for ${request.capability}.`);
      return this.implement();
    }
    if (cached?.action === 'reject') {
      await this.feedback(`Skill request rejected by SM: ${cached.reason || 'cached rejection'}. Continue with the capabilities already available.`);
      return this.implement();
    }
    const selection = await this.askSkillSelect(role, task, request);
    if (!selection) return this.fail('code', `skill-select failed for ${request.capability}`);
    await this.feedback(await this.applySelection(role, request, selection));
    return this.implement();
  }

  private async reviewDraft(role: Role, task: PlanTask, draft: { id: string; whenToUse: string; rules: readonly string[] }): Promise<void> {
    const request = { capability: draft.whenToUse, reason: `private draft ${draft.id}` };
    await this.deps.journal.fact(OrchEvent.SkillRequested, { taskId: this.taskId, role, ...request, draft: draft.id });
    const selection = await this.askSkillSelect(role, task, request, draft);
    if (!selection) return;
    if (selection.action === 'create') {
      await this.applySelection(role, request, selection);
      return;
    }
    if (selection.action === 'reuse') {
      await this.applySelection(role, request, selection);
      return;
    }
    await this.deps.journal.fact(OrchEvent.SkillSelected, { taskId: this.taskId, role, action: 'reject', capability: request.capability, reason: selection.reason });
  }

  /** A skill request from a review is journaled only: no step routes it to the SM. */
  private async journalSkillRequest(role: Role, request: { capability: string; reason: string } | undefined): Promise<void> {
    if (request) await this.deps.journal.fact(OrchEvent.SkillRequested, { taskId: this.taskId, role, ...request });
  }

  /** A task with criteria whose every concrete path already exists on origin/main (glob paths are not checked, so they never qualify). */
  private async alreadyOnMain(def: PlanTask): Promise<boolean> {
    if (def.criteriaRefs.length === 0 || def.affectedPaths.length === 0 || def.affectedPaths.some((p) => /[*?[]/.test(p))) return false;
    for (const p of def.affectedPaths) {
      const found = await git(this.deps.ws.repo, ['cat-file', '-e', `origin/main:${p}`], this.deps.exec).then(() => true, () => false);
      if (!found) return false;
    }
    return true;
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

  /** The task's diff against origin/main, read once for both reviews. */
  private async boundedDiff(): Promise<string> {
    const full = await git(this.worktree, ['diff', 'origin/main...HEAD'], this.deps.exec);
    // sec has no Bash and cannot tell a short diff from a cut one: say so, or it approves code it never saw.
    return full.length > SECURITY_DIFF_CHARS
      ? `${full.slice(0, SECURITY_DIFF_CHARS)}\n[diff truncated: first ${SECURITY_DIFF_CHARS} of ${full.length} characters shown. The changes after the cut were not shown: read the changed files and the task's affectedPaths to review them.]`
      : full;
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
    const diff = await this.boundedDiff();
    const pack = reviewPack(this.deps.packBase(), this.task.def, { diffStat, changedFiles: changed, diff, junit: this.junit, code, profile });
    // R11.13 slice 5: both reviews read the same diff and edit nothing, so they run together (about 40 s per task). The
    // security step must settle before this method returns, or a Dev retry could edit the worktree while it still reads it.
    const security = this.startSecurity(changed, diffStat, diff, code);
    try {
      await this.judgeReview(pack, security);
    } finally {
      await security.then(() => undefined, () => undefined);
    }
  }

  private async judgeReview(pack: ReturnType<typeof reviewPack>, security: Promise<StepOutcome<OutputOf<'security'>>>): Promise<void> {
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
    await this.journalSkillRequest('test', value.skillRequest);
    const evidenceErrors = verifyClaimedEvidence(value.criteria, this.junit);
    if (evidenceErrors.length > 0) return this.fail('schema', `Review evidence rejected:\n${evidenceErrors.join('\n')}`);
    if (value.decision === 'changes') {
      await this.deps.journal.fact(OrchEvent.ReviewChanges, { taskId: this.taskId, findings: value.findings });
      const text = value.findings.map((f) => `- ${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.problem} (fix: ${f.fix})`).join('\n');
      return this.fail('review-changes', `Review requested changes:\n${text}`);
    }
    await this.deps.journal.fact(OrchEvent.ReviewApproved, { taskId: this.taskId, criteria: value.criteria });
    if (!(await this.judgeSecurity(await security))) return;
    await this.transition('rebasing');
  }

  private startSecurity(changed: readonly string[], diffStat: string, diff: string, code: CodeContext): Promise<StepOutcome<OutputOf<'security'>>> {
    const attempt = this.task.attempts + 1;
    const run = this.deps.runAgent<'security'>({
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
    return run.then(async (outcome) => {
      if (outcome.ok) await this.journalSkillRequest('sec', (outcome.value as SecurityOutputSchema).skillRequest);
      return outcome;
    });
  }

  /** Counted only after Test approves: critical/high findings go back to Dev like review changes; medium/low are journaled only. */
  private async judgeSecurity(outcome: StepOutcome<OutputOf<'security'>>): Promise<boolean> {
    if (!outcome.ok) {
      await this.fail(outcome.failure, outcome.errors.join('\n'));
      return false;
    }
    const value = outcome.value as SecurityOutputSchema;
    if (value.skillRequest) {
      await this.fail('review-changes', `Security review incomplete: a skill is needed for ${value.skillRequest.capability} (${value.skillRequest.reason})`);
      return false;
    }
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
    // A resume can reach the merge with the replay's markers still in place; they must never merge.
    const markers = this.task.state === 'rebasing' ? await this.markersLeft() : null;
    if (markers) return this.fail('code', markers);
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
      // The queue short-circuits an already-merged PR before afterMerge; the cleanup still has to happen (an empty rebase already ran it).
      if (outcome.already && !outcome.empty && steps.afterMerge) await steps.afterMerge();
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
      case 'rebase': {
        const conflicts = outcome.conflicts ?? [];
        // A rebase stage that failed without conflicts (a gh call, say) is no conflict to replay and nothing for the Dev to fix: retry it as infrastructure, and say why when the retries run out.
        if (conflicts.length === 0) return this.fail('infra', `Rebase stage failed without conflicts: ${this.clean(outcome.detail ?? 'no detail')}`, 'rebase');
        // A retry on the old base replays the same conflicting commit (the Dev cannot rebase), so move the task onto main first.
        await gitFetch(this.deps.ws.repo, this.deps.exec);
        let failure = '';
        const replay = await replayOnto(this.deps.ws.repo, this.worktree, 'origin/main', `${this.taskId}: replay onto origin/main`, this.deps.exec).catch((err: Error) => {
          failure = ` (moving the task onto main failed: ${this.clean(err.message)})`;
          return null;
        });
        if (!replay) return this.fail('rebase-conflict', `Rebase conflicts on origin/main${failure}:\n${conflicts.join('\n')}`);
        await this.deps.journal.fact(OrchEvent.RebaseReplayed, { taskId: this.taskId, previous: replay.previous, files: replay.files });
        // Clean: the task stays in rebasing and the next advance merges it, no attempt spent.
        if (replay.files.length === 0) return;
        return this.fail('rebase-conflict', `Rebase conflicts on origin/main. The orchestrator moved this task onto the current origin/main; these files hold conflict markers where both sides changed the same lines (${MARKER_SIDES}). In each, keep main's change and this task's intent and remove every marker line, then run the project's tests:\n${replay.files.join('\n')}`);
      }
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
  budgetExceeded(used: number, cap: number, unit: 'tokens' | 'USD' = 'tokens'): Promise<void> {
    const what = unit === 'USD' ? `Task cost budget exceeded: US$ ${used.toFixed(2)} used, cap US$ ${cap.toFixed(2)}.` : `Task token budget exceeded: ${used} tokens used, cap ${cap}.`;
    return this.fail('budget', `${what} Finish with a smaller change set.`);
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
        // instead of spending the remaining attempts; a replacement task is never replanned again, so it blocks.
        const next = this.task.attempts + 2;
        if (next >= 3) {
          const { progress, source } = await assessAttemptProgress(this.task.def, next, [...this.attemptDeltas(), text], this.deps.decider, this.ctx);
          if (progress !== 'converging' && this.task.replanned) {
            await this.feedback(text, { attempt: true });
            await this.deps.journal.fact(RunEvent.AttemptConsumed, { taskId: this.taskId });
            return this.block(`${text}\n\nAttempt progress judged ${progress} (${source}) on a replanned task; blocked instead of spending its remaining attempts.`);
          }
          if (progress !== 'converging') {
            await this.feedback(`${text}\n\nAttempt progress judged ${progress} (${source}); replanning early.`, { attempt: true });
            // A System 1 verdict may route to the SM but never end the task: if the SM cannot replan, retry as usual.
            const settled = await this.replan({ early: true });
            // A replan the quota or the login paused left the task where it was: its next failure charges the attempt.
            if (settled && !this.done) return;
            if (!settled) await this.transition('implementing');
            await this.deps.journal.fact(RunEvent.AttemptConsumed, { taskId: this.taskId });
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
    const own = this.ownInfraOnly(outcome.value as ReplanOutput);
    // A replacement changes the same repository as the task it replaces, whatever service the agent names.
    const service = this.task.def.service;
    const value = { ...own, replacements: own.replacements.map(({ service: _, ...r }) => (service ? { ...r, service } : r)) };
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

  /** A devops replacement that also touches app or docs files goes to dev, who has Bash and may edit infra too. */
  private ownInfraOnly(value: ReplanOutput): ReplanOutput {
    const manifests = this.deps.plan.deploy.manifests;
    const replacements = value.replacements.map((r) => (r.owner === 'devops' && devopsOwnerErrors([r], manifests).length > 0 ? { ...r, owner: 'dev' as const } : r));
    return { ...value, replacements };
  }

  private replanErrors(replacements: readonly PlanTask[]): string[] {
    const errors: string[] = [];
    const known = new Set(this.deps.journal.state.tasks.keys());
    const newIds = new Set(replacements.map((r) => r.id));
    if (newIds.size !== replacements.length) errors.push('duplicate replacement ids');
    // The scaffold makes the gates runnable; a piece of it cannot pass them (seen live: a scripts-only
    // replacement failed lint/typecheck/build for lack of the toolchain its sibling task owned).
    if (this.task.bootstrapsFrozenPaths && replacements.length !== 1) errors.push(`${this.taskId} is the scaffold task and must be replanned into exactly one task, got ${replacements.length}`);
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
