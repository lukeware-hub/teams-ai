import type { EvidenceRow } from '../../evidence/matrix.js';
import { DEPENDENCY_BLOCKED, type TaskState } from '../../pipeline/task-state.js';

export type GapStatus = 'delivered' | 'partial' | 'missing';

/** One section of a project doc, as the test agent judged it against main. */
export interface GapItem {
  doc: string;
  heading: string;
  status: GapStatus;
  evidence: string[];
  missing: string;
  acIds: string[];
}

export type GapCause =
  | { kind: 'no-task' }
  | { kind: 'blocked'; roots: Array<{ taskId: string; reason: string }> }
  | { kind: 'tests-failing'; acIds: string[] }
  | { kind: 'run-stopped'; result: string }
  | { kind: 'not-built' };

export interface GapContext {
  evidence: readonly EvidenceRow[];
  /** Each task of the run: its state and the tasks it waits for. */
  tasks: ReadonlyMap<string, { state: TaskState; dependsOn: readonly string[] }>;
  /** The journaled reason a task blocked. */
  reasonOf: (taskId: string) => string;
  result: string;
}

/** The tasks that blocked a task for real: a dependency block passes on to the task it waits for. */
function rootBlocks(ids: readonly string[], ctx: GapContext, seen = new Set<string>()): Array<{ taskId: string; reason: string }> {
  return ids.flatMap((id) => {
    const task = ctx.tasks.get(id);
    if (seen.has(id) || task?.state !== 'blocked') return [];
    seen.add(id);
    const reason = ctx.reasonOf(id);
    return reason === DEPENDENCY_BLOCKED ? rootBlocks(task.dependsOn, ctx, seen) : [{ taskId: id, reason }];
  });
}

/** Why a section is open: the first rule that fits, in the order a human would check them. */
export function gapCause(item: Pick<GapItem, 'acIds'>, ctx: GapContext): GapCause {
  const rows = ctx.evidence.filter((r) => item.acIds.includes(r.criterion));
  const owners = rows.flatMap((r) => r.tasks);
  if (owners.length === 0) return { kind: 'no-task' };
  const roots = rootBlocks(owners, ctx);
  if (roots.length > 0) return { kind: 'blocked', roots };
  const failing = rows.filter((r) => r.status === 'failed').map((r) => r.criterion);
  if (failing.length > 0) return { kind: 'tests-failing', acIds: failing };
  if (ctx.result !== 'awaiting-validation') return { kind: 'run-stopped', result: ctx.result };
  return { kind: 'not-built' };
}

/** Every section with its cause; a delivered section has none. */
export function explainGaps<T extends Pick<GapItem, 'status' | 'acIds'>>(items: readonly T[], ctx: GapContext): Array<T & { cause: GapCause | null }> {
  return items.map((item) => ({ ...item, cause: item.status === 'delivered' ? null : gapCause(item, ctx) }));
}
