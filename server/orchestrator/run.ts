import type { DecideOutput } from '../agents/outputs.js';
import { maskableValues, redactSecrets } from '../core/redact.js';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agents/registry.js';
import type { OutputOf, StepKind } from '../agents/outputs.js';
import { Accounting } from '../budget/accounting.js';
import { replayAccounting } from './accounting-replay.js';
import { Governor } from '../budget/governor.js';
import { DEFAULT_BREAKER, QuotaBreaker } from '../budget/quota-breaker.js';
import { codeQuestionOf } from '../knowledge/code-question.js';
import { readRelationSpecs } from '../knowledge/relation-links.js';
import { failureLines, failuresOf, readRunJournals } from '../knowledge/failure-memory.js';
import { BRIEF_MAX_CHARS, specBrief } from '../knowledge/spec-brief.js';
import { agentsDecideFor, graphArmOf, graphOffFor, manualAgentSettings, stepBudgetFor, automaticStepOf, type AgentSetting, type Config, type Role, type SettingKey } from '../config/config.js';
import { parseAnyPlan, scaffoldId, servicePlans, type AnyPlan, type Plan, type PlanTask, type ServiceView } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { createDecider } from '../decide/create-decider.js';
import type { Decider } from '../decide/decider.js';
import { classifyCliError } from '../decide/decisions/cli-error.js';
import { sandboxPolicyViolation } from '../runner/sandbox-policy.js';
import { execCommand, type Exec } from '../exec/command.js';
import { TOOLS_GATE } from '../validators/security-tooling.js';
import { writeToolsInstaller } from './tools-install.js';
import { prepareGateImage, runGate, runGates, type GateContext, type GateExecutor, type GateResult } from '../exec/gate-runner.js';
import { TEST_GATE, withTestServices } from '../exec/test-services.js';
import { fetch as gitFetch, git, headSha, withCheckoutLock, withRepoLock } from '../git/git.js';
import { INSTALLED_AT, needsInstall } from './install-state.js';
import { writeSecret } from '../core/secrets.js';
import type { PlatformService } from '../contracts/project.js';
import { repairedDatabaseUrl, sharedDatabase } from './shared-database.js';
import { freePort, needsTestDatabase, startTestDatabase, stopTestDatabase } from './test-database.js';
import { MergeQueue } from '../git/merge-queue.js';
import type { CodeContext, GraphAccess, HandoffSummary } from '../knowledge/context-pack.js';
import { grepFallback, MIN_COVERAGE, type Graphify } from '../knowledge/graphify.js';
import { ensureProjectGraph, refreshMergedGraph, refreshProjectGraph, type LocatedProject } from '../knowledge/project-graph.js';
import type { KnowledgeIndex } from '../knowledge/retrieval.js';
import { RunEvent, type RunState } from '../pipeline/run-state.js';
import { ACTIVE_STATES, DEPENDENCY_BLOCKED } from '../pipeline/task-state.js';
import type { RunnerBinary } from '../runner/process-runner.js';
import type { runStep as runStepFn, StepDeps, StepOutcome } from '../runner/step.js';
import { nextRunnable, runProgress, tasksToBlock, type RunProgress } from '../scheduler/scheduler.js';
import { DEFAULT_POLICY } from '../scheduler/retry-policy.js';
import { CrashInjected, Intent, Journal, OrchEvent, type IntentType, type RunResult } from './events.js';
import { phase6Resume } from './phase6-resume.js';
import { effectivePlan } from './gate-fix.js';
export { CrashInjected };
import { taskMergeSteps, type MergeStepsDeps } from './merge-steps.js';
import { PAUSED_AUTH, ensureServiceRepos, runPhase0, runWorkflowBootstrap, runPhase1, runPhase2, runPhase4, runPhase5, runServicesPhase5, runPhase6, deployStartAttempt, MAX_DEPLOY_ATTEMPTS, MAX_ENV_RERUNS, type PhaseDeps, type PhaseResult } from './phases/index.js';
import { withMainSnapshot } from './phases/shared.js';
import { runDocsPhase } from './phases/docs.js';
import { planGapTasks, runPlanReview } from './phases/converge.js';
import { reconcile } from './reconcile.js';
import { environmentContainers, issueEnvironmentTokens, mintEnvironment, prepareEnvironment, type EnvironmentHost } from '../environment/service.js';
import { runAgentStep, type AgentStepDeps, type AgentStepRequest, type PackBase } from './steps.js';
import { TaskRunner, type TaskRunnerDeps } from './task-runner.js';
import { portKey, registeredPorts } from '../deploy/port-registry.js';
import { holdsOnlyDocs } from './first-spec.js';
import { deliveredByPriorRuns, eventsFile, expandHome, graphDir, graphFile, mergedByPriorRuns, nextRunId, runDir, sameVersionRunEvents, serviceWorkspace, sessionDir, stateFile, stepDir, worktreeDir, type Workspace } from './workspace.js';
import type { StoredEvent } from '../store/event-store.js';
import type { DeployTarget } from '../deploy/target.js';
import { E2E_GATE, runE2e } from '../exec/e2e.js';
import { agentPluginsRoot } from '../skills/plugins.js';
import { gateReachableUrl, runSmoke } from '../exec/smoke.js';
import { withRepairNotes } from '../program/repair-notes.js';
import { ownerDecisionLines, type OwnerDecision } from './owner-decisions.js';
import { androidToolchainOf, copyCargoRoot, stackDomains, stackKind, type AndroidToolchain, type StackKind } from '../runner/stacks.js';
import type { DocsRun } from '../docs/layout.js';
import { readState, snapshotDesign, updateState } from '../docs/project-state.js';

export interface RunDeps {
  cfg: Config;
  /** The project's manual model and effort per agent, read at each step; without it the run uses `cfg`. */
  agentSettings?: (projectId: string) => Promise<Partial<Record<Role, AgentSetting | null>>>;
  /** Whether the project's agents decide blocks themselves, read at each use; without it the run uses `cfg`. */
  agentsDecide?: (projectId: string) => Promise<boolean>;
  ws: Workspace;
  project: Project;
  spec: Spec;
  repairNotes?: string | null;
  /** The owner's answers to this spec's blocks, read at the start of the run; each is a binding assumption. */
  ownerDecisions?: OwnerDecision[];
  firstSpec: boolean;
  /** Set when a blocked run with its returns spent starts the one automatic successor: that run is not chained again. */
  autoReprocess?: boolean;
  requireDelivery?: boolean;
  requireSecurityTooling?: boolean;
  requireE2e?: boolean;
  requireCoverage?: boolean;
  requireFrozenScope?: boolean;
  exec: Exec;
  ghExec: Exec;
  runStep: typeof runStepFn;
  binary: RunnerBinary;
  agents: Record<Role, AgentDefinition>;
  graphify: Graphify | null;
  knowledge: KnowledgeIndex | null;
  secrets: Record<string, string>;
  /** Set by the run itself from `secrets.ANTHROPIC_API_KEY`: the key is for agent steps only and is kept out of `secrets`. */
  apiKey?: string;
  fetch?: typeof fetch;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Test hook: the journal throws CrashInjected right after appending a matching intent. */
  crashAfterIntent?: (intentId: string) => boolean;
  maxParallel?: number;
  /** Claude Code's trust file; tests point it into a temp dir so they never touch the real ~/.claude.json. */
  claudeJsonPath?: string;
  /** Spec (refinement) §4: docs to put on main before Phase 1 (`run --draft`). */
  bootstrap?: { docsDir: string; owner: string | undefined };
  /** The plan file of this spec, when its refinement prepared one. */
  planFile?: string;
  /** The spec's task list in the repository, when the refinement wrote one. */
  taskFile?: string;
  target?: DeployTarget;
  /** Runs gates and smoke; absent means docker over `exec`. */
  gateExecutor?: GateExecutor;
  /** Set when the project's documents live in a documentation repository; its machine files are read from the mirror. */
  docsRepo?: boolean;
  /** A documentation-repository project's layout and the pinned snapshot its agents read the documents from. */
  docs?: DocsRun;
}

export type ExecuteResult = RunResult | 'paused:auth';


const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `uid:gid` of this process on POSIX hosts; undefined on Windows, where Docker Desktop maps ownership itself. */
export function containerUser(rootless = false): string | undefined {
  // A rootless daemon maps its own user to root inside containers: the files this process owns belong to "root" there,
  // and any other uid (even the same number) is a subuid that cannot write them.
  if (rootless) return undefined;
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
}

/** Spec (orchestrator) §2.2: one tick loop, runners return through the journal. */
/**
 * R11.13 slice 12: the Claude Console key reaches the agent steps and nothing else. Gates, the smoke and e2e runs and the
 * deployed service get `secrets` without it, so a plan that names ANTHROPIC_API_KEY as a gate secret finds nothing to read.
 */
function withApiKeySplit(deps: RunDeps): RunDeps {
  const { ANTHROPIC_API_KEY: key, ...secrets } = deps.secrets;
  return { ...deps, secrets, ...(key && key.trim() !== '' ? { apiKey: key } : {}) };
}

/** One cache per project: a gate a project's own agents can steer never writes where another project's gates read (a poisoned scanner database). */
export const gateCacheDir = (root: string, projectId: string): string => path.join(root, 'gates', projectId);

/** Only the secrets the spec declares reach a gate container: the platform's (GitHub token, API keys) never do, whatever the plan asks. */
export function gateSecrets(spec: Pick<Spec, 'externalDependencies'>, all: Readonly<Record<string, string>>, environmentNames: readonly string[] = []): Record<string, string> {
  const declared = new Set([...spec.externalDependencies.flatMap((d) => d.secretNames), ...environmentNames]);
  return Object.fromEntries(Object.entries(all).filter(([name]) => declared.has(name)));
}

