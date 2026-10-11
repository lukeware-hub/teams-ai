import type { DecideOutput } from '../agents/outputs.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agents/registry.js';
import type { OutputOf, StepKind } from '../agents/outputs.js';
import { Accounting } from '../budget/accounting.js';
import { Governor } from '../budget/governor.js';
import { DEFAULT_BREAKER, QuotaBreaker } from '../budget/quota-breaker.js';
import type { Config, Role } from '../config/config.js';
import { AnyPlan, scaffoldId, servicePlans, type Plan, type PlanTask, type ServiceView } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { createDecider } from '../decide/create-decider.js';
import type { Decider } from '../decide/decider.js';
import { classifyCliError } from '../decide/decisions/cli-error.js';
import { sandboxPolicyViolation } from '../runner/sandbox-policy.js';
import type { Exec } from '../exec/command.js';
import { TOOLS_GATE } from '../validators/security-tooling.js';
import { writeToolsInstaller } from './tools-install.js';
import { prepareGateImage, runGates, TAIL_CHARS, type GateExecutor, type GateResult } from '../exec/gate-runner.js';
import { fetch as gitFetch, git, withRepoLock } from '../git/git.js';
import { MergeQueue } from '../git/merge-queue.js';
import type { CodeContext, HandoffSummary } from '../knowledge/context-pack.js';
import { grepFallback, MIN_COVERAGE, type Graphify } from '../knowledge/graphify.js';
import type { KnowledgeIndex } from '../knowledge/retrieval.js';
import { RunEvent } from '../pipeline/run-state.js';
import { ACTIVE_STATES } from '../pipeline/task-state.js';
import type { RunnerBinary } from '../runner/process-runner.js';
import type { runStep as runStepFn, StepDeps, StepOutcome } from '../runner/step.js';
import { nextRunnable, runProgress, tasksToBlock, type RunProgress } from '../scheduler/scheduler.js';
import { DEFAULT_POLICY } from '../scheduler/retry-policy.js';
import { CrashInjected, Intent, Journal, OrchEvent, type IntentType, type RunResult } from './events.js';
export { CrashInjected };
import { taskMergeSteps, type MergeStepsDeps } from './merge-steps.js';
import { PAUSED_AUTH, ensureServiceRepos, runPhase0, runWorkflowBootstrap, runPhase1, runPhase2, runPhase4, runPhase5, runServicesPhase5, runPhase6, deployStartAttempt, MAX_DEPLOY_ATTEMPTS, type PhaseDeps, type PhaseResult } from './phases/index.js';
import { withMainSnapshot } from './phases/shared.js';
import { reconcile } from './reconcile.js';
import { validateDocs } from '../validators/docs.js';
import { readmePack, runAgentStep, type AgentStepDeps, type AgentStepRequest, type PackBase } from './steps.js';
import { TaskRunner, type TaskRunnerDeps } from './task-runner.js';
import { eventsFile, expandHome, graphDir, mergedByPriorRuns, nextRunId, runDir, serviceWorkspace, sessionDir, stateFile, stepDir, worktreeDir, type Workspace } from './workspace.js';
import type { DeployTarget } from '../deploy/target.js';
import { E2E_GATE, runE2e } from '../exec/e2e.js';
import { gateReachableUrl, runSmoke } from '../exec/smoke.js';
import { copyCargoRoot, stackDomains, stackEnv, stackKind } from '../runner/stacks.js';

export interface RunDeps {
  cfg: Config;
  ws: Workspace;
  project: Project;
  spec: Spec;
  firstSpec: boolean;
  requireDelivery?: boolean;
  requireSecurityTooling?: boolean;
  requireE2e?: boolean;
  requireCoverage?: boolean;
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
  target?: DeployTarget;
  /** Runs gates and smoke; absent means docker over `exec`. */
  gateExecutor?: GateExecutor;
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

function assertApiKey(deps: RunDeps): void {
  if (deps.cfg.claude.auth === 'api-key' && !(deps.secrets.ANTHROPIC_API_KEY ?? '').trim()) {
    throw new Error('claude.auth is "api-key" but the secret ANTHROPIC_API_KEY is not set (store it with the other secrets)');
  }
}

/** A cold Go or Rust build in a fresh worktree is slow, and parallel tasks compile their tools at the same time (live: three Rust installs passed 10 minutes). */
const buildTimeoutMs = (plan: Plan): number => ((['go', 'rust'] as const).includes(stackKind(plan.stack) as 'go') ? 25 * 60_000 : 10 * 60_000);

/** The plan when it has one repository; a services plan is read per service instead. */
const singlePlan = (plan: AnyPlan | null): Plan | undefined => (plan && !('services' in plan) ? plan : undefined);

/** The view a task runs in: its service's, or the whole plan for a task without a service. */
function viewOf(plan: AnyPlan, service: string | undefined): ServiceView {
  const view = servicePlans(plan).find((v) => v.service === (service ?? null));
  if (!view) throw new Error(`the plan has no service ${service}`);
  return view;
}

/** Docs merges run no gates. */
const NO_GATES = async (): Promise<{ results: GateResult[]; blockingFailure: GateResult | null }> => ({ results: [], blockingFailure: null });

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
  private techSpecText = '';
  private adrs: Array<{ id: string; title: string; text: string }> = [];
  private readonly runners = new Map<string, TaskRunner>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly deps: RunDeps;

