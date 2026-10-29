import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';

/** The owner's answer to a block: the run and task it answers, the question asked and the choice made. */
export interface OwnerDecision {
  runId: string;
  taskId: string;
  question: string;
  answer: string;
}

/** Kept outside `docs/`, which Phase 0 publishes to main; one file per spec, beside its repair notes. */
export const ownerDecisionsFile = (root: string, specId: string): string => path.posix.join(root, 'decisions', `${specId}.json`);

export const readOwnerDecisions = (root: string, specId: string): Promise<OwnerDecision[]> =>
  fs.readFile(ownerDecisionsFile(root, specId), 'utf8').then((text) => JSON.parse(text) as OwnerDecision[]).catch(() => []);

/** Stores the answers, each replacing the earlier answer to the same question of the same run. */
export async function recordOwnerDecisions(root: string, specId: string, answers: readonly OwnerDecision[]): Promise<void> {
  const kept = (await readOwnerDecisions(root, specId)).filter((d) => !answers.some((a) => a.runId === d.runId && a.taskId === d.taskId));
  await fs.mkdir(path.dirname(ownerDecisionsFile(root, specId)), { recursive: true });
  await writeFileAtomic(ownerDecisionsFile(root, specId), `${JSON.stringify([...kept, ...answers], null, 2)}\n`);
}

/** The owner's answers as assumptions that every step reads first: each one is binding for the spec. */
export const ownerDecisionLines = (decisions: readonly OwnerDecision[]): string[] =>
  decisions.map((d) => `Owner decision (binding) for ${d.taskId}: ${d.question} → ${d.answer}`);
