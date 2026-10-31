import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';

/** The owner's answer to a block: the run, task and spec version it answers, the question asked and the choice made. */
export interface OwnerDecision {
  runId: string;
  taskId: string;
  specHash: string;
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

/** The owner's answer to one question of one run and task, or null while it waits. */
export const ownerAnswer = (decisions: readonly OwnerDecision[], runId: string, taskId: string, question: string): string | null =>
  decisions.find((d) => d.runId === runId && d.taskId === taskId && d.question === question)?.answer ?? null;

/** The answers given for this spec version, as assumptions every step reads first; an answer for another version does not carry over. */
export const ownerDecisionLines = (decisions: readonly OwnerDecision[], specHash: string): string[] =>
  decisions.filter((d) => d.specHash === specHash).map((d) => `Owner decision (binding) for ${d.taskId}: ${d.question} → ${d.answer}`);
