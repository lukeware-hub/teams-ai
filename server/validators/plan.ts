import { DELIVERY_PATH_FIELDS, type Plan, type PlanTask } from '../contracts/plan.js';
import { gateFileErrors, gateTerminationErrors } from './gate-files.js';
import type { Spec } from '../contracts/spec.js';
import { validateCoverage } from './coverage.js';
import { validateE2e } from './e2e.js';
import { validateSecurityGates } from './security-tooling.js';

export const SCAFFOLD_TASK_ID = 'T0-scaffold';

/** Blocking gates every POC plan must define (spec §4.3); `typecheck` only when the stack has one. */
export const REQUIRED_BLOCKING_GATES = ['format', 'lint', 'unit-test', 'build', 'secret-scan'] as const;

export interface PlanCheckOptions {
  firstSpec: boolean;
  /** New plans must carry `delivery` (roadmap R8.1); false keeps plans without it valid. */
  requireDelivery?: boolean;
  /** New plans must carry the prescribed security gates (roadmap R8.5); false keeps older plans valid. */
  requireSecurityTooling?: boolean;
  /** New plans must carry a post-deploy e2e gate (roadmap R8.4); false keeps older plans valid. */
  requireE2e?: boolean;
  /** New plans must carry a `coverage` gate clearing the line-coverage floor (roadmap R10.2); false keeps older plans valid. */
  requireCoverage?: boolean;
  /** Files already tracked on main; when given, blocking gates may only name files that exist or that a root task creates. */
  repoFiles?: ReadonlySet<string>;
}

/** Is `p` the kind of path planRules reserves for `devops` (Dockerfile, deploy manifests, a CI/release workflow or docker-compose)? */
export function isInfraPath(p: string, manifests: readonly string[]): boolean {
  const base = p.split('/').at(-1) ?? p;
  if (/^Dockerfile(\..+)?$/.test(base)) return true;
  if (base === 'deployment.json') return true;
  if (/^docker-compose(\..+)?\.ya?ml$/i.test(base)) return true;
  if (p.startsWith('.github/workflows/')) return true;
  if (base === '.dockerignore') return true;
  const manifestRoots = new Set(manifests.map((m) => m.split('/')[0]));
  return manifestRoots.has(p.split('/')[0]);
}

/** A task owned by devops whose affectedPaths are not infra gets no Bash at all (ROLE_ALLOW.devops), so it can never
 * run format/lint/typecheck itself; used by both the full-plan validator and a mid-run replan's own check. */
export function devopsOwnerErrors(tasks: readonly Pick<PlanTask, 'id' | 'owner' | 'affectedPaths'>[], manifests: readonly string[]): string[] {
  const errors: string[] = [];
  for (const task of tasks) {
    if (task.owner !== 'devops') continue;
    for (const p of task.affectedPaths) {
      if (!isInfraPath(p, manifests)) errors.push(`task ${task.id} is owned by devops but ${p} is not infra (Dockerfile, deploy manifests, a CI/release workflow or docker-compose); use dev`);
    }
  }
  return errors;
}

