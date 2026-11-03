import type { DocFile } from './draft.js';

/** The design text of a project with no interface: "Não se aplica" marks it, and the Jev counts it as present. */
export const NOT_APPLICABLE_DESIGN = 'Não se aplica: este projeto não tem interface.';

/** Whether a document is marked not applicable: only design.md can be, and the agents keep its mark when they improve the text. */
export const isNotApplicable = (file: DocFile, text: string): boolean => file === 'design.md' && text.trim().startsWith('Não se aplica');
