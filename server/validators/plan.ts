import { DELIVERY_PATH_FIELDS, findCycle, SCAFFOLD_TASK_ID, scaffoldId, servicePlans, type Plan, type PlanTask, type ServicesPlan } from '../contracts/plan.js';
import { IMAGE_REFERENCE } from '../exec/gate-runner.js';
import { gateFileErrors, gateTerminationErrors } from './gate-files.js';
import { specShare, type Spec } from '../contracts/spec.js';
import { validateCoverage } from './coverage.js';
import { checkScope } from './diff-guard.js';
import { validateE2e, validateE2eExemptions } from './e2e.js';
import { validateSecurityGates } from './security-tooling.js';

/** Blocking gates every POC plan must define (spec §4.3); `typecheck` only when the stack has one. */
export const REQUIRED_BLOCKING_GATES = ['format', 'lint', 'unit-test', 'build', 'secret-scan'] as const;

export interface PlanCheckOptions {
  firstSpec: boolean;
  /** Deploy ports other projects already plan with; this plan must not take one of them. */
  takenPorts?: readonly number[];
  /** New plans must carry `delivery` (roadmap R8.1); false keeps plans without it valid. */
  requireDelivery?: boolean;
  /** New plans must carry the prescribed security gates (roadmap R8.5); false keeps older plans valid. */
  requireSecurityTooling?: boolean;
  /** New plans must carry a post-deploy e2e gate (roadmap R8.4); false keeps older plans valid. */
  requireE2e?: boolean;
  /** New plans must carry a `coverage` gate clearing the line-coverage floor (roadmap R10.2); false keeps older plans valid. */
  requireCoverage?: boolean;
  /** New plans must keep every task off the frozen paths; false keeps older plans valid (a fix task revalidates the whole plan). */
  requireFrozenScope?: boolean;
  /** Files already tracked on main; when given, blocking gates may only name files that exist or that a root task creates. */
  repoFiles?: ReadonlySet<string>;
  /** Secrets the environment creates for every project (`environment.generatedSecrets`): a gate may read them without the spec declaring them. */
  generatedSecretNames?: readonly string[];
}

