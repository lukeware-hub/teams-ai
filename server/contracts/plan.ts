import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';
import { AC_ID, HASH_PATTERN } from './patterns.js';
import { ServiceName } from './project.js';

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
  owner: z.enum(['dev', 'devops', 'front']),
  /** Set by the orchestrator, never by the SM: plan task, Phase 4 fix task, Phase 5 deploy-fix task. */
  origin: z.enum(['plan', 'fix', 'deploy-fix']).default('plan'),
  /** The service whose repository the task changes; only in a services plan. */
  service: ServiceName.optional(),
  /** The ids of the plan tasks (T001, ...) this task does; `speckitTasks` is the name before the rename. */
  planTasks: z.array(z.string().min(1)).optional(),
  speckitTasks: z.array(z.string().min(1)).optional(),
});
export type PlanTask = z.infer<typeof PlanTask>;

/** The plan task ids a task does, under either name. */
export const taskPlanIds = (task: Pick<PlanTask, 'planTasks' | 'speckitTasks'>): string[] => task.planTasks ?? task.speckitTasks ?? [];

export const SCAFFOLD_TASK_ID = 'T0-scaffold';

/** The scaffold task of a repository: `T0-scaffold` for the project repository, `T0-scaffold-<service>` for a service's. */
export const scaffoldId = (service: string | null): string => (service === null ? SCAFFOLD_TASK_ID : `${SCAFFOLD_TASK_ID}-${service}`);

/** The first dependency cycle among the tasks, as the ids around it, or null when there is none. */
export function findCycle(tasks: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>): string[] | null {
  const byId = new Map<string, { id: string; dependsOn: readonly string[] }>();
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task);
  const color = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep) || dep === id) continue;
      if (color.get(dep) === 'visiting') return [...stack.slice(stack.indexOf(dep)), dep];
      if (!color.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 'done');
    return null;
  };

  for (const task of tasks) {
    if (!color.has(task.id)) {
      const found = visit(task.id);
      if (found) return found;
    }
  }
  return null;
}

export const Plan = z.object({
  specId: z.string().regex(ID_PATTERNS.SLUG),
  specHash: z.string().regex(HASH_PATTERN),
  stack: z.string().min(1),
  adrRefs: z.array(z.string().regex(ADR_ID)),
  commands: Commands,
  /** Toolchain image every gate runs in (from the stack ADR), e.g. node:22-bookworm, golang:1.26-bookworm, python:3.12-bookworm, rust:1-bookworm. */
  gateImage: z.string().min(1),
  junitPath: RepoPath,
  gates: z.array(Gate).min(1),
  frozenPaths: z.array(RepoPath).min(1),
  tasks: z.array(PlanTask).min(1),
  deploy: z
    .object({
      image: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      healthcheckPath: z.string().startsWith('/').optional(),
      manifests: z.array(RepoPath),
      /** What the validation page offers: `api` opens the docs path (Swagger), `front` opens the app, `mobile` offers the artifact. */
      kind: z.enum(['api', 'front', 'mobile']).optional(),
      docsPath: z.string().startsWith('/').optional(),
      /** Mobile only: the repository-relative file the build writes and the owner downloads (for example the debug APK). */
      artifact: RepoPath.optional(),
    })
    .superRefine((deploy, ctx) => {
      if (deploy.kind === 'mobile') {
        if (!deploy.artifact) ctx.addIssue({ code: 'custom', path: ['artifact'], message: 'deploy.artifact is required for a mobile plan' });
        return;
      }
      for (const field of ['image', 'port', 'healthcheckPath'] as const) {
        if (deploy[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `deploy.${field} is required unless deploy.kind is mobile` });
      }
    }),
  /** Optional; absent means no delivery contract. See `Delivery`. */
  delivery: Delivery.optional(),
  /** Criteria with no testable observable behavior over the service interface; the e2e gate skips them (roadmap R8.4). */
  e2eExemptions: z.array(z.object({ acId: z.string().regex(AC_ID), reason: z.string().min(1) })).optional(),
  /** Lockfile for whatever package manager the stack uses, declared by the SM (never a fixed per-language name,
   * so no stack is assumed); checked for existence on main at Phase 4 (roadmap R10.2). */
  lockfilePath: RepoPath.optional(),
  /** Where the `coverage` gate's command writes `{"linesPct": N}` (roadmap R10.2); required when coverage is required. */
  coveragePath: RepoPath.optional(),
  /** Paths the coverage tool's own ignore mechanism already excluded from the denominator, with a reviewable reason. */
  coverageExemptions: z.array(z.object({ path: RepoPath, reason: z.string().min(1) })).optional(),
});
export type Plan = z.infer<typeof Plan>;

/** One service's settings in a services plan: a single-repository plan without the spec identity and the tasks. */
export const ServicePlan = Plan.omit({ specId: true, specHash: true, adrRefs: true, tasks: true, e2eExemptions: true });
export type ServicePlan = z.infer<typeof ServicePlan>;

/** A plan that changes several services in one run: the spec identity and the task graph are plan-wide, every task names its service. */
export const ServicesPlan = Plan.pick({ specId: true, specHash: true, adrRefs: true, e2eExemptions: true }).extend({
  tasks: z.array(PlanTask).min(1),
  services: z.record(ServiceName, ServicePlan).refine((s) => Object.keys(s).length > 0, { message: 'a services plan needs at least one service' }),
});
export type ServicesPlan = z.infer<typeof ServicesPlan>;

/** Either plan shape; the project decides which one it gets. */
export const AnyPlan = z.union([ServicesPlan, Plan]);
export type AnyPlan = z.infer<typeof AnyPlan>;

/** A plan of either shape, told apart by `services`, so a broken plan reports only its own shape's errors. */
export const parseAnyPlan = (value: unknown): AnyPlan => (typeof value === 'object' && value !== null && 'services' in value ? ServicesPlan.parse(value) : Plan.parse(value));

/** One repository's share of a plan; `service` is null for the project repository. */
export interface ServiceView {
  service: string | null;
  plan: Plan;
}

/** The single-repository plans the pipeline runs: one per service, with its own tasks and only the dependencies inside it. */
export function servicePlans(plan: AnyPlan): ServiceView[] {
  if (!('services' in plan)) return [{ service: null, plan }];
  const { services, tasks, ...shared } = plan;
  return Object.entries(services).map(([service, settings]) => {
    const own = tasks.filter((t) => t.service === service);
    const ids = new Set(own.map((t) => t.id));
    return { service, plan: { ...shared, ...settings, tasks: own.map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => ids.has(d)) })) } };
  });
}
