import { z } from 'zod';
import { Project } from '../contracts/project.js';
import { AcceptanceCriterion, Spec } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import type { JevValidationResult } from './jev-validation.js';

export function derivePack(input: {
  specHash: string;
  principles: readonly string[];
  projectMd: string;
  briefMd: string;
  stackMd?: string;
  flowMd?: string;
  designMd?: string;
  previous: { project: Project; spec: Spec } | null;
  specId: string;
  jevValidation?: JevValidationResult;
}): ContextPackInput {
  const schemas = {
    project: z.toJSONSchema(Project, { target: 'draft-07', io: 'input' }),
    spec: z.toJSONSchema(Spec, { target: 'draft-07', io: 'input' }),
  };
  const feedback = [
    `specId must be ${input.specId}. Derive project.json and spec.json from the Markdown below. Classify the demand as feature, bug, maintenance, or refactor. For bugs, preserve actual behavior, expected behavior, reproduction steps, and optional evidence in the bug object; do not invent missing reproduction details.`,
    'Use flow.md as the business-flow reference and keep the derived objectives, features, and acceptance criteria consistent with its application behavior.',
    '### docs/project.md',
    input.projectMd,
    '### brief.md',
    input.briefMd,
    ...(input.stackMd ? ['### stack.md', input.stackMd] : []),
    ...(input.flowMd ? ['### flow.md (Mermaid)', input.flowMd] : []),
    ...(input.designMd ? ['### design.md', input.designMd] : []),
    '### Jev preflight validation',
    input.jevValidation ? JSON.stringify(input.jevValidation, null, 2) : '(not available)',
    '### previous derived JSON (keep unchanged acceptance criterion ids)',
    input.previous ? JSON.stringify(input.previous, null, 2) : '(none)',
    '### JSON schemas',
    JSON.stringify(schemas),
  ].join('\n\n');
  return {
    kind: 'derive',
    role: 'po',
    specHash: input.specHash,
    principles: input.principles,
    outputContract: outputContract('derive'),
    criteria: input.previous?.spec.acceptanceCriteria ?? [],
    feedback,
    budgetTokens: 20_000,
  };
}

export type DeriveCheck = { ok: true; value: { project: Project; spec: Spec } } | { ok: false; issues: string[] };

export const acNum = (id: string) => Number(id.slice(3));
export const acId = (n: number) => `AC-${String(n).padStart(3, '0')}`;
export const sameText = (a: AcceptanceCriterion, b: AcceptanceCriterion) => a.given === b.given && a.when === b.when && a.then === b.then;

/** Spec (refinement) §3.2 step 1: the orchestrator, not the agent, owns ids, status, hash and version. */
export function postProcessDerived(out: { project: unknown; spec: unknown }, previous: Spec | null, specId: string): DeriveCheck {
  const p = Project.safeParse(out.project);
  const raw = typeof out.spec === 'object' && out.spec !== null ? (out.spec as Record<string, unknown>) : {};
  // Ids are renumbered before the Spec schema runs, since the schema rejects duplicates the agent may produce.
  const acs = z.array(AcceptanceCriterion).safeParse(raw.acceptanceCriteria ?? []);
  const prevAcs = previous?.acceptanceCriteria ?? [];
  let criteria: AcceptanceCriterion[] = [];
  if (acs.success) {
    const used = new Set<string>();
    let max = Math.max(0, ...prevAcs.map((c) => acNum(c.id)), ...acs.data.map((c) => acNum(c.id)));
    criteria = acs.data.map((c) => {
      const kept = prevAcs.find((pc) => sameText(pc, c) && !used.has(pc.id));
      let id = kept ? kept.id : c.id;
      const takenByOther = !kept && prevAcs.some((pc) => pc.id === id && !sameText(pc, c));
      if (used.has(id) || takenByOther) id = acId(++max);
      used.add(id);
      return { ...c, id };
    });
  }
  const s = Spec.safeParse({
    ...raw,
    acceptanceCriteria: acs.success ? criteria : raw.acceptanceCriteria,
    specId,
    status: 'refining',
    specHash: null,
    specVersion: previous?.specVersion ?? 0,
    validationReports: previous?.validationReports ?? [],
    // Only backlog detailing records where a spec comes from; one the agent fills in here would be invented.
    derivedFrom: undefined,
  });
  const issues = [
    ...(p.success ? [] : p.error.issues.map((i) => `project.${i.path.join('.')}: ${i.message}`)),
    ...(s.success ? [] : s.error.issues.map((i) => `spec.${i.path.join('.')}: ${i.message}`)),
  ];
  if (!p.success || !s.success) return { ok: false, issues };
  return { ok: true, value: { project: p.data, spec: s.data } };
}