export interface ServicesPlanCheckOptions extends Omit<PlanCheckOptions, 'firstSpec' | 'repoFiles'> {
  /** The project's services (`project.json`); the plan may name only these. */
  services: readonly string[];
  /** Services with no repository yet: each needs its own scaffold task. */
  newServices: ReadonlySet<string>;
  /** Files tracked on main of each service's repository, by service. */
  repoFiles?: Readonly<Record<string, ReadonlySet<string>>>;
  /** The host port the orchestrator assigned each service; the other services reach it there in later specs. */
  ports?: Readonly<Record<string, number | null>>;
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

/** Oldest release of a tool that still works with the gate images' toolchains, as [major, minor]. */
const TOOL_FLOORS: Record<string, [number, number]> = { 'cargo-tarpaulin': [0, 37] };

export function validatePlan(plan: Plan, spec: Spec, requested: PlanCheckOptions): string[] {
  // A mobile plan ships an artifact, not a container: no delivery files, no compose and no e2e suite over HTTP.
  const opts = plan.deploy.kind === 'mobile' ? { ...requested, requireDelivery: false, requireE2e: false } : requested;
  // `service` belongs to a services plan; a run of this project would never find the repository it names.
  const named = plan.tasks.filter((t) => t.service !== undefined).map((t) => `task ${t.id} names service ${t.service}, but this project keeps its code in the project repository; remove service`);
  return [...named, ...planWideErrors(plan, spec, opts), ...repositoryErrors(plan, spec, opts)];
}

/** A services plan: plan-wide checks once, then each service's own checks, prefixed with its name. */
export function validateServicesPlan(plan: ServicesPlan, spec: Spec, opts: ServicesPlanCheckOptions): string[] {
  const errors = planWideErrors(plan, spec, opts);
  const names = Object.keys(plan.services);
  for (const task of plan.tasks) {
    if (task.service === undefined || !names.includes(task.service)) errors.push(`task ${task.id} must name one of the plan's services (${names.join(', ')})`);
  }
  const ports = new Map<number, string>();
  for (const { service, plan: view } of servicePlans(plan)) {
    const name = service!;
    if (!opts.services.includes(name)) errors.push(`service ${name} is not one of the project's services (project.json lists ${opts.services.join(', ') || 'none'})`);
    if (view.tasks.length === 0) {
      errors.push(`service ${name} has no task`);
      continue;
    }
    // A mobile service runs no container, so it takes no port.
    const port = view.deploy.port;
    if (port !== undefined) {
      const other = ports.get(port);
      if (other !== undefined) errors.push(`services ${other} and ${name} both use deploy.port ${port}`);
      ports.set(port, name);
      const assigned = opts.ports?.[name];
      if (assigned && port !== assigned) errors.push(`service ${name}: deploy.port ${port} is not ${assigned}, the port the orchestrator assigned it`);
    }
    // A service answers only for the criteria its own tasks deliver (a smoke criterion asks for its commands.smoke).
    const share = specShare(spec, view.tasks);
    const own = { ...opts, firstSpec: opts.newServices.has(name), repoFiles: opts.repoFiles?.[name] };
    errors.push(...repositoryErrors(view, share, own, scaffoldId(name)).map((e) => `service ${name}: ${e}`));
  }
  return errors;
}

const smokeCriteria = (spec: Spec): string[] => spec.acceptanceCriteria.filter((ac) => ac.smoke).map((ac) => ac.id);

/** The spec the plan answers, the task graph across every repository, criteria coverage and e2e exemptions. */
function planWideErrors(plan: Pick<Plan, 'specId' | 'specHash' | 'tasks' | 'e2eExemptions'>, spec: Spec, opts: Pick<PlanCheckOptions, 'requireE2e'>): string[] {
  const errors: string[] = [];

  if (spec.specHash === null) errors.push('spec is not frozen');
  else if (plan.specHash !== spec.specHash) {
    errors.push(`plan specHash ${plan.specHash} does not match spec ${spec.specHash}`);
  }
  if (plan.specId !== spec.specId) errors.push(`plan specId ${plan.specId} does not match spec ${spec.specId}`);

  const ids = new Set<string>();
  let duplicates = false;
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      errors.push(`duplicate task id ${task.id}`);
      duplicates = true;
    }
    ids.add(task.id);
  }

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
  for (const ac of acIds) {
    if (!covered.has(ac)) errors.push(`acceptance criterion ${ac} is not covered by any task`);
  }

  // A criterion only ever touched by devops tasks (manifests, Dockerfile) has no unit/integration test to
  // prove it - only a running deployment can (spec §9 smoke); Phase 4 then reports it as evidence-missing
  // forever (seen live: AC-008/AC-009 on 1387253335-001-r13). Require the spec to say so up front.
  const smokeSet = new Set(smokeCriteria(spec));
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

  if (opts.requireE2e) errors.push(...validateE2eExemptions(plan, spec));
  return errors;
}

