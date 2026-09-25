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
  role: 'po' | 'sm';
  file: DocFile;
  find: string;
  replace: string;
  reason: string;
  diff: string;
}
export type PatchCheck = { ok: true; file: DocFile } | { ok: false; reason: string };

const count = (text: string, find: string): number => (find === '' ? 0 : text.split(find).length - 1);

/** Spec (refinement) §3.4: only the two Markdown files, and `find` must occur exactly once. */
export function checkPatch(p: DocPatchIn, specId: string, docs: Record<DocFile, string>): PatchCheck {
  const file = (Object.keys(DOC_REL) as DocFile[]).find((f) => DOC_REL[f](specId) === p.file);
  if (!file) return { ok: false, reason: `unknown file ${p.file}` };
  const n = count(docs[file], p.find);
  if (n === 0) return { ok: false, reason: `find not found in ${file}` };
  if (n > 1) return { ok: false, reason: `find occurs ${n} times in ${file}` };
  return { ok: true, file };
}

export function applyPatch(text: string, p: { find: string; replace: string }): string | null {
  return count(text, p.find) === 1 ? text.replace(p.find, () => p.replace) : null;
}

export function unifiedDiff(file: DocFile, before: string, after: string): string {
  return createPatch(file, before, after, '', '', { context: 2 });
}

export const patchId = (role: 'po' | 'sm', cycle: number, index: number): string => `${role}-c${cycle}-${index}`;
