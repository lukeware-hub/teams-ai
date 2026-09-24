import type { DecideOutput } from '../agents/outputs.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agents/registry.js';
import type { OutputOf, StepKind } from '../agents/outputs.js';
import { Accounting } from '../budget/accounting.js';
import { Governor } from '../budget/governor.js';
import { DEFAULT_BREAKER, QuotaBreaker } from '../budget/quota-breaker.js';
import { resolveProfile, type Config, type Role } from '../config/config.js';
import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { createDecider } from '../decide/create-decider.js';
import type { Exec } from '../exec/command.js';
import { runGates } from '../exec/gate-runner.js';
import { git } from '../git/git.js';
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
import { PAUSED_AUTH, runPhase1, runPhase2, type PhaseDeps } from './phases/index.js';
import { reconcile } from './reconcile.js';
import { runAgentStep, type AgentStepDeps, type AgentStepRequest, type PackBase } from './steps.js';
import { TaskRunner, type TaskRunnerDeps } from './task-runner.js';
import { eventsFile, expandHome, graphDir, nextRunId, runDir, stateFile, stepDir, type Workspace } from './workspace.js';

export interface RunDeps {
  cfg: Config;
  ws: Workspace;
  project: Project;
  spec: Spec;
  firstSpec: boolean;
  exec: Exec;
  ghExec: Exec;
  runStep: typeof runStepFn;
  binary: RunnerBinary;
  agents: Record<Role, AgentDefinition>;
  graphify: Graphify | null;
  knowledge: KnowledgeIndex | null;
  secrets: Record<string, string>;
  fetch?: typeof fetch;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Test hook: the journal throws CrashInjected right after appending a matching intent. */
  crashAfterIntent?: (intentId: string) => boolean;
  maxParallel?: number;
  /** Claude Code's trust file; tests point it into a temp dir so they never touch the real ~/.claude.json. */
  claudeJsonPath?: string;
}

export type ExecuteResult = RunResult | 'paused:auth';


const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `uid:gid` of this process on POSIX hosts; undefined on Windows, where Docker Desktop maps ownership itself. */
export function containerUser(): string | undefined {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
}