function assertApiKey(deps: RunDeps): void {
  if (deps.cfg.claude.auth === 'api-key' && !(deps.secrets.ANTHROPIC_API_KEY ?? '').trim()) {
    throw new Error('claude.auth is "api-key" but the secret ANTHROPIC_API_KEY is not set (store it with the other secrets)');
  }
}

/** A cold Go or Rust build in a fresh worktree is slow, and parallel tasks compile their tools at the same time (live: three Rust installs passed 10 minutes). */
const buildTimeoutMs = (plan: Plan): number => ((['go', 'rust', 'flutter', 'expo'] as const).includes(stackKind(plan.stack) as 'go') ? 25 * 60_000 : 10 * 60_000);

/** The plan when it has one repository; a services plan is read per service instead. */
const singlePlan = (plan: AnyPlan | null): Plan | undefined => (plan && !('services' in plan) ? plan : undefined);

/** The view a task runs in: its service's, or the whole plan for a task without a service. */
function viewOf(plan: AnyPlan, service: string | undefined): ServiceView {
  const view = servicePlans(plan).find((v) => v.service === (service ?? null));
  if (!view) throw new Error(`the plan has no service ${service}`);
  return view;
}

/** The state the scheduler reads: a task handed to a runner holds its paths and its slot before its first transition lands. */
export function withInflightClaimed(state: RunState, inflight: Iterable<string>): RunState {
  const tasks = new Map(state.tasks);
  for (const id of inflight) {
    const t = tasks.get(id);
    if (t && (t.state === 'planned' || t.state === 'ready')) tasks.set(id, { ...t, state: 'implementing' });
  }
  return { ...state, tasks };
}

/** Docs merges run no gates. */
const NO_GATES = async (): Promise<{ results: GateResult[]; blockingFailure: GateResult | null }> => ({ results: [], blockingFailure: null });

/** The blocked tasks of a finished run as one comparable signature: each task with the first line of its reason. */
export function blockSignature(blocked: unknown): string {
  if (!Array.isArray(blocked)) return '';
  return blocked.map((b: { taskId: string; reason: string }) => `${b.taskId}\u0000${String(b.reason).split('\n')[0]}`).sort().join('\u0001');
}

/** The last two finishes of the run ended blocked with the same blocked tasks for the same reason: another try repeats it. */
export function repeatedBlock(events: readonly { type: string; data: Record<string, unknown> }[]): boolean {
  const finishes = events.filter((e) => e.type === OrchEvent.RunFinished);
  if (finishes.length < 2) return false;
  const [before, last] = finishes.slice(-2) as Array<{ data: Record<string, unknown> }>;
  if (before!.data.result !== 'blocked' || last!.data.result !== 'blocked') return false;
  const signature = blockSignature(last!.data.blocked);
  return signature !== '' && signature === blockSignature(before!.data.blocked);
}

/** The last return to the agents ended blocked again and merged no task: another return burns money the same way. */
export function returnMadeNoProgress(events: readonly { type: string; data: Record<string, unknown> }[]): boolean {
  const finishes = events.map((e, i) => (e.type === OrchEvent.RunFinished ? i : -1)).filter((i) => i >= 0);
  if (finishes.length < 2) return false;
  const [from, to] = finishes.slice(-2) as [number, number];
  if (events[to]!.data.result !== 'blocked') return false;
  return !events.slice(from, to).some((e) => e.type === RunEvent.TaskStateChanged && e.data.to === 'merged');
}

/** After a fix task's loop the run goes on unless a task is blocked. A fix task replanned into replacements is judged by its replacements. */
export function fixTasksOutcome(state: RunState): 'merged' | 'blocked' {
  return [...state.tasks.values()].some((t) => t.state === 'blocked') ? 'blocked' : 'merged';
}

/** The arm of the graph experiment the run is in, journaled with its start so the report can tell the two groups apart; nothing outside the experiment. */
const graphArmFact = (deps: Pick<RunDeps, 'cfg' | 'project' | 'spec'>): { graphArm?: 'control' | 'graph' } => {
  const { arm } = graphArmOf(deps.cfg, deps.project.projectId, deps.spec.specId);
  return arm ? { graphArm: arm } : {};
};

/** How many times a blocked run goes back to the agents on its own, when the owner lets them decide. */
export const MAX_AUTO_RETURNS = 3;

export class Run {
  readonly accounting = new Accounting();
  private readonly governor: Governor;
  private readonly breaker: QuotaBreaker;
  private readonly mergeQueue = new MergeQueue();
  private readonly handoffs: HandoffSummary[];
  private readonly clock: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly maxParallel: number;
  private plan: AnyPlan | null = null;
  /** Plan task ids an earlier run of this spec delivered, in any version; read when Phase 3 starts. */
  private deliveredBefore: ReadonlySet<string> = new Set();
  private techSpecText = '';
  private adrs: Array<{ id: string; title: string; text: string }> = [];
  /** R12.6: each service's address on the shared network, and the design doc, for steps in a service's repository. */
  private addresses: Record<string, string> = {};
  private design: string | null = null;
  private readonly runners = new Map<string, TaskRunner>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** The tasks, and the run as null, whose spent budget observe mode journaled already. */
  private readonly budgetNoted: Set<string | null>;
  private costAlerted: boolean;
  private readonly deps: RunDeps;

  private constructor(
    readonly runId: string,
    readonly journal: Journal,
    rawDeps: RunDeps,
    /** The gate corrections earlier runs of this spec version accepted: applied here, never journaled again, counted toward no limit of this run. */
    private readonly priorGateFixes: readonly StoredEvent[],
  ) {
    this.deps = withApiKeySplit(rawDeps);
    const deps = this.deps;
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
    this.maxParallel = deps.maxParallel ?? deps.cfg.concurrency.maxParallel;
    this.handoffs = journal.handoffs();
    this.budgetNoted = new Set(journal.events.filter((e) => e.type === OrchEvent.BudgetExceeded).map((e) => (e.data.taskId as string | null) ?? null));
    this.costAlerted = journal.events.some((e) => e.type === OrchEvent.RunCostAlert);
    replayAccounting(this.journal.events, this.accounting);
    this.governor = new Governor(deps.cfg.concurrency.maxClaudeProcesses);
    this.breaker = new QuotaBreaker(DEFAULT_BREAKER, this.clock);
  }

  private static async openJournal(deps: RunDeps, runId: string): Promise<Journal> {
    const journal = await Journal.open({ file: eventsFile(deps.ws, runId), runId, specHash: deps.spec.specHash!, clock: deps.clock });
    if (deps.crashAfterIntent) {
      const hook = deps.crashAfterIntent;
      const original = journal.intent.bind(journal);
      journal.intent = (async (type: IntentType, key: string, data?: Record<string, unknown>) => {
        const stored = await original(type, key, data);
        if (hook(stored.intentId!)) throw new CrashInjected(`crash injected after ${stored.intentId}`);
        return stored;
      }) as Journal['intent'];
    }
    return journal;
  }

  /** Refuse an unsafe or inconsistent configuration before any phase runs. Audit C1: runStep keeps the sandbox check as a backstop. */
  private static assertSandboxPolicy(deps: RunDeps): void {
    const violation = sandboxPolicyViolation(deps.cfg.sandbox, process.env);
    if (violation) throw new Error(violation);
  }

  static async create(deps: RunDeps, runId?: string): Promise<Run> {
    Run.assertSandboxPolicy(deps);
    assertApiKey(deps);
    const id = runId ?? (await nextRunId(deps.ws, deps.spec.specId));
    await fs.mkdir(runDir(deps.ws, id), { recursive: true });
    const journal = await Run.openJournal(deps, id);
    await journal.fact(OrchEvent.RunStarted, { runId: id, specId: deps.spec.specId, projectId: deps.project.projectId, firstSpec: deps.firstSpec, ...(deps.autoReprocess ? { autoReprocess: true } : {}), ...graphArmFact(deps) });
    return new Run(id, journal, deps, await Run.loadPriorGateFixes(deps, id));
  }

  /** The GATE_FIXED and GATE_IMAGE_FIXED facts of earlier runs of this same spec version, oldest first. */
  private static async loadPriorGateFixes(deps: RunDeps, runId: string): Promise<StoredEvent[]> {
    const fixes = new Set<string>([OrchEvent.GateFixed, OrchEvent.GateImageFixed]);
    return (await sameVersionRunEvents(deps.ws, deps.spec.specId, runId, deps.spec.specHash!)).flat().filter((e) => fixes.has(e.type));
  }

  static async resume(deps: RunDeps, runId: string): Promise<Run> {
    Run.assertSandboxPolicy(deps);
    assertApiKey(deps);
    // The UI marks a run whose process died with `pid.gone`; any resume, CLI or UI, ends that state.
    await fs.rm(path.join(runDir(deps.ws, runId), 'pid.gone'), { force: true });
    const journal = await Run.openJournal(deps, runId);
    const run = new Run(runId, journal, deps, await Run.loadPriorGateFixes(deps, runId));
    await reconcile({ journal, ws: deps.ws, exec: deps.exec, ghExec: deps.ghExec, afterMerge: (taskId, branch) => run.afterMergeOnResume(taskId, branch), log: run.log, currentImage: deps.target?.currentImage.bind(deps.target) });
    // `resume` is the human's signal that the login was redone (spec §7 "resume tries again").
    // A hand resume of a stopped run is journaled too: the supervisor reads a stop as intentional only while it is the last lifecycle event.
    if (journal.state.status === 'paused:auth' || journal.state.status === 'draining') await journal.fact(RunEvent.RunResumed, { manual: true });
    await run.writeState();
    return run;
  }

