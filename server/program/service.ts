import { promises as fs } from 'node:fs';
import path from 'node:path';
import { abandonLaunch, isAlive, spawnRun, waitForRunJournal, type RunControlDeps } from '../api/run-control.js';
import { claimLaunch, claimsSpec, clearStopRequested, listRuns, runRow, runsDir as runsDirOf, writePid, type IndexDeps } from '../api/run-index.js';
import type { Config } from '../config/config.js';
import { Project } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import type { Decider } from '../decide/decider.js';
import type { DecisionRecord } from '../decide/types.js';
import { classifyFailure, retryable } from '../decide/decisions/failure-cause.js';
import { OrchEvent } from '../orchestrator/events.js';
import { expandHome, nextRunId } from '../orchestrator/workspace.js';
import { RunEvent } from '../pipeline/run-state.js';
import { DEPENDENCY_BLOCKED } from '../pipeline/task-state.js';
import { loadEvents } from '../store/event-store.js';
import { writeRepairNotes } from './repair-notes.js';
import { newProgram, prioritizeItem, retryItem, tick, type Program, type ProgramEffects, type ProgramEntry, type ProgramItem, type RunOutcome } from './controller.js';

export interface ProgramServiceDeps {
  cfg: () => Promise<Config>;
  home?: string;
  control: RunControlDeps;
  /** The draft root, where `docs/` and `program.json` live, for a refinement session. */
  draftRoot: (projectId: string, draftId: string) => Promise<string>;
  /** Freezes one planned item spec in the draft (RefineSession.freezeItem). */
  freezeItem: (projectId: string, draftId: string, specId: string) => Promise<void>;
  register: (dir: string) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
  /** Classifies a failed run (R11.14); absent means a failed run is never repaired. */
  decider?: Pick<Decider, 'decide'>;
}

/** A pull request a run opened for a spec. */
export interface ProgramPr { number: number; url: string }
/** One System 1 decision of a run, as the decision timeline lists it. */
export interface ProgramDecision {
  at: string;
  /** The key of the backlog item whose run decided. */
  key: string;
  runId: string;
  decisionId: string;
  /** Who answered: `jev`, `local`, `claude`, or null when none did. */
  backend: string | null;
  escalated: boolean;
  answers: Array<{ question: string; value: string | number; confidence: number | null }>;
}
interface RunFacts { prs: ProgramPr[]; decisions: ProgramDecision[]; pause?: { reason: 'quota' | 'auth'; until?: string } }

const decisionOf = (r: DecisionRecord, key: string, runId: string): ProgramDecision => ({
  at: r.at, key, runId, decisionId: r.decisionId, backend: r.backend, escalated: r.escalated,
  answers: Object.entries(r.answers ?? {}).map(([question, a]) => ({ question, value: a.value, confidence: a.confidence })),
});

/** An item as the screen reads it: the ledger's item, the pull requests of its runs and, while a run waits, why and until when. */
export type ProgramItemView = ProgramItem & Pick<RunFacts, 'prs' | 'pause'>;
export type ProgramView = Omit<Program, 'items'> & { items: ProgramItemView[] };

export const programFile = (draftRoot: string): string => path.posix.join(draftRoot, 'program.json');

export async function readProgram(draftRoot: string): Promise<Program | null> {
  const text = await fs.readFile(programFile(draftRoot), 'utf8').catch(() => null);
  return text === null ? null : (JSON.parse(text) as Program);
}

const writeProgram = (draftRoot: string, p: Program): Promise<void> => writeFileAtomic(programFile(draftRoot), `${JSON.stringify(p, null, 2)}\n`);

/** Runs of a program, one tick at a time per draft: the ledger is written by whoever holds the tick. */
export class ProgramService {
  private readonly ticking = new Set<string>();

  /** When this server started: a run launched before it died in the restart, not on its own. */
  private readonly bootedAt = Date.now();

