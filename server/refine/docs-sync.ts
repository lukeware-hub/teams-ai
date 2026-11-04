import { loadSecretValues } from '../core/secrets.js';
import type { Style } from '../docs/layout.js';
import { readClosingRecord, removeClosingRecord, writeClosingRecord } from '../docs/project-state.js';
import { closeRefinement, commitProjection, createStartTags, DocsStoreError, openStore, pushDocuments, recordPublishedSha, retireAliases, type Store } from '../docs/store.js';
import type { Exec } from '../exec/command.js';
import { aheadCount } from '../git/git.js';
import { readUserConfig } from '../onboarding/config-store.js';
import { expandHome, type Workspace } from '../orchestrator/workspace.js';
import { baseAliases, draftBases, projectDraftFiles, type SpecAlias } from './docs-projection.js';
import type { Draft } from './draft.js';

/** What the session shows of the sync: the changes waiting for a push, and the last failure, in plain words. */
export interface DocsSyncView {
  pending: number;
  lastError: string | null;
  /** True when lastError is the store's refusal, which names its documents in plain words. */
  refused: boolean;
  /** Failures in a row: the page shows a failure only once the automatic retries did not settle it. */
  failures?: number;
}

export interface DocsSyncInput {
  ws: Workspace;
  draft: Draft;
  style: Style;
  exec: Exec;
  /** The specs the draft owns, read at each flush. */
  aliases: () => SpecAlias[] | Promise<SpecAlias[]>;
  /** The secrets directories whose values a flush refuses to commit; the project's and the platform's by default. */
  secretDirs?: () => Promise<string[]>;
  /** The timer of the push debounce; the system timer by default. */
  timer?: PushTimer;
  /** The clock of the retry cadence, in milliseconds; the system clock by default. */
  clock?: () => number;
}

/** The timer that runs a debounced push. */
export interface PushTimer {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const systemTimer: PushTimer = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A normal flush's push waits this long for the next flush, so a burst goes out as one push. */
const PUSH_DEBOUNCE_MS = 3_000;

/** A failed sync is retried at most this often. */
const RETRY_MS = 60_000;

/** The boundaries whose push goes out at once. */
const IMMEDIATE_LABELS = ['plans prepared'];

const FALLBACK_LABEL = 'documents synced';

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The project's secrets directory and the platform's, from the user configuration. */
async function defaultSecretDirs(ws: Workspace): Promise<string[]> {
  const { cfg } = await readUserConfig();
  return [ws.secrets, expandHome(cfg.paths.secrets)];
}

/** Names the documents the store refused; the others are already published. */
const refusedMessage = (refused: string[]): string =>
  `Não publicado: o documento ${refused.join(', ')} mudou na loja; os outros foram publicados.`;

/** Flushes one draft's documents to its store: a boundary waits for the tick, and a failed flush is retried there. */
export class DocsSync {
  /** The changes not yet pushed, committed or not. */
  private pending = 0;
  /** The part of pending that is committed but not pushed yet. */
  private committedPending = 0;
  /** The labels of the commits not pushed yet; they leave the list with the push. */
  private labels: string[] = [];
  private committedLabels = 0;
  private lastError: string | null = null;
  /** Set by a run the store refused; only a run without a refusal clears it. */
  private refused = false;
  private failures = 0;
  /** Set when a reset dropped local commits, so the next tick projects them again. */
  private resync = false;
  private lastRetryAt = -Infinity;
  private queued = false;
  private chain: Promise<void> = Promise.resolve();
  private pushHandle: unknown = null;

  constructor(private readonly input: DocsSyncInput) {}

  get view(): DocsSyncView {
    return { pending: this.pending, lastError: this.lastError, refused: this.refused, failures: this.failures };
  }

  /** A document changed; it rides the next boundary. */
  edit(): void {
    this.pending += 1;
  }

  /** A boundary: its commit is made at the next tick, with this label. */
  boundary(label: string): void {
    this.pending += 1;
    this.labels.push(label);
  }