  /** A resume gives every blocked task a fresh start: the cause may be fixed now (live: a Go download the sandbox refused). A finished run is reopened first; `auto` marks a return the agents made on their own. */
  async retryBlocked(opts: { auto?: boolean } = {}): Promise<void> {
    const events = this.journal.events;
    if (events.findLastIndex((e) => e.type === OrchEvent.RunFinished) > events.findLastIndex((e) => e.type === RunEvent.RunReopened)) await this.journal.fact(RunEvent.RunReopened, opts.auto ? { auto: true } : { manual: true });
    const blocked = [...this.journal.state.tasks].filter(([, t]) => t.state === 'blocked').map(([id]) => id);
    if (blocked.length > 0) await this.journal.fact(RunEvent.TasksUnblocked, { taskIds: blocked });
  }

  /** The agents take the blocked tasks back on their own: the owner lets them decide, and fewer than MAX_AUTO_RETURNS returns ran. */
  async canReturnBlocked(): Promise<boolean> {
    const returns = this.journal.events.filter((e) => e.type === RunEvent.RunReopened && e.data.auto === true).length;
    return returns < MAX_AUTO_RETURNS && !repeatedBlock(this.journal.events) && !returnMadeNoProgress(this.journal.events) && (await this.autonomous());
  }

  /** With the owner's agents deciding, a blocked run whose returns are spent starts one successor of the spec; a successor starts none, and a repeated block starts none. */
  async canReprocessAutomatically(): Promise<boolean> {
    const successor = this.journal.events.some((e) => e.type === OrchEvent.RunStarted && e.data.autoReprocess === true);
    return !successor && !repeatedBlock(this.journal.events) && (await this.autonomous());
  }


  private async afterMergeOnResume(taskId: string, branch: string): Promise<void> {
    const plan = this.plan ?? (await this.loadPlan());
    const task = plan?.tasks.find((t) => t.id === taskId);
    if (!plan || !task) return;
    const view = viewOf(plan, task.service);
    const steps = taskMergeSteps(this.mergeDeps(view), task, worktreeDir(this.wsOf(view), branch), branch, this.deps.spec, `resumed ${taskId}`);
    await steps.afterMerge?.();
  }

  private wsOf(view: ServiceView): Workspace {
    return serviceWorkspace(this.deps.ws, view.service);
  }

  /** A new service's repository is bootstrapped by its own scaffold; the project repository keeps the run's firstSpec. */
  private firstSpecOf(view: ServiceView): boolean {
    return view.service === null ? this.deps.firstSpec : view.plan.tasks.some((t) => t.id === scaffoldId(view.service));
  }

  private taskView(taskId: string): ServiceView {
    return viewOf(this.plan!, this.journal.state.tasks.get(taskId)?.def.service);
  }

  /** Texts naming a step's stack: its task's, or every stack of the plan for a step outside a task. */
  private stackTexts(view?: ServiceView): string[] {
    const views = view ? [view] : this.plan ? servicePlans(this.plan) : [];
    return views.length > 0 ? views.map((v) => `${v.plan.stack} ${v.plan.gateImage} ${this.deps.project.stack ?? ''}`) : [this.deps.project.stack ?? ''];
  }

  /** Package registries a step may reach, by its stacks. */
  private registries(view?: ServiceView): string[] {
    return [...new Set(this.stackTexts(view).flatMap((text) => stackDomains(stackKind(text))))];
  }

  /** The stacks a step works on, for its toolchain commands. */
  private stacks(view?: ServiceView): StackKind[] {
    return [...new Set(this.stackTexts(view).map(stackKind))];
  }

  private async loadPlan(): Promise<AnyPlan | null> {
    const { readDocs } = await import('./phases/shared.js');
    return (await readDocs(this.deps.ws.repo, this.deps.spec.specId, this.deps.exec, this.deps.docsRepo ? this.deps.ws : undefined)).plan;
  }

  /** The manual settings as they are now, so a model or effort changed during the run applies to the next step. */
  private async manualSettings(): Promise<Partial<Record<SettingKey, AgentSetting>>> {
    const projectId = this.deps.project.projectId;
    return manualAgentSettings(this.deps.agentSettings ? await this.deps.agentSettings(projectId) : this.deps.cfg.agentSettings[projectId]);
  }

  /** Whether this project's agents decide blocks themselves, read at each use so a change in Settings reaches the next step. */
  private async autonomous(): Promise<boolean> {
    const projectId = this.deps.project.projectId;
    return this.deps.agentsDecide ? this.deps.agentsDecide(projectId) : agentsDecideFor(this.deps.cfg, projectId);
  }

  private stepDeps(view?: ServiceView): StepDeps {
    const { cfg, ws } = this.deps;
    return {
      binary: this.deps.binary,
      caps: stepBudgetFor(cfg, this.deps.project.projectId),
      accounting: this.accounting,
      claudeJsonPath: this.deps.claudeJsonPath ?? expandHome('~/.claude.json'),
      settingsDir: path.posix.join(runDir(ws, this.runId), 'settings'),
      workspacesRoot: expandHome(cfg.paths.workspaces),
      agentPluginsRoot: agentPluginsRoot(),
      skillsRoot: expandHome('~/.teams-ai/skills'),
      skillScope: this.deps.project.projectId,
      // The stack's registries let a step install dependencies; cfg.docker.serviceHost is where the orchestrator and the
      // gates already reach a deployed service (server/deploy/docker-local.ts), so a step's own sandbox needs the same
      // route to test against SERVICE_URL itself — never a wider one (no internet host, no datastore port).
      network: { allowedDomains: [...this.registries(view), cfg.docker.serviceHost] },
      stacks: this.stacks(view),
      sandbox: { enabled: cfg.sandbox.enabled, unsafeNoSandbox: cfg.sandbox.unsafeNoSandbox },
      clock: this.clock,
      // cli-error's chain never reaches Claude, so classifying a failed step cannot start another step.
      ...(cfg.claude.auth === 'api-key' && this.deps.apiKey ? { apiKey: this.deps.apiKey } : {}),
      classifyUnknown: (input) => classifyCliError(input, this.decider(), { confidential: this.deps.project.confidential }),
    };
  }

  private secretValues(): string[] {
    return [...maskableValues(this.deps.secrets), ...(this.deps.apiKey ? [this.deps.apiKey] : [])];
  }

  private agentDeps(view?: ServiceView): AgentStepDeps {
    const { cfg } = this.deps;
    return {
      runStep: this.deps.runStep,
      stepDeps: this.stepDeps(view),
      agents: this.deps.agents,
      profile: (role) => cfg.roles[role],
      governor: this.governor,
      breaker: this.breaker,
      journal: this.journal,
      stepDir: (seq) => stepDir(this.deps.ws, this.runId, seq),
      sessionDir: (taskId) => sessionDir(this.deps.ws, this.runId, taskId),
      stepSetting: (kind) => automaticStepOf(cfg.routing, kind),
      effortCaps: cfg.routing.automaticEffortCap,
      defaultEffort: cfg.routing.efforts.automatic,
      agentSetting: async (role) => (await this.manualSettings())[role],
      secretValues: () => this.secretValues(),
      docsRoot: this.deps.docs?.snapshot,
      agentsDecide: () => this.autonomous(),
      graphAccess: this.graphAccess(view),
      graphOff: this.graphOff(),
      specBrief: () => this.specBrief(),
      specHash: this.deps.spec.specHash!,
    };
  }

  /** The step kinds this run is not offered the graph for: the project's own list, plus the experiment's kinds only when the run's start put it in the experiment's control arm. */
  private graphOff(): readonly string[] {
    const cfg = this.deps.cfg;
    const { projectId } = this.deps.project;
    const inExperiment = this.journal.events.find((e) => e.type === OrchEvent.RunStarted)?.data.graphArm !== undefined;
    return inExperiment ? graphArmOf(cfg, projectId, this.deps.spec.specId).off : graphOffFor(cfg, projectId);
  }

  /** After a merge, the project's graph is merged again from the repositories' graphs. */
  private mergedGraph(): void {
    if (this.deps.graphify) refreshMergedGraph(this.deps.graphify, this.located(), this.deps.log);
  }

  /** The project as the graph builders take it, with the GitHub owner the settings name: the graph keeps to that owner's repositories. */
  private located(): LocatedProject {
    return { ws: this.deps.ws, project: this.deps.project, newestSpec: this.deps.spec.specId, owner: this.deps.bootstrap?.owner ?? this.deps.project.github.owner ?? this.deps.cfg.github.owner };
  }

  private briefOf?: Promise<string>;

  /** The relations of this run's spec, read once from the project's saved state; empty for a project with none. */
  private specBrief(): Promise<string> {
    this.briefOf ??= (async () => {
      const runs = expandHome(this.deps.cfg.paths.runs);
      const [specs, journals] = await Promise.all([readRelationSpecs(this.deps.ws), readRunJournals(runs, this.deps.project.projectId)]);
      return specBrief(specs, this.deps.spec.specId, BRIEF_MAX_CHARS, failureLines(failuresOf(journals), this.deps.spec.specId));
    })();
    return this.briefOf;
  }

  /** The graphs the agents of a step may query, each only when its file exists: the repository's and the project's brain. */
  private graphAccess(view?: ServiceView): GraphAccess {
    const found = (file: string | null | undefined): string | undefined => (file && existsSync(file) ? file : undefined);
    const repoGraph = found(graphFile(graphDir(view ? this.wsOf(view) : this.deps.ws, null)));
    const projectGraph = found(graphFile(path.posix.join(this.deps.ws.graph, 'project')));
    return { ...(repoGraph ? { repoGraph } : {}), ...(projectGraph ? { projectGraph } : {}) };
  }

