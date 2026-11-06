import { isStarted } from './coverage.js';
import type { BacklogState } from './state.js';

/** One plain finding and the closing check it breaks. */
export interface SpecsIssue {
  check: 'po.objectives-verifiable' | 'sm.tasks-feasible';
  text: string;
}

/** What is wrong in the new work of the backlog, found without asking an agent: a spec with no criteria, a repeated criterion, a task citing a criterion that does not exist, a criterion no task covers. */
export function specsIssues(backlog: Pick<BacklogState, 'items' | 'specs' | 'preplans'>): SpecsIssue[] {
  const issues: SpecsIssue[] = [];
  const seen = new Set<string>();
  for (const item of backlog.items) {
    const spec = backlog.specs?.[item.key]?.spec;
    const criteria = spec?.acceptanceCriteria ?? [];
    if (isStarted(spec?.status)) {
      for (const c of criteria) seen.add(c.id);
      continue;
    }
    if (criteria.length === 0) issues.push({ check: 'po.objectives-verifiable', text: `${item.key}: sem critérios de aceite.` });
    for (const c of criteria) {
      if (seen.has(c.id)) issues.push({ check: 'po.objectives-verifiable', text: `${item.key}: o critério ${c.id} se repete.` });
      seen.add(c.id);
    }
    const tasks = backlog.preplans?.[item.key]?.preplan?.tasks ?? [];
    const own = new Set(criteria.map((c) => c.id));
    const covered = new Set(tasks.flatMap((t) => t.criteriaRefs));
    for (const t of tasks) for (const ref of t.criteriaRefs) if (!own.has(ref)) issues.push({ check: 'sm.tasks-feasible', text: `${item.key}: a tarefa ${t.id} cita ${ref}, que não existe.` });
    for (const c of criteria) if (!covered.has(c.id)) issues.push({ check: 'sm.tasks-feasible', text: `${item.key}: nenhuma tarefa cobre ${c.id}.` });
  }
  return issues;
}
