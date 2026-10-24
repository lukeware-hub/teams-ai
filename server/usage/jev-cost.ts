import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadEvents, type StoredEvent } from '../store/event-store.js';

// Same type strings in the refinement and run journals: the score of the documents, and each decision.
const DOCS_SCORED = 'REFINE_DOCS_SCORED';
const DECISION_MADE = 'DECISION_MADE';

async function subdirs(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

const usd = (cost: unknown): number => (typeof cost === 'number' && Number.isFinite(cost) ? cost : 0);

/** What one journaled event charged the Jev, in US$. */
function jevCharge(event: StoredEvent): number {
  if (event.type === DOCS_SCORED) return usd((event.data.usage as { costUsd?: unknown } | undefined)?.costUsd);
  if (event.type !== DECISION_MADE) return 0;
  const attempts = (event.data.record as { attempts?: Array<{ backend: string; usage: { costUsd?: unknown } | null }> } | undefined)?.attempts ?? [];
  return attempts.filter((a) => a.backend === 'jev').reduce((sum, a) => sum + usd(a.usage?.costUsd), 0);
}

/** The Jev's total cost in US$ across every project and spec: refinement journals first, then run journals. */
export async function jevCostUsd(workspacesRoot: string, runsRoot: string): Promise<number> {
  const refineDirs = (await Promise.all((await subdirs(workspacesRoot)).map((ws) => subdirs(path.join(ws, 'refine'))))).flat();
  const journals = [...refineDirs, ...(await subdirs(runsRoot))].map((dir) => path.join(dir, 'events.ndjson'));
  const logs = await Promise.all(journals.map((file) => loadEvents(file).catch(() => [])));
  return logs.flat().reduce((sum, event) => sum + jevCharge(event), 0);
}