  private constructor(
    readonly runId: string,
    readonly journal: Journal,
    rawDeps: RunDeps,
  ) {
    this.deps = withApiKeySplit(rawDeps);
    const deps = this.deps;
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? ((l) => process.stderr.write(`${l}\n`));
    this.maxParallel = deps.maxParallel ?? deps.cfg.concurrency.maxParallel;
    this.handoffs = journal.handoffs();
    this.rebuildAccounting();
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
    await journal.fact(OrchEvent.RunStarted, { runId: id, specId: deps.spec.specId, projectId: deps.project.projectId, firstSpec: deps.firstSpec });
    return new Run(id, journal, deps);
  }

  static async resume(deps: RunDeps, runId: string): Promise<Run> {
    Run.assertSandboxPolicy(deps);
    assertApiKey(deps);
    // The UI marks a run whose process died with `pid.gone`; any resume, CLI or UI, ends that state.
    await fs.rm(path.join(runDir(deps.ws, runId), 'pid.gone'), { force: true });
    const journal = await Run.openJournal(deps, runId);
    const run = new Run(runId, journal, deps);
    await reconcile({ journal, ws: deps.ws, exec: deps.exec, ghExec: deps.ghExec, afterMerge: (taskId, branch) => run.afterMergeOnResume(taskId, branch), log: run.log, currentImage: deps.target?.currentImage.bind(deps.target) });
    // `resume` is the human's signal that the login was redone (spec §7 "resume tries again").
    // A hand resume of a stopped run is journaled too: the supervisor reads a stop as intentional only while it is the last lifecycle event.
    if (journal.state.status === 'paused:auth' || journal.state.status === 'draining') await journal.fact(RunEvent.RunResumed, { manual: true });
    await run.writeState();
    return run;
  }

  /** Budgets span the whole run, not one process: replay STEP_STARTED/STEP_FINISHED into the ledger. */
  private rebuildAccounting(): void {
    const started = new Map<string, Record<string, unknown>>();
    for (const e of this.journal.events) {
      if (e.type === OrchEvent.StepStarted) started.set(String(e.data.stepId), e.data);
      if (e.type !== OrchEvent.StepFinished) continue;
      const s = started.get(String(e.data.stepId));
      const usage = e.data.usage as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
      if (!s || !usage) continue;
      this.accounting.record({
        role: s.role as Role,
        phase: e.data.taskId ? 'phase3' : 'phase',
        taskId: (e.data.taskId as string | null) ?? null,
        attempt: Number(e.data.attempt ?? 0),
        stepKind: e.data.kind as StepKind,
        provider: 'claude',
        model: 'unknown',
        usage,
        costUsd: (e.data.costUsd as number | null) ?? null,
        durationMs: Number(e.data.durationMs ?? 0),
        numTurns: Number(e.data.numTurns ?? 0),
        at: e.at,
      });
    }
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

  /** Package registries a step may reach: its task's stack, or every stack of the plan for a step outside a task. */
  private registries(view?: ServiceView): string[] {
    const views = view ? [view] : this.plan ? servicePlans(this.plan) : [];
    const texts = views.length > 0 ? views.map((v) => `${v.plan.stack} ${v.plan.gateImage} ${this.deps.project.stack ?? ''}`) : [this.deps.project.stack ?? ''];
    return [...new Set(texts.flatMap((text) => stackDomains(stackKind(text))))];
  }

  private async loadPlan(): Promise<AnyPlan | null> {
    const { readDocs } = await import('./phases/shared.js');
    return (await readDocs(this.deps.ws.repo, this.deps.spec.specId, this.deps.exec)).plan;
  }

  private stepDeps(view?: ServiceView): StepDeps {
    const { cfg, ws } = this.deps;
    return {
      binary: this.deps.binary,
      caps: cfg.budgets.step,
      accounting: this.accounting,
      claudeJsonPath: this.deps.claudeJsonPath ?? expandHome('~/.claude.json'),
      settingsDir: path.posix.join(runDir(ws, this.runId), 'settings'),
      workspacesRoot: ws.root,
      // The stack's registries let a step install dependencies; cfg.docker.serviceHost is where the orchestrator and the
      // gates already reach a deployed service (server/deploy/docker-local.ts), so a step's own sandbox needs the same
      // route to test against SERVICE_URL itself — never a wider one (no internet host, no datastore port).
      network: { allowedDomains: [...this.registries(view), cfg.docker.serviceHost] },
      sandbox: { enabled: cfg.sandbox.enabled, unsafeNoSandbox: cfg.sandbox.unsafeNoSandbox },
      clock: this.clock,
      // cli-error's chain never reaches Claude, so classifying a failed step cannot start another step.
      ...(cfg.claude.auth === 'api-key' && this.deps.apiKey ? { apiKey: this.deps.apiKey } : {}),
      classifyUnknown: (input) => classifyCliError(input, this.decider(), { confidential: this.deps.project.confidential }),
    };
  }

  private secretValues(): string[] {
    return [...Object.values(this.deps.secrets), ...(this.deps.apiKey ? [this.deps.apiKey] : [])];
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
      stepModel: (kind) => cfg.routing.stepModels[kind],
      secretValues: () => this.secretValues(),
      specHash: this.deps.spec.specHash!,
    };
  }

