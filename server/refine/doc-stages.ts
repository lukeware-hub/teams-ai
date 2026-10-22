import type { DocFile } from './draft.js';

/** The order a new project refines its documents in: each stage reads only the ones before it. */
export const DOC_STAGES: readonly DocFile[] = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];

/** The documents a stage reads: the ones before it in the order. */
export const earlierDocs = (file: DocFile): readonly DocFile[] => DOC_STAGES.slice(0, DOC_STAGES.indexOf(file));