  /** The names the environment step made readable by the suites, on top of the machine's own generated secrets. */
  private readonly environmentSuiteNames = new Set<string>();
  private environmentNames(): string[] {
    return [...this.deps.cfg.environment.generatedSecrets, ...this.environmentSuiteNames];
  }

  private environmentPhase?: PhaseDeps['environment'];
  /** The environment step of this run: one host, so the values it creates stay visible to every later deploy attempt. */
  private environment(): PhaseDeps['environment'] {
    if (this.environmentPhase) return this.environmentPhase;
    const host: EnvironmentHost = {
      projectId: this.deps.project.projectId,
      specId: this.deps.spec.specId,
      secretsDir: path.posix.join(this.deps.ws.root, 'secrets'),
      manifestDir: path.posix.join(this.deps.ws.root, 'environment'),
      secrets: this.deps.secrets,
      suiteNames: this.environmentSuiteNames,
      services: this.deps.project.services ?? [],
      target: this.deps.target ?? {},
      runAgent: this.runAgent,
      packBase: this.packBase,
      pause: async (failure) => (await this.pauseFor(failure as 'quota' | 'auth')) === 'auth',
      journal: this.journal,
    };
    return (this.environmentPhase = { prepare: (repo, failure) => prepareEnvironment(host, repo, failure), mint: (urls) => mintEnvironment(host, urls), containers: () => environmentContainers(host), issue: () => issueEnvironmentTokens(host) });
  }

  private runAgent = <K extends StepKind>(req: AgentStepRequest<K>): Promise<StepOutcome<OutputOf<K>>> => runAgentStep(req, this.agentDeps());

  /**
   * A task worktree starts from origin/main, which never carries installed dependencies, and gates run
   * offline in the gate image. Without this every task lost its first attempt to "tsc: not found" until
   * the Dev thought of running the install itself. Runs the plan's install command in the worktree when
   * the dependency directory is missing or was installed for another commit (a rebase onto a main whose
   * lock file changed); a failure is handed to the Dev as its feedback before it runs.
   */
  private async installDeps(view: ServiceView, worktree: string): Promise<GateResult | null> {
    const command = view.plan.commands.install;
    if (!command) return null;
    const present = await fs.access(path.join(worktree, 'node_modules')).then(() => true, () => false);
    const marker = path.join(worktree, 'node_modules', INSTALLED_AT);
    const installedAt = await fs.readFile(marker, 'utf8').then((s) => s.trim(), () => null);
    const head = await headSha(worktree, this.deps.exec);
    if (!needsInstall(present, installedAt, head)) return null;
    // Tools that `cargo install` put in .tools come from a cache, so they build once, not once per task worktree; the cache is
    // per project, since a project's install command is agent-written and must never plant a binary another project runs.
    const cargoRoot = path.join(expandHome(this.deps.cfg.paths.gateCache), 'cargo-root', this.deps.ws.projectId);
    const tools = path.join(worktree, '.tools');
    const cargoInstall = /\bcargo install\b/.test(command);
    if (cargoInstall) await copyCargoRoot(cargoRoot, tools).catch(() => undefined);
    const failed = await this.installInGate(view, worktree);
    if (cargoInstall && !failed) await copyCargoRoot(tools, cargoRoot).catch(() => undefined);
    if (!failed) await fs.writeFile(marker, `${head}\n`).catch(() => undefined);
    return failed;
  }

  /** A plan as the run executes it: the gate corrections of earlier runs of this spec version, then this run's own. */
  private effective(plan: Plan, service: string | null): Plan {
    return effectivePlan(plan, [...this.priorGateFixes, ...this.journal.events], service);
  }

  /** The plan's install command in the gate container, never on the host: the toolchain must be the plan's gateImage, not the orchestrator's. */
  private async installInGate(view: ServiceView, worktree = this.wsOf(view).repo, command?: string): Promise<GateResult | null> {
    const p = this.effective(view.plan, view.service);
    const where = worktree === this.wsOf(view).repo ? 'deploy' : `install-${path.basename(worktree)}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const ctx = { worktree, image: await this.gateImageOf(p), junitPath: p.junitPath, cpus: 2, memory: '2g', timeoutMs: buildTimeoutMs(p), secrets: {}, containerName: `teams-ai-${this.runId}-${where}${view.service ? `-${view.service}` : ''}`, user: containerUser(this.deps.cfg.docker.rootless), bindRewrite: this.deps.cfg.docker.bindRewrite };
    const r = await runGate({ name: 'install', command: command ?? p.commands.install, blocking: true, network: 'egress', secrets: [] }, ctx, { exec: this.deps.exec, executor: this.deps.gateExecutor, readFile: (f) => fs.readFile(f, 'utf8').catch(() => null), removeFile: (f) => fs.rm(f, { force: true }) });
    return r.passed ? null : r;
  }

  private readonly gateImages = new Map<string, Promise<string>>();

  /** The gate image of a plan: its toolchain, plus Chromium for a front e2e and the Android SDK for Flutter and Expo. */
  private gateImageOf(plan: Plan, browser = false): Promise<string> {
    return this.gateImage(plan.gateImage, { browser, android: androidToolchainOf(stackKind(plan.stack)) });
  }

  /** The image every gate, smoke and e2e container of one stack runs, prepared once per run and flavour (jq, rustfmt and clippy for rust, Chromium, the Android SDK). */
  private gateImage(image: string, flavour: { browser?: boolean; android?: AndroidToolchain } = {}): Promise<string> {
    const key = `${flavour.browser ? 'browser' : ''}|${flavour.android ?? ''}|${image}`;
    let ready = this.gateImages.get(key);
    if (!ready) this.gateImages.set(key, (ready = prepareGateImage(image, this.deps.exec, flavour)));
    return ready;
  }

  private gatesFor(view: ServiceView) {
    return async (worktree: string, branch: string) => {
      const plan = this.effective(view.plan, view.service);
      const install = await this.installDeps(view, worktree);
      if (install) return { results: [install], blockingFailure: install };
      if (plan.gates.some((g) => g.name === TOOLS_GATE)) await writeToolsInstaller(worktree);
      const cacheDir = gateCacheDir(expandHome(this.deps.cfg.paths.gateCache), this.deps.ws.projectId);
      // The gate user may differ from the orchestrator's (rootless dind maps it to its own root), so the cache is open to all.
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o777 }).then(() => fs.chmod(cacheDir, 0o777)).catch(() => undefined);
      const gates = plan.gates.filter((g) => g.blocking && g.name !== E2E_GATE); // the e2e gate runs in Phase 5 only
      const ctx: GateContext = {
        worktree,
        image: await this.gateImageOf(plan),
        junitPath: plan.junitPath,
        coveragePath: plan.coveragePath,
        cacheDir,
        cpus: 2,
        memory: '2g',
        timeoutMs: buildTimeoutMs(plan),
        secrets: gateSecrets(this.deps.spec, this.deps.secrets, this.environmentNames()),
        containerName: `teams-ai-${this.runId}-${branch.replace(/\//g, '__')}`,
        // Files the gate writes into the bind-mounted worktree (the JUnit report) must stay owned by the
        // orchestrator user, or the next attempt cannot remove them (EACCES on the first live run).
        user: containerUser(this.deps.cfg.docker.rootless),
        bindRewrite: this.deps.cfg.docker.bindRewrite,
      };
      const deps = { exec: this.deps.exec, executor: this.deps.gateExecutor, readFile: (p: string) => fs.readFile(p, 'utf8').catch(() => null), removeFile: (p: string) => fs.rm(p, { force: true }) };
      if (!plan.testServices?.length) return runGates(gates, ctx, deps);
      // A service that fails to start fails the gate as infrastructure, with its message only (no values).
      return withTestServices(plan.testServices, ctx.containerName, { exec: this.deps.exec }, (services) =>
        runGates(
          gates.map((g) => (g.name === TEST_GATE ? { ...g, secrets: [...g.secrets, ...services.urlNames] } : g)),
          { ...ctx, testNetwork: services.network, secrets: { ...ctx.secrets, ...services.secrets } },
          deps,
        ),
      ).catch((err: Error) => {
        const failure: GateResult = { name: TEST_GATE, blocking: true, passed: false, exitCode: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: err.message, junit: null, failure: 'infra' };
        return { results: [failure], blockingFailure: failure };
      });
    };
  }

  private mergeDeps(view: ServiceView | null): MergeStepsDeps {
    return { journal: this.journal, ws: view ? this.wsOf(view) : this.deps.ws, exec: this.deps.exec, ghExec: this.deps.ghExec, gates: view ? this.gatesFor(view) : NO_GATES, graphify: this.deps.graphify, mergedGraph: () => this.mergedGraph(), secretValues: () => this.secretValues(), handoffs: this.handoffs, clock: this.clock, docs: this.deps.docs };
  }

  private packBase = (): PackBase => ({
    spec: this.deps.spec,
    project: this.deps.project,
    specHash: this.deps.spec.specHash!,
    assumptions: withRepairNotes(this.deps.repairNotes, [...ownerDecisionLines(this.deps.ownerDecisions ?? [], this.deps.spec.specHash!), ...this.journal.assumptions()]),
    adrs: this.adrs,
    techSpecExcerpt: this.techSpecText.slice(0, 6000),
    retrieval: this.deps.knowledge?.search(this.deps.spec.objectives.join(' '), { k: 5, specId: this.deps.spec.specId }) ?? [],
    budgetTokens: 12_000,
    planFile: this.deps.planFile,
    taskFile: this.deps.taskFile,
    docsRoot: this.deps.docs?.snapshot,
  });

