import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';

/** R11.5.7: the owner role answers a blocking question from the five documents alone, or returns null when they do not settle it. */
export function answerPack(input: { specHash: string; role: 'po' | 'sm'; question: string; docs: { projectMd: string; briefMd: string; stackMd: string; flowMd: string; designMd: string } }): ContextPackInput {
  const feedback = [
    'Answer the refinement question below only with what the documents already state, in Brazilian Portuguese, in one or two sentences that name the document and the section the answer comes from.',
    'Return `answer: null` when the documents do not settle it, so the question goes to the human. Never make a product or technical choice the documents leave open. Do not edit any file.',
    `### Question\n${input.question}`,
    `### project.md\n${input.docs.projectMd}`,
    `### briefing.md\n${input.docs.briefMd}`,
    `### stack.md\n${input.docs.stackMd}`,
    `### flow.md (Mermaid)\n${input.docs.flowMd}`,
    `### design.md\n${input.docs.designMd}`,
  ].join('\n\n');
  return { kind: 'answer', role: input.role, specHash: input.specHash, principles: [], outputContract: outputContract('answer'), criteria: [], feedback, budgetTokens: 30_000 };
}
