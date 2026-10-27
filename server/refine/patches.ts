import { createPatch } from 'diff';
import { DOC_REL, type DocFile } from './draft.js';

export interface DocPatchIn {
  file: string;
  find: string;
  replace: string;
  reason: string;
}
export interface PendingPatch {
  patchId: string;
  role: 'po' | 'sm' | 'front';
  file: DocFile;
  find: string;
  replace: string;
  reason: string;
  diff: string;
  /** Whether the change adds or removes structure (a heading, a list item, a criterion id or a priority): see scope-guard.ts. Journaled only; nothing applies a patch because of it. */
  scopeChange?: boolean;
}
export type PatchCheck = { ok: true; file: DocFile } | { ok: false; reason: string };

export const count = (text: string, find: string): number => (find === '' ? 0 : text.split(find).length - 1);

/** The document a path names, as the packs show it; undefined when the path is none of the five. */
export function docOf(file: string, specId: string, projectBriefing = false): DocFile | undefined {
  const exact = (Object.keys(DOC_REL) as DocFile[]).find((f) => DOC_REL[f](specId, projectBriefing) === file);
  // Agents often cite a document by its bare name, which is the same document.
  return exact ?? (Object.keys(DOC_REL) as DocFile[]).find((f) => f === file);
}

/** Shown as the reason when another change covered a pending suggestion, so it no longer applies. */
export const COVERED_REASON = 'Este ajuste já foi coberto por outra alteração e foi descartado.';

/** Spec (refinement) §3.4: only known Markdown files, and `find` must occur exactly once. */
export function checkPatch(p: DocPatchIn, specId: string, docs: Partial<Record<DocFile, string>>, projectBriefing = false): PatchCheck {
  const file = docOf(p.file, specId, projectBriefing);
  if (!file) return { ok: false, reason: `unknown file ${p.file}` };
  const text = docs[file];
  if (text === undefined) return { ok: false, reason: `document not loaded: ${file}` };
  const n = count(text, p.find);
  if (n === 0) return { ok: false, reason: `find not found in ${file}` };
  if (n > 1) return { ok: false, reason: `find occurs ${n} times in ${file}` };
  return { ok: true, file };
}

/** Applies `find` once; an empty `find` appends, and only the orchestrator's own patches carry one (`checkPatch` refuses it). */
export function applyPatch(text: string, p: { find: string; replace: string }): string | null {
  if (p.find === '') return `${text}\n${p.replace}`;
  return count(text, p.find) === 1 ? text.replace(p.find, () => p.replace) : null;
}

export function unifiedDiff(file: DocFile, before: string, after: string): string {
  return createPatch(file, before, after, '', '', { context: 2 });
}

export const patchId = (role: 'po' | 'sm' | 'front', cycle: number, index: number): string => `${role}-c${cycle}-${index}`;