/** Spec (orchestrator) §2.2: one tick loop, runners return through the journal. */
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
  private plan: Plan | null = null;
  private techSpecText = '';
  private adrs: Array<{ id: string; title: string; text: string }> = [];
  private readonly runners = new Map<string, TaskRunner>();
  private readonly inflight = new Map<string, Promise<void>>();

  private constructor(
    readonly runId: string,
    readonly journal: Journal,
    private readonly deps: RunDeps,
  ) {
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

  static async create(deps: RunDeps, runId?: string): Promise<Run> {
    const id = runId ?? (await nextRunId(deps.ws, deps.spec.specId));
    await fs.mkdir(runDir(deps.ws, id), { recursive: true });
    const journal = await Run.openJournal(deps, id);
    await journal.fact(OrchEvent.RunStarted, { runId: id, specId: deps.spec.specId, projectId: deps.project.projectId });
    return new Run(id, journal, deps);
  }

  static async resume(deps: RunDeps, runId: string): Promise<Run> {
    const journal = await Run.openJournal(deps, runId);
    const run = new Run(runId, journal, deps);
    await reconcile({ journal, ws: deps.ws, exec: deps.exec, ghExec: deps.ghExec, afterMerge: (taskId, branch) => run.afterMergeOnResume(taskId, branch), log: run.log });
    // `resume` is the human's signal that the login was redone (spec §7 "resume tries again").
    if (journal.state.status === 'paused:auth') await journal.fact(RunEvent.RunResumed, {});
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
    if (!task) return;
    const steps = taskMergeSteps(this.mergeDeps(), task, this.worktreeOf(branch), branch, this.deps.spec, `resumed ${taskId}`);
    await steps.afterMerge?.();
  }

  private worktreeOf(branch: string): string {
    return path.posix.join(this.deps.ws.worktrees, branch.replace(/\//g, '__'));
  }

  private async loadPlan(): Promise<Plan | null> {
    const { readDocs } = await import('./phases/shared.js');
    return (await readDocs(this.deps.ws.repo, this.deps.spec.specId, this.deps.exec)).plan;
  }

  private stepDeps(): StepDeps {
    const { cfg, ws } = this.deps;
    return {
      binary: this.deps.binary,
      caps: cfg.budgets.step,
      accounting: this.accounting,
      claudeJsonPath: this.deps.claudeJsonPath ?? expandHome('~/.claude.json'),
      settingsDir: path.posix.join(runDir(ws, this.runId), 'settings'),
      workspacesRoot: ws.root,
      network: { allowedDomains: ['registry.npmjs.org', ...(cfg.omniroute.enabled ? ['localhost'] : [])] },
      clock: this.clock,
    };
  }

  private agentDeps(): AgentStepDeps {
    const { cfg, project, secrets } = this.deps;
    return {
      runStep: this.deps.runStep,
      stepDeps: this.stepDeps(),
      agents: this.deps.agents,
      profile: (role) => resolveProfile(cfg, role, project),
      omniroute: cfg.omniroute.enabled ? { baseUrl: cfg.omniroute.baseUrl, token: secrets.OMNIROUTE_TOKEN ?? '' } : undefined,
      governor: this.governor,
      breaker: this.breaker,
      journal: this.journal,
      stepDir: (seq) => stepDir(this.deps.ws, this.runId, seq),
      secretValues: () => Object.values(secrets),
      specHash: this.deps.spec.specHash!,
    };
  }

  private runAgent = <K extends StepKind>(req: AgentStepRequest<K>): Promise<StepOutcome<OutputOf<K>>> => runAgentStep(req, this.agentDeps());

  private gates = async (worktree: string, branch: string) => {
    const plan = this.plan!;
    return runGates(
      plan.gates.filter((g) => g.blocking),
      {
        worktree,
        image: plan.gateImage,
        junitPath: plan.junitPath,
        cpus: 2,
        memory: '2g',
        timeoutMs: 15 * 60_000,
        secrets: this.deps.secrets,
        containerName: `teams-ai-${this.runId}-${branch.replace(/\//g, '__')}`,
        // Files the gate writes into the bind-mounted worktree (the JUnit report) must stay owned by the
        // orchestrator user, or the next attempt cannot remove them (EACCES on the first live run).
        user: containerUser(),
      },
      { exec: this.deps.exec, readFile: (p) => fs.readFile(p, 'utf8').catch(() => null), removeFile: (p) => fs.rm(p, { force: true }) },
    );
  };

  private mergeDeps(): MergeStepsDeps {
    return { journal: this.journal, ws: this.deps.ws, exec: this.deps.exec, ghExec: this.deps.ghExec, gates: this.gates, graphify: this.deps.graphify, secretValues: () => Object.values(this.deps.secrets), handoffs: this.handoffs, clock: this.clock };
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

  private code = async (worktree: string, task: PlanTask): Promise<CodeContext> => {
    const g = this.deps.graphify;
    const terms = [task.title, ...task.affectedPaths].map((t) => t.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 2)).flat().slice(0, 6);
    if (g) {
      const tracked = await g.trackedFiles(this.deps.ws.repo).catch(() => [] as string[]);
      const cov = await g.coverage(graphDir(this.deps.ws, null), tracked).catch(() => null);
      if (cov && cov.ratio >= MIN_COVERAGE) {
        const q = await g.query(graphDir(this.deps.ws, null), `${task.title} ${task.description}`, 2000);
        return { source: 'graph', nodes: q.nodes, truncated: q.truncated };
      }
    }
    return { source: 'grep', grep: await grepFallback(worktree, terms, this.deps.exec) };
  };

  private impact = async (worktree: string, branch: string, changed: readonly string[], depth: number): Promise<CodeContext> => {
    const g = this.deps.graphify;
    if (!g || changed.length === 0) return { source: 'none' };
    const out = graphDir(this.deps.ws, branch);
    await g.update(worktree, out).catch(() => undefined);
    const affected = (await Promise.all(changed.map((f) => g.affected(out, f, depth).catch(() => [])))).flat();
    return { source: 'graph', affected };
  };

  private runnerDeps(): TaskRunnerDeps {
    const { cfg, project, spec, secrets } = this.deps;
    const decider = createDecider({
      cfg,
      secrets,
      accounting: this.accounting,
      runEscalation: async ({ role, prompt }) => {
        // A Claude escalation is a claude process like any other step: governed and breaker-observed (spec §7).
        const profile = resolveProfile(cfg, role, project);
        const release = await this.governor.acquire();
        try {
          const out = (await this.deps.runStep<'decide'>({ kind: 'decide', role, agent: this.deps.agents[role], profile, model: profile.model, cwd: this.deps.ws.repo, prompt, expectedSpecHash: spec.specHash!, phase: 'decide', taskId: null, attempt: 0 }, this.stepDeps())) as StepOutcome<DecideOutput>;
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
    });
    return {
      journal: this.journal, ws: this.deps.ws, spec, project, plan: this.plan!, specHash: spec.specHash!, firstSpec: this.deps.firstSpec,
      exec: this.deps.exec,
      runAgent: this.runAgent,
      gates: this.gates,
      mergeQueue: this.mergeQueue,
      mergeSteps: (task, worktree, branch) => taskMergeSteps(this.mergeDeps(), task, worktree, branch, spec, this.summaryOf(task.id)),
      code: this.code,
      impact: this.impact,
      decider,
      tierModel: (role, tier) => {
        const profile = resolveProfile(cfg, role, project);
        return profile.provider === 'claude' ? cfg.decisions.modelTiers[tier] : null;
      },
      policy: { ...DEFAULT_POLICY, ...cfg.retry },
      packBase: this.packBase,
      handoffs: () => this.handoffs,
      boundaries: async () => {
        const g = this.deps.graphify;
        if (g) {
          const nodes = await g.godNodes(graphDir(this.deps.ws, null), 10).catch(() => []);
          if (nodes.length > 0) return nodes.map((n) => n.label);
        }
        return (await git(this.deps.ws.repo, ['ls-tree', '--name-only', 'origin/main'], this.deps.exec)).split('\n').filter((l) => l !== '');
      },
    };
  }

  private summaryOf(taskId: string): string {
    const e = [...this.journal.events].reverse().find((ev) => ev.type === OrchEvent.DevCommitted && ev.data.taskId === taskId);
    return e ? String(e.data.summary) : taskId;
  }

  private phaseDeps(): PhaseDeps {
    return {
      journal: this.journal, ws: this.deps.ws, spec: this.deps.spec, project: this.deps.project, specHash: this.deps.spec.specHash!, firstSpec: this.deps.firstSpec, exec: this.deps.exec,
      runAgent: this.runAgent,
      mergeQueue: this.mergeQueue,
      mergeDeps: this.mergeDeps(),
      packBase: this.packBase,
      godNodes: () => (this.deps.graphify ? this.deps.graphify.godNodes(graphDir(this.deps.ws, null), 10).catch(() => []) : Promise.resolve([])),
      pause: (failure) => this.pauseFor(failure),
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

  private async loadAdrs(): Promise<void> {
    const list = await git(this.deps.ws.repo, ['ls-tree', '--name-only', 'origin/main', 'docs/adr/'], this.deps.exec).catch(() => '');
    this.adrs = [];
    for (const rel of list.split('\n').filter((l) => l.endsWith('.md'))) {
      const text = await git(this.deps.ws.repo, ['show', `origin/main:${rel}`], this.deps.exec).catch(() => '');
      const id = /ADR-\d{3}/.exec(rel)?.[0] ?? rel;
      this.adrs.push({ id, title: text.split('\n')[0]?.replace(/^#\s*/, '') ?? id, text: text.slice(0, 4000) });
    }
  }

  async execute(): Promise<ExecuteResult> {
    const phase1 = await runPhase1(this.phaseDeps());
    if (!phase1.ok) return phase1.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase1.reason);
    this.techSpecText = phase1.techSpecText ?? '';
    await this.loadAdrs();
    const phase2 = await runPhase2(this.phaseDeps(), this.techSpecText);
    if (!phase2.ok) return phase2.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase2.reason);
    this.plan = phase2.plan!;
    if (!this.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 3)) await this.journal.fact(OrchEvent.PhaseStarted, { phase: 3 });
    for (const task of this.plan.tasks) {
      const t = this.journal.state.tasks.get(task.id);
      if (t && t.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: task.id, to: 'ready' });
    }
    return this.loop();
  }

  /** Spec (run API) §5: a signal drains — in-flight steps finish, nothing new starts. Idempotent. */
  async requestStop(): Promise<void> {
    if (this.journal.state.status === 'draining') return;
    await this.journal.fact(RunEvent.RunStopRequested, {});
  }

  private async loop(): Promise<ExecuteResult> {
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
      if (progress !== 'running' && this.inflight.size === 0) return this.finish(progress === 'complete' ? 'complete' : progress);
      if (this.journal.state.status === 'running') {
        for (const id of nextRunnable(this.journal.state, this.maxParallel)) {
          // Replacements from a replan are born `planned`; the runner only acts from `ready` onward.
          if (this.journal.state.tasks.get(id)!.state === 'planned') await this.journal.fact(RunEvent.TaskStateChanged, { taskId: id, to: 'ready' });
          if (!this.runners.has(id)) this.runners.set(id, new TaskRunner(id, this.runnerDeps()));
          this.start(id);
        }
      }
      // Draining (spec §7): nothing new starts, but tasks already active run to their terminal state.
      if (this.journal.state.status === 'running' || this.journal.state.status === 'draining') {
        // Tasks left active by a previous process (resume) get a runner too; nothing new is admitted here.
        for (const [id, t] of this.journal.state.tasks) if (ACTIVE_STATES.has(t.state) && !this.runners.has(id)) this.runners.set(id, new TaskRunner(id, this.runnerDeps()));
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
        const cap = this.deps.cfg.budgets.perTaskTokens;
        const tokens = this.accounting.tokensOf(this.accounting.total({ taskId: id }));
        if (tokens > cap && !runner.done) {
          if (this.deps.cfg.budgets.observeOnly) await this.journal.fact(OrchEvent.BudgetExceeded, { taskId: id, tokens, cap });
          else await runner.budgetExceeded(tokens, cap);
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
