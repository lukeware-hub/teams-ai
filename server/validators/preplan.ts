import type { Preplan } from '../contracts/preplan.js';
import type { Spec } from '../contracts/spec.js';
import { findCycle } from './plan.js';

/** Deterministic rules on the SM's pre-plan of one spec; the agent gets the messages back when it breaks one. */
export function validatePreplan(preplan: Pick<Preplan, 'modules' | 'tasks'>, spec: Pick<Spec, 'acceptanceCriteria'>): string[] {
  const errors: string[] = [];
  const modules = new Set(preplan.modules.map((m) => m.name));
  const criteria = new Set(spec.acceptanceCriteria.map((c) => c.id));
  const ids = new Set<string>();
  for (const t of preplan.tasks) {
    if (ids.has(t.id)) errors.push(`tarefa duplicada: ${t.id}`);
    ids.add(t.id);
  }
  for (const t of preplan.tasks) {
    if (!modules.has(t.module)) errors.push(`tarefa ${t.id}: módulo desconhecido ${t.module}`);
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(`tarefa ${t.id} depende dela mesma`);
      else if (!ids.has(d)) errors.push(`tarefa ${t.id}: dependência desconhecida ${d}`);
    }
    for (const ref of t.criteriaRefs) if (!criteria.has(ref)) errors.push(`tarefa ${t.id}: critério ${ref} não é desta spec`);
  }
  const cycle = findCycle(preplan.tasks);
  if (cycle) errors.push(`ciclo de dependências: ${cycle.join(' -> ')}`);
  for (const c of spec.acceptanceCriteria) {
    if (!preplan.tasks.some((t) => t.criteriaRefs.includes(c.id))) errors.push(`critério ${c.id} sem nenhuma tarefa`);
  }
  return errors;
}
