import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';

/** Outside `docs/`, which Phase 0 publishes to main. */
export const repairNotesFile = (root: string, specId: string): string => path.posix.join(root, 'repair', `${specId}.md`);

export async function writeRepairNotes(root: string, specId: string, failures: readonly string[]): Promise<void> {
  await fs.mkdir(path.dirname(repairNotesFile(root, specId)), { recursive: true });
  await writeFileAtomic(repairNotesFile(root, specId), `${failures.map((f, i) => `attempt ${i + 1} failed: ${f}`).join('\n')}\n`);
}

export const readRepairNotes = (root: string, specId: string): Promise<string | null> => fs.readFile(repairNotesFile(root, specId), 'utf8').catch(() => null);

/** The assumptions a step sees: the failures of the earlier attempts first, then what this run logged. */
export const withRepairNotes = (notes: string | null | undefined, assumptions: readonly string[]): readonly string[] => (notes ? [`The earlier run of this spec failed, and this run must not repeat it:\n${notes.trim()}`, ...assumptions] : assumptions);
