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
/** What each checklist id checks, in plain words, and the documents the owner reviews when it fails. */
export const CHECK_NAMES: Record<ChecklistId, { label: string; files: readonly string[] }> = {
  'po.objectives-verifiable': { label: 'Objetivos verificáveis', files: ['project.md', 'briefing.md'] },
  'po.personas': { label: 'Público e personas definidos', files: ['project.md', 'briefing.md'] },
  'po.scope-explicit': { label: 'Escopo explícito', files: ['flow.md', 'briefing.md'] },
  'po.no-contradictions': { label: 'Documentos sem contradições', files: [] },
  'sm.constraints-clear': { label: 'Restrições técnicas claras', files: ['stack.md'] },
  'sm.tasks-feasible': { label: 'Tarefas viáveis', files: ['stack.md', 'flow.md'] },
  'sm.no-open-questions': { label: 'Sem perguntas obrigatórias em aberto', files: [] },
  'sm.flow-is-mermaid': { label: 'flow.md é um diagrama mermaid', files: ['flow.md'] },
};

/** The documents to review for a failing item: the ones its check reads, then both sides of each contradiction, with no repeats. */
export function reviewFiles(item: { id: string; divergences?: Divergence[] }): string[] {
  const named = CHECK_NAMES[item.id as ChecklistId]?.files ?? [];
  const sides = (item.divergences ?? []).flatMap((d) => [d.a.file, d.b.file]).map((file) => file.split('/').pop() ?? file);
  return [...new Set([...named, ...sides])];
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
