import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { stepId } from '../core/ids.js';
import type { SuggestOutput } from '../agents/outputs.js';
import type { StepOutcome } from '../runner/step.js';
import type { RunAgent } from './cycle.js';
import { fitPackBudget } from './fit-pack.js';
import { ownerFailure, TRY_AGAIN } from './agent-failure.js';
import { requestSuggestPack } from './suggest.js';

/** The part of the project's code graph that answers a question; empty when there is none. */
export type GraphContext = (question: string, budgetTokens: number) => Promise<string>;

const QUESTION_MAX = 600;
const GRAPH_BUDGET = 2_000;

/**
 * "Sugestão" of the new spec modal: one PO step that rewrites the typed text as a detailed spec, grounded in the project's
 * code graph. It runs before any draft exists, so it gets a throwaway directory under the workspaces root and an in-memory
 * journal. Nothing is saved: the user reviews the text in the modal.
 */
export async function suggestRequest(deps: { runAgent: RunAgent; workspacesRoot: string; graphContext?: GraphContext }, requestText: string): Promise<string> {
  const graphContext = (await deps.graphContext?.(requestText.slice(0, QUESTION_MAX), GRAPH_BUDGET).catch(() => '')) ?? '';
  const specHash = sha256(canonicalJson({ requestText, graphContext }));
  const cwd = path.join(deps.workspacesRoot, '_suggest', randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  let seq = 0;
  try {
    const out = (await deps.runAgent<'suggest'>(
      { kind: 'suggest', role: 'po', pack: fitPackBudget(requestSuggestPack({ specHash, requestText, graphContext })), cwd, phase: 'refine', taskId: null, attempt: 1 },
      { journal: { allocStepSeq: () => ++seq, fact: async () => undefined } as never, stepDir: (n) => path.join(cwd, 'steps', stepId(n)), specHash },
    )) as StepOutcome<SuggestOutput>;
    if (!out.ok) throw ownerFailure('A sugestão da spec', out.failure, out.errors, TRY_AGAIN);
    return out.value.text;
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