export function validatePlan(plan: Plan, spec: Spec, opts: PlanCheckOptions): string[] {
  const errors: string[] = [];

  if (spec.specHash === null) errors.push('spec is not frozen');
  else if (plan.specHash !== spec.specHash) {
    errors.push(`plan specHash ${plan.specHash} does not match spec ${spec.specHash}`);
  }
  if (plan.specId !== spec.specId) errors.push(`plan specId ${plan.specId} does not match spec ${spec.specId}`);
  // The Dev installs dependencies on the orchestrator's Debian host; an Alpine gate image then fails to load
  // the native optional packages that install picked for glibc (seen live: rollup under vitest).
  // A leading dash would be read by `docker run` as a flag, not as the image.
  if (plan.gateImage.startsWith('-')) errors.push(`gateImage ${plan.gateImage} must not start with '-'`);
  if (/(^|[:/-])alpine(\d|[.:-]|$)/i.test(plan.gateImage)) errors.push(`gateImage ${plan.gateImage} is Alpine (musl); use a glibc-based image such as node:22-bookworm-slim`);

  if (opts.repoFiles) errors.push(...gateFileErrors(plan, opts.repoFiles));
  errors.push(...gateTerminationErrors(plan));

  const ids = new Set<string>();
  let duplicates = false;
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      errors.push(`duplicate task id ${task.id}`);
      duplicates = true;
    }
    ids.add(task.id);
  }

  const smokeAcs = spec.acceptanceCriteria.filter((ac) => ac.smoke).map((ac) => ac.id);
  if (smokeAcs.length > 0 && !plan.commands.smoke) errors.push(`commands.smoke is required: ${smokeAcs.join(', ')} ${smokeAcs.length === 1 ? 'is a smoke criterion' : 'are smoke criteria'}`);

  const acIds = new Set(spec.acceptanceCriteria.map((ac) => ac.id));
  const covered = new Set<string>();
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) errors.push(`task ${task.id} depends on itself`);
      else if (!ids.has(dep)) errors.push(`task ${task.id} depends on unknown task ${dep}`);
    }
    for (const ref of task.criteriaRefs) {
      if (!acIds.has(ref)) errors.push(`task ${task.id} references unknown acceptance criterion ${ref}`);
      covered.add(ref);
    }
  }
  // planRules tells the agent "use devops only for Dockerfile, deploy manifests, CI/release workflows and docker-compose",
  // but nothing enforced it: an SM-planned devops task that actually touches app or test code gets no Bash at all
  // (ROLE_ALLOW.devops carries none) and loops GATE_FAILED -> TASK_REPLANNED on format/typecheck it cannot run itself.
  const devopsScopeErrors = devopsOwnerErrors(plan.tasks, plan.deploy.manifests);
  errors.push(...devopsScopeErrors);
  for (const ac of acIds) {
    if (!covered.has(ac)) errors.push(`acceptance criterion ${ac} is not covered by any task`);
  }

  // A criterion only ever touched by devops tasks (manifests, Dockerfile) has no unit/integration test to
  // prove it - only a running deployment can (spec §9 smoke); Phase 4 then reports it as evidence-missing
  // forever (seen live: AC-008/AC-009 on 1387253335-001-r13). Require the spec to say so up front.
  const smokeSet = new Set(smokeAcs);
  const tasksByAc = new Map<string, string[]>();
  for (const task of plan.tasks) for (const ref of task.criteriaRefs) tasksByAc.set(ref, [...(tasksByAc.get(ref) ?? []), task.owner]);
  for (const [ac, owners] of tasksByAc) {
    if (owners.length > 0 && owners.every((o) => o === 'devops') && !smokeSet.has(ac)) {
      errors.push(`acceptance criterion ${ac} is only covered by devops task(s) (infra/manifests, no app test); mark it smoke: true in the spec or add an app-level test`);
    }
  }

  // With duplicate ids the graph is ambiguous; the duplicate error already blocks the plan.
  if (!duplicates) {
    const cycle = findCycle(plan.tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }

  const scaffold = plan.tasks.find((t) => t.id === SCAFFOLD_TASK_ID);
  if (opts.firstSpec) {
    if (!scaffold) errors.push(`first spec requires task ${SCAFFOLD_TASK_ID}`);
    else {
      if (scaffold.dependsOn.length > 0) errors.push(`${SCAFFOLD_TASK_ID} must not depend on other tasks`);
      const byId = new Map(plan.tasks.map((t) => [t.id, t]));
      for (const task of plan.tasks) {
        if (task.id === SCAFFOLD_TASK_ID) continue;
        if (!reaches(task.id, SCAFFOLD_TASK_ID, byId)) {
          errors.push(`task ${task.id} must depend on ${SCAFFOLD_TASK_ID}`);
        }
      }
    }
    if (!plan.tasks.some((t) => t.owner === 'devops')) {
      errors.push('first spec requires a deploy-infrastructure task owned by devops');
    }
  } else if (scaffold) {
    errors.push(`${SCAFFOLD_TASK_ID} is only allowed on the first spec`);
  }

  const blocking = new Set(plan.gates.filter((g) => g.blocking).map((g) => g.name));
  for (const name of REQUIRED_BLOCKING_GATES) {
    if (!blocking.has(name)) errors.push(`missing blocking gate ${name}`);
  }
  if (plan.commands.typecheck && !blocking.has('typecheck')) {
    errors.push('missing blocking gate typecheck (commands.typecheck is defined)');
  }

  if (opts.requireSecurityTooling) errors.push(...validateSecurityGates(plan));
  if (opts.requireE2e) errors.push(...validateE2e(plan, spec));
  if (opts.requireCoverage) errors.push(...validateCoverage(plan));

  if (!plan.delivery) {
    if (opts.requireDelivery) errors.push('delivery is required: list dockerfile, compose, ciWorkflow, releaseWorkflow, e2eSuite and readmeSections');
  } else {
    for (const field of DELIVERY_PATH_FIELDS) {
      if (!plan.delivery[field]) errors.push(`delivery.${field} is required`);
    }
    if (!plan.delivery.readmeSections?.length) errors.push('delivery.readmeSections is required (at least one section)');
  }
  if (opts.requireDelivery && !plan.lockfilePath) errors.push('lockfilePath is required (the stack\'s own lockfile, committed on main)');

  return errors;
}

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

function reaches(from: string, target: string, byId: ReadonlyMap<string, PlanTask>): boolean {
  const seen = new Set<string>();
  const pending = [...(byId.get(from)?.dependsOn ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}
