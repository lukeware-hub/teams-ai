import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { briefTemplate, designTemplate, projectTemplate, stackTemplate, type DocFile } from './draft.js';

/** Every document but flow.md, which is the source the others are suggested from. */
export type SuggestFile = Exclude<DocFile, 'flow.md'>;

export const SUGGEST_ROLE: Record<SuggestFile, 'po' | 'sm' | 'front'> = { 'project.md': 'po', 'brief.md': 'po', 'stack.md': 'sm', 'design.md': 'front' };

const TEMPLATE: Record<SuggestFile, (projectId: string) => string> = { 'project.md': projectTemplate, 'brief.md': briefTemplate, 'stack.md': stackTemplate, 'design.md': designTemplate };

/** Refinement "Sugerir": one step that writes `file` in full from flow.md, keeping only what of the current text agrees with it. */
export function suggestPack(input: { file: SuggestFile; projectId: string; specHash: string; flowMd: string; currentMd: string }): ContextPackInput {
  const feedback = [
    `Write the complete docs/${input.file} in \`text\`, derived from docs/flow.md. flow.md is the source of truth: when the current ${input.file} disagrees with it, flow.md wins.`,
    '- Keep the headings of the template below.',
    `- Keep from the current ${input.file} only the decisions flow.md does not contradict.`,
    '- Never invent scope flow.md does not support.',
    '- Write the content in Brazilian Portuguese. Do not edit any file.',
    `### flow.md\n${input.flowMd}`,
    `### current ${input.file}\n${input.currentMd.trim() || '(empty)'}`,
    `### template\n${TEMPLATE[input.file](input.projectId)}`,
  ].join('\n\n');
  return { kind: 'suggest', role: SUGGEST_ROLE[input.file], specHash: input.specHash, principles: [], outputContract: outputContract('suggest'), criteria: [], feedback, budgetTokens: 30_000 };
}
