import type { Style } from '../docs/layout.js';
import { readClosingRecord, removeClosingRecord, writeClosingRecord } from '../docs/project-state.js';
import { closeRefinement, commitProjection, createStartTags, DocsStoreError, openStore, pushWithRecovery, retireAliases, type Store } from '../docs/store.js';
import type { Exec } from '../exec/command.js';
import type { Workspace } from '../orchestrator/workspace.js';
import { projectDraftFiles, type SpecAlias } from './docs-projection.js';
import type { Draft } from './draft.js';

/** What the session shows of the sync: the changes waiting for a commit, and the last failure, in plain words. */
export interface DocsSyncView {
  pending: number;
  lastError: string | null;
}

export interface DocsSyncInput {
  ws: Workspace;
  draft: Draft;
  style: Style;
  exec: Exec;
  /** The specs the draft owns, read at each flush. */
  aliases: () => SpecAlias[];
}

const FALLBACK_LABEL = 'documents synced';

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Names the documents the store refused; the others are already published. */
const refusedMessage = (refused: string[]): string =>
  `Não publicado: o documento ${refused.join(', ')} mudou na loja; os outros foram publicados.`;

/** Pushes the local commits; a refusal is thrown in plain words. */
async function pushLocalCommits(store: Store): Promise<void> {
  const pushed = await pushWithRecovery(store);
  if (!pushed.ok) throw new DocsStoreError(pushed.message);
}

/** Flushes one draft's documents to its store: a boundary waits for the tick, and a failed flush is retried there. */
export class DocsSync {
  private pending = 0;
  private labels: string[] = [];
  private lastError: string | null = null;
  private queued = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly input: DocsSyncInput) {}

  get view(): DocsSyncView {
    return { pending: this.pending, lastError: this.lastError };
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

  /** The registry tick: a pending boundary is flushed again, and a failure without one only pushes the local commits. */
  tick(): Promise<void> {
    if (this.labels.length > 0) return this.flush();
    return this.lastError === null ? this.chain : this.enqueue(() => this.pushLocal());
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task);
    return this.chain;
  }

  private async retireNow(): Promise<void> {
    const { ws, draft, style, exec } = this.input;
    const store = await openStore(ws, style, exec);
    const flushed = await retireAliases(store, draft.specId);
    if (flushed.sha !== null) await pushLocalCommits(store);
  }

  private async closeNow(aliases: readonly string[]): Promise<void> {
    const { ws, draft, style, exec } = this.input;
    const store = await openStore(ws, style, exec);
    const files = await projectDraftFiles(draft, style, this.input.aliases());
    const projection = { draftId: draft.specId, stepKey: 'close', scope: 'refine', label: 'refinement closed', files };
    await closeRefinement(ws, store, projection, { summary: `development starts: ${aliases.join(', ')}`, aliases });
    this.labels = [];
    this.pending = 0;
    this.lastError = null;
  }

  /** Pushes the commits already local, and projects no document: an edit alone waits for a boundary. */
  private async pushLocal(): Promise<void> {
    try {
      await pushLocalCommits(await openStore(this.input.ws, this.input.style, this.input.exec));
      this.lastError = null;
    } catch (err) {
      this.lastError = messageOf(err);
    }
  }

  /** Commits the projection and pushes it; the labels stay while a document is refused, so the next flush tries it again. */
  private async run(): Promise<void> {
    try {
      const store = await openStore(this.input.ws, this.input.style, this.input.exec);
      const seen = { pending: this.pending, labels: this.labels.length };
      const files = await projectDraftFiles(this.input.draft, this.input.style, this.input.aliases());
      const label = [...new Set(this.labels.slice(0, seen.labels))].join(', ') || FALLBACK_LABEL;
      const flushed = await commitProjection(store, { draftId: this.input.draft.specId, stepKey: 'docs', scope: 'refine', label, files });
      const refused = [...flushed.diverged, ...flushed.aliasTaken];
      await pushLocalCommits(store);
      if (refused.length > 0) {
        this.lastError = refusedMessage(refused);
        return;
      }
      this.labels.splice(0, seen.labels);
      this.pending = Math.max(0, this.pending - seen.pending);
      this.lastError = null;
    } catch (err) {
      this.lastError = messageOf(err);
    }
  }
}
