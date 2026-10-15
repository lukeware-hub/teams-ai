import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { briefTemplate, designTemplate, projectTemplate, stackTemplate, type DocFile } from './draft.js';
import { buildWithDocs } from './docs-view.js';

/** Every document but flow.md, which is the source the others are suggested from. */
export type SuggestFile = Exclude<DocFile, 'flow.md'>;

/** Read-only roles only: a suggestion returns text and must never touch the draft (Front may edit and run Bash). */
export const SUGGEST_ROLE: Record<SuggestFile, 'po' | 'sm'> = { 'project.md': 'po', 'brief.md': 'po', 'stack.md': 'sm', 'design.md': 'po' };

const TEMPLATE: Record<SuggestFile, (projectId: string) => string> = { 'project.md': projectTemplate, 'brief.md': briefTemplate, 'stack.md': stackTemplate, 'design.md': designTemplate };

/** Every document of the refinement draft. */
export const DOC_FILES: DocFile[] = ['project.md', 'brief.md', 'stack.md', 'flow.md', 'design.md'];

/** Refinement "Sugerir": one step that writes `file` in full, coherent with the other four documents and their recorded decisions. */
export function suggestPack(input: { file: SuggestFile; projectId: string; specHash: string; docs: Record<DocFile, string> }): ContextPackInput {
  const others = DOC_FILES.filter((f) => f !== input.file);
  const viewed = buildWithDocs(Object.fromEntries(others.map((f) => [f, input.docs[f]])) as Record<DocFile, string>, (view) => others.map((f) => `### ${f}\n${view[f]}`).join('\n\n'));
  const feedback = [
    `Write the complete docs/${input.file} in \`text\`, coherent with the other documents below.`,
    'Precedence when they disagree: the decisions recorded under "## Decisões" in the briefing first, then docs/flow.md, then the rest. Never remove, reword or reorder a recorded decision.',
    `- Keep the headings of the current ${input.file}; use the template's headings only when it is empty or still the template.`,
    `- Keep from the current ${input.file} only what the other documents do not contradict.`,
    '- Never invent scope the documents do not support.',
    '- Write the content in Brazilian Portuguese. Do not edit any file.',
    viewed,
    `### current ${input.file}\n${input.docs[input.file].trim() || '(empty)'}`,
    `### template\n${TEMPLATE[input.file](input.projectId)}`,
  ].join('\n\n');
  return { kind: 'suggest', role: SUGGEST_ROLE[input.file], specHash: input.specHash, principles: [], outputContract: outputContract('suggest'), criteria: [], feedback, budgetTokens: 30_000 };
}

/** "Anexar imagem": one step that adjusts design.md from template images the agent opens with Read; the images are deleted afterwards. */
export function designFromImagesPack(input: { projectId: string; specHash: string; currentMd: string; imagePaths: string[] }): ContextPackInput {
  const feedback = [
    'Write the complete docs/design.md in `text`, adjusted to follow the example template shown in the images below.',
    '- Open every image with the Read tool before writing.',
    '- From the images take the color palette (hex values), fonts, spacing, alignment and the order of the screen sections.',
    '- Keep the headings and the decisions of the current design.md that the images do not contradict; the images win when they do.',
    '- Never invent what the images do not show.',
    '- Write the content in Brazilian Portuguese. Do not edit any file.',
    `### images\n${input.imagePaths.map((f) => `- ${f}`).join('\n')}`,
    `### current design.md\n${input.currentMd.trim() || '(empty)'}`,
    `### template\n${designTemplate()}`,
  ].join('\n\n');
  return { kind: 'suggest', role: SUGGEST_ROLE['design.md'], specHash: input.specHash, principles: [], outputContract: outputContract('suggest'), criteria: [], feedback, budgetTokens: 30_000 };
}
