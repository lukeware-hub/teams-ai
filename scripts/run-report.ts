import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { reduceEvents } from '../server/pipeline/run-state.js';

export interface JournalEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface TaskReport {
  taskId: string;
  state: string;
  attempts: number;
  replanned: boolean;
  costUsd: number;
  /** Steps whose session total went down, so their cost is a guess. */
  sessionResets: number;
  /** Failures that mention a worktree that already exists. */
  worktreeExists: number;
  blockedReason: string | null;
}

const WORKTREE_EXISTS = /worktree[\s\S]*already exists|already exists[\s\S]*worktree/i;

/** One row per task of a run: its state, attempts, cost and the last reason it was blocked, read from the journal. */
export function runReport(events: readonly JournalEvent[]): TaskReport[] {
  const state = reduceEvents(events);
  const rows = new Map<string, TaskReport>();
  for (const [taskId, task] of state.tasks) {
    rows.set(taskId, { taskId, state: task.state, attempts: task.attempts, replanned: task.replanned, costUsd: 0, sessionResets: 0, worktreeExists: 0, blockedReason: null });
  }
  for (const e of events) {
    const row = rows.get(String(e.data.taskId));
    if (!row) continue;
    if (e.type === 'STEP_FINISHED') {
      row.costUsd += Number(e.data.costUsd ?? 0);
      if ((e.data.profile as { sessionTotalsReset?: boolean } | undefined)?.sessionTotalsReset) row.sessionResets += 1;
    }
    if (e.type === 'TASK_BLOCKED') row.blockedReason = String(e.data.reason);
    if (WORKTREE_EXISTS.test(JSON.stringify(e.data))) row.worktreeExists += 1;
  }
  return [...rows.values()];
}

/** Prints the report of each run directory that has an events.ndjson. */
async function main(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    const lines = (await fs.readFile(`${dir}/events.ndjson`, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    console.log(`# ${dir}`);
    console.table(runReport(lines.map((l) => JSON.parse(l) as JournalEvent)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('usage: tsx scripts/run-report.ts <run directory>...');
  await main(process.argv.slice(2));
}
