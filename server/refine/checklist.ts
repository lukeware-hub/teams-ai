export const PO_ITEMS = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'] as const;
export const SM_ITEMS = ['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions', 'sm.flow-is-mermaid'] as const;
export type ChecklistId = (typeof PO_ITEMS)[number] | (typeof SM_ITEMS)[number];
/** One side of a divergence: the document, the section that holds the quote, and the quote itself. */
export interface DivergenceSide {
  file: string;
  heading: string | null;
  quote: string;
}
/** A verified contradiction between two documents, with how to correct it. */
export interface Divergence {
  fact: string;
  a: DivergenceSide;
  b: DivergenceSide;
  fix: string;
}
export interface ChecklistItem {
  id: ChecklistId;
  role: 'po' | 'sm';
  passed: boolean;
  detail: string;
  divergences?: Divergence[];
}
type Reported = ReadonlyArray<{ id: string; passed: boolean; detail: string }>;

/** Spec (refinement) §3.2 step 4: fixed ids per role; omitted items fail as "not reported". */
export function mergeChecklist(po: Reported, sm: Reported): ChecklistItem[] {
  const pick = (role: 'po' | 'sm', ids: readonly ChecklistId[], reported: Reported): ChecklistItem[] =>
    ids.map((id) => {
      const r = reported.find((x) => x.id === id);
      return r ? { id, role, passed: r.passed, detail: r.detail } : { id, role, passed: false, detail: 'not reported' };
    });
  return [...pick('po', PO_ITEMS, po), ...pick('sm', SM_ITEMS, sm)];
}
