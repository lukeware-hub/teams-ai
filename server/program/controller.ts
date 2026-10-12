/**
 * R11.4: the program controller. It takes a refined backlog from `planned` to delivered, in rank and dependency order,
 * up to `MAX_PARALLEL` specs at once. Two specs run together only when the SM's conflict map says they touch different
 * code, and never before the first spec (the project's foundation) is done; the clone and the deploy stack are guarded by
 * file locks in the runs themselves. The ledger (`Program`) is the only state: `tick` reads it, settles what is in flight, starts the next item and
 * writes it back before it launches anything, so a restart finds the claim and adopts the run instead of starting another.
 * A failed spec is isolated: its dependents wait while it is repaired (R11.14, bounded by MAX_REPAIRS) and are blocked once it stays failed; everything independent of it keeps going.
 */

export type ItemStatus = 'pending' | 'running' | 'completing' | 'done' | 'failed' | 'blocked';

export interface ProgramItem {
  specId: string;
  key: string;
  rank: number;
  dependsOn: string[];
  status: ItemStatus;
  /** The run that delivers the spec; null until launched (or adopted after a crash). */
  runId: string | null;
  /** The `spec complete` run that marks it done on main. */
  completeRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  reason: string | null;
  /** Resumes of an interrupted run so far. */
  resumes: number;
  /** Sum of the delivering run's and (once it runs) the `spec complete` run's cost; null until the first one finishes. */
  costUsd: number | null;
  /** Specs it must never run beside, from the SM's conflict map; absent means it runs alone. */
  conflictsWith?: string[];
  /** Asked to run now: it goes ahead of the queue at the next free slot. */
  priority?: boolean;
  /** Automatic repairs so far (R11.14); absent in a ledger written before them. */
  repairs?: number;
  /** The failure of each attempt, oldest first; the next run reads them. */
  failures?: string[];
}

export interface Program {
  version: 1;
  draftId: string;
  status: 'running' | 'finished';
  items: ProgramItem[];
  updatedAt: string;
}

export type RunOutcome =
  | { kind: 'running' }
  /** The process is gone and the journal never finished: resumable. `restart`: it died with the server, not on its own. */
  | { kind: 'interrupted'; restart?: boolean }
  /** The run ended `awaiting-validation` with no blocked task: ready to complete. */
  | { kind: 'delivered'; costUsd?: number | null }
  /** A `complete` run ended `done`. */
  | { kind: 'done'; costUsd?: number | null }
  | { kind: 'failed'; reason: string; costUsd?: number | null };

export interface ProgramEffects {
  now(): Date;
  /** A run of this spec that is still live or resumable, or null. */
  findActiveRun(specId: string): Promise<string | null>;
  /** Freezes the item's spec and launches its run. */
  startRun(specId: string): Promise<{ runId: string }>;
  resumeRun(runId: string): Promise<void>;
  /** Marks the delivered spec ready to complete and launches the `spec complete` run. */
  completeSpec(specId: string): Promise<{ runId: string }>;
  outcome(runId: string): Promise<RunOutcome>;
  /** Whether another run can fix this failure; when it can, it also hands the failures to that run. Absent: a failure is final. */
  repair?(specId: string, failures: readonly string[]): Promise<boolean>;
}

export interface ProgramEntry {
  specId: string;
  key: string;
  rank: number;
  dependsOn: string[];
  /** Delivered before this program (R11.7.2): it starts done and never runs again. */
  done?: boolean;
  conflictsWith?: string[];
}

export const MAX_RESUMES = 3;
/** Automatic repairs of one failed spec; after them the owner decides. */
export const MAX_REPAIRS = 2;
/** Specs running at once: each run already uses several Claude processes, so two keep the quota and merges calm. */
export const MAX_PARALLEL = 2;

export function newProgram(draftId: string, entries: readonly ProgramEntry[], now: Date): Program {
  const items = [...entries].sort((a, b) => a.rank - b.rank).map(({ done, ...e }): ProgramItem => ({ ...e, dependsOn: [...e.dependsOn], status: done ? 'done' : 'pending', runId: null, completeRunId: null, startedAt: null, finishedAt: done ? now.toISOString() : null, reason: null, resumes: 0, costUsd: null }));
  return { version: 1, draftId, status: 'running', items, updatedAt: now.toISOString() };
}

