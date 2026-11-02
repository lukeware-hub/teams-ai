import type { Style } from '../docs/layout.js';
import { commitProjection, DocsStoreError, openStore, pushWithRecovery } from '../docs/store.js';
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
      this.chain = this.chain.then(() => {
        this.queued = false;
        return this.run();
      });
    }
    return this.chain;
  }

  /** The registry tick: flushes when a boundary or a failure waits, and waits for a flush already in progress. */
  tick(): Promise<void> {
    return this.labels.length === 0 && this.lastError === null ? this.chain : this.flush();
  }

  /** Commits the projection and pushes it; the labels are cleared only when the push lands. */
  private async run(): Promise<void> {
    const seen = { pending: this.pending, labels: this.labels.length };
    try {
      const store = await openStore(this.input.ws, this.input.style, this.input.exec);
      const files = await projectDraftFiles(this.input.draft, this.input.style, this.input.aliases());
      const label = [...new Set(this.labels.slice(0, seen.labels))].join(', ') || FALLBACK_LABEL;
      const flushed = await commitProjection(store, { draftId: this.input.draft.specId, stepKey: 'docs', scope: 'refine', label, files });
      const refused = [...flushed.diverged, ...flushed.aliasTaken];
      if (refused.length > 0) throw new DocsStoreError(`the store changed under this draft (${refused.join(', ')})`);
      const pushed = await pushWithRecovery(store);
      if (!pushed.ok) throw new DocsStoreError(pushed.message);
      this.labels.splice(0, seen.labels);
      this.pending = Math.max(0, this.pending - seen.pending);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