  private runAgent = <K extends StepKind>(req: AgentStepRequest<K>): Promise<StepOutcome<OutputOf<K>>> => runAgentStep(req, this.agentDeps());

  /**
   * A task worktree starts from origin/main, which never carries installed dependencies, and gates run
   * offline in the gate image. Without this every task lost its first attempt to "tsc: not found" until
   * the Dev thought of running the install itself. Runs the plan's install command in the worktree when
   * the dependency directory is missing; a failure is reported like a blocking gate so the Dev sees it.
   */
  private async installDeps(view: ServiceView, worktree: string): Promise<GateResult | null> {
    const command = view.plan.commands.install;
    if (!command) return null;
    const present = await fs.access(path.join(worktree, 'node_modules')).then(() => true, () => false);
    if (present) return null;
    const started = Date.now();
    // Tools that `cargo install` put in .tools come from a cache, so they build once, not once per task worktree; the cache is
    // per project, since a project's install command is agent-written and must never plant a binary another project runs.
    const cargoRoot = path.join(expandHome(this.deps.cfg.paths.gateCache), 'cargo-root', this.deps.ws.projectId);
    const tools = path.join(worktree, '.tools');
    const cargoInstall = /\bcargo install\b/.test(command);
    if (cargoInstall) await copyCargoRoot(cargoRoot, tools).catch(() => undefined);
    const env = { ...stackEnv(worktree), CARGO_TARGET_DIR: path.join(expandHome(this.deps.cfg.paths.gateCache), 'cargo-install') };
    const r = await this.deps.exec({ bin: 'sh', args: ['-lc', command], cwd: worktree, env, timeoutMs: buildTimeoutMs(view.plan) });
    if (cargoInstall && r.exitCode === 0 && !r.timedOut) await copyCargoRoot(tools, cargoRoot).catch(() => undefined);
    if (r.exitCode === 0 && !r.timedOut) return null;
    return {
      name: 'install',
      blocking: true,
      passed: false,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      stdoutTail: r.stdout.slice(-TAIL_CHARS),
      stderrTail: r.stderr.slice(-TAIL_CHARS),
      junit: null,
      failure: r.timedOut ? 'infra' : 'code',
    };
  }

  private readonly gateImages = new Map<string, Promise<string>>();

  /** The image every gate, smoke and e2e container of one stack runs, prepared once per run and image (jq, plus rustfmt and clippy for rust). */
  private gateImage(image: string): Promise<string> {
    let ready = this.gateImages.get(image);
    if (!ready) this.gateImages.set(image, (ready = prepareGateImage(image, this.deps.exec)));
    return ready;
  }