  /** The first publication after a bind: pushes at once, and connects the repository when it is not connected yet. */
  publish(): Promise<void> {
    return this.enqueue(() => this.pushLocal());
  }

  /** One flush after the ones already queued; a flush not started yet takes every change made before it starts. */
  flush(): Promise<void> {
    if (!this.queued) {
      this.queued = true;
      this.enqueue(() => {
        this.queued = false;
        return this.run();
      });
    }
    return this.chain;
  }

  /** The closing of the refinement: the flush, the closing commit, its push and the snapshot. It throws, and launches nothing, when one fails. */
  close(aliases: readonly string[]): Promise<void> {
    const done = this.chain.then(() => this.closeNow(aliases));
    this.chain = done.catch(() => undefined);
    return done;
  }

  /** A discarded draft that never started: its alias folders leave the store, and the removal is published. */
  retire(): Promise<void> {
    const done = this.chain.then(() => this.retireNow());
    this.chain = done.catch(() => undefined);
    return done;
  }

  /** Drops the closing of a launch that never happened, so no start tag is ever published for it. */
  discardClosing(): Promise<void> {
    return this.enqueue(() => removeClosingRecord(this.input.ws, this.input.draft.specId).catch((err) => console.error(`closing of ${this.input.draft.specId}: ${messageOf(err)}`)));
  }

  /** The start tags of the closing, published once on the serial chain; a failure keeps them pending for the next tick and never fails the start. */
  publishTags(): Promise<void> {
    return this.enqueue(() => this.publishPendingTags());
  }

  private async publishPendingTags(): Promise<void> {
    const { ws, draft, style, exec } = this.input;
    try {
      const record = await readClosingRecord(ws, draft.specId);
      if (record === null || record.pendingTags.length === 0) return;
      const { pushed } = await createStartTags(await openStore(ws, style, exec), record.aliases, record.commit);
      if (!pushed) throw new DocsStoreError('the start tags could not be published');
      await writeClosingRecord(ws, draft.specId, { ...record, pendingTags: [] });
    } catch (err) {
      console.error(`start tags of ${draft.specId}: ${messageOf(err)}`);
    }
  }

  /** The registry tick: a dropped projection is made again, a failed push is retried at most once a minute, and a pending boundary is flushed. */
  tick(): Promise<void> {
    if (this.resync) return this.retryDue() ? this.flush() : this.chain;
    if (this.lastError !== null && this.committedPending > 0) return this.retryDue() ? this.enqueue(() => this.pushLocal()) : this.chain;
    if (this.labels.length > this.committedLabels) return this.flush();
    if (this.lastError !== null) return this.retryDue() ? this.enqueue(() => this.pushLocal()) : this.chain;
    return this.chain;
  }

  /** Whether a retry may run now: one retry at most every RETRY_MS. */
  private retryDue(): boolean {
    const now = (this.input.clock ?? Date.now)();
    if (now - this.lastRetryAt < RETRY_MS) return false;
    this.lastRetryAt = now;
    return true;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task);
    return this.chain;
  }

  private async retireNow(): Promise<void> {
    const { ws, draft, style, exec } = this.input;
    const store = await openStore(ws, style, exec);
    const flushed = await retireAliases(store, draft.specId, await baseAliases(draft));
    if (flushed.sha !== null) await this.push(store);
  }

  private async closeNow(aliases: readonly string[]): Promise<void> {
    const { ws, draft, style, exec } = this.input;
    const store = await openStore(ws, style, exec);
    const files = await projectDraftFiles(draft, style, await this.input.aliases());
    const projection = { draftId: draft.specId, stepKey: 'close', scope: 'refine', label: 'refinement closed', files, bases: await draftBases(draft), known: await this.knownSecrets() };
    await closeRefinement(ws, store, projection, { summary: `development starts: ${aliases.join(', ')}`, aliases });
    this.labels = [];
    this.committedLabels = 0;
    this.pending = 0;
    this.committedPending = 0;
    this.refused = false;
    this.resync = false;
    this.lastError = null;
    this.failures = 0;
  }

