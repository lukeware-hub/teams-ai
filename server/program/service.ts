import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isAlive, spawnRun, waitForRunJournal, type RunControlDeps } from '../api/run-control.js';
import { claimLaunch, clearStopRequested, CLAIMS_SPEC, listRuns, runRow, runsDir as runsDirOf, writePid, type IndexDeps } from '../api/run-index.js';
import type { Config } from '../config/config.js';
import { Spec } from '../contracts/spec.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import { nextRunId } from '../orchestrator/workspace.js';
import { loadEvents } from '../store/event-store.js';
import { newProgram, tick, type Program, type ProgramEffects, type ProgramEntry, type RunOutcome } from './controller.js';

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
      await waitForRunJournal(control, runs, runId, pid);
      await writePid(runs, runId, pid);
      this.deps.log?.(`program ${draftId}: run ${runId} ${mode} pid ${pid}`);
    };
    return {
      now: () => this.now(),
      findActiveRun: async (specId) => (await listRuns(await this.index(), projectId)).find((r) => r.specId === specId && CLAIMS_SPEC.has(r.status))?.runId ?? null,
      startRun: async (specId) => {
        await this.deps.freezeItem(projectId, draftId, specId);
        const runs = runsDirOf(await this.index());
        const runId = await nextRunId({ runs }, specId);
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
        const runId = await nextRunId({ runs }, `${specId}-complete`);
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
    const finished = async () => {
      const events = await loadEvents(path.join(runsDirOf(idx), runId, 'events.ndjson')).catch(() => []);
      return [...events].reverse().find((e) => e.type === 'RUN_FINISHED')?.data as { reason?: string | null; blocked?: Array<{ taskId: string; reason: string }> } | undefined;
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
      case 'done':
        return { kind: 'done' };
      case 'awaiting-validation': {
        const data = await finished();
        const blocked = data?.blocked ?? [];
        // Verification accepts criteria whose only tasks are blocked, so a delivered spec still needs zero blocked tasks.
        return blocked.length === 0 ? { kind: 'delivered' } : { kind: 'failed', reason: `finished with ${blocked.length} blocked task(s): ${blocked.map((b) => `${b.taskId} (${b.reason})`).join('; ').slice(0, 400)}` };
      }
      default: {
        const data = await finished();
        return { kind: 'failed', reason: `${row.status}${data?.reason ? `: ${String(data.reason).slice(0, 400)}` : ''}` };
      }
    }
  }
}