/**
 * R11.4 continuation: clears a `failed` item back to `pending` so the next `tick()` gives it another try, and
 * un-blocks whatever was `blocked` on it (or transitively on those), letting `tick()`'s own block-detection pass
 * re-derive who is still blocked by another cause. No cause classification, no replanning: a human or a future Jev
 * routing (R11.5/R11.5a) decides whether a retry is warranted; this only clears the ledger for one.
 */
/**
 * Puts an item ahead of the queue, a failed one retried first: the next `tick()` starts it at the first free slot it does
 * not conflict with. A blocked item cannot run until its dependency does, and says why.
 */
export function prioritizeItem(program: Program, specId: string, now: Date): Program {
  const found = program.items.find((i) => i.specId === specId);
  if (!found) throw new RangeError(`unknown spec ${specId}`);
  const p = found.status === 'failed' ? retryItem(program, specId, now) : structuredClone(program);
  const item = p.items.find((i) => i.specId === specId)!;
  if (item.status !== 'pending') throw new RangeError(`item ${specId} is ${item.status}${item.reason ? `: ${item.reason}` : ''}`);
  item.priority = true;
  p.updatedAt = now.toISOString();
  return p;
}

const clearForRetry = (item: ProgramItem) => Object.assign(item, { status: 'pending', runId: null, completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 });

export function retryItem(program: Program, specId: string, now: Date): Program {
  const p: Program = structuredClone(program);
  const item = p.items.find((i) => i.specId === specId);
  if (!item) throw new RangeError(`unknown spec ${specId}`);
  if (item.status !== 'failed') throw new RangeError(`item ${specId} is not failed (it is ${item.status})`);
  Object.assign(clearForRetry(item), { repairs: 0, failures: [] });
  for (const i of p.items) if (i.status === 'blocked') Object.assign(i, { status: 'pending', reason: null, finishedAt: null });
  p.status = 'running';
  p.updatedAt = now.toISOString();
  return p;
}

