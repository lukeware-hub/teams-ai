import type { ItemSpec } from '../agents/outputs.js';
import { Spec, type AcceptanceCriterion, type SpecProvenance } from '../contracts/spec.js';
import { acId, sameText } from './derive.js';

/** The highest criterion number; the id format (`AC_ID`) and the JUnit tags read any number of four digits. */
const MAX_AC = 9999;

export type Allocation = { ok: true; criteria: AcceptanceCriterion[]; highWater: number } | { ok: false; issues: string[] };

/**
 * Backlog mode numbers acceptance criteria across the whole backlog: Phase 4 matches criteria against the JUnit of the
 * whole repo, so two specs must never share an id. A criterion keeps the id of the same text in the item's previous
 * spec, else the previous id the agent echoes; anything else takes the next number above `highWater`, the highest id
 * ever used in the target project, so a removed criterion's number is never reused.
 */
export function allocateCriteria(criteria: readonly AcceptanceCriterion[], previous: readonly AcceptanceCriterion[], highWater: number): Allocation {
  const ids: Array<string | null> = criteria.map(() => null);
  const used = new Set<string>();
  criteria.forEach((c, i) => {
    const kept = previous.find((p) => sameText(p, c) && !used.has(p.id));
    if (kept) { ids[i] = kept.id; used.add(kept.id); }
  });
  criteria.forEach((c, i) => {
    if (ids[i] === null && previous.some((p) => p.id === c.id) && !used.has(c.id)) { ids[i] = c.id; used.add(c.id); }
  });
  let high = highWater;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== null) continue;
    if (++high > MAX_AC) return { ok: false, issues: [`os critérios de aceite chegaram a ${acId(MAX_AC)}: não há números livres`] };
    ids[i] = acId(high);
  }
  return { ok: true, criteria: criteria.map((c, i) => ({ ...c, id: ids[i]! })), highWater: high };
}

export type ItemSpecCheck = { ok: true; spec: Spec; highWater: number } | { ok: false; issues: string[]; detail?: string[] };

/** The orchestrator, not the agent, owns the item spec's id, status, version, hash, provenance and criterion ids. */
export function postProcessItemSpec(out: ItemSpec, ctx: { specId: string; previous: Spec | null; highWater: number; provenance: SpecProvenance }): ItemSpecCheck {
  const allocated = allocateCriteria(out.acceptanceCriteria, ctx.previous?.acceptanceCriteria ?? [], ctx.highWater);
  if (!allocated.ok) return allocated;
  const { key, ...content } = out;
  const parsed = Spec.safeParse({
    ...content,
    specId: ctx.specId,
    specVersion: 0,
    specHash: null,
    acceptanceCriteria: allocated.criteria,
    status: 'refining',
    validationReports: [],
    derivedFrom: ctx.provenance,
  });
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `a spec não passou na validação (${i.path.join('.') || 'raiz'})`), detail: parsed.error.issues.map((i) => `spec ${key}.${i.path.join('.')}: ${i.message}`) };
  return { ok: true, spec: parsed.data, highWater: allocated.highWater };
}
