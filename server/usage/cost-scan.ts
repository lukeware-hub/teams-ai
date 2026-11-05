import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mergeSpecs, projectDirs, SAFE_ID } from '../api/run-index.js';
import { ChatStore } from '../chat/store.js';
import type { Config } from '../config/config.js';
import { parseRunId } from '../core/ids.js';
import { expandHome } from '../orchestrator/workspace.js';
import { loadEvents, type StoredEvent } from '../store/event-store.js';
import { factsOfChat, factsOfJournal, type JournalContext } from './cost-facts.js';
import type { CostFact } from './cost-types.js';

export interface CostScan {
  facts: CostFact[];
  projects: Array<{ projectId: string; name: string }>;
  /** Journals that exist but could not be read; their cost is missing from `facts`. */
  unreadJournals: number;
}

export interface CostScanner {
  scan(): Promise<CostScan>;
}

interface Cached {
  size: number;
  mtimeMs: number;
  facts: CostFact[];
}

const subdirs = async (root: string): Promise<string[]> =>
  (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && SAFE_ID.test(e.name)).map((e) => e.name);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Reads every journal and chat on disk into cost facts. It only reads: it never calls the run index's liveness check, which
 * renames a pid file. A journal that cannot be read is counted, never hidden. A journal is read again only when its size or
 * its time changed.
 */
export function createCostScanner(deps: { config: () => Promise<Config>; chatsDir: string }): CostScanner {
  const cache = new Map<string, Cached>();

  /** The facts of one journal, or null when the file exists and cannot be read. */
  async function readJournal(file: string, contextOf: (events: StoredEvent[]) => JournalContext): Promise<CostFact[] | null> {
    const stat = await fs.stat(file).catch(() => null);
    if (stat === null) return [];
    const hit = cache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.facts;
    try {
      const events = await loadEvents(file);
      const facts = factsOfJournal(events, contextOf(events));
      cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, facts });
      return facts;
    } catch {
      return null;
    }
  }

  return {
    async scan(): Promise<CostScan> {
      const cfg = await deps.config();
      const workspaces = expandHome(cfg.paths.workspaces);
      const runs = expandHome(cfg.paths.runs);
      const catalog = new Map<string, { name: string; repositories: Map<string, string | null> }>();
      for (const [projectId, entries] of await projectDirs({ cfg })) {
        catalog.set(projectId, {
          name: entries[0]!.read.project.name,
          repositories: new Map(mergeSpecs(entries).map((s) => [s.specId, s.repository ?? null])),
        });
      }

      const facts: CostFact[] = [];
      let unreadJournals = 0;
      const take = (read: CostFact[] | null) => {
        if (read === null) unreadJournals += 1;
        else facts.push(...read);
      };

      for (const projectId of await subdirs(workspaces)) {
        const refine = path.join(workspaces, projectId, 'refine');
        for (const draftId of await subdirs(refine)) {
          take(await readJournal(path.join(refine, draftId, 'events.ndjson'), () => ({ stage: 'refinement', projectId, specId: draftId, runId: null })));
        }
      }

      for (const runId of await subdirs(runs)) {
        const parsed = parseRunId(runId);
        take(
          await readJournal(path.join(runs, runId, 'events.ndjson'), (events) => {
            const started = events.find((e) => e.type === 'RUN_STARTED');
            return {
              stage: 'development',
              projectId: parsed?.projectId ?? text(started?.data.projectId),
              specId: parsed?.specId ?? text(started?.data.specId),
              runId,
            };
          }),
        );
      }

      const chats = new ChatStore(deps.chatsDir);
      for (const projectId of catalog.keys()) facts.push(...factsOfChat(projectId, await chats.read(projectId)));

      const withRepository = (f: CostFact): CostFact => {
        if (f.repository !== null || f.projectId === null || f.specId === null) return f;
        return { ...f, repository: catalog.get(f.projectId)?.repositories.get(f.specId) ?? null };
      };
      return {
        facts: facts.map(withRepository),
        projects: [...catalog].map(([projectId, c]) => ({ projectId, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
        unreadJournals,
      };
    },
  };
}
