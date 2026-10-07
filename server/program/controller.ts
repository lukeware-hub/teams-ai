/**
 * R11.4: the program controller. It takes a refined backlog from `planned` to delivered, one spec at a time, in rank and
 * dependency order. One at a time because the clone, the compose stack and the quota are shared; parallelism stays inside a
 * spec. The ledger (`Program`) is the only state: `tick` reads it, settles what is in flight, starts the next item and
 * writes it back before it launches anything, so a restart finds the claim and adopts the run instead of starting another.
 * A failed spec is isolated: its dependents are blocked, everything independent of it keeps going (the Jev repair loop is R11.5).
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
  /** The process is gone and the journal never finished: resumable. */
  | { kind: 'interrupted' }
  /** The run ended `awaiting-validation` with no blocked task: ready to complete. */
  | { kind: 'delivered' }
  /** A `complete` run ended `done`. */
  | { kind: 'done' }
  | { kind: 'failed'; reason: string };

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
}

export interface ProgramEntry {
  specId: string;
  key: string;
  rank: number;
  dependsOn: string[];
}

export const MAX_RESUMES = 3;

export function newProgram(draftId: string, entries: readonly ProgramEntry[], now: Date): Program {
  const items = [...entries].sort((a, b) => a.rank - b.rank).map((e): ProgramItem => ({ ...e, dependsOn: [...e.dependsOn], status: 'pending', runId: null, completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 }));
  return { version: 1, draftId, status: 'running', items, updatedAt: now.toISOString() };
}

/**
 * R11.4 continuation: clears a `failed` item back to `pending` so the next `tick()` gives it another try, and
 * un-blocks whatever was `blocked` on it (or transitively on those), letting `tick()`'s own block-detection pass
 * re-derive who is still blocked by another cause. No cause classification, no replanning: a human or a future Jev
 * routing (R11.5/R11.5a) decides whether a retry is warranted; this only clears the ledger for one.
 */
export function retryItem(program: Program, specId: string, now: Date): Program {
  const p: Program = structuredClone(program);
  const item = p.items.find((i) => i.specId === specId);
  if (!item) throw new RangeError(`unknown spec ${specId}`);
  if (item.status !== 'failed') throw new RangeError(`item ${specId} is not failed (it is ${item.status})`);
  Object.assign(item, { status: 'pending', runId: null, completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 });
  for (const i of p.items) if (i.status === 'blocked') Object.assign(i, { status: 'pending', reason: null, finishedAt: null });
  p.status = 'running';
  p.updatedAt = now.toISOString();
  return p;
}

const IN_FLIGHT: ReadonlySet<ItemStatus> = new Set(['running', 'completing']);
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
  const fail = (item: ProgramItem, reason: string) => {
    item.status = 'failed';
    item.reason = reason;
    item.finishedAt = stamp();
    dirty = true;
  };
  const resume = async (item: ProgramItem, runId: string, what: string) => {
    if (item.resumes >= MAX_RESUMES) return fail(item, `${what} interrupted ${MAX_RESUMES} times and was not finished`);
    item.resumes += 1;
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
      if (o.kind === 'failed') fail(item, o.reason);
      else if (o.kind === 'interrupted') await resume(item, item.runId, 'the run');
      else if (o.kind === 'delivered') {
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
        dirty = true;
      } else if (o.kind === 'failed') fail(item, `completion failed: ${o.reason}`);
      else if (o.kind === 'interrupted') await resume(item, item.completeRunId, 'the completion');
    }
  }

  // A dependent of a failed or blocked item can never run: block it, transitively.
  for (let changed = true; changed; ) {
    changed = false;
    for (const item of p.items) {
      if (item.status !== 'pending') continue;
      const bad = item.dependsOn.map((d) => p.items.find((i) => i.specId === d)).find((d) => d !== undefined && (d.status === 'failed' || d.status === 'blocked'));
      if (!bad) continue;
      item.status = 'blocked';
      item.reason = `depends on ${bad.key}, which ${bad.status === 'failed' ? 'failed' : 'is blocked'}`;
      item.finishedAt = stamp();
      changed = dirty = true;
    }
  }

  // Nothing in flight: the first pending item by rank whose dependencies are all done.
  while (!p.items.some((i) => IN_FLIGHT.has(i.status))) {
    const next = p.items.find((i) => i.status === 'pending' && i.dependsOn.every((d) => p.items.find((x) => x.specId === d)?.status === 'done'));
    if (!next) break;
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
