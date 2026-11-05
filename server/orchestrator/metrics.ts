import { RunEvent } from '../pipeline/run-state.js';
import type { StoredEvent } from '../store/event-store.js';
import { OrchEvent } from './events.js';

/** What a spec cost and how much rework it took, from the journals of its runs. */
export interface RunMetrics {
  runs: number;
  costUsd: number;
  fixCostUsd: number;
  fixCostShare: number | null;
  tasks: number;
  attemptsPerTask: number | null;
  firstTryRate: number | null;
  reviewRejectRate: number | null;
  wallMs: number;
}

// The orchestrator assigns these ids, so they name the tasks that repair earlier work.
const isFixTask = (id: unknown): boolean => typeof id === 'string' && (id.startsWith('T900-fix-') || id.startsWith('T950-deploy-fix-'));
const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

export function runMetrics(events: readonly StoredEvent[]): RunMetrics {
  let costUsd = 0;
  let fixCostUsd = 0;
  let changes = 0;
  let approved = 0;
  const attempts = new Map<string, number>();
  const merged = new Set<string>();
  for (const e of events) {
    const task = `${e.runId}|${String(e.data.taskId)}`;
    if (e.type === OrchEvent.StepFinished) {
      const cost = Number(e.data.costUsd ?? 0);
      costUsd += cost;
      if (isFixTask(e.data.taskId)) fixCostUsd += cost;
      if (e.data.kind === 'dev' && typeof e.data.taskId === 'string') attempts.set(task, Math.max(attempts.get(task) ?? 0, Number(e.data.attempt ?? 1)));
    } else if (e.type === RunEvent.TaskStateChanged && e.data.to === 'merged') merged.add(task);
    else if (e.type === OrchEvent.ReviewChanges) changes++;
    else if (e.type === OrchEvent.ReviewApproved) approved++;
  }
  const times = events.map((e) => Date.parse(e.at));
  return {
    runs: new Set(events.filter((e) => e.type === OrchEvent.RunStarted).map((e) => e.runId)).size,
    costUsd,
    fixCostUsd,
    fixCostShare: ratio(fixCostUsd, costUsd),
    tasks: attempts.size,
    attemptsPerTask: ratio([...attempts.values()].reduce((a, b) => a + b, 0), attempts.size),
    firstTryRate: ratio([...attempts].filter(([task, n]) => n === 1 && merged.has(task)).length, attempts.size),
    reviewRejectRate: ratio(changes, changes + approved),
    wallMs: times.length === 0 ? 0 : Math.max(...times) - Math.min(...times),
  };
}
