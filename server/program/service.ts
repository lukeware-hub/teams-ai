import { promises as fs } from 'node:fs';
import path from 'node:path';
import { abandonLaunch, isAlive, spawnRun, waitForRunJournal, type RunControlDeps } from '../api/run-control.js';
import { claimLaunch, claimsSpec, clearStopRequested, listRuns, runRow, runsDir as runsDirOf, writePid, type IndexDeps } from '../api/run-index.js';
import type { Config } from '../config/config.js';
import { Spec } from '../contracts/spec.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import { nextRunId } from '../orchestrator/workspace.js';
import { DEPENDENCY_BLOCKED } from '../pipeline/task-state.js';
import { loadEvents } from '../store/event-store.js';
import { newProgram, retryItem, tick, type Program, type ProgramEffects, type ProgramEntry, type RunOutcome } from './controller.js';

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
}

export const programFile = (draftRoot: string): string => path.posix.join(draftRoot, 'program.json');

export async function readProgram(draftRoot: string): Promise<Program | null> {
  const text = await fs.readFile(programFile(draftRoot), 'utf8').catch(() => null);
  return text === null ? null : (JSON.parse(text) as Program);
}

const writeProgram = (draftRoot: string, p: Program): Promise<void> => writeFileAtomic(programFile(draftRoot), `${JSON.stringify(p, null, 2)}\n`);

/** Runs of a program, one tick at a time per draft: the ledger is written by whoever holds the tick. */
export class ProgramService {
  private readonly ticking = new Set<string>();

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
      await waitForRunJournal(control, runs, runId, pid).catch(async (err: unknown) => {
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
    };
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
      case 'unknown':
        return { kind: 'interrupted' };
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
