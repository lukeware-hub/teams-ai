import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import type { DocFile } from './draft.js';

/** The PO decides one open question for the owner, who gave the team full autonomy: the decision goes into the right document as an assumption. */
export function decideQuestionPack(input: { specHash: string; question: string; file?: DocFile }): ContextPackInput {
  const feedback = [
    'The owner gave you full autonomy: decide this open question yourself, using what the documents say (docs/project.md, briefing.md, stack.md, flow.md, design.md, which you can read) and choosing what you would recommend.',
    `Question: ${input.question}`,
    'Write the decision into the right document as a docPatch, as `Assumption: <claim>. Reason: <why>.` Return no question and an empty checklist. Write everything in Brazilian Portuguese.',
    ...(input.file ? [`Change only docs/${input.file}: a docPatch to any other document is discarded.`] : []),
  ].join('\n');
  return { kind: 'refine', role: 'po', specHash: input.specHash, principles: [], outputContract: outputContract('refine'), criteria: [], feedback, budgetTokens: 30_000 };
}
