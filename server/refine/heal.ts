/** What the heal driver does about a failed refinement, decided from the journal alone. */
import { RefineEvent } from './events.js';

/** The kinds the driver tells apart; anything else is `other`, which the owner decides. */
export type HealKind = 'interrupted' | 'schema' | 'timeout' | 'environment' | 'quota' | 'auth' | 'other';

const KINDS: readonly HealKind[] = ['interrupted', 'schema', 'timeout', 'environment', 'quota', 'auth'];

/** The failures in a row of one kind after which the driver pauses the draft for the owner. */
export const HEAL_LIMITS: Partial<Record<HealKind, number>> = { interrupted: 3, schema: 2, timeout: 2, environment: 3 };

/** The kind of a failure the journal recorded without one: the reasons written before kinds existed. */
export function kindOfLegacyReason(reason: string): HealKind {
  if (reason === 'interrupted' || reason.startsWith('A preparação foi interrompida quando o servidor reiniciou')) return 'interrupted';
  if (reason.includes('passou do tempo limite')) return 'timeout';
  if (reason.includes('sessão do Claude expirou')) return 'auth';
  if (reason.includes('formato válido') || reason.includes('schema')) return 'schema';
  return 'other';
}

/** The kind of a recorded failure: its own kind when it has one, the reason's otherwise. */
export function kindOf(data: { kind?: unknown; reason?: unknown }): HealKind {
  if (typeof data.kind === 'string') return KINDS.includes(data.kind as HealKind) ? (data.kind as HealKind) : 'other';
  return kindOfLegacyReason(String(data.reason ?? ''));
}

/** One failure as the driver sees it: its kind, and how many failures came in a row, of any kind. */
export interface HealFailure {
  kind: HealKind;
  reason: string;
  attempts: number;
}

/** What the driver needs about one draft. */
export interface HealView {
  busy: boolean;
  started: boolean;
  /** A new project's stage reviews are open: they are retried through the stage routes, which the driver does not call. */
  staged: boolean;
  /** The driver already paused this draft and the owner has not acted since. */
  paused: boolean;
  /** The cycle that failed, while the draft is in error. */
  cycle?: HealFailure;
  /** The plan preparation that failed. */
  speckit?: HealFailure;
}

export type HealAction = { do: 'idle' } | { do: 'evaluate' } | { do: 'prepare' } | { do: 'pause'; reason: string };

/** The next thing the driver does for one draft. A quota wait is left to the step, and a draft the driver paused stays paused. */
export function nextHeal(view: HealView): HealAction {
  if (view.busy || view.started || view.staged || view.paused) return { do: 'idle' };
  if (view.cycle) return decide(view.cycle, 'evaluate');
  if (view.speckit) return decide(view.speckit, 'prepare');
  return { do: 'idle' };
}

function decide(failure: HealFailure, retry: 'evaluate' | 'prepare'): HealAction {
  if (failure.kind === 'quota') return { do: 'idle' };
  const limit = HEAL_LIMITS[failure.kind];
  if (limit !== undefined && failure.attempts < limit) return { do: retry };
  return { do: 'pause', reason: failure.kind };
}

/** A journal event the driver reads: its sequence number, its type and its data. */
export interface HealEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

/** The failures in a row of the cycle and of the plan preparation, and whether the driver paused since the last one. */
export interface HealRuns {
  cycle?: HealFailure;
  speckit?: HealFailure;
  paused: boolean;
}

/** A cycle that finished, of any kind of draft: a round, a stage review or a stage moved on. */
const CYCLE_DONE: readonly string[] = [RefineEvent.Evaluated, RefineEvent.StageReviewed, RefineEvent.StageAdvanced];

/** Walks the journal once: a failure extends the run, a success ends it, and a pause after the last failure is the owner's to lift. */
export function healRunsOf(events: readonly HealEvent[]): HealRuns {
  let cycle: HealFailure | undefined;
  let speckit: HealFailure | undefined;
  let lastFailure = 0;
  let lastPause = 0;
  for (const e of events) {
    if (e.type === RefineEvent.CycleFailed) {
      cycle = run(cycle, kindOf(e.data), String(e.data.reason ?? ''));
      lastFailure = e.seq;
    } else if (CYCLE_DONE.includes(e.type)) {
      cycle = undefined;
    } else if (e.type === RefineEvent.SpeckitFailed) {
      speckit = run(speckit, kindOf(e.data), String(e.data.reason ?? ''));
      lastFailure = e.seq;
    } else if (e.type === RefineEvent.SpeckitDone || e.type === RefineEvent.PlansPrepared) {
      speckit = undefined;
    } else if (e.type === RefineEvent.AutopilotPaused) {
      lastPause = e.seq;
    }
  }
  return { cycle, speckit, paused: lastPause > lastFailure };
}

/** The run counts its failures in a row whatever their kinds, so an alternation of kinds reaches the limit too. */
function run(current: HealFailure | undefined, kind: HealKind, reason: string): HealFailure {
  return { kind, reason, attempts: (current?.attempts ?? 0) + 1 };
}