  /** What the journals of an item whose runs ended say: it never changes, so the screen's polling reads it once. */
  private readonly settledFacts = new Map<string, RunFacts>();

  constructor(private readonly deps: ProgramServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Creates the ledger once (a second start finds it) and takes the first tick. */
  async start(projectId: string, draftId: string, entries: readonly ProgramEntry[]): Promise<Program> {
    const root = await this.deps.draftRoot(projectId, draftId);
    if ((await readProgram(root)) === null) await writeProgram(root, newProgram(draftId, entries, this.now()));
    await this.deps.register(root);
    return (await this.tick(projectId, draftId)) ?? (await readProgram(root))!;
  }

  async read(projectId: string, draftId: string): Promise<Program | null> {
    return readProgram(await this.deps.draftRoot(projectId, draftId));
  }

  /** What the journals of an item's runs say: its pull requests, why and until when a run waits, and the System 1 decisions. */
  private async runFacts(item: ProgramItem, runs: string): Promise<RunFacts> {
    const runIds = [item.runId, item.completeRunId].filter((id): id is string => id !== null);
    const settled = item.status === 'done' || item.status === 'failed' || item.status === 'blocked';
    const key = runIds.join('+');
    const cached = settled ? this.settledFacts.get(key) : undefined;
    if (cached) return cached;
    const prs = new Map<number, ProgramPr>();
    const decisions: ProgramDecision[] = [];
    let pause: RunFacts['pause'];
    for (const runId of runIds) {
      const events = await loadEvents(path.join(runs, runId, 'events.ndjson')).catch(() => []);
      for (const e of events) {
        if (e.type === OrchEvent.PrCreated) prs.set(Number(e.data.number), { number: Number(e.data.number), url: String(e.data.url) });
        if (e.type === OrchEvent.DecisionMade) decisions.push(decisionOf(e.data.record as DecisionRecord, item.key, runId));
      }
      const last = [...events].reverse().find((e) => e.type === RunEvent.RunPaused || e.type === RunEvent.RunResumed || e.type === 'RUN_FINISHED');
      if (last?.type === RunEvent.RunPaused) pause = { reason: last.data.reason === 'auth' ? 'auth' : 'quota', ...(typeof last.data.until === 'string' ? { until: last.data.until } : {}) };
    }
    const facts = { prs: [...prs.values()].sort((a, b) => a.number - b.number), decisions, ...(pause ? { pause } : {}) };
    if (settled) this.settledFacts.set(key, facts);
    return facts;
  }

  /** The ledger with each item's pull requests and, for a run paused by the quota or the login, why and until when. */
  async view(projectId: string, draftId: string): Promise<ProgramView | null> {
    const program = await this.read(projectId, draftId);
    if (program === null) return null;
    const runs = runsDirOf(await this.index());
    const items = await Promise.all(program.items.map(async (item): Promise<ProgramItemView> => {
      const { prs, pause } = await this.runFacts(item, runs);
      return { ...item, prs, ...(pause ? { pause } : {}) };
    }));
    return { ...program, items };
  }

  /** The System 1 decisions of the program's runs, the newest first and at most `limit`. */
  async decisions(projectId: string, draftId: string, limit = 100): Promise<ProgramDecision[]> {
    const program = await this.read(projectId, draftId);
    if (program === null) return [];
    const runs = runsDirOf(await this.index());
    const all = (await Promise.all(program.items.map(async (item) => (await this.runFacts(item, runs)).decisions))).flat();
    return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  /** Puts a pending item ahead of the queue and takes a tick, which starts it if a slot is free and nothing in flight conflicts. */
  async prioritize(projectId: string, draftId: string, specId: string): Promise<Program> {
    const root = await this.deps.draftRoot(projectId, draftId);
    const program = await readProgram(root);
    if (program === null) throw new RangeError(`no program for ${projectId}/${draftId}`);
    await writeProgram(root, prioritizeItem(program, specId, this.now()));
    return (await this.tick(projectId, draftId)) ?? (await readProgram(root))!;
  }

  /** R11.4 continuation: clears a failed item back to pending (and un-blocks its dependents) and takes a tick. */
  async retry(projectId: string, draftId: string, specId: string): Promise<Program> {
    const root = await this.deps.draftRoot(projectId, draftId);
    const program = await readProgram(root);
    if (program === null) throw new RangeError(`no program for ${projectId}/${draftId}`);
    await writeProgram(root, retryItem(program, specId, this.now()));
    return (await this.tick(projectId, draftId)) ?? (await readProgram(root))!;
  }

  /** One reconciliation of this draft's program; null when there is none, it is finished, or a tick is already running. */
  async tick(projectId: string, draftId: string): Promise<Program | null> {
    const key = `${projectId}/${draftId}`;
    if (this.ticking.has(key)) return null;
    const root = await this.deps.draftRoot(projectId, draftId);
    const program = await readProgram(root);
    if (program === null || program.status === 'finished') return null;
    this.ticking.add(key);
    try {
      return await tick(program, this.effects(projectId, draftId, root), (p) => writeProgram(root, p));
    } finally {
      this.ticking.delete(key);
    }
  }

  private async index(): Promise<IndexDeps> {
    return { cfg: await this.deps.cfg(), home: this.deps.home, isAlive: (pid) => isAlive(this.deps.control, pid) };
  }

  private effects(projectId: string, draftId: string, root: string): ProgramEffects {
    const { control } = this.deps;
    const launch = async (specId: string, runId: string, mode: 'run' | 'resume' | 'complete'): Promise<void> => {
      const runs = runsDirOf(await this.index());
      await fs.mkdir(path.join(runs, runId), { recursive: true });
      const { pid } = spawnRun(control, { projectDir: root, specId, runId, mode, ...(mode === 'run' ? { draft: true } : {}), logFile: path.join(runs, runId, 'ui.log') });
      await waitForRunJournal(control, runs, runId, pid, expandHome((await this.deps.cfg()).paths.secrets, this.deps.home)).catch(async (err: unknown) => {
        // A resume keeps its directory: it holds the run's journal.
        if (mode !== 'resume') await abandonLaunch(control, runs, runId, pid);
        throw err;
      });
      await writePid(runs, runId, pid);
      this.deps.log?.(`program ${draftId}: run ${runId} ${mode} pid ${pid}`);
    };
    return {
      now: () => this.now(),
      findActiveRun: async (specId) => (await listRuns(await this.index(), projectId)).find((r) => r.specId === specId && claimsSpec(r))?.runId ?? null,
      startRun: async (specId) => {
        await this.deps.freezeItem(projectId, draftId, specId);
        const runs = runsDirOf(await this.index());
        const runId = await nextRunId({ runs, projectId }, specId);
        await launch(specId, runId, 'run');
        await this.deps.register(root);
        return { runId };
      },
      resumeRun: async (runId) => {
        const idx = await this.index();
        const runs = runsDirOf(idx);
        const release = await claimLaunch(runs, runId);
        if (!release) return; // another resumer holds it; the next tick looks again
        try {
          const row = await runRow(idx, runId);
          if (!row) throw new Error(`unknown run ${runId}`);
          await clearStopRequested(runs, runId);
          await launch(row.specId, runId, 'resume');
        } finally {
          await release();
        }
      },
      completeSpec: async (specId) => {
        // The draft root keeps the status the freeze gave it (running); `spec complete` runs from it and wants awaiting-validation.
        const file = path.posix.join(root, 'docs', 'specs', specId, 'spec.json');
        const spec = Spec.parse(JSON.parse(await fs.readFile(file, 'utf8')));
        if (spec.status === 'running') await writeFileAtomic(file, `${JSON.stringify({ ...spec, status: 'awaiting-validation' }, null, 2)}\n`);
        const runs = runsDirOf(await this.index());
        const runId = await nextRunId({ runs, projectId }, specId, 'complete');
        await launch(specId, runId, 'complete');
        return { runId };
      },
      outcome: async (runId) => this.outcome(runId),
      repair: this.deps.decider && ((specId, failures) => this.repair(root, specId, failures)),
    };
  }

  /** Classifies the latest failure; when another run may fix it, leaves every failure for that run to read. */
  private async repair(root: string, specId: string, failures: readonly string[]): Promise<boolean> {
    const { confidential } = Project.parse(JSON.parse(await fs.readFile(path.join(root, 'docs', 'project.json'), 'utf8')));
    if (!retryable(await classifyFailure(failures, this.deps.decider!, { confidential }))) return false;
    await writeRepairNotes(root, specId, failures);
    return true;
  }

  /** What the controller needs to know about a run: still going, resumable, delivered clean, done, or failed and why. */
  async outcome(runId: string): Promise<RunOutcome> {
    const idx = await this.index();
    const row = await runRow(idx, runId);
    if (!row) return { kind: 'running' };
    const events = () => loadEvents(path.join(runsDirOf(idx), runId, 'events.ndjson')).catch(() => []);
    const finished = async () => {
      return [...(await events())].reverse().find((e) => e.type === 'RUN_FINISHED')?.data as { reason?: string | null; blocked?: Array<{ taskId: string; reason: string }>; tokens?: { costUsd?: number | null } } | undefined;
    };
    switch (row.status) {
      case 'running':
      case 'paused:quota':
      case 'paused:auth':
      case 'draining':
        return { kind: 'running' };
      case 'interrupted':
      case 'unknown': {
        // The pid file (retired to pid.gone once its process is dead) is written at each launch and resume.
        const dir = path.join(runsDirOf(idx), runId);
        const launched = (await fs.stat(path.join(dir, 'pid')).catch(() => fs.stat(path.join(dir, 'pid.gone'))).catch(() => null))?.mtimeMs;
        return launched !== undefined && launched < this.bootedAt ? { kind: 'interrupted', restart: true } : { kind: 'interrupted' };
      }
      case 'done': {
        const data = await finished();
        return { kind: 'done', costUsd: data?.tokens?.costUsd ?? null };
      }
      case 'awaiting-validation': {
        const data = await finished();
        // The repair loop redid a blocked task's work when every criterion it owns passed verification; one that owns none is work nothing measured.
        const matrix = (([...(await events())].reverse().find((e) => e.type === 'VERIFICATION_PASSED')?.data.matrix ?? []) as Array<{ tasks: string[]; status: string }>);
        const covered = (taskId: string) => matrix.some((r) => r.tasks.includes(taskId)) && matrix.every((r) => !r.tasks.includes(taskId) || r.status === 'passed');
        const blocked = (data?.blocked ?? []).filter((b) => !covered(b.taskId));
        const costUsd = data?.tokens?.costUsd ?? null;
        return blocked.length === 0 ? { kind: 'delivered', costUsd } : { kind: 'failed', reason: `finished with ${blocked.length} blocked task(s): ${blocked.map((b) => `${b.taskId} (${b.reason})`).join('; ').slice(0, 400)}`, costUsd };
      }
      default: {
        const data = await finished();
        // The tasks that blocked on their own cause tell why criteria went without evidence; their dependents add nothing.
        const own = (data?.blocked ?? []).filter((b) => b.reason !== DEPENDENCY_BLOCKED).map((b) => `${b.taskId} (${b.reason})`);
        return { kind: 'failed', reason: `${row.status}${data?.reason ? `: ${String(data.reason).slice(0, 400)}` : ''}${own.length ? `; blocked: ${own.join('; ').slice(0, 400)}` : ''}`, costUsd: data?.tokens?.costUsd ?? null };
      }
    }
  }
}
