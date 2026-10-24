import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { briefTemplate, designTemplate, projectTemplate, stackTemplate, type DocFile } from './draft.js';
import { earlierDocs } from './doc-stages.js';
import { buildWithDocs } from './docs-view.js';

/** Every document but flow.md, which is the source the others are suggested from. */
export type SuggestFile = Exclude<DocFile, 'flow.md'>;

/** Read-only roles only: a suggestion returns text and must never touch the draft (Front may edit and run Bash). */
export const SUGGEST_ROLE: Record<SuggestFile, 'po' | 'sm'> = { 'project.md': 'po', 'briefing.md': 'po', 'stack.md': 'sm', 'design.md': 'po' };

export const TEMPLATE: Record<SuggestFile, (projectId: string) => string> ={ 'project.md': projectTemplate, 'briefing.md': briefTemplate, 'stack.md': stackTemplate, 'design.md': designTemplate };

/** Every document of the refinement draft. */
export const DOC_FILES: DocFile[] = ['project.md', 'briefing.md', 'stack.md', 'flow.md', 'design.md'];

/** Refinement "Sugerir": one step that writes `file` in full, coherent with the other four documents and their recorded decisions. */
export function suggestPack(input: { file: SuggestFile; projectId: string; specHash: string; docs: Record<DocFile, string>; earlierOnly?: boolean }): ContextPackInput {
  // A stage of a new project reads only the documents before it; the other sessions read all the others.
  const others = input.earlierOnly ? earlierDocs(input.file) : DOC_FILES.filter((f) => f !== input.file);
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

/** Reformatar: one step that rewrites `file` in the shape of its template, from its own text only. */
export function reshapePack(input: { file: SuggestFile; projectId: string; specHash: string; current: string }): ContextPackInput {
  const feedback = [
    `Write the complete docs/${input.file} in \`text\`, in the shape of the template below.`,
    '- Keep every heading of the template, in its order, at the top of the text. Sections the template does not have go after them, at the end, each under its own heading; never fold them into a template section.',
    '- Replace each placeholder of the template, the text between < and >, with the real content of the current file; a line with no real content is removed; a section with no content gets "- (none)"; a section that does not apply gets "- (not applicable)".',
    '- Keep every fact of the current file: reword only to fit the shape; never drop, invent or change a fact.',
    '- Keep the sections "## Decisões" and "## Ajuste aprovado" word for word.',
    '- Write the content in Brazilian Portuguese. Do not edit any file.',
    `### current ${input.file}\n${input.current.trim() || '(empty)'}`,
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