/** One repository's share of the plan, the whole plan for a single-repository project: image, port, gates, scaffold and delivery. */
function repositoryErrors(plan: Plan, spec: Spec, opts: PlanCheckOptions, scaffold = SCAFFOLD_TASK_ID): string[] {
  const errors: string[] = [];

  // The Dev installs dependencies on the orchestrator's Debian host; an Alpine gate image then fails to load
  // the native optional packages that install picked for glibc (seen live: rollup under vitest).
  // A leading dash would be read by `docker run` as a flag, not as the image.
  if (!IMAGE_REFERENCE.test(plan.gateImage)) errors.push(`gateImage ${JSON.stringify(plan.gateImage)} is not a plain image reference (name, optional :tag and @sha256 digest)`);
  if (/(^|[:/-])alpine(\d|[.:-]|$)/i.test(plan.gateImage)) errors.push(`gateImage ${plan.gateImage} is Alpine (musl); use a glibc-based image such as node:22-bookworm, golang:1.26-bookworm, python:3.12-bookworm or rust:1-bookworm`);

  if (plan.deploy.port !== undefined && opts.takenPorts?.includes(plan.deploy.port)) errors.push(`deploy.port ${plan.deploy.port} is already used by another project; use the port the orchestrator assigned`);
  if (opts.repoFiles) errors.push(...gateFileErrors(plan, opts.repoFiles));
  errors.push(...gateTerminationErrors(plan));
  // A gate may only read the secrets the spec declares; the platform's (GitHub token, API keys) never reach a gate container.
  // SERVICE_URL and SERVICE_URL_<SERVICE> are the addresses the orchestrator itself hands to the smoke and e2e gates.
  const declared = new Set([...spec.externalDependencies.flatMap((d) => d.secretNames), ...(opts.generatedSecretNames ?? [])]);
  for (const gate of plan.gates) for (const name of gate.secrets) if (!declared.has(name) && !/^SERVICE_URL(_[A-Z0-9_]+)?$/.test(name)) errors.push(`gate ${gate.name} declares secret ${name}, which no externalDependencies entry of the spec names`);
  // The JUnit report is gate output the orchestrator never commits; a task listing it can never deliver it (live: a review loop).
  for (const task of plan.tasks) if (task.affectedPaths.includes(plan.junitPath)) errors.push(`task ${task.id} lists ${plan.junitPath} in affectedPaths, but the JUnit report is gate output and never committed`);
  // A frozen file is rejected at merge even with a justification, so a task that lists one can never finish; only the first spec's scaffold may.
  if (opts.requireFrozenScope) for (const task of plan.tasks) {
    if (opts.firstSpec && task.id === scaffold) continue;
    const frozen = checkScope({ changedFiles: task.affectedPaths, affectedPaths: [], frozenPaths: plan.frozenPaths }).frozenTouched;
    if (frozen.length > 0) errors.push(`task ${task.id} lists frozen paths in affectedPaths: ${frozen.join(', ')}; frozenPaths (${plan.frozenPaths.join(', ')}) are rejected at merge, so no task can deliver them. Take them out of frozenPaths or of this task`);
  }
  // A tool fetched at a moving reference changes under the same plan (supply chain); pin a version or commit.
  // A tool pinned below a known floor cannot read the current toolchain's output (live: cargo-tarpaulin 0.31 "Parsing failed" on Rust 1.99).
  for (const command of [...plan.gates.map((g) => g.command), ...Object.values(plan.commands)]) {
    if (typeof command !== 'string') continue;
    const moving = /\S+@(latest|master|main)\b/.exec(command);
    if (moving) errors.push(`command fetches ${moving[0]} at a moving reference; pin a version or commit`);
    for (const [tool, floor] of Object.entries(TOOL_FLOORS)) {
      const pinned = new RegExp(`\\b${tool}@(\\d+)\\.(\\d+)`).exec(command);
      if (pinned && Number(pinned[1]) * 1000 + Number(pinned[2]) < floor[0] * 1000 + floor[1]) errors.push(`${pinned[0]} is too old for the current toolchain; pin ${tool} ${floor.join('.')} or newer`);
    }
  }

  const smokeAcs = smokeCriteria(spec);
  if (smokeAcs.length > 0 && !plan.commands.smoke) errors.push(`commands.smoke is required: ${smokeAcs.join(', ')} ${smokeAcs.length === 1 ? 'is a smoke criterion' : 'are smoke criteria'}`);

  // planRules tells the agent "use devops only for Dockerfile, deploy manifests, CI/release workflows and docker-compose",
  // but nothing enforced it: an SM-planned devops task that actually touches app or test code gets no Bash at all
  // (ROLE_ALLOW.devops carries none) and loops GATE_FAILED -> TASK_REPLANNED on format/typecheck it cannot run itself.
  errors.push(...devopsOwnerErrors(plan.tasks, plan.deploy.manifests));

  const scaffoldTask = plan.tasks.find((t) => t.id === scaffold);
  if (opts.firstSpec) {
    if (!scaffoldTask) errors.push(`first spec requires task ${scaffold}`);
    else {
      if (scaffoldTask.dependsOn.length > 0) errors.push(`${scaffold} must not depend on other tasks`);
      const byId = new Map(plan.tasks.map((t) => [t.id, t]));
      for (const task of plan.tasks) {
        if (task.id === scaffold) continue;
        if (!reaches(task.id, scaffold, byId)) {
          errors.push(`task ${task.id} must depend on ${scaffold}`);
        }
      }
    }
    if (!plan.tasks.some((t) => t.owner === 'devops')) {
      errors.push('first spec requires a deploy-infrastructure task owned by devops');
    }
  } else if (scaffoldTask) {
    errors.push(`${scaffold} is only allowed on the first spec`);
  }

  const blocking = new Set(plan.gates.filter((g) => g.blocking).map((g) => g.name));
  for (const name of REQUIRED_BLOCKING_GATES) {
    if (!blocking.has(name)) errors.push(`missing blocking gate ${name}`);
  }
  if (plan.commands.typecheck && !blocking.has('typecheck')) {
    errors.push('missing blocking gate typecheck (commands.typecheck is defined)');
  }

  if (opts.requireSecurityTooling) errors.push(...validateSecurityGates(plan));
  if (opts.requireE2e) errors.push(...validateE2e(plan));
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
