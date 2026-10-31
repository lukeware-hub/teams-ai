import type { GapsOutput } from '../../agents/outputs.js';
import type { Spec } from '../../contracts/spec.js';
import type { EvidenceRow } from '../../evidence/matrix.js';
import { DEPENDENCY_BLOCKED, type TaskState } from '../../pipeline/task-state.js';
import type { StepOutcome } from '../../runner/step.js';
import { gapsPack } from '../steps.js';
import { PAUSED_AUTH, pauseForFailure, type PhaseDeps } from './shared.js';

/** One section of a project doc, as the test agent judged it against main. */
export type GapItem = GapsOutput['items'][number];

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

/** The gap check of a run: its sections with their cause, or why it did not run. */
export type GapsReport = { items: Array<GapItem & { cause: GapCause | null }> } | { unavailable: string };

/** The tasks that blocked a task for real: a dependency block passes on to the task it waits for. */
export function rootBlocks(ids: readonly string[], ctx: Pick<GapContext, 'tasks' | 'reasonOf'>, seen = new Set<string>()): Array<{ taskId: string; reason: string }> {
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

type Section = { doc: string; heading: string };

/** The doc sections a spec cites, each once. */
export function citedSections(spec: Spec): Section[] {
  const sources = spec.derivedFrom?.sources ?? [];
  return [...new Map(sources.map((s) => [`${s.doc}\n${s.heading}`, { doc: s.doc, heading: s.heading }])).values()];
}

/** Why the answer is not usable: each cited section once, no other section, real criteria, and a reason for every open section. */
export function gapErrors(items: readonly GapItem[], sections: readonly Section[], spec: Spec): string[] {
  const known = new Set(spec.acceptanceCriteria.map((c) => c.id));
  const same = (a: Section, b: Section) => a.doc === b.doc && a.heading === b.heading;
  const errors = sections.flatMap((s) => {
    const n = items.filter((i) => same(i, s)).length;
    return n === 1 ? [] : [`${s.doc} › ${s.heading}: answered ${n} times`];
  });
  for (const item of items) {
    const label = `${item.doc} › ${item.heading}`;
    if (!sections.some((s) => same(item, s))) errors.push(`${label}: not a cited section`);
    for (const id of item.acIds) if (!known.has(id)) errors.push(`${label}: unknown criterion ${id}`);
    if (item.status !== 'delivered' && item.missing.trim() === '') errors.push(`${label}: ${item.status} without what is missing`);
  }
  return errors;
}

/** The Test agent judges the cited sections against the code in `wt`, a checkout of main that nothing may write. */
export async function checkGaps(deps: PhaseDeps, wt: string, ctx: GapContext): Promise<GapsReport | typeof PAUSED_AUTH> {
  if (deps.services) return { unavailable: 'a services run keeps its code in each service repository; the check covers one repository' };
  const sections = citedSections(deps.spec);
  if (sections.length === 0) return { unavailable: 'the spec cites no section of the docs' };
  let error = 'gap step failed';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runAgent<'gaps'>({ kind: 'gaps', role: 'test', pack: gapsPack(deps.packBase(), { sections }), cwd: wt, phase: 'phase6', taskId: null, attempt, protectedDirs: [wt] }) as StepOutcome<GapsOutput>;
    if (out.ok) {
      const errors = gapErrors(out.value.items, sections, deps.spec);
      if (errors.length === 0) return { items: explainGaps(out.value.items, ctx) };
      error = `gap check rejected: ${errors.join('; ')}`;
      continue;
    }
    if (out.failure === 'quota' || out.failure === 'auth') { if (await pauseForFailure(deps, out.failure)) return PAUSED_AUTH; continue; }
    error = out.errors.join('; ') || error;
  }
  return { unavailable: error };
}
