import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';
import { AC_ID, HASH_PATTERN } from './patterns.js';

export const ADR_ID = /^ADR-\d{3}$/;

/**
 * A path or glob relative to the repository root, as an agent may declare it. Rejected: absolute
 * paths and drive letters, `..` segments (escape the worktree), and picomatch extglob/negation
 * syntax (`!(...)`, `@(...)`, leading `!`) that would widen a scope guard match.
 */
export const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !/^([/\\]|[A-Za-z]:)/.test(p), { message: 'must be relative to the repository root' })
  .refine((p) => !p.split(/[/\\]/).includes('..'), { message: 'must not contain ".." segments' })
  .refine((p) => !/^!|[!@+?*]\(/.test(p), { message: 'extglob and negation patterns are not allowed' })
  .refine((p) => !/[\0\r\n]/.test(p), { message: 'control characters are not allowed' });

export const Gate = z.object({
  name: z.string().regex(ID_PATTERNS.SLUG),
  command: z.string().min(1),
  blocking: z.boolean(),
  /** Gates run offline unless they must fetch (install, dependency scan). */
  network: z.enum(['none', 'egress']).default('none'),
  /** Secret names injected as environment variables into this gate's container only. */
  secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
});
export type Gate = z.infer<typeof Gate>;

export const Commands = z.object({
  install: z.string().min(1),
  format: z.string().min(1),
  lint: z.string().min(1),
  typecheck: z.string().min(1).optional(),
  test: z.string().min(1),
  build: z.string().min(1),
  run: z.string().min(1),
  healthcheck: z.string().min(1),
  /** Runs against SERVICE_URL after deploy and must write JUnit to junitPath (spec Phase 5). */
  smoke: z.string().min(1).optional(),
  /** Black-box e2e suite run after deploy against SERVICE_URL (roadmap R8.4); not the smoke command. */
  e2e: z.string().min(1).optional(),
});

/**
 * Artifacts a generated project must ship (roadmap R8.1). Every field is optional in the schema so a plan
 * without `delivery` stays valid (default: no contract, today's behavior); `validatePlan` rejects a
 * present `delivery` that omits a required artifact, and rejects a plan with no `delivery` when called
 * with `requireDelivery` (new plans). Paths are repository-relative and must exist on main at Phase 4.
 */
export const Delivery = z.object({
  dockerfile: RepoPath.optional(),
  compose: RepoPath.optional(),
  ciWorkflow: RepoPath.optional(),
  releaseWorkflow: RepoPath.optional(),
  e2eSuite: RepoPath.optional(),
  /** README headings that must exist, e.g. "Run", "Test", "Environment". */
  readmeSections: z.array(z.string().min(1)).optional(),
});
export type Delivery = z.infer<typeof Delivery>;
/** Delivery fields holding a file path (checked on main in Phase 4). */
export const DELIVERY_PATH_FIELDS = ['dockerfile', 'compose', 'ciWorkflow', 'releaseWorkflow', 'e2eSuite'] as const;

export const PlanTask = z.object({
  id: z.string().regex(ID_PATTERNS.TASK_ID),
  title: z.string().min(1),
  description: z.string().min(1),
  criteriaRefs: z.array(z.string().regex(AC_ID)),
  dependsOn: z.array(z.string().regex(ID_PATTERNS.TASK_ID)),
  affectedPaths: z.array(RepoPath).min(1),
  owner: z.enum(['dev', 'devops']),
  /** Set by the orchestrator, never by the SM: plan task, Phase 4 fix task, Phase 5 deploy-fix task. */
  origin: z.enum(['plan', 'fix', 'deploy-fix']).default('plan'),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const Plan = z.object({
  specId: z.string().regex(ID_PATTERNS.SLUG),
  specHash: z.string().regex(HASH_PATTERN),
  stack: z.string().min(1),
  adrRefs: z.array(z.string().regex(ADR_ID)),
  commands: Commands,
  /** Toolchain image every gate runs in (from the stack ADR), e.g. node:22-bookworm. */
  gateImage: z.string().min(1),
  junitPath: RepoPath,
  gates: z.array(Gate).min(1),
  frozenPaths: z.array(RepoPath).min(1),
  tasks: z.array(PlanTask).min(1),
  deploy: z.object({
    image: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    healthcheckPath: z.string().startsWith('/'),
    manifests: z.array(RepoPath),
    /** What the validation page offers: `api` opens the docs path (Swagger), `front` opens the app. */
    kind: z.enum(['api', 'front']).optional(),
    docsPath: z.string().startsWith('/').optional(),
  }),
  /** Optional; absent means no delivery contract. See `Delivery`. */
  delivery: Delivery.optional(),
  /** Criteria with no testable observable behavior over the service interface; the e2e gate skips them (roadmap R8.4). */
  e2eExemptions: z.array(z.object({ acId: z.string().regex(AC_ID), reason: z.string().min(1) })).optional(),
});
export type Plan = z.infer<typeof Plan>;
