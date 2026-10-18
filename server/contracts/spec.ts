import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';
import { BacklogSource } from './backlog.js';
import { canonicalJson, sha256 } from './hash.js';
import { AC_ID, HASH_PATTERN } from './patterns.js';
import type { PlanTask } from './plan.js';

export { AC_ID };

export const AcceptanceCriterion = z.object({
  id: z.string().regex(AC_ID),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
  smoke: z.boolean().default(false),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const ExternalDependency = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  secretNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  /** An internal credential of this project (one service accepts it, another sends it): the platform creates it, a person never types it. */
  generated: z.boolean().optional(),
});
export type ExternalDependency = z.infer<typeof ExternalDependency>;

/** The secrets a person must provide; the generated ones are the platform's to create. */
export const providedSecretNames = (deps: readonly ExternalDependency[]): string[] => deps.filter((d) => !d.generated).flatMap((d) => d.secretNames);
export const generatedSecretNames = (deps: readonly ExternalDependency[]): string[] => deps.filter((d) => d.generated).flatMap((d) => d.secretNames);

/** Human-defined tasks carry no dependencies; the SM derives them in the plan. */
export const HumanTask = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});

export const SpecType = z.enum(['feature', 'bug', 'maintenance', 'refactor']);
export type SpecType = z.infer<typeof SpecType>;

export const BugDetails = z.object({
  actual: z.string().min(1),
  expected: z.string().min(1),
  reproduction: z.string().min(1),
  evidence: z.string().min(1).optional(),
});
export type BugDetails = z.infer<typeof BugDetails>;

export const SpecStatus = z.enum([
  'refining',
  /** Backlog mode: derived during refinement with its pre-plan, complete but not frozen; it can still be re-derived. */
  'planned',
  'running',
  'paused:quota',
  'paused:auth',
  'awaiting-validation',
  'done',
  /** R11.7.5: a planned spec whose item left the backlog; it never runs. */
  'retired',
]);
export type SpecStatus = z.infer<typeof SpecStatus>;

export const ValidationReport = z.object({
  at: z.iso.datetime(),
  text: z.string().min(1),
});

/** Backlog mode: where a derived spec comes from, so a later sync re-derives only what the docs changed. */
export const SpecProvenance = z.object({
  backlogKey: z.string().regex(ID_PATTERNS.SLUG),
  inputHash: z.string().regex(HASH_PATTERN),
  docsHash: z.string().regex(HASH_PATTERN),
  /**
   * Each cited section with the hash of its text; null when the heading was not found in the doc. `bodyHash` leaves the
   * heading line out, so a renumbered or renamed section reads as unchanged (R11.7.4); older specs lack it.
   */
  sources: z.array(BacklogSource.extend({ hash: z.string().regex(HASH_PATTERN).nullable(), bodyHash: z.string().regex(HASH_PATTERN).nullable().optional() })).min(1),
});
export type SpecProvenance = z.infer<typeof SpecProvenance>;

/** An answer to a refinement question, kept with the spec so a later version neither loses it nor asks it again (R11.7.1). */
export const SpecDecision = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  /** The role that answered from the docs (R11.5.7); absent when the owner answered. */
  by: z.enum(['po', 'sm']).optional(),
});
export type SpecDecision = z.infer<typeof SpecDecision>;

export const Spec = z
  .object({
    specId: z.string().regex(ID_PATTERNS.SLUG),
    specVersion: z.number().int().nonnegative(),
    specHash: z.string().regex(HASH_PATTERN).nullable(),
    type: SpecType.default('feature'),
    bug: BugDetails.optional(),
    objectives: z.array(z.string().min(1)).min(1),
    features: z.array(z.string().min(1)),
    acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
    outOfScope: z.array(z.string().min(1)),
    externalDependencies: z.array(ExternalDependency),
    tasks: z.array(HumanTask).optional(),
    status: SpecStatus,
    validationReports: z.array(ValidationReport).default([]),
    derivedFrom: SpecProvenance.optional(),
    decisions: z.array(SpecDecision).optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.type === 'bug' && !spec.bug) {
      ctx.addIssue({ code: 'custom', message: 'bug details are required for bug specs', path: ['bug'] });
    }
    const seen = new Set<string>();
    for (const ac of spec.acceptanceCriteria) {
      if (seen.has(ac.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate acceptance criterion id ${ac.id}`,
          path: ['acceptanceCriteria'],
        });
      }
      seen.add(ac.id);
    }
  });
export type Spec = z.infer<typeof Spec>;

/** The part of a spec some tasks deliver: the criteria they reference. */
export const specShare = (spec: Spec, tasks: readonly Pick<PlanTask, 'criteriaRefs'>[]): Spec => {
  const delivered = new Set(tasks.flatMap((t) => t.criteriaRefs));
  return { ...spec, acceptanceCriteria: spec.acceptanceCriteria.filter((ac) => delivered.has(ac.id)) };
};

const HASHED_FIELDS = [
  'specId',
  'specVersion',
  'type',
  'bug',
  'objectives',
  'features',
  'acceptanceCriteria',
  'outOfScope',
  'externalDependencies',
  'tasks',
  'decisions',
] as const;

/** Hashes the parsed form, so defaults (e.g. smoke=false) are always included. */
export function computeSpecHash(spec: Spec): string {
  const parsed = Spec.parse(spec);
  const content: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) content[field] = parsed[field];
  return sha256(canonicalJson(content));
}

export class SpecFrozenError extends Error {}

export function freezeSpec(spec: Spec): Spec {
  if (spec.status !== 'refining' && spec.status !== 'planned') {
    throw new SpecFrozenError(
      `spec ${spec.specId} is ${spec.status}; only refining or planned specs can be frozen`,
    );
  }
  const next: Spec = { ...spec, specVersion: spec.specVersion + 1, status: 'running' };
  return { ...next, specHash: computeSpecHash(next) };
}
