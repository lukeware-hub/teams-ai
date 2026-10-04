import path from 'node:path';
import { loadEvents } from '../store/event-store.js';
import { spawnRun, type RunControlDeps } from '../api/run-control.js';
import { listRuns, readProject, runsDir, writePid, type IndexDeps } from '../api/run-index.js';

const MAX_BACKOFF_MS = 3_600_000;

export interface SuperviseDeps {
  idx: IndexDeps;
  control: RunControlDeps;
  projectDir: string;
  intervalMs: number;
  now: () => number;
  log: (s: string) => void;
}

/** Per run: how many resumes were tried since it last looked alive, and when the next one may happen. */
export type Backoff = Map<string, { attempts: number; nextAt: number }>;

async function stopRequested(runs: string, runId: string): Promise<boolean> {
  const events = await loadEvents(path.join(runs, runId, 'events.ndjson')).catch(() => []);
  return events.some((e) => e.type === 'RUN_STOP_REQUESTED');
}

/** One scan: resume every interrupted run that is not finished, not intentionally stopped and not backing off.
 * A resumed run gets a live pid, so the next scan sees it as running: one resume per run at a time. */
export async function superviseTick(d: SuperviseDeps, backoff: Backoff): Promise<string[]> {
  const { project } = await readProject(d.projectDir);
  const runs = runsDir(d.idx);
  const resumed: string[] = [];
  for (const row of await listRuns(d.idx, project.projectId)) {
    if (row.status !== 'interrupted') {
      if (row.stoppable && d.now() >= (backoff.get(row.runId)?.nextAt ?? 0)) backoff.delete(row.runId); // stayed alive past the backoff window: forget it
      continue;
    }
    if (await stopRequested(runs, row.runId)) {
      d.log(`supervise: ${row.runId} skipped, stop was requested`);
      continue;
    }
    const b = backoff.get(row.runId) ?? { attempts: 0, nextAt: 0 };
    if (d.now() < b.nextAt) continue;
    const attempts = b.attempts + 1;
    backoff.set(row.runId, { attempts, nextAt: d.now() + Math.min(d.intervalMs * 2 ** attempts, MAX_BACKOFF_MS) });
    try {
      const { pid } = spawnRun(d.control, { projectDir: d.projectDir, specId: row.specId, runId: row.runId, mode: 'resume', logFile: path.join(runs, row.runId, 'ui.log') });
      await writePid(runs, row.runId, pid);
      d.log(`supervise: resumed ${row.runId} pid ${pid} (attempt ${attempts})`);
      resumed.push(row.runId);
    } catch (err) {
      d.log(`supervise: resume of ${row.runId} failed: ${(err as Error).message}`);
    }
  }
  return resumed;
}

/** Scans every interval; `sleep` is called in short slices so a stop request is honoured promptly. */
export async function supervise(d: SuperviseDeps, stopped: () => boolean, sleep: (ms: number) => Promise<void>): Promise<void> {
  const backoff: Backoff = new Map();
  d.log(`supervise: watching ${d.projectDir} every ${d.intervalMs / 1000}s`);
  while (!stopped()) {
    await superviseTick(d, backoff).catch((err) => d.log(`supervise: scan failed: ${(err as Error).message}`));
    for (let waited = 0; waited < d.intervalMs && !stopped(); waited += 1000) await sleep(Math.min(1000, d.intervalMs - waited));
  }
  d.log('supervise: stopped');
}
