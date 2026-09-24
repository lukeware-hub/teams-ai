import { z } from 'zod';
import { HASH_PATTERN } from '../contracts/hash.js';
import { ADR_ID, Plan } from '../contracts/plan.js';
import { AC_ID } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';

export const STEP_KINDS = ['refine', 'tech-spec', 'coverage', 'plan', 'dev', 'review', 'deployment', 'report'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const specHash = z.string().regex(HASH_PATTERN);
const acId = z.string().regex(AC_ID);
const taskId = z.string().regex(ID_PATTERNS.TASK_ID);

export const DocPatch = z.object({
  file: z.string().min(1),
  find: z.string(),
  replace: z.string(),
  reason: z.string().min(1),
});

export const RefineOutput = z.object({
  specHash,
  checklist: z.array(z.object({ id: z.string().min(1), passed: z.boolean(), detail: z.string() })),
  questions: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      blocking: z.boolean(),
      relatedAcIds: z.array(acId).default([]),
    }),
  ),
  docPatch: z.array(DocPatch),
});

export const TechSpecOutput = z.object({
  specHash,
  techSpecPath: z.string().min(1),
  adrs: z.array(z.object({ id: z.string().regex(ADR_ID), title: z.string().min(1), path: z.string().min(1) })),
  stack: z.string().min(1),
  summary: z.string().min(1),
});

export const CoverageOutput = z.object({
  specHash,
  coverage: z.array(z.object({ acId, section: z.string().nullable(), covered: z.boolean(), note: z.string() })),
});

export const PlanOutput = Plan;

const devCommon = {
  specHash,
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  scopeJustification: z.string().optional(),
};

/** A discriminated union so the generated JSON Schema tells the model which fields each status requires. */
export const DevOutput = z.discriminatedUnion('status', [
  z.object({ ...devCommon, status: z.literal('done'), commitMessage: z.string().min(1) }),
  z.object({ ...devCommon, status: z.literal('spec-gap'), question: z.string().min(1) }),
]);

export const ReviewOutput = z.object({
  specHash,
  decision: z.enum(['approve', 'changes']),
  criteria: z.array(z.object({ id: acId, status: z.enum(['passed', 'failed', 'not-covered']), evidence: z.array(z.string()) })).min(1),
  findings: z.array(
    z.object({
      file: z.string().min(1),
      line: z.number().int().nonnegative().nullable(),
      severity: z.enum(['critical', 'important', 'minor']),
      problem: z.string().min(1),
      fix: z.string().min(1),
    }),
  ),
});

export const DeploymentOutput = z.object({
  specHash,
  target: z.enum(['docker-local', 'kind']),
  image: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  healthcheckPath: z.string().startsWith('/'),
  manifests: z.array(z.string().min(1)),
  secretNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  notes: z.string(),
});

export const ReportOutput = z.object({
  specHash,
  delivered: z.array(taskId),
  blocked: z.array(z.object({ taskId, reason: z.string().min(1) })),
  assumptions: z.array(z.string()),
  exploratoryScript: z.array(z.object({ acId, steps: z.array(z.string().min(1)).min(1) })),
  summary: z.string().min(1),
});

export const OUTPUT_SCHEMAS: Record<StepKind, z.ZodType<{ specHash: string }>> = {
  refine: RefineOutput,
  'tech-spec': TechSpecOutput,
  coverage: CoverageOutput,
  plan: PlanOutput,
  dev: DevOutput,
  review: ReviewOutput,
  deployment: DeploymentOutput,
  report: ReportOutput,
};

export type OutputOf<K extends StepKind> = z.infer<(typeof OUTPUT_SCHEMAS)[K]>;

/** Draft-07 JSON Schema for `claude --json-schema`, generated from the same zod contract the validator uses. */
export function toJsonSchema(kind: StepKind): object {
  return z.toJSONSchema(OUTPUT_SCHEMAS[kind], { target: 'draft-07', io: 'input', reused: 'inline' });
}