  /** The secret values a flush must not commit, read at each flush. */
  private async knownSecrets(): Promise<string[]> {
    const dirs = await (this.input.secretDirs ?? (() => defaultSecretDirs(this.input.ws)))();
    return (await Promise.all(dirs.map((dir) => loadSecretValues(dir)))).flat();
  }

  /** Pushes the commits already local, and projects no document: an edit alone waits for a boundary; a failure stays while a change is pending or a document is refused. */
  private async pushLocal(): Promise<void> {
    if (this.resync) return;
    try {
      const store = await openStore(this.input.ws, this.input.style, this.input.exec);
      // Nothing ahead of origin main: every local commit is already published, so the network push is skipped.
      if ((await aheadCount(store.dir, 'origin/main', this.input.exec)) === 0) {
        await recordPublishedSha(this.input.ws, store);
        this.published();
      } else await this.push(store);
      if (this.pending === 0 && !this.refused) this.lastError = null;
    this.failures = 0;
    } catch (err) {
      this.refused = false;
      this.fail(err);
    }
  }

  /** A failure that is not a refusal: kept for the retry, and counted so the page stays quiet until it repeats. */
  private fail(err: unknown): void {
    this.failures += 1;
    this.lastError = messageOf(err);
  }

  /** Pushes the local commits; a push that leaves them out of origin keeps them pending and asks for a projection on the next tick. */
  private async push(store: Store): Promise<void> {
    const pushed = await pushDocuments(this.input.ws, store);
    if (!pushed.ok) {
      if (pushed.kind === 'busy') {
        this.resync = true;
        this.committedLabels = 0;
        this.committedPending = 0;
      }
      throw new DocsStoreError(pushed.message);
    }
    this.published();
  }

  /** A push went out: the commits made before it are published, and their labels and changes leave the pending count. */
  private published(): void {
    this.labels.splice(0, this.committedLabels);
    this.committedLabels = 0;
    this.pending = Math.max(0, this.pending - this.committedPending);
    this.committedPending = 0;
  }

  /** A normal flush's push waits for the debounce time; a newer flush restarts the wait, so the burst goes out as one push. */
  private schedulePush(): void {
    const timer = this.input.timer ?? systemTimer;
    timer.clear(this.pushHandle);
    this.pushHandle = timer.set(() => {
      this.pushHandle = null;
      void this.enqueue(() => this.pushLocal());
    }, PUSH_DEBOUNCE_MS);
  }

  /** Commits the projection and pushes it; the labels and the pending count stay until the push lands, and a refused document keeps the labels for the next flush. */
  private async run(): Promise<void> {
    this.refused = false;
    this.resync = false;
    try {
      const store = await openStore(this.input.ws, this.input.style, this.input.exec);
      const seen = { pending: this.pending, labels: this.labels.length };
      const files = await projectDraftFiles(this.input.draft, this.input.style, await this.input.aliases());
      const label = [...new Set(this.labels.slice(0, seen.labels))].join(', ') || FALLBACK_LABEL;
      const flushed = await commitProjection(store, { draftId: this.input.draft.specId, stepKey: 'docs', scope: 'refine', label, files, bases: await draftBases(this.input.draft), known: await this.knownSecrets() });
      const refused = [...flushed.diverged, ...flushed.aliasTaken];
      const immediate = this.labels.slice(0, seen.labels).some((name) => IMMEDIATE_LABELS.includes(name));
      if (refused.length === 0) {
        this.committedLabels = seen.labels;
        this.committedPending = seen.pending;
      }
      if (immediate) await this.push(store);
      else this.schedulePush();
      if (refused.length > 0) {
        this.refused = true;
        this.lastError = refusedMessage(refused);
        return;
      }
      this.lastError = null;
    this.failures = 0;
    } catch (err) {
      this.fail(err);
    }
  }
}