  private codeFor(view: ServiceView) {
    return async (worktree: string, task: PlanTask): Promise<CodeContext> => {
      const g = this.deps.graphify;
      const ws = this.wsOf(view);
      const terms = [task.title, ...task.affectedPaths].map((t) => t.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 2)).flat().slice(0, 6);
      if (g) {
        const tracked = await withRepoLock(ws.repo, () => g.trackedFiles(ws.repo)).catch(() => [] as string[]);
        const cov = await g.coverage(graphDir(ws, null), tracked).catch(() => null);
        if (cov && cov.ratio >= MIN_COVERAGE) {
          const q = await g.query(graphDir(ws, null), codeQuestionOf(task), 2000);
          // A graphify that failed answers nothing; the step reads the code with grep and the journal says it was grep.
          if (q.failed === undefined) return { source: 'graph', nodes: q.nodes, truncated: q.truncated, graphFile: graphFile(graphDir(ws, null)) };
        }
      }
      return { source: 'grep', grep: await grepFallback(worktree, terms, this.deps.exec) };
    };
  }

  private impactFor(view: ServiceView) {
    return async (worktree: string, branch: string, changed: readonly string[], depth: number): Promise<CodeContext> => {
      const g = this.deps.graphify;
      if (!g || changed.length === 0) return { source: 'none' };
      const out = graphDir(this.wsOf(view), branch);
      await g.update(worktree, out).catch(() => undefined);
      const affected = (await Promise.all(changed.map((f) => g.affected(out, f, depth).catch(() => [])))).flat();
      return { source: 'graph', affected, graphFile: graphFile(out) };
    };
  }

  private system1?: Decider;

  /** One decider per run: task steps and the runner's CLI error classification (decision 8) share its journal. */
  private decider(): Decider {
    const { cfg, project, spec, secrets } = this.deps;
    return (this.system1 ??= createDecider({
      cfg,
      secrets,
      accounting: this.accounting,
      specHash: spec.specHash!,
      runEscalation: async ({ role, prompt }) => {
        // A Claude escalation is a claude process like any other step: governed and breaker-observed (spec §7).
        const profile = cfg.roles[role];
        const release = await this.governor.acquire();
        try {
          // Inside the governor slot, so the snapshot lives only while the step runs; it keeps afterMerge off the agent's tree.
          const out = await withMainSnapshot(this.deps.ws, this.deps.exec, async (cwd) => (await this.deps.runStep<'decide'>({ kind: 'decide', role, agent: this.deps.agents[role], profile, model: profile.model, cwd, prompt, expectedSpecHash: spec.specHash!, phase: 'decide', taskId: null, attempt: 0 }, this.stepDeps())) as StepOutcome<DecideOutput>);
          this.breaker.observe(out.summary.rateLimit);
          if (!out.ok && out.failure === 'quota') this.breaker.onQuotaFailure(out.summary.rateLimit);
          return out;
        } finally {
          release();
        }
      },
      fetch: this.deps.fetch,
      onDecision: (record) => {
        this.journal.fact(OrchEvent.DecisionMade, { record: JSON.parse(JSON.stringify(record)) }).catch((err: Error) => this.log(`decision not journaled: ${err.message}`));
      },
    }));
  }

  private runnerDeps(view: ServiceView): TaskRunnerDeps {
    const { cfg, project, spec } = this.deps;
    const decider = this.decider();
    const ws = this.wsOf(view);
    return {
      journal: this.journal, ws, spec, project, plan: view.plan, specHash: spec.specHash!, firstSpec: this.firstSpecOf(view), docs: this.deps.docs,
      exec: this.deps.exec,
      testDatabaseUrl: this.testDatabaseUrl,
      runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => runAgentStep(req, this.agentDeps(view)),
      gates: this.gatesFor(view),
      installDeps: (worktree) => this.installDeps(view, worktree),
      installTool: (worktree, command) => this.installInGate(view, worktree, command),
      mergeQueue: this.mergeQueue,
      mergeSteps: (task, worktree, branch) => taskMergeSteps(this.mergeDeps(view), task, worktree, branch, spec, this.summaryOf(task.id)),
      code: this.codeFor(view),
      impact: this.impactFor(view),
      decider,
      tierModel: (_role, tier) => cfg.decisions.modelTiers[tier],
      routing: cfg.routing,
      agentSetting: async (role) => (await this.manualSettings())[role],
      autonomous: () => this.autonomous(),
      policy: { ...DEFAULT_POLICY, ...cfg.retry },
      spentTokens: (taskId) => this.accounting.tokensOf(this.accounting.total({ taskId })),
      priorGateFixes: this.priorGateFixes,
      packBase: view.service ? () => ({ ...this.packBase(), service: { name: view.service!, plan: this.effective(view.plan, view.service), addresses: Object.fromEntries(Object.entries(this.addresses).filter(([s]) => s !== view.service)), design: this.design } }) : this.packBase,
      deliveredBefore: this.deliveredBefore,
      skillsRoot: expandHome('~/.teams-ai/skills'),
      skillExec: execCommand,
      handoffs: () => this.handoffs,
      boundaries: async () => {
        const g = this.deps.graphify;
        if (g) {
          const nodes = await g.godNodes(graphDir(ws, null), 10).catch(() => []);
          if (nodes.length > 0) return nodes.map((n) => n.label);
        }
        return (await this.gitLocked(['ls-tree', '--name-only', 'origin/main'], ws)).split('\n').filter((l) => l !== '');
      },
    };
  }

  private summaryOf(taskId: string): string {
    const e = [...this.journal.events].reverse().find((ev) => ev.type === OrchEvent.DevCommitted && ev.data.taskId === taskId);
    return e ? String(e.data.summary) : taskId;
  }

  private phaseDeps(): PhaseDeps {
    const single = singlePlan(this.plan);
    return {
      journal: this.journal, ws: this.deps.ws, docsRepo: this.deps.docsRepo, artifactsDir: path.join(runDir(this.deps.ws, this.runId), 'artifacts'), workspacesRoot: expandHome(this.deps.cfg.paths.workspaces), spec: this.deps.spec, project: this.deps.project, specHash: this.deps.spec.specHash!, firstSpec: this.deps.firstSpec, requireDelivery: this.deps.requireDelivery, requireSecurityTooling: this.deps.requireSecurityTooling, requireE2e: this.deps.requireE2e, requireCoverage: this.deps.requireCoverage, requireFrozenScope: this.deps.requireFrozenScope, exec: this.deps.exec,
      runAgent: this.runAgent,
      generatedSecretNames: this.deps.cfg.environment.generatedSecrets,
      serviceHasCode: async (service) => !(await holdsOnlyDocs(serviceWorkspace(this.deps.ws, service).repo, this.deps.exec)),
      environment: this.environment(),
      provisionDatabase: (needed) => this.provisionDatabase(needed),
      decider: this.decider(),
      mergeQueue: this.mergeQueue,
      mergeDeps: this.mergeDeps(null),
      packBase: this.packBase,
      // The central modules of the whole project when its graph exists (every service), else of the project repository.
      godNodes: async () => {
        const g = this.deps.graphify;
        if (!g) return [];
        const project = await g.godNodes(path.posix.join(this.deps.ws.graph, 'project'), 10).catch(() => []);
        return project.length > 0 ? project : g.godNodes(graphDir(this.deps.ws, null), 10).catch(() => []);
      },
      pause: (failure) => this.pauseFor(failure),
      plan: single,
      gates: single ? this.gatesFor({ service: null, plan: single }) : undefined,
      tasks: () => [...this.journal.state.tasks.values()],
      boundaries: async () => (this.deps.graphify ? (await this.deps.graphify.godNodes(graphDir(this.deps.ws, null), 10).catch(() => [])).map((n) => n.label) : []),
      target: this.deps.target,
      smoke: async (contextDir, url, gateUrl, gateNetwork, scope) => {
        const p = this.effective(scope?.plan ?? singlePlan(this.plan)!, scope?.service ?? null);
        const r = await runSmoke(p, scope?.spec ?? this.deps.spec, { worktree: contextDir, image: await this.gateImageOf(p), junitPath: p.junitPath, cpus: 2, memory: '2g', timeoutMs: 15 * 60_000, secrets: gateSecrets(this.deps.spec, this.deps.secrets, this.environmentNames()), containerName: `teams-ai-${this.runId}-smoke${scope ? `-${scope.service}` : ''}`, user: containerUser(this.deps.cfg.docker.rootless), bindRewrite: this.deps.cfg.docker.bindRewrite, ...(gateNetwork ? { network: gateNetwork } : {}) }, gateNetwork ? gateUrl ?? url : gateReachableUrl(url), { exec: this.deps.exec, executor: this.deps.gateExecutor, readFile: (f) => fs.readFile(f, 'utf8').catch(() => null), removeFile: (f) => fs.rm(f, { force: true }) }, scope?.urls);
        // The gate's output is the only clue the fix task gets about why a smoke test is missing or failing.
        const tail = r.ok || !r.result ? '' : `\n\nsmoke gate (exit ${r.result.exitCode ?? 'null'}) stderr:\n${r.result.stderrTail}\nstdout:\n${r.result.stdoutTail}`;
        return { ok: r.ok, rows: r.rows, detail: `${r.detail}${tail}` };
      },
      e2e: async (contextDir, url, gateUrl, gateNetwork, scope) => {
        const p = this.effective(scope?.plan ?? singlePlan(this.plan)!, scope?.service ?? null);
        const r = await runE2e(p, scope?.spec ?? this.deps.spec, { worktree: contextDir, image: await this.gateImageOf(p, p.deploy.kind === 'front'), junitPath: p.junitPath, cpus: 2, memory: '2g', timeoutMs: 15 * 60_000, secrets: gateSecrets(this.deps.spec, this.deps.secrets, this.environmentNames()), containerName: `teams-ai-${this.runId}-e2e${scope ? `-${scope.service}` : ''}`, user: containerUser(this.deps.cfg.docker.rootless), bindRewrite: this.deps.cfg.docker.bindRewrite, ...(gateNetwork ? { network: gateNetwork } : {}) }, gateNetwork ? gateUrl ?? url : url, { exec: this.deps.exec, executor: this.deps.gateExecutor, readFile: (f) => fs.readFile(f, 'utf8').catch(() => null), removeFile: (f) => fs.rm(f, { force: true }) }, scope?.urls);
        const tail = r.ok || !r.result ? '' : `\n\ne2e gate (exit ${r.result.exitCode ?? 'null'}) stderr:\n${r.result.stderrTail}\nstdout:\n${r.result.stdoutTail}`;
        return { ok: r.ok, rows: r.rows, detail: `${r.detail}${tail}` };
      },
      ...(this.plan && 'services' in this.plan ? { services: { plan: this.plan, repos: servicePlans(this.plan).map((view) => ({ ...view, ws: this.wsOf(view), firstSpec: this.firstSpecOf(view), gates: this.gatesFor(view) })) } } : {}),
    };
  }

  /** Spec §7: a quota failure pauses the whole run until the breaker reopens; auth needs a human. */
  private async pauseFor(failure: 'quota' | 'auth'): Promise<'resumed' | 'auth'> {
    if (failure === 'auth') {
      if (this.journal.state.status === 'running') await this.journal.fact(RunEvent.RunPaused, { reason: 'auth' });
      // The process exits next; the run list reads the pause from the state file.
      await this.writeState();
      return 'auth';
    }
    await this.waitWhilePaused();
    return 'resumed';
  }

  private pauseUntil(): string {
    const b = this.breaker.state();
    return (b.status === 'paused' ? b.until : new Date(this.clock().getTime() + 60_000)).toISOString();
  }

  private async waitWhilePaused(): Promise<void> {
    while (!this.breaker.canStart()) {
      if (this.journal.state.status === 'running') await this.journal.fact(RunEvent.RunPaused, { reason: 'quota', until: this.pauseUntil() });
      const b = this.breaker.state();
      const wait = b.status === 'paused' ? Math.max(1000, b.until.getTime() - this.clock().getTime()) : 60_000;
      this.log(`run paused (quota) for ${Math.round(wait / 1000)}s`);
      await this.sleep(wait);
      this.breaker.tick();
    }
    if (this.journal.state.status === 'paused:quota') await this.journal.fact(RunEvent.RunResumed, {});
  }

  /**
   * A git command on the main repo, queued behind every other locked operation on it: afterMerge's checkout and
   * reset --hard rewrite its index and work tree while other tasks read it. gitFetch and removeWorktree take the
   * (non-reentrant) lock themselves, so those are called bare, never through here.
   */
  private gitLocked(args: readonly string[], ws: Workspace = this.deps.ws): Promise<string> {
    return withRepoLock(ws.repo, () => git(ws.repo, args, this.deps.exec));
  }

  private async loadAdrs(): Promise<void> {
    if (this.deps.docsRepo) return; // A documentation repository keeps no ADRs.
    const list = await this.gitLocked(['ls-tree', '--name-only', 'origin/main', 'docs/adr/']).catch(() => '');
    // Filled aside and swapped in whole, so a step building its pack meanwhile never reads a partial list.
    const adrs: typeof this.adrs = [];
    for (const rel of list.split('\n').filter((l) => l.endsWith('.md'))) {
      const text = await this.gitLocked(['show', `origin/main:${rel}`]).catch(() => '');
      const id = /ADR-\d{3}/.exec(rel)?.[0] ?? rel;
      adrs.push({ id, title: text.split('\n')[0]?.replace(/^#\s*/, '') ?? id, text: text.slice(0, 4000) });
    }
    this.adrs = adrs;
  }

  /** The origin/main commit the ADRs and the design doc were last read from. */
  private sharedDocsAt: string | null = null;

  /** Reads the ADRs and the design doc again when the project's main moved, so a step never gets the copy from the run's start. */
  private async loadSharedDocs(): Promise<void> {
    // A failed fetch keeps the last copy: the run goes on without it.
    await gitFetch(this.deps.ws.repo, this.deps.exec).catch(() => undefined);
    const head = await this.gitLocked(['rev-parse', 'origin/main']).catch(() => '');
    if (head === this.sharedDocsAt) return;
    this.sharedDocsAt = head;
    await this.loadAdrs();
    const design = this.deps.docs ? await snapshotDesign(this.deps.docs.snapshot) : await this.gitLocked(['show', 'origin/main:docs/design.md']).catch(() => null);
    this.design = design?.slice(0, 6000) ?? null;
  }

  /** What a step in a service's repository cannot read there: where every service answers. */
  private async loadServiceContext(plan: AnyPlan): Promise<void> {
    if (singlePlan(plan)) return;
    const registry = await registeredPorts(expandHome(this.deps.cfg.paths.workspaces));
    const planned = new Map(servicePlans(plan).map((v) => [v.service!, v.plan.deploy.port]));
    this.addresses = Object.fromEntries((this.deps.project.services ?? []).flatMap((s) => {
      const port = registry[portKey(this.deps.project.projectId, s)] ?? planned.get(s);
      return port ? [[s, `http://${s}:${port}`]] : [];
    }));
  }

  /** Phase 0: the docs reach main (a draft) or are fetched, then every service gets its repository; public so tests can drive it without scripting Phases 1–3. */
  async executePhase0(): Promise<PhaseResult> {
    // Phases 1 and 2 read the docs from origin/main; a later run must see what was merged since the last one.
    const docs = this.deps.bootstrap ? await runPhase0({ ...this.phaseDeps(), ghExec: this.deps.ghExec }, { ...this.deps.bootstrap, docs: this.deps.docs }) : await gitFetch(this.deps.ws.repo, this.deps.exec).then((): PhaseResult => ({ ok: true }));
    if (!docs.ok) return docs;
    return ensureServiceRepos({ ...this.phaseDeps(), ghExec: this.deps.ghExec }, this.deps.bootstrap?.owner ?? this.deps.project.github.owner ?? this.deps.cfg.github.owner, this.deps.bootstrap?.docsDir);
  }

  /** R8.3: CI and release workflows land on main of a bootstrapped repository, and of every new service's; public for tests. */
  async executeWorkflows(plan: AnyPlan): Promise<PhaseResult> {
    const single = singlePlan(plan);
    if (single) return this.deps.bootstrap ? runWorkflowBootstrap(this.phaseDeps(), single) : { ok: true };
    for (const view of servicePlans(plan).filter((v) => this.firstSpecOf(v))) {
      const r = await runWorkflowBootstrap({ ...this.phaseDeps(), ws: this.wsOf(view), service: view.service!, mergeDeps: this.mergeDeps(view) }, view.plan);
      if (!r.ok) return { ...r, reason: `service ${view.service}: ${r.reason}` };
    }
    return { ok: true };
  }

  /** A run that failed in phase 6 writes its report again: phases 0 to 5 already passed, and the journal says so. */
  private async resumePhase6(result: 'awaiting-validation'): Promise<ExecuteResult> {
    const events = this.journal.events;
    if (events.findLastIndex((e) => e.type === OrchEvent.RunFinished) > events.findLastIndex((e) => e.type === RunEvent.RunReopened)) await this.journal.fact(RunEvent.RunReopened, { manual: true });
    const plan = await this.loadPlan();
    if (plan === null) return this.finish('phase-failed', 'the plan is not on main, so phase 6 has nothing to report');
    this.plan = plan;
    await this.loadServiceContext(plan);
    const p6 = await runPhase6({ ...this.phaseDeps(), runId: this.runId, accounting: this.accounting, result });
    if (!p6.ok && p6.reason === PAUSED_AUTH) return 'paused:auth';
    if (!p6.ok) return this.finish('phase-failed', p6.reason);
    return this.finish(result);
  }

  async execute(): Promise<ExecuteResult> {
    const resumed = phase6Resume(this.journal.events);
    if (resumed !== null) return this.resumePhase6(resumed);
    const phase0 = await this.executePhase0();
    if (!phase0.ok) return phase0.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase0.reason);
    // A project with no graph yet gets one now, so the first task already has code context; a slow or failed build never stops the run.
    if (this.deps.graphify) await ensureProjectGraph(this.deps.graphify, this.located(), { log: this.deps.log });
    // A docs-repo project has no technical spec: its plan is the technical specification, so Phase 1 does not run.
    if (!this.deps.docsRepo) {
      const phase1 = await runPhase1(this.phaseDeps());
      if (!phase1.ok) return phase1.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase1.reason);
      this.techSpecText = phase1.techSpecText ?? '';
    }
    await this.loadSharedDocs();
    const phase2 = await runPhase2(this.phaseDeps(), this.techSpecText);
    if (!phase2.ok) return phase2.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase2.reason);
    this.plan = phase2.plan!;
    await this.loadServiceContext(this.plan);
    const workflows = await this.executeWorkflows(this.plan);
    if (!workflows.ok) return this.finish('phase-failed', workflows.reason);
    if (!this.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 3)) await this.journal.fact(OrchEvent.PhaseStarted, { phase: 3 });
    await this.startTestDatabase();
    // R11.4 retry: a fresh run's journal starts every task 'planned'; one an earlier run of this same version delivered with the
    // same definition is adopted as 'merged' straight away instead of redone (Phase 4 still proves it from the current repo's JUnit).
    const inherited = await mergedByPriorRuns(this.deps.ws, this.deps.spec.specId, this.runId, this.plan.tasks, this.deps.spec.specHash!);
    this.deliveredBefore = await deliveredByPriorRuns(this.deps.ws, this.deps.spec.specId, this.runId);
    for (const task of this.plan.tasks) {
      const t = this.journal.state.tasks.get(task.id);
      if (t && t.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: task.id, to: inherited.has(task.id) ? 'merged' : 'ready' });
    }
    const phase3 = await this.loop({ final: false });
    if (phase3 !== 'complete') return phase3;
    // A blocked task leaves the work unbuilt: the run ends here, before the review, verification and deploy.
    const scaffold = this.plan.tasks.find((t) => t.id === scaffoldId(t.service ?? null) && this.journal.state.tasks.get(t.id)?.state === 'blocked');
    if (scaffold || [...this.journal.state.tasks.values()].some((t) => t.state === 'blocked')) {
      return this.finish('blocked', scaffold ? `${scaffold.id} is blocked and every other task of its repository depends on it` : undefined);
    }
    const review = await this.convergePlans();
    if (review !== 'done') return review;
    // Unit harnesses without a deployment target exercise Phases 0–3 only; production deps always provide one.
    if (!this.deps.target) return this.finish('complete');
    return this.postPhases();
  }

  /** The review of the merged code against the plan after the build: round one builds the gaps it finds, then round two reviews again. */
  private async convergePlans(): Promise<ExecuteResult | 'done'> {
    for (const round of [1, 2] as const) {
      const r = await runPlanReview(this.phaseDeps(), round);
      if (r.kind === 'paused') return 'paused:auth';
      if (r.kind === 'failed') return this.finish('phase-failed', r.reason);
      if (r.kind === 'done') return 'done';
      // The second round is the verdict: gaps it still finds are journaled and the verification runs as usual.
      if (round === 2) {
        await this.journal.fact(OrchEvent.SpecKitGap, { gaps: r.gaps });
        return 'done';
      }
      const gaps = await planGapTasks(this.phaseDeps(), round, r.gaps);
      if (gaps.kind === 'paused') return 'paused:auth';
      if (gaps.kind === 'failed') return this.finish('phase-failed', gaps.reason);
      const back = await this.runFixTasks(gaps.tasks);
      if (back === 'blocked') return this.finish('blocked');
      if (back !== 'merged') return back;
    }
    return 'done';
  }

  /** Fix tasks join the run ready to build; a blocked or merged outcome leaves the next verification to decide. */
  private async runFixTasks(tasks: PlanTask[]): Promise<ExecuteResult | 'merged'> {
    for (const t of tasks) if (this.journal.state.tasks.get(t.id)?.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: t.id, to: 'ready' });
    const r = await this.loop({ final: false });
    if (r !== 'complete') return r; // loop() already journaled RUN_FINISHED for a non-complete outcome
    return fixTasksOutcome(this.journal.state);
  }

  /** Spec (run API) §5: a signal drains — in-flight steps finish, nothing new starts. Idempotent. */
  async requestStop(): Promise<void> {
    if (this.journal.state.status === 'draining') return;
    await this.journal.fact(RunEvent.RunStopRequested, {});
  }

  async completeSpec(): Promise<ExecuteResult> {
    if (this.deps.spec.status !== 'awaiting-validation') return this.finish('phase-failed', `spec ${this.deps.spec.specId} is ${this.deps.spec.status}; only awaiting-validation specs complete`);
    if (this.deps.docsRepo) {
      await updateState(this.deps.ws, `specs/${this.deps.spec.specId}/spec.json`, (current) => `${JSON.stringify({ ...(current as object), status: 'done' }, null, 2)}\n`);
      return this.finish('done');
    }
    const branch = `docs/${this.deps.spec.specId}-done`;
    const wt = await (await import('./phases/shared.js')).docsWorktree(this.phaseDeps(), branch);
    const file = path.join(wt, 'docs', 'specs', this.deps.spec.specId, 'spec.json');
    const current = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(file, `${JSON.stringify({ ...current, status: 'done' }, null, 2)}\n`);
    const merged = await (await import('./phases/shared.js')).commitAndMergeDocs(this.phaseDeps(), 6, branch, wt, `docs(${this.deps.spec.specId}): done`);
    if (!merged.ok) return this.finish('phase-failed', merged.reason);
    return this.finish('done');
  }

  /** `spec readme`: the docs step writes the docs tree from what main carries; the files land through a docs PR. */
  async writeReadme(): Promise<ExecuteResult> {
    const plan = await this.loadPlan();
    if (plan === null) return this.finish('phase-failed', 'the plan is not on main, so there is nothing to document');
    this.plan = plan;
    await this.loadServiceContext(plan);
    const docs = await this.docsPhases();
    if (!docs.ok && docs.reason === PAUSED_AUTH) return 'paused:auth';
    return docs.ok ? this.finish('done') : this.finish('phase-failed', docs.reason);
  }

  /** `spec deploy`: one Phase 5 attempt of the plan on main to this run's target; no agent runs, a failure is only reported. */
  async deployOnly(): Promise<ExecuteResult> {
    if (!this.deps.target) return this.finish('phase-failed', 'no deployment target');
    const specId = this.deps.spec.specId;
    await gitFetch(this.deps.ws.repo, this.deps.exec);
    const plan = this.deps.docsRepo ? await readState(this.deps.ws, `specs/${specId}/plan.json`) : await this.gitLocked(['show', `origin/main:docs/specs/${specId}/plan.json`]).then((text) => JSON.parse(text) as unknown, () => undefined);
    if (plan === undefined) return this.finish('phase-failed', `main has no docs/specs/${specId}/plan.json`);
    this.plan = parseAnyPlan(plan);
    // A fresh clone (an import) has no installed test dependencies, and smoke and e2e run from them.
    for (const view of servicePlans(this.plan)) {
      const install = await this.installInGate(view);
      if (install) return this.finish('deploy-failed', `install failed: ${install.stderrTail || install.stdoutTail}`);
    }
    const p5 = await this.phase5(1, { fixTasks: false });
    return p5.ok ? this.finish('done') : this.finish('deploy-failed', p5.reason);
  }

  /** One deploy attempt, holding the main checkout still: it builds from it, and another spec's merge would reset it. */
  // ponytail: holds the project repo only; a services project's service repos are not held, lock each if they run in parallel.
  private async phase5(attempt: 1 | 2 | 3, opts?: { fixTasks?: boolean }) {
    const once = (envRerun: number) => withCheckoutLock(this.deps.ws.repo, () => (singlePlan(this.plan) ? runPhase5(this.phaseDeps(), attempt, { ...opts, envRerun }) : runServicesPhase5(this.phaseDeps(), attempt, { ...opts, envRerun })));
    let result = await once(0);
    // The environment step created what the failure said was missing: the same attempt runs again, no fix task and no attempt spent.
    for (let n = 1; !result.ok && result.retryEnvironment && n <= MAX_ENV_RERUNS; n++) result = await once(n);
    return result;
  }

  /** Phase 8: each repository this spec changed gets its docs pull request, written from the code on its main. */
  private async docsPhases(): Promise<PhaseResult> {
    for (const view of servicePlans(this.plan!)) {
      const r = await runDocsPhase({ ...this.phaseDeps(), plan: view.plan, ws: this.wsOf(view), service: view.service ?? undefined, mergeDeps: this.mergeDeps(view) }, view);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  private async postPhases(): Promise<ExecuteResult> {
    let result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed' = 'awaiting-validation';
    let reason: string | undefined;
    let p4 = await runPhase4(this.phaseDeps(), 1);
    if (!p4.ok && p4.reason === PAUSED_AUTH) return 'paused:auth';
    if (!p4.ok && p4.fixTasks) {
      const back = await this.runFixTasks(p4.fixTasks);
      // A blocked fix task leaves the work unbuilt: no second verification round and no deploy for it.
      if (back === 'blocked') return this.finish('blocked');
      if (back !== 'merged') return back;
      p4 = await runPhase4(this.phaseDeps(), 2);
    }
    if (!p4.ok) { result = 'verification-failed'; reason = p4.reason; }
    if (p4.ok && this.deps.target) {
      for (let attempt = deployStartAttempt(this.phaseDeps()); attempt <= MAX_DEPLOY_ATTEMPTS; attempt = (attempt + 1) as 1 | 2 | 3) {
        const p5 = await this.phase5(attempt);
        if (p5.ok) break;
        if (!p5.fixTask) { result = 'deploy-failed'; reason = p5.reason; break; }
        // A drain, a deadlock or a login pause already ended the run inside the loop; a blocked fix task ends it blocked.
        const back = await this.runFixTasks([p5.fixTask]);
        if (back === 'blocked') return this.finish('blocked');
        if (back !== 'merged') return back;
      }
    }
    // Phase 8 documents the code on main, so it runs whenever verification passed, whether the deploy did or not.
    if (p4.ok) {
      const docs = await this.docsPhases();
      if (!docs.ok && docs.reason === PAUSED_AUTH) return 'paused:auth';
      if (!docs.ok) return this.finish('phase-failed', docs.reason);
    }
    const p6 = await runPhase6({ ...this.phaseDeps(), runId: this.runId, accounting: this.accounting, result });
    if (!p6.ok && p6.reason === PAUSED_AUTH) return 'paused:auth';
    if (!p6.ok) return this.finish('phase-failed', p6.reason);
    return this.finish(result, reason);
  }

  private async loop(opts: { final: boolean } = { final: true }): Promise<ExecuteResult> {
    const { cfg } = this.deps;
    for (;;) {
      // Every task step starts from an iteration, so each one sees the shared docs main holds now.
      await this.loadSharedDocs();
      const state = this.journal.state;
      if (state.status === 'paused:auth') {
        await Promise.allSettled(this.inflight.values());
        return 'paused:auth';
      }
      if (!this.breaker.canStart()) {
        if (state.status === 'running') await this.journal.fact(RunEvent.RunPaused, { reason: 'quota', until: this.pauseUntil() });
        const b = this.breaker.state();
        const wait = b.status === 'paused' ? Math.max(1000, b.until.getTime() - this.clock().getTime()) : 60_000;
        this.log(`run paused (quota) for ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
        this.breaker.tick();
        continue;
      }
      if (state.status === 'paused:quota') await this.journal.fact(RunEvent.RunResumed, {});
      const runTokens = this.accounting.tokensOf(this.accounting.total());
      if (state.status === 'running' && runTokens > cfg.budgets.perRunTokens) {
        if (!cfg.budgets.observeOnly) await this.journal.fact(RunEvent.RunBudgetExhausted, { tokens: runTokens, cap: cfg.budgets.perRunTokens });
        // Observe mode only records the spent budget, once per run.
        else if (!this.budgetNoted.has(null)) {
          this.budgetNoted.add(null);
          await this.journal.fact(OrchEvent.BudgetExceeded, { taskId: null, tokens: runTokens, cap: cfg.budgets.perRunTokens });
        }
      }
      const runCostUsd = this.accounting.total().costUsd;
      if (runCostUsd > cfg.budgets.perRunCostUsd && !this.costAlerted) {
        this.costAlerted = true;
        await this.journal.fact(OrchEvent.RunCostAlert, { costUsd: runCostUsd, capUsd: cfg.budgets.perRunCostUsd });
      }
      for (const id of tasksToBlock(this.journal.state)) {
        const t = this.journal.state.tasks.get(id)!;
        if (t.state !== 'blocked') {
          await this.journal.fact(RunEvent.TaskStateChanged, { taskId: id, to: 'blocked' });
          await this.journal.fact(OrchEvent.TaskBlocked, { taskId: id, reason: DEPENDENCY_BLOCKED });
        }
      }
      const progress = runProgress(this.journal.state, this.maxParallel);
      if (progress !== 'running' && this.inflight.size === 0) {
        // A non-final loop reports completion and the caller judges any blocked task.
        if (progress === 'complete' && !opts.final) return 'complete';
        return this.finish(progress === 'complete' ? 'complete' : progress);
      }
      if (this.journal.state.status === 'running') {
        for (const id of nextRunnable(withInflightClaimed(this.journal.state, this.inflight.keys()), this.maxParallel)) {
          // Replacements from a replan are born `planned`; the runner only acts from `ready` onward.
          if (this.journal.state.tasks.get(id)!.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: id, to: 'ready' });
          if (!this.runners.has(id)) this.runners.set(id, new TaskRunner(id, this.runnerDeps(this.taskView(id))));
          this.start(id);
        }
      }
      // Draining (spec §7, plan 38): after a stop request only the step already in flight finishes (a budget drain still lets active tasks run to their end). A task that is mid-pipeline (implementing -> validating -> ...)
      // is NOT restarted for its next step, or a STEP_STARTED lands after RUN_STOP_REQUESTED and the stop outlives the API's graceful window.
      // The task stays in its active state in the journal; a resume continues it from there.
      if (this.journal.state.status === 'running' || (this.journal.state.status === 'draining' && !this.journal.state.stopOnly)) {
        // Tasks left active by a previous process (resume) get a runner too; nothing new is admitted here.
        for (const [id, t] of this.journal.state.tasks) if (ACTIVE_STATES.has(t.state) && !this.runners.has(id)) this.runners.set(id, new TaskRunner(id, this.runnerDeps(this.taskView(id))));
        // A budget drain never starts another Dev attempt: a task sent back to implementing waits for a resume.
        const draining = this.journal.state.status === 'draining';
        for (const [id, r] of this.runners) if (!r.done && !this.inflight.has(id) && ACTIVE_STATES.has(r.task.state) && !(draining && r.task.state === 'implementing')) this.start(id);
      }
      if (this.inflight.size === 0) {
        if (this.journal.state.status === 'draining') return this.finish('drained');
        return this.finish(progress === 'running' ? 'deadlocked' : progress);
      }
      await Promise.race(this.inflight.values());
      await this.writeState();
    }
  }

  private start(id: string): void {
    if (this.inflight.has(id)) return;
    const runner = this.runners.get(id)!;
    const p = runner
      .advance()
      .then(async () => {
        const { perTaskTokens, perTaskCostUsd, observeOnly } = this.deps.cfg.budgets;
        const spent = this.accounting.total({ taskId: id });
        const tokens = this.accounting.tokensOf(spent);
        const byCost = perTaskCostUsd !== undefined;
        if ((byCost ? spent.costUsd > perTaskCostUsd : tokens > perTaskTokens) && !runner.done) {
          if (observeOnly) {
            // Observe mode records a task's spent budget once.
            if (this.budgetNoted.has(id)) return;
            this.budgetNoted.add(id);
            await this.journal.fact(OrchEvent.BudgetExceeded, { taskId: id, tokens, cap: perTaskTokens, ...(byCost ? { costUsd: spent.costUsd, capUsd: perTaskCostUsd } : {}) });
          } else if (byCost) await runner.budgetExceeded(spent.costUsd, perTaskCostUsd, 'USD');
          else await runner.budgetExceeded(tokens, perTaskTokens);
        }
      })
      .catch(async (err: Error & { fatal?: boolean }) => {
        // A runner that throws blocks its task with the error; only a fatal error (crash injection) ends the process.
        if (err.fatal === true) throw err;
        this.log(`task ${id} failed with an unexpected error: ${err.message}`);
        if (!runner.done) {
          const unrecorded = (what: string) => (e: Error) => this.log(`${what} not journaled for ${id}: ${e.message}`);
          await this.journal.fact(RunEvent.TaskStateChanged, { taskId: id, to: 'blocked' }).catch(unrecorded('blocked state'));
          await this.journal.fact(OrchEvent.TaskBlocked, { taskId: id, reason: `orchestrator error: ${redactSecrets(err.message, this.secretValues())}` }).catch(unrecorded('block reason'));
        }
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
  }

  private async finish(result: RunProgress | RunResult, reason?: string): Promise<RunResult> {
    const tasks = [...this.journal.state.tasks.values()];
    // "complete" is every task merged; a run that ended with blocked tasks reports `blocked` (spec §4.7).
    const r: RunResult = (result === 'complete' || result === 'awaiting-validation') && tasks.some((t) => t.state === 'blocked') ? 'blocked' : (result as RunResult);
    const blocked = tasks.filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: String([...this.journal.events].reverse().find((e) => e.type === OrchEvent.TaskBlocked && e.data.taskId === t.def.id)?.data.reason ?? reason ?? 'blocked') }));
    await this.journal.fact(OrchEvent.RunFinished, { result: r, reason: reason ?? null, merged: tasks.filter((t) => t.state === 'merged').map((t) => t.def.id), blocked, tokens: this.accounting.total() });
    await this.writeState();
    // The agents read the graph, so it is rebuilt from main when a run ends, whatever the outcome: a blocked or failed run is history the graph should hold too.
    if (this.deps.graphify) refreshProjectGraph(this.deps.graphify, this.located(), this.deps.log);
    return r;
  }

  private async writeState(): Promise<void> {
    const s = this.journal.state;
    const snapshot = { runId: this.runId, at: this.clock().toISOString(), status: s.status, tasks: [...s.tasks.values()].map((t) => ({ id: t.def.id, state: t.state, attempts: t.attempts })), tokens: this.accounting.total() };
    await fs.writeFile(stateFile(this.deps.ws, this.runId), JSON.stringify(snapshot, null, 2));
  }

  /** The platform containers of the deploy; a needed shared PostgreSQL also replaces any older DATABASE_URL, which may name a host that does not exist. */
  private async provisionDatabase(needed: boolean): Promise<readonly PlatformService[]> {
    const shared = sharedDatabase(this.deps.project, needed, this.deps.secrets.POSTGRES_PASSWORD);
    const secretsDir = path.posix.join(this.deps.ws.root, 'secrets');
    if (!shared) {
      // A URL that names a host nobody starts is pointed at the project's own postgres instead of failing every service that reads it.
      const platform = this.deps.project.platform ?? [];
      const url = needed ? await fs.readFile(path.posix.join(secretsDir, 'DATABASE_URL'), 'utf8').then((v) => v.trim(), () => undefined) : undefined;
      const repaired = repairedDatabaseUrl(url, platform);
      if (repaired) {
        await writeSecret(secretsDir, 'DATABASE_URL', repaired);
        this.deps.secrets.DATABASE_URL = repaired;
      }
      return platform;
    }
    await writeSecret(secretsDir, 'DATABASE_URL', shared.url);
    this.deps.secrets.DATABASE_URL = shared.url;
    return shared.project.platform!;
  }

  private testDatabaseUrl: string | null = null;
  private readonly testDatabaseName = () => `teams-ai-${this.runId}-db`;

  /** A spec that names a DATABASE_URL gets a disposable local PostgreSQL for its Dev tasks; a failure to start it leaves the tasks without one. */
  private async startTestDatabase(): Promise<void> {
    if (!needsTestDatabase(this.deps.spec)) return;
    await stopTestDatabase(this.deps.exec, this.testDatabaseName());
    const started = await startTestDatabase(this.deps.exec, { containerName: this.testDatabaseName(), serviceHost: this.deps.cfg.docker.serviceHost, port: await freePort() });
    this.testDatabaseUrl = started.ok ? started.url : null;
  }

  async close(): Promise<void> {
    try {
      if (this.testDatabaseUrl !== null) await stopTestDatabase(this.deps.exec, this.testDatabaseName());
      await this.journal.close();
    } finally {
      this.deps.knowledge?.close();
    }
  }
}
