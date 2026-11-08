import type { StoredEvent } from '../store/event-store.js';
import type { DocFile } from './draft.js';
import { RefineEvent } from './events.js';

/** A step that has started and not finished: what the page shows as "em uso agora". */
export interface RunningStep {
  stepId: string;
  kind: string;
  role: string;
  model: string;
  effort: string | null;
  part: { index: number; total: number } | null;
  limitMs: number | null;
  startedAt: string;
}

/** What one stage has cost so far: its review rounds, its steps, their time and their charge. */
export interface StageCost {
  rounds: number;
  steps: number;
  durationMs: number;
  costUsd: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The steps started but not finished, in the order they started. An id can start again after it finished, so each start is paired with the next finish of its id. */
export function runningStepsOf(events: ReadonlyArray<StoredEvent>): RunningStep[] {
  const open = new Map<string, StoredEvent>();
  for (const e of events) {
    const id = str(e.data.stepId);
    if (e.type === 'STEP_STARTED') {
      open.delete(id);
      open.set(id, e);
    } else if (e.type === 'STEP_FINISHED') open.delete(id);
  }
  return [...open.values()]
    .map((e) => ({
      stepId: str(e.data.stepId),
      kind: str(e.data.kind),
      role: str(e.data.role),
      model: str(e.data.model),
      effort: typeof e.data.effort === 'string' ? e.data.effort : null,
      part: (e.data.part as RunningStep['part']) ?? null,
      limitMs: typeof e.data.limitMs === 'number' ? e.data.limitMs : null,
      startedAt: e.at,
    }));
}

/** The Claude quota wait in progress: from its event until the next step starts. */
export function waitingOf(events: ReadonlyArray<StoredEvent>): { until: string } | null {
  let waiting: { until: string } | null = null;
  for (const e of events) {
    if (e.type === RefineEvent.QuotaWaiting) waiting = { until: str(e.data.until) };
    else if (e.type === 'STEP_STARTED') waiting = null;
  }
  return waiting;
}

/** The stage document under review now, from its cycle's start until the evaluation ends; null otherwise. */
export function reviewingOf(events: ReadonlyArray<StoredEvent>): DocFile | null {
  let reviewing: DocFile | null = null;
  for (const e of events) {
    if (e.type === RefineEvent.CycleStarted) reviewing = typeof e.data.file === 'string' ? (e.data.file as DocFile) : null;
    else if (e.type === RefineEvent.EvaluationEnded) reviewing = null;
  }
  return reviewing;
}

/** How many answers each stage holds that no review has used yet: they wait for Reprocessar. */
export function answersAwaitingOf(events: ReadonlyArray<StoredEvent>): Partial<Record<DocFile, number>> {
  const fileOf = new Map<string, DocFile>();
  const awaiting: Partial<Record<DocFile, Set<string>>> = {};
  for (const e of events) {
    if (e.type === RefineEvent.StageReviewed) {
      const file = e.data.file as DocFile;
      for (const q of (e.data.questions as Array<{ questionId: string }> | undefined) ?? []) fileOf.set(q.questionId, file);
      // A review uses every answer given before it.
      awaiting[file] = new Set();
    } else if (e.type === RefineEvent.QuestionAnswered) {
      const id = str(e.data.questionId);
      const file = fileOf.get(id);
      if (file) (awaiting[file] ??= new Set()).add(id);
    }
  }
  const counts: Partial<Record<DocFile, number>> = {};
  for (const [file, ids] of Object.entries(awaiting) as Array<[DocFile, Set<string>]>) if (ids.size > 0) counts[file] = ids.size;
  return counts;
}

/** Each stage's cost: its rounds, and the steps finished while it was the stage under review. */
export function stageCostOf(events: ReadonlyArray<StoredEvent>): Partial<Record<DocFile, StageCost>> {
  const costs: Partial<Record<DocFile, StageCost>> = {};
  let file: DocFile | null = null;
  for (const e of events) {
    if (e.type === RefineEvent.CycleStarted) {
      file = typeof e.data.file === 'string' ? (e.data.file as DocFile) : null;
      if (file) {
        const cost = (costs[file] ??= { rounds: 0, steps: 0, durationMs: 0, costUsd: 0 });
        cost.rounds += 1;
      }
    } else if (e.type === 'STEP_FINISHED' && file) {
      const cost = costs[file]!;
      cost.steps += 1;
      cost.durationMs += Number(e.data.durationMs ?? 0);
      cost.costUsd += Number(e.data.costUsd ?? 0);
    }
  }
  return costs;
}

/** What the stage review of the current round has done so far: its review, its Jev score, and whether the Jev did not answer. */
export function stageSignalsOf(events: ReadonlyArray<StoredEvent>): { reviewed: boolean; scored: boolean; jevDown: boolean } {
  let start = 0;
  events.forEach((e, i) => {
    if (e.type === RefineEvent.CycleStarted) start = i;
  });
  const round = events.slice(start);
  const scores = round.filter((e) => e.type === RefineEvent.DocsScored);
  return {
    reviewed: round.some((e) => e.type === RefineEvent.StageReviewed),
    scored: scores.length > 0,
    jevDown: scores.some((e) => e.data.available === false),
  };
}