  private gatesFor(view: ServiceView) {
    return async (worktree: string, branch: string) => {
      const plan = view.plan;
      const install = await this.installDeps(view, worktree);
      if (install) return { results: [install], blockingFailure: install };
      if (plan.gates.some((g) => g.name === TOOLS_GATE)) await writeToolsInstaller(worktree);
      const cacheDir = expandHome(this.deps.cfg.paths.gateCache);
      // The gate user may differ from the orchestrator's (rootless dind maps it to its own root), so the shared cache is open to all.
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o777 }).then(() => fs.chmod(cacheDir, 0o777)).catch(() => undefined);
      return runGates(
        plan.gates.filter((g) => g.blocking && g.name !== E2E_GATE), // the e2e gate runs in Phase 5 only
        {
          worktree,
          image: await this.gateImage(plan.gateImage),
          junitPath: plan.junitPath,
          coveragePath: plan.coveragePath,
          cacheDir,
          cpus: 2,
          memory: '2g',
          timeoutMs: buildTimeoutMs(plan),
          secrets: this.deps.secrets,
          containerName: `teams-ai-${this.runId}-${branch.replace(/\//g, '__')}`,
          // Files the gate writes into the bind-mounted worktree (the JUnit report) must stay owned by the
          // orchestrator user, or the next attempt cannot remove them (EACCES on the first live run).
          user: containerUser(this.deps.cfg.docker.rootless),
          bindRewrite: this.deps.cfg.docker.bindRewrite,
        },
        { exec: this.deps.exec, executor: this.deps.gateExecutor, readFile: (p) => fs.readFile(p, 'utf8').catch(() => null), removeFile: (p) => fs.rm(p, { force: true }) },
      );
    };
  }

  private mergeDeps(view: ServiceView | null): MergeStepsDeps {
    return { journal: this.journal, ws: view ? this.wsOf(view) : this.deps.ws, exec: this.deps.exec, ghExec: this.deps.ghExec, gates: view ? this.gatesFor(view) : NO_GATES, graphify: this.deps.graphify, secretValues: () => this.secretValues(), handoffs: this.handoffs, clock: this.clock };
  }

  private packBase = (): PackBase => ({
    spec: this.deps.spec,
    project: this.deps.project,
    specHash: this.deps.spec.specHash!,
    assumptions: this.journal.assumptions(),
    adrs: this.adrs,
    techSpecExcerpt: this.techSpecText.slice(0, 6000),
    retrieval: this.deps.knowledge?.search(this.deps.spec.objectives.join(' '), { k: 5, specId: this.deps.spec.specId }) ?? [],
    budgetTokens: 12_000,
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
          const q = await g.query(graphDir(ws, null), `${task.title} ${task.description}`, 2000);
          return { source: 'graph', nodes: q.nodes, truncated: q.truncated };
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
      return { source: 'graph', affected };
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
      journal: this.journal, ws, spec, project, plan: view.plan, specHash: spec.specHash!, firstSpec: this.firstSpecOf(view),
      exec: this.deps.exec,
      runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => runAgentStep(req, this.agentDeps(view)),
      gates: this.gatesFor(view),
      installDeps: (worktree) => this.installDeps(view, worktree),
      mergeQueue: this.mergeQueue,
      mergeSteps: (task, worktree, branch) => taskMergeSteps(this.mergeDeps(view), task, worktree, branch, spec, this.summaryOf(task.id)),
      code: this.codeFor(view),
      impact: this.impactFor(view),
      decider,
      tierModel: (_role, tier) => cfg.decisions.modelTiers[tier],
      routing: cfg.routing,
      policy: { ...DEFAULT_POLICY, ...cfg.retry },
      packBase: this.packBase,
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
      journal: this.journal, ws: this.deps.ws, workspacesRoot: expandHome(this.deps.cfg.paths.workspaces), spec: this.deps.spec, project: this.deps.project, specHash: this.deps.spec.specHash!, firstSpec: this.deps.firstSpec, requireDelivery: this.deps.requireDelivery, requireSecurityTooling: this.deps.requireSecurityTooling, requireE2e: this.deps.requireE2e, requireCoverage: this.deps.requireCoverage, exec: this.deps.exec,
      runAgent: this.runAgent,
      decider: this.decider(),
      mergeQueue: this.mergeQueue,
      mergeDeps: this.mergeDeps(null),
      packBase: this.packBase,
      godNodes: () => (this.deps.graphify ? this.deps.graphify.godNodes(graphDir(this.deps.ws, null), 10).catch(() => []) : Promise.resolve([])),
      pause: (failure) => this.pauseFor(failure),
      plan: single,
      gates: single ? this.gatesFor({ service: null, plan: single }) : undefined,
      tasks: () => [...this.journal.state.tasks.values()],
      boundaries: async () => (this.deps.graphify ? (await this.deps.graphify.godNodes(graphDir(this.deps.ws, null), 10).catch(() => [])).map((n) => n.label) : []),
      target: this.deps.target,
      smoke: async (contextDir, url, gateUrl, gateNetwork, scope) => {
        const p = scope?.plan ?? singlePlan(this.plan)!;
        const r = await runSmoke(p, scope?.spec ?? this.deps.spec, { worktree: contextDir, image: await this.gateImage(p.gateImage), junitPath: p.junitPath, cpus: 2, memory: '2g', timeoutMs: 15 * 60_000, secrets: this.deps.secrets, containerName: `teams-ai-${this.runId}-smoke${scope ? `-${scope.service}` : ''}`, user: containerUser(this.deps.cfg.docker.rootless), bindRewrite: this.deps.cfg.docker.bindRewrite, ...(gateNetwork ? { network: gateNetwork } : {}) }, gateNetwork ? gateUrl ?? url : gateReachableUrl(url), { exec: this.deps.exec, executor: this.deps.gateExecutor, readFile: (f) => fs.readFile(f, 'utf8').catch(() => null), removeFile: (f) => fs.rm(f, { force: true }) }, scope?.urls);
        // The gate's output is the only clue the fix task gets about why a smoke test is missing or failing.
        const tail = r.ok || !r.result ? '' : `\n\nsmoke gate (exit ${r.result.exitCode ?? 'null'}) stderr:\n${r.result.stderrTail}\nstdout:\n${r.result.stdoutTail}`;
        return { ok: r.ok, rows: r.rows, detail: `${r.detail}${tail}` };
      },
      e2e: async (contextDir, url, gateUrl, gateNetwork, scope) => {
        const p = scope?.plan ?? singlePlan(this.plan)!;
        const r = await runE2e(p, scope?.spec ?? this.deps.spec, { worktree: contextDir, image: await this.gateImage(p.gateImage), junitPath: p.junitPath, cpus: 2, memory: '2g', timeoutMs: 15 * 60_000, secrets: this.deps.secrets, containerName: `teams-ai-${this.runId}-e2e${scope ? `-${scope.service}` : ''}`, user: containerUser(this.deps.cfg.docker.rootless), bindRewrite: this.deps.cfg.docker.bindRewrite, ...(gateNetwork ? { network: gateNetwork } : {}) }, gateNetwork ? gateUrl ?? url : url, { exec: this.deps.exec, executor: this.deps.gateExecutor, readFile: (f) => fs.readFile(f, 'utf8').catch(() => null), removeFile: (f) => fs.rm(f, { force: true }) }, scope?.urls);
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
    const list = await this.gitLocked(['ls-tree', '--name-only', 'origin/main', 'docs/adr/']).catch(() => '');
    this.adrs = [];
    for (const rel of list.split('\n').filter((l) => l.endsWith('.md'))) {
      const text = await this.gitLocked(['show', `origin/main:${rel}`]).catch(() => '');
      const id = /ADR-\d{3}/.exec(rel)?.[0] ?? rel;
      this.adrs.push({ id, title: text.split('\n')[0]?.replace(/^#\s*/, '') ?? id, text: text.slice(0, 4000) });
    }
  }

  /** Phase 0: the docs reach main (a draft) or are fetched, then every service gets its repository; public so tests can drive it without scripting Phases 1–3. */
  async executePhase0(): Promise<PhaseResult> {
    // Phases 1 and 2 read the docs from origin/main; a later run must see what was merged since the last one.
    const docs = this.deps.bootstrap ? await runPhase0({ ...this.phaseDeps(), ghExec: this.deps.ghExec }, this.deps.bootstrap) : await gitFetch(this.deps.ws.repo, this.deps.exec).then((): PhaseResult => ({ ok: true }));
    if (!docs.ok) return docs;
    return ensureServiceRepos({ ...this.phaseDeps(), ghExec: this.deps.ghExec }, this.deps.bootstrap?.owner ?? this.deps.project.github.owner ?? this.deps.cfg.github.owner);
  }

  /** R8.3: CI and release workflows land on main of a bootstrapped repository, and of every new service's; public for tests. */
  async executeWorkflows(plan: AnyPlan): Promise<PhaseResult> {
    const single = singlePlan(plan);
    if (single) return this.deps.bootstrap ? runWorkflowBootstrap(this.phaseDeps(), single) : { ok: true };
    for (const view of servicePlans(plan).filter((v) => this.firstSpecOf(v))) {
      const r = await runWorkflowBootstrap({ ...this.phaseDeps(), ws: this.wsOf(view), service: view.service!, mergeDeps: this.mergeDeps(view) }, view.plan);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  async execute(): Promise<ExecuteResult> {
    const phase0 = await this.executePhase0();
    if (!phase0.ok) return phase0.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase0.reason);
    const phase1 = await runPhase1(this.phaseDeps());
    if (!phase1.ok) return phase1.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase1.reason);
    this.techSpecText = phase1.techSpecText ?? '';
    await this.loadAdrs();
    const phase2 = await runPhase2(this.phaseDeps(), this.techSpecText);
    if (!phase2.ok) return phase2.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase2.reason);
    this.plan = phase2.plan!;
    const workflows = await this.executeWorkflows(this.plan);
    if (!workflows.ok) return this.finish('phase-failed', workflows.reason);
    if (!this.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 3)) await this.journal.fact(OrchEvent.PhaseStarted, { phase: 3 });
    // R11.4 retry: a fresh run's journal starts every task 'planned'; one an earlier run of this spec already merged
    // is adopted as 'merged' straight away instead of redone (Phase 4 still proves it from the current repo's JUnit).
    const inherited = await mergedByPriorRuns(this.deps.ws, this.deps.spec.specId, this.runId);
    for (const task of this.plan.tasks) {
      const t = this.journal.state.tasks.get(task.id);
      if (t && t.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: task.id, to: inherited.has(task.id) ? 'merged' : 'ready' });
    }
    const phase3 = await this.loop({ final: false });
    if (phase3 !== 'complete') return phase3;
    // Every task of a new repository depends on its scaffold, fix tasks included: verifying without it only spends tokens.
    const scaffold = this.plan.tasks.find((t) => t.id === scaffoldId(t.service ?? null) && this.journal.state.tasks.get(t.id)?.state === 'blocked');
    if (scaffold) return this.finish('blocked', `${scaffold.id} is blocked and every other task of its repository depends on it`);
    // Unit harnesses without a deployment target exercise Phases 0–3 only; production deps always provide one.
    if (!this.deps.target) return this.finish('complete');
    return this.postPhases();
  }

  /** Spec (run API) §5: a signal drains — in-flight steps finish, nothing new starts. Idempotent. */
  async requestStop(): Promise<void> {
    if (this.journal.state.status === 'draining') return;
    await this.journal.fact(RunEvent.RunStopRequested, {});
  }

  async completeSpec(): Promise<ExecuteResult> {
    if (this.deps.spec.status !== 'awaiting-validation') return this.finish('phase-failed', `spec ${this.deps.spec.specId} is ${this.deps.spec.status}; only awaiting-validation specs complete`);
    const branch = `docs/${this.deps.spec.specId}-done`;
    const wt = await (await import('./phases/shared.js')).docsWorktree(this.phaseDeps(), branch);
    const file = path.join(wt, 'docs', 'specs', this.deps.spec.specId, 'spec.json');
    const current = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(file, `${JSON.stringify({ ...current, status: 'done' }, null, 2)}\n`);
    const merged = await (await import('./phases/shared.js')).commitAndMergeDocs(this.phaseDeps(), 6, branch, wt, `docs(${this.deps.spec.specId}): done`);
    if (!merged.ok) return this.finish('phase-failed', merged.reason);
    return this.finish('done');
  }

  /** `spec readme`: the SM writes docs/README.md from what main carries; the file lands through a docs PR. */
  async writeReadme(): Promise<ExecuteResult> {
    const shared = await import('./phases/shared.js');
    const specId = this.deps.spec.specId;
    const branch = `docs/${specId}-readme`;
    const wt = await shared.docsWorktree(this.phaseDeps(), branch);
    const rel = (...p: string[]) => path.join(wt, ...p);
    this.techSpecText = await fs.readFile(rel('docs', 'specs', specId, 'tech-spec.md'), 'utf8').catch(() => '');
    const plan = await fs.readFile(rel('docs', 'specs', specId, 'plan.json'), 'utf8').then((t) => JSON.parse(t) as Plan).catch(() => null);
    const existing = await fs.readFile(rel('docs', 'README.md'), 'utf8').catch(() => null);
    let readme = '';
    let runbook = '';
    let apiDocs = '';
    let docsErrors: string[] = [];
    let error = 'readme step failed';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const out = (await this.runAgent<'readme'>({ kind: 'readme', role: 'sm', pack: readmePack(this.packBase(), { readmeSections: plan?.delivery?.readmeSections, tasks: (plan?.tasks ?? []).map((t) => `- ${t.id}: ${t.title}`), existing, docsErrors }), cwd: wt, phase: 'readme', taskId: null, attempt })) as { ok: boolean; value?: { readme: string; runbook?: string; apiDocs?: string }; failure?: string; errors?: string[] };
      if (out.ok && out.value) {
        readme = out.value.readme; runbook = out.value.runbook ?? ''; apiDocs = out.value.apiDocs ?? '';
        docsErrors = validateDocs({ readme, runbook, apiDocs }, this.deps.spec.features, plan?.delivery?.readmeSections);
        if (docsErrors.length === 0) break;
        error = `documentation rejected: ${docsErrors.join('; ')}`; readme = ''; continue;
      }
      if (out.failure === 'quota' || out.failure === 'auth') { if (await shared.pauseForFailure(this.phaseDeps(), out.failure)) return 'paused:auth'; continue; }
      error = out.errors?.join('; ') ?? error;
    }
    if (!readme) return this.finish('phase-failed', error);
    await fs.writeFile(rel('docs', 'README.md'), `${readme.trimEnd()}\n`);
    await fs.writeFile(rel('docs', 'RUNBOOK.md'), `${runbook.trimEnd()}\n`);
    if (apiDocs.trim()) await fs.writeFile(rel('docs', 'API.md'), `${apiDocs.trimEnd()}\n`);
    const merged = await shared.commitAndMergeDocs(this.phaseDeps(), 6, branch, wt, `docs(${specId}): README`);
    return merged.ok ? this.finish('done') : this.finish('phase-failed', merged.reason);
  }

  /** `spec deploy`: one Phase 5 attempt of the plan on main to this run's target; no agent runs, a failure is only reported. */
  async deployOnly(): Promise<ExecuteResult> {
    if (!this.deps.target) return this.finish('phase-failed', 'no deployment target');
    const specId = this.deps.spec.specId;
    await gitFetch(this.deps.ws.repo, this.deps.exec);
    const text = await this.gitLocked(['show', `origin/main:docs/specs/${specId}/plan.json`]).catch(() => null);
    if (!text) return this.finish('phase-failed', `main has no docs/specs/${specId}/plan.json`);
    this.plan = AnyPlan.parse(JSON.parse(text));
    const p5 = singlePlan(this.plan) ? await runPhase5(this.phaseDeps(), 1, { fixTasks: false }) : await runServicesPhase5(this.phaseDeps(), 1, { fixTasks: false });
    return p5.ok ? this.finish('done') : this.finish('deploy-failed', p5.reason);
  }

  private async postPhases(): Promise<ExecuteResult> {
    const runFix = async (tasks: PlanTask[]): Promise<ExecuteResult | 'merged'> => {
      for (const t of tasks) if (this.journal.state.tasks.get(t.id)?.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: t.id, to: 'ready' });
      const r = await this.loop({ final: false });
      if (r !== 'complete') return r; // loop() already journaled RUN_FINISHED for a non-complete outcome
      return tasks.every((t) => this.journal.state.tasks.get(t.id)?.state === 'merged') ? 'merged' : 'blocked';
    };
    let result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed' = 'awaiting-validation';
    let reason: string | undefined;
    let p4 = await runPhase4(this.phaseDeps(), 1);
    if (!p4.ok && p4.reason === PAUSED_AUTH) return 'paused:auth';
    if (!p4.ok && p4.fixTasks) {
      const back = await runFix(p4.fixTasks);
      if (back !== 'merged' && back !== 'blocked') return back;
      // Fix tasks are best effort; the second verification round is the verdict. A fix task that blocked
      // (e.g. the SM diagnosed a toolchain problem the Dev found nothing to change for) must not end the
      // run before that round runs (1387253335-001-r13). Its blocked state is still reported by finish().
      p4 = await runPhase4(this.phaseDeps(), 2);
    }
    if (!p4.ok) { result = 'verification-failed'; reason = p4.reason; }
    if (p4.ok && this.deps.target) {
      for (let attempt = deployStartAttempt(this.phaseDeps()); attempt <= MAX_DEPLOY_ATTEMPTS; attempt = (attempt + 1) as 1 | 2 | 3) {
        const p5 = singlePlan(this.plan) ? await runPhase5(this.phaseDeps(), attempt) : await runServicesPhase5(this.phaseDeps(), attempt);
        if (p5.ok) break;
        if (!p5.fixTask) { result = 'deploy-failed'; reason = p5.reason; break; }
        // Same rule as Phase 4: the fix task is best effort and the next deploy attempt is the verdict.
        const back = await runFix([p5.fixTask]); if (back !== 'merged' && back !== 'blocked') { result = 'deploy-failed'; reason = p5.reason; break; }
      }
    }
    const p6 = await runPhase6({ ...this.phaseDeps(), runId: this.runId, accounting: this.accounting, result });
    if (!p6.ok && p6.reason === PAUSED_AUTH) return 'paused:auth';
    if (!p6.ok) return this.finish('phase-failed', p6.reason);
    return this.finish(result, reason);
  }

  private async loop(opts: { final: boolean } = { final: true }): Promise<ExecuteResult> {
    const { cfg } = this.deps;
    for (;;) {
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
      if (state.status === 'running' && !cfg.budgets.observeOnly && this.accounting.tokensOf(this.accounting.total()) > cfg.budgets.perRunTokens) {
        await this.journal.fact(RunEvent.RunBudgetExhausted, {});
      }
      for (const id of tasksToBlock(this.journal.state)) {
        const t = this.journal.state.tasks.get(id)!;
        if (t.state !== 'blocked') {
          await this.journal.fact(RunEvent.TaskStateChanged, { taskId: id, to: 'blocked' });
          await this.journal.fact(OrchEvent.TaskBlocked, { taskId: id, reason: 'a dependency is blocked' });
        }
      }
      const progress = runProgress(this.journal.state, this.maxParallel);
      if (progress !== 'running' && this.inflight.size === 0) {
        // A non-final loop (fix tasks) reports completion and lets the caller judge blocked tasks: a blocked
        // fix task must not end the run before the next verification round or deploy attempt.
        if (progress === 'complete' && !opts.final) return 'complete';
        return this.finish(progress === 'complete' ? 'complete' : progress);
      }
      if (this.journal.state.status === 'running') {
        for (const id of nextRunnable(this.journal.state, this.maxParallel)) {
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
        for (const [id, r] of this.runners) if (!r.done && !this.inflight.has(id) && ACTIVE_STATES.has(r.task.state)) this.start(id);
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
          if (observeOnly) await this.journal.fact(OrchEvent.BudgetExceeded, { taskId: id, tokens, cap: perTaskTokens, ...(byCost ? { costUsd: spent.costUsd, capUsd: perTaskCostUsd } : {}) });
          else if (byCost) await runner.budgetExceeded(spent.costUsd, perTaskCostUsd, 'USD');
          else await runner.budgetExceeded(tokens, perTaskTokens);
        }
      })
      .catch(async (err: Error & { fatal?: boolean }) => {
        // A runner that throws blocks its task with the error; only a fatal error (crash injection) ends the process.
        if (err.fatal === true) throw err;
        this.log(`task ${id} failed with an unexpected error: ${err.message}`);
        if (!runner.done) {
          await this.journal.fact(RunEvent.TaskStateChanged, { taskId: id, to: 'blocked' }).catch(() => undefined);
          await this.journal.fact(OrchEvent.TaskBlocked, { taskId: id, reason: `orchestrator error: ${err.message}` }).catch(() => undefined);
        }
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
  }

  private async finish(result: RunProgress | RunResult, reason?: string): Promise<RunResult> {
    const tasks = [...this.journal.state.tasks.values()];
    // "complete" is every task merged; a run that ended with blocked tasks reports `blocked` (spec §4.7).
    const r: RunResult = result === 'complete' && tasks.some((t) => t.state === 'blocked') ? 'blocked' : (result as RunResult);
    const blocked = tasks.filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: String([...this.journal.events].reverse().find((e) => e.type === OrchEvent.TaskBlocked && e.data.taskId === t.def.id)?.data.reason ?? reason ?? 'blocked') }));
    await this.journal.fact(OrchEvent.RunFinished, { result: r, reason: reason ?? null, merged: tasks.filter((t) => t.state === 'merged').map((t) => t.def.id), blocked, tokens: this.accounting.total() });
    await this.writeState();
    return r;
  }

  private async writeState(): Promise<void> {
    const s = this.journal.state;
    const snapshot = { runId: this.runId, at: this.clock().toISOString(), status: s.status, tasks: [...s.tasks.values()].map((t) => ({ id: t.def.id, state: t.state, attempts: t.attempts })), tokens: this.accounting.total() };
    await fs.writeFile(stateFile(this.deps.ws, this.runId), JSON.stringify(snapshot, null, 2));
  }

  async close(): Promise<void> {
    await this.journal.close();
  }
}
