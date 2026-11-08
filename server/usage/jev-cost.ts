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

/** The token counts and cost one Jev call reports; a null cost counts as zero. */
interface JevUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

/** The usage of each Jev attempt that one journaled decision carries; any other event carries none. */
export function jevUsages(event: StoredEvent): JevUsage[] {
  if (event.type !== DECISION_MADE) return [];
  const attempts = (event.data.record as { attempts?: Array<{ backend: string; usage?: JevUsage | null }> } | undefined)?.attempts ?? [];
  return attempts.flatMap((a) => (a.backend === 'jev' && a.usage ? [a.usage] : []));
}

/** What one journaled event charged the Jev, in US$. */
export function jevCharge(event: StoredEvent): number {
  if (event.type === DOCS_SCORED) return usd((event.data.usage as { costUsd?: unknown } | undefined)?.costUsd);
  return jevUsages(event).reduce((sum, u) => sum + usd(u.costUsd), 0);
}

/** The Jev's total cost in US$ across every project and spec: refinement journals first, then run journals. */
export async function jevCostUsd(workspacesRoot: string, runsRoot: string): Promise<number> {
  const refineDirs = (await Promise.all((await subdirs(workspacesRoot)).map((ws) => subdirs(path.join(ws, 'refine'))))).flat();
  const journals = [...refineDirs, ...(await subdirs(runsRoot))].map((dir) => path.join(dir, 'events.ndjson'));
  const logs = await Promise.all(journals.map((file) => loadEvents(file).catch(() => [])));
  return logs.flat().reduce((sum, event) => sum + jevCharge(event), 0);
}
