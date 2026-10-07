import type { BacklogItem } from '../contracts/backlog.js';
import { headingMatches } from './sections.js';
import type { BacklogState } from './state.js';

/**
 * The coverage of a detailed backlog: doc section -> spec -> acceptance criterion -> pre-plan task. Browser-safe: the
 * shared reducer gates `ready` on it and the refinement screen draws the same tree.
 */

/** An item covers a flow.md section when one of its flow.md citations names it (lenient match). */
export const itemCites = (item: Pick<BacklogItem, 'sources'>, heading: string): boolean =>
  item.sources.some((s) => s.doc === 'flow.md' && headingMatches(s.heading, heading));

export interface CoverageMatrix {
  sections: Array<{ heading: string; items: string[] }>;
  items: Array<{ key: string; specId: string | null; criteria: Array<{ id: string; tasks: string[] }> }>;
}

const byRank = (b: BacklogState) => [...b.items].sort((x, y) => x.rank - y.rank);

export function coverageMatrix(b: BacklogState): CoverageMatrix {
  const items = byRank(b);
  return {
    sections: (b.flowHeadings ?? []).map((heading) => ({ heading, items: items.filter((i) => itemCites(i, heading)).map((i) => i.key) })),
    items: items.map((i) => {
      const spec = b.specs?.[i.key]?.spec ?? null;
      const tasks = b.preplans?.[i.key]?.preplan?.tasks ?? [];
      return { key: i.key, specId: spec?.specId ?? null, criteria: (spec?.acceptanceCriteria ?? []).map((c) => ({ id: c.id, tasks: tasks.filter((t) => t.criteriaRefs.includes(c.id)).map((t) => t.id) })) };
    }),
  };
}

/** What still keeps a detailed backlog from `ready`, in Portuguese for the screen and the review pack. */
export function coverageGaps(b: BacklogState): string[] {
  const gaps: string[] = [];
  for (const heading of b.flowHeadings ?? []) {
    if (!b.items.some((i) => itemCites(i, heading))) gaps.push(`seção do flow.md sem nenhum item: "${heading}"`);
  }
  for (const item of byRank(b)) {
    const spec = b.specs?.[item.key];
    if (!spec?.spec) { gaps.push(`item ${item.key}: sem spec válida`); continue; }
    const pre = b.preplans?.[item.key];
    if (!pre?.preplan) { gaps.push(`item ${item.key}: sem pré-plano válido`); continue; }
    if (pre.specRev !== spec.rev) { gaps.push(`item ${item.key}: pré-plano desatualizado`); continue; }
    const ids = new Set(spec.spec.acceptanceCriteria.map((c) => c.id));
    for (const id of ids) {
      if (!pre.preplan.tasks.some((t) => t.criteriaRefs.includes(id))) gaps.push(`item ${item.key}: critério ${id} sem tarefa no pré-plano`);
    }
    for (const t of pre.preplan.tasks) {
      for (const ref of t.criteriaRefs) if (!ids.has(ref)) gaps.push(`item ${item.key}: tarefa ${t.id} cita ${ref}, que não é desta spec`);
    }
  }
  return gaps;
}
