import path from 'node:path';
import { loadEvents } from '../store/event-store.js';
import { spawnRun, type RunControlDeps } from '../api/run-control.js';
import { claimLaunch, isStopRequested, listRuns, readProject, runRow, runsDir, writePid, type IndexDeps } from '../api/run-index.js';

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

/** Either the CLI journaled the stop, or the UI left its marker (its Stop can kill a process that never got to journal). */
async function stopRequested(runs: string, runId: string): Promise<boolean> {
  if (await isStopRequested(runs, runId)) return true;
  const events = await loadEvents(path.join(runs, runId, 'events.ndjson')).catch(() => []);
  // A stop is intentional only while it is the last lifecycle event: a later RUN_RESUMED (hand resume) or
  // RUN_STARTED means someone restarted the run, so a crash after that is an interruption to resume.
  const lastStop = events.map((e) => e.type).lastIndexOf('RUN_STOP_REQUESTED');
  return lastStop >= 0 && !events.slice(lastStop + 1).some((e) => e.type === 'RUN_RESUMED' || e.type === 'RUN_STARTED');
}

/** One scan: resume every interrupted run that is not finished, not intentionally stopped and not backing off.
 * A resumed run gets a live pid, so the next scan sees it as running: one resume per run at a time.
 * The scan is a snapshot and the UI resumes runs too, so each run is claimed and looked at again before it is spawned. */
export async function superviseTick(d: SuperviseDeps, backoff: Backoff): Promise<string[]> {
  const { project } = await readProject(d.projectDir);
  const runs = runsDir(d.idx);
  const resumed: string[] = [];
  for (const row of await listRuns(d.idx, project.projectId)) {
    if (row.locked) continue; // a concluded spec's runs are read-only
    if (row.status !== 'interrupted') {
      if (row.stoppable && d.now() >= (backoff.get(row.runId)?.nextAt ?? 0)) backoff.delete(row.runId); // stayed alive past the backoff window: forget it
      continue;
    }
    const b = backoff.get(row.runId) ?? { attempts: 0, nextAt: 0 };
    if (d.now() < b.nextAt) continue;
    const release = await claimLaunch(runs, row.runId);
    if (!release) {
      d.log(`supervise: ${row.runId} skipped, another launch is in flight`);
      continue;
    }
    try {
      // Checked under the claim and in this order: a dead process of a user's Stop implies its marker is already on disk.
      if ((await runRow(d.idx, row.runId))?.status !== 'interrupted') continue;
      if (await stopRequested(runs, row.runId)) {
        d.log(`supervise: ${row.runId} skipped, stop was requested`);
        continue;
      }
      const attempts = b.attempts + 1;
      backoff.set(row.runId, { attempts, nextAt: d.now() + Math.min(d.intervalMs * 2 ** attempts, MAX_BACKOFF_MS) });
      const { pid } = spawnRun(d.control, { projectDir: d.projectDir, specId: row.specId, runId: row.runId, mode: 'resume', logFile: path.join(runs, row.runId, 'ui.log') });
      await writePid(runs, row.runId, pid);
      d.log(`supervise: resumed ${row.runId} pid ${pid} (attempt ${attempts})`);
      resumed.push(row.runId);
    } catch (err) {
      d.log(`supervise: resume of ${row.runId} failed: ${(err as Error).message}`);
    } finally {
      await release();
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
