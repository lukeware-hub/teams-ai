import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';
import { canonicalJson, sha256 } from './hash.js';
import { AC_ID, HASH_PATTERN } from './patterns.js';

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
});

/** Human-defined tasks carry no dependencies; the SM derives them in the plan. */
export const HumanTask = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});

export const SpecStatus = z.enum([
  'refining',
  'running',
  'paused:quota',
  'paused:auth',
  'awaiting-validation',
  'done',
]);
export type SpecStatus = z.infer<typeof SpecStatus>;

export const ValidationReport = z.object({
  at: z.iso.datetime(),
  text: z.string().min(1),
});

export const Spec = z
  .object({
    specId: z.string().regex(ID_PATTERNS.SLUG),
    specVersion: z.number().int().nonnegative(),
    specHash: z.string().regex(HASH_PATTERN).nullable(),
    objectives: z.array(z.string().min(1)).min(1),
    features: z.array(z.string().min(1)),
    acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
    outOfScope: z.array(z.string().min(1)),
    externalDependencies: z.array(ExternalDependency),
    tasks: z.array(HumanTask).optional(),
    status: SpecStatus,
    validationReports: z.array(ValidationReport).default([]),
  })
  .superRefine((spec, ctx) => {
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

const HASHED_FIELDS = [
  'specId',
  'specVersion',
  'objectives',
  'features',
  'acceptanceCriteria',
  'outOfScope',
  'externalDependencies',
  'tasks',
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
  if (spec.status !== 'refining') {
    throw new SpecFrozenError(
      `spec ${spec.specId} is ${spec.status}; only refining specs can be frozen`,
    );
  }
  const next: Spec = { ...spec, specVersion: spec.specVersion + 1, status: 'running' };
  return { ...next, specHash: computeSpecHash(next) };
}