const IN_FLIGHT: ReadonlySet<ItemStatus> = new Set(['running', 'completing']);
/** Two items may run together only when both carry a conflict map and neither names the other. */
const compatible = (a: ProgramItem, b: ProgramItem) => !!a.conflictsWith && !!b.conflictsWith && !a.conflictsWith.includes(b.specId) && !b.conflictsWith.includes(a.specId);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One reconciliation step. Returns the new ledger; `save` is called whenever it changes, before any launch that follows. */
export async function tick(program: Program, fx: ProgramEffects, save: (p: Program) => Promise<void>): Promise<Program> {
  const p: Program = structuredClone(program);
  const stamp = () => fx.now().toISOString();
  const persist = async () => {
    p.updatedAt = stamp();
    await save(p);
  };
  let dirty = false;
  const addCost = (item: ProgramItem, costUsd: number | null | undefined) => {
    if (costUsd == null) return;
    item.costUsd = (item.costUsd ?? 0) + costUsd;
  };
  const fail = (item: ProgramItem, reason: string, costUsd?: number | null) => {
    item.status = 'failed';
    item.reason = reason;
    item.finishedAt = stamp();
    addCost(item, costUsd);
    dirty = true;
  };
  // A failed delivering run goes again with its failures while it has repairs left; an unwilling or broken repair leaves it failed.
  const failOrRepair = async (item: ProgramItem, reason: string, costUsd?: number | null) => {
    const repairs = item.repairs ?? 0;
    const failures = [...(item.failures ?? []), reason];
    if (fx.repair && repairs < MAX_REPAIRS && (await fx.repair(item.specId, failures).catch(() => false))) {
      addCost(item, costUsd);
      Object.assign(clearForRetry(item), { repairs: repairs + 1, failures });
      dirty = true;
    } else fail(item, repairs > 0 ? `${reason}; ${repairs} reparo(s) automático(s) não resolveram` : reason, costUsd);
  };
  // A run the server's own restart killed is resumed for free: only runs that die on their own spend the bounded resumes.
  const resume = async (item: ProgramItem, runId: string, what: string, restart = false) => {
    if (!restart && item.resumes >= MAX_RESUMES) return fail(item, `${what} interrupted ${MAX_RESUMES} times and was not finished`);
    if (!restart) item.resumes += 1;
    dirty = true;
    await fx.resumeRun(runId).catch((err) => fail(item, `resume failed: ${message(err)}`));
  };

  for (const item of p.items) {
    if (item.status === 'running') {
      if (item.runId === null) {
        // A crash between the claim and the launch: adopt the run if it exists, otherwise launch it now.
        item.runId = await fx.findActiveRun(item.specId);
        if (item.runId === null) {
          try {
            item.runId = (await fx.startRun(item.specId)).runId;
          } catch (err) {
            fail(item, message(err));
          }
        }
        dirty = true;
        continue;
      }
      const o = await fx.outcome(item.runId);
      if (o.kind === 'failed') await failOrRepair(item, o.reason, o.costUsd);
      else if (o.kind === 'interrupted') await resume(item, item.runId, 'the run', o.restart);
      else if (o.kind === 'delivered') {
        addCost(item, o.costUsd);
        try {
          item.completeRunId = (await fx.completeSpec(item.specId)).runId;
          item.status = 'completing';
          dirty = true;
        } catch (err) {
          fail(item, `completion failed: ${message(err)}`);
        }
      }
    } else if (item.status === 'completing') {
      if (item.completeRunId === null) {
        try {
          item.completeRunId = (await fx.completeSpec(item.specId)).runId;
          dirty = true;
        } catch (err) {
          fail(item, `completion failed: ${message(err)}`);
        }
        continue;
      }
      const o = await fx.outcome(item.completeRunId);
      if (o.kind === 'done') {
        item.status = 'done';
        item.finishedAt = stamp();
        addCost(item, o.costUsd);
        dirty = true;
      } else if (o.kind === 'failed') fail(item, `completion failed: ${o.reason}`, o.costUsd);
      else if (o.kind === 'interrupted') await resume(item, item.completeRunId, 'the completion', o.restart);
    }
  }

  // A dependent of a failed or blocked item can never run, nor one whose dependency names no item: block it, transitively.
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of p.items) {
      if (item.status !== 'pending') continue;
      const unknown = item.dependsOn.find((d) => !p.items.some((i) => i.specId === d));
      const bad = item.dependsOn.map((d) => p.items.find((i) => i.specId === d)).find((d) => d !== undefined && (d.status === 'failed' || d.status === 'blocked'));
      if (!unknown && !bad) continue;
      item.status = 'blocked';
      item.reason = unknown ? `depends on ${unknown}, which names no item of this program` : `depends on ${bad!.key}, which ${bad!.status === 'failed' ? 'failed' : 'is blocked'}`;
      item.finishedAt = stamp();
      changed = dirty = true;
    }
  }

  // Fill the free slots: prioritized items first, then by rank, each with its dependencies done and no conflict in flight.
  // Until one spec is done, one runs alone: the first spec lays the project's foundation.
  for (;;) {
    const inFlight = p.items.filter((i) => IN_FLIGHT.has(i.status));
    const slots = p.items.some((i) => i.status === 'done') ? MAX_PARALLEL : 1;
    if (inFlight.length >= slots) break;
    const ready = p.items.filter((i) => i.status === 'pending' && i.dependsOn.every((d) => p.items.find((x) => x.specId === d)?.status === 'done'));
    const next = [...ready.filter((i) => i.priority), ...ready.filter((i) => !i.priority)].find((i) => inFlight.every((f) => compatible(i, f)));
    if (!next) break;
    delete next.priority;
    next.status = 'running';
    next.startedAt = stamp();
    await persist();
    dirty = false;
    try {
      next.runId = (await fx.startRun(next.specId)).runId;
    } catch (err) {
      fail(next, message(err));
    }
    await persist();
    dirty = false;
  }

  if (!p.items.some((i) => i.status === 'pending' || IN_FLIGHT.has(i.status)) && p.status !== 'finished') {
    p.status = 'finished';
    dirty = true;
  }
  if (dirty) await persist();
  return p;
}
