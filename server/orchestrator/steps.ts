import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import type { Governor } from '../budget/governor.js';
import type { QuotaBreaker } from '../budget/quota-breaker.js';
import type { RoleProfile, Role } from '../config/config.js';
import { SCAFFOLD_TASK_ID, type Plan, type PlanTask } from '../contracts/plan.js';
import type { Preplan } from '../contracts/preplan.js';
import type { PlatformService, Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { Effort } from '../decide/decisions/model-tier.js';
import type { ReviewProfile } from '../decide/decisions/pr-risk.js';
import { stepId } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import { buildContextPack, estimateTokens, type CodeContext, type ContextPack, type ContextPackInput, type HandoffSummary } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import { hasSession } from '../runner/session-store.js';
import type { runStep as runStepFn, StepDeps, StepOutcome, StepRequest } from '../runner/step.js';
import type { TestResult } from '../evidence/junit.js';
import type { RefContext } from '../validators/references.js';
import { REQUIRED_BLOCKING_GATES } from '../validators/plan.js';
import { securityToolingRules } from '../validators/security-tooling.js';
import { OrchEvent, type Journal } from './events.js';

export interface PackBase {
  spec: Spec;
  project: Project;
  specHash: string;
  assumptions: readonly string[];
  adrs?: ReadonlyArray<{ id: string; title: string; text: string }>;
  techSpecExcerpt?: string;
  retrieval?: readonly Hit[];
  budgetTokens: number;
}

export function outputContract(kind: StepKind): string {
  return `Return exactly one JSON object matching this schema:\n${JSON.stringify(toJsonSchema(kind))}`;
}

function criteriaOf(spec: Spec, ids: readonly string[]) {
  return spec.acceptanceCriteria.filter((c) => ids.includes(c.id));
}

/** Longest gate-result list a review pack carries; the rest is a count. */
const REVIEW_JUNIT_LINES = 200;

type Common = Pick<
  ContextPackInput,
  'kind' | 'role' | 'specHash' | 'principles' | 'outputContract' | 'assumptions' | 'adrs' | 'retrieval' | 'budgetTokens' | 'techSpecExcerpt'
>;

function common(base: PackBase, kind: StepKind, role: Role): Common {
  return {
    kind,
    role,
    specHash: base.specHash,
    principles: base.project.principles,
    outputContract: outputContract(kind),
    assumptions: base.assumptions,
    adrs: base.adrs,
    retrieval: base.retrieval,
    techSpecExcerpt: base.techSpecExcerpt,
    budgetTokens: base.budgetTokens,
  };
}

/** How the e2e suite must be written; any task that writes it gets this, whatever role owns it. */
export const e2eSuiteRules = (suite: string): string =>
  `When you write or change the e2e suite (${suite}): it runs black-box over HTTP against process.env.SERVICE_URL after the deploy, one test per acceptance criterion with its id in the name (for example "[AC-001] POST /todos creates a todo"), no mocks of the service under test, and it never starts, builds or restarts containers. The deployed service keeps the data of earlier runs and specs: never assume an empty store or a fixed count; create the data each test needs with unique values and assert only on that data, and prove a behavior that needs no data with a request no stored record can match (for example a filter or page no record reaches). Never skip a test: a skipped test counts as a criterion without an e2e test and fails the deploy.`;

/** The task touches the suite itself or a file of its folder. */
function writesE2eSuite(task: PlanTask, suite: string): boolean {
  const dir = suite.endsWith('/') ? suite : `${path.posix.dirname(suite)}/`;
  return task.affectedPaths.some((p) => p === suite || (dir !== './' && p.startsWith(dir)));
}

export function devPack(
  base: PackBase,
  task: PlanTask,
  opts: { code: CodeContext; handoffs: readonly HandoffSummary[]; feedback: string | null; e2eSuite?: string },
  role: Role = 'dev',
): ContextPackInput {
  const shared = common(base, 'dev', role);
  return {
    ...shared,
    principles: opts.e2eSuite && writesE2eSuite(task, opts.e2eSuite) ? [...shared.principles, e2eSuiteRules(opts.e2eSuite)] : shared.principles,
    task,
    criteria: criteriaOf(base.spec, task.criteriaRefs),
    handoffs: opts.handoffs,
    code: opts.code,
    feedback: opts.feedback ?? undefined,
  };
}

/**
 * What a resumed Dev session is told (R11.13 slice 7): the original pack is already in the session, so only the feedback
 * of the attempt that just ended travels. Files may have changed since (a rebase, the Test engineer's tests), hence the re-read.
 */
export function devResumePrompt(feedback: string | null): string {
  return [
    '## Retry of the previous attempt',
    'This continues your previous session on this task: the task, acceptance criteria, code context and your earlier work are above and still apply. The worktree is the one you worked in; read a file again before editing it, because other changes may have landed.',
    `## Feedback from the previous attempt\n${feedback ?? 'None recorded; try again.'}`,
    'Fix what the feedback names and answer with the same JSON contract, echoing the same specHash.',
  ].join('\n\n') + '\n';
}

/** A prompt that is not built from sections; journaled like one so the step record keeps its shape. */
export function resumedPack(text: string): ContextPack {
  return { text, tokens: estimateTokens(text), sections: ['feedback'], dropped: [] };
}

export function reviewPack(
  base: PackBase,
  task: PlanTask,
  opts: { diffStat: string; changedFiles: readonly string[]; diff: string; junit: readonly TestResult[]; code: CodeContext; profile: ReviewProfile },
): ContextPackInput {
  const feedback = `Review profile: ${opts.profile}`;
  const results = opts.junit.slice(0, REVIEW_JUNIT_LINES).map((t) => `- ${t.id} [${t.status}]${t.acIds.length > 0 ? ` ${t.acIds.join(', ')}` : ''}`);
  if (opts.junit.length > REVIEW_JUNIT_LINES) results.push(`- ... ${opts.junit.length - REVIEW_JUNIT_LINES} more`);
  // The merge gates already ran the suite on this exact diff: the reviewer reads their result instead of re-running it (R11.13 slice 2).
  const changeSet = `Changed files:\n${opts.changedFiles.join('\n')}\n\nDiff stat:\n${opts.diffStat}\n\nThe JUnit report (reports/junit.xml) is gate output the orchestrator never commits: do not ask for it.\n\nThe compose service healthcheck and its "image: \${TEAMS_AI_IMAGE:-...}" line are the orchestrator's deploy contract (it tags, verifies and rolls back the image through them): never ask to remove them.\n\nGate test results (the merge gates already ran the suite on this diff; do not re-run it):\n${results.join('\n') || '- none reported'}\n\nDiff against origin/main:\n${opts.diff}`;
  return { ...common(base, 'review', 'test'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), code: opts.code, feedback, changeSet };
}

/**
 * The diff is inlined because the sec role has no Bash; it reads surrounding files with Read, Grep and Glob.
 * It travels as the pinned change set: as droppable feedback, a diff that alone outgrew the 12k-token budget
 * (about 40k characters) was dropped whole, and the truncation notice at its end went with it.
 */
export function securityPack(
  base: PackBase,
  task: PlanTask,
  opts: { diffStat: string; changedFiles: readonly string[]; diff: string; code: CodeContext },
): ContextPackInput {
  const changeSet = `Changed files:\n${opts.changedFiles.join('\n')}\n\nDiff stat:\n${opts.diffStat}\n\nDiff against origin/main:\n${opts.diff}`;
  return { ...common(base, 'security', 'sec'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), code: opts.code, changeSet };
}

export function techSpecPack(base: PackBase, opts: { feedback: string | null }): ContextPackInput {
  return {
    ...common(base, 'tech-spec', 'dev'),
    criteria: base.spec.acceptanceCriteria,
    objectives: [
      ...base.spec.objectives,
      ...base.spec.features.map((f) => `feature: ${f}`),
      ...base.project.constraints.map((c) => `constraint: ${c}`),
      ...(base.project.stack ? [`stack: ${base.project.stack}`] : []),
    ],
    feedback: opts.feedback ?? undefined,
  };
}

export function coveragePack(base: PackBase, opts: { techSpecText: string }): ContextPackInput {
  return { ...common(base, 'coverage', 'po'), criteria: base.spec.acceptanceCriteria, objectives: base.spec.objectives, techSpecExcerpt: opts.techSpecText };
}

/** The validator's rules, stated before the SM plans; learning them by rejection costs a step each time. */
/** How Phase 5 runs commands.smoke; the Dev writing the smoke tests must know it (SERVICE_URL was never
 * mentioned to any agent, and the first live smoke suite built and started containers itself). */
export const SMOKE_CONTRACT =
  'commands.smoke runs inside gateImage against a service the orchestrator has ALREADY deployed: the tests read the base URL from process.env.SERVICE_URL, never start, build or restart containers (docker is not available there), and each acceptance criterion with smoke: true needs at least one test whose name carries its id, e.g. "[AC-001] GET /health answers 200"';

/** How Phase 5 runs commands.e2e (roadmap R8.4); the Test agent writing the suite and the SM planning it must know it. */
export const E2E_CONTRACT =
  'commands.e2e is required and is NOT commands.smoke: it runs the suite at delivery.e2eSuite (the command must reference that path) inside gateImage after the compose stack is deployed and smoke has passed, black-box over HTTP against process.env.SERVICE_URL, no mocks of the service under test, never starting containers; the gate has no root, no apt and no browser, so the suite uses only HTTP (for example fetch with node:test, checking page HTML as text) and never Playwright, Cypress or Puppeteer; every acceptance criterion needs one test whose name carries its id, e.g. "[AC-001] POST /todos creates a todo", EXCEPT criteria with no testable observable behavior over the service interface (devops-only, build, docs or style rules): list those in plan.e2eExemptions as {acId, reason} (reason of at least 10 characters, at least one criterion stays covered) and they get no e2e test; plan one task owned by dev that creates the suite and depends on the service tasks; a failing e2e blocks the run';

/** The coverage gate is stack-agnostic by contract, never by prescribed tool (roadmap R10.2): whatever the stack's
 * own coverage tool is, the gate's command must end by writing coveragePath as one line of JSON, {"linesPct": N};
 * the orchestrator reads only that number, never the tool's own report format, and fails the gate below 80 even
 * when the command's own exit code is 0. coverageExemptions lists paths the tool's own ignore mechanism already
 * excluded from the denominator, each with a reason of at least 10 characters. */
export const COVERAGE_CONTRACT =
  'gate "coverage" (blocking) runs the test suite with whatever coverage tool the stack has, then writes plan.coveragePath as one line of JSON {"linesPct": <number>}; the orchestrator fails the gate when linesPct is below 80, or the file is missing or malformed, regardless of the command\'s own exit code; a path the tool\'s own config already excludes from coverage goes in plan.coverageExemptions as {path, reason} (reason of at least 10 characters)';

export function planRules(firstSpec: boolean | 'services', requireDelivery = false, requireSecurityTooling = false, requireE2e = false, requireCoverage = false): string {
  const lines = [
    'Plan rules (the orchestrator rejects a plan that breaks any of them):',
    '- deploy.kind is "api" or "front" (what the service is); an api sets deploy.docsPath to the path that serves its Swagger/OpenAPI page (for example /docs); deploy.port must be inside 20000-20099, the range the platform publishes to the host so the human can open the service',
    '- a database or other datastore service in docker-compose (Postgres, MySQL, Redis, ...) publishes its own port to the host too, on a port outside 20000-20099; an integration test against a real database needs a route to it exactly like the app has for deploy.port, and one that only the compose-internal network can reach has none',
    `- gates must include these blocking gates: ${REQUIRED_BLOCKING_GATES.join(', ')} (plus a blocking typecheck gate when commands.typecheck exists)`,
    '- every acceptance criterion is covered by at least one task (criteriaRefs); every task has at least one criterion or is infrastructure',
    '- every task id is T<n>-<slug>: a number plus 1 to 4 English kebab-case words saying what the task does (T1-create-endpoint, T2-add-login-form); never a bare T1',
    '- dependsOn forms a DAG; affectedPaths are repository-relative paths or globs; tasks small enough for one agent step',
    '- dependsOn names only a real dependency: the task needs code, an interface or a file that the other task creates. Writing the tasks in order is not a dependency; tasks that touch different files run in parallel, and a chain of dependsOn that is not needed makes the run sequential',
    OWNER_RULE,
    EVIDENCE_RULE,
    '- gateImage is a glibc-based image with the stack toolchain plus sh, python3, curl and jq, never an Alpine/musl one and never a -slim variant without those tools: node:22-bookworm, golang:1.26-bookworm, python:3.12-bookworm or rust:1-bookworm. Dependencies are installed by the Dev on a Debian host and native optional packages (rollup, esbuild, swc) will not load under musl',
    '- the gates run offline in another container, so everything install fetches must land in the worktree. Go: golang image of the same minor as the host Go (1.26); Cargo, Go and pip caches already point to .tools. Python: python:3.11-bookworm (the minor of the Debian host that runs install) and commands.install is `python3 -m venv .tools/venv && .tools/venv/bin/pip install --target .tools/py -r requirements.txt`; gates run `python -m pytest` (PYTHONPATH already exposes .tools/py)',
    '- coverage tool per stack: Go `go test -coverprofile` then `go tool cover -func`; Rust cargo-tarpaulin 0.37 or newer with --engine llvm; Python coverage.py; Node.js vitest --coverage or c8. Pin every tool at its current release: an old release may not read the data of the toolchain in the gate image',
    '- the deploy contract is fixed and no ADR may forbid it: docker-compose.yml keeps a healthcheck on deploy.healthcheckPath and `image: ${TEAMS_AI_IMAGE:-<image>:latest}`, through which the orchestrator tags, verifies and rolls back each deploy',
    '- Rust: the gates build with the Rust of the gate image, offline, and ignore rust-toolchain.toml; never write code that needs a Rust newer than that image',
    '- Go: the go.mod `go` line carries the full patch version of the Go in the gate image (for example `go 1.26.9`, never `go 1.26`): osv-scanner reads `go 1.26` as 1.26.0 and fails dependency-scan on every standard library vulnerability fixed later. Write that patch version in the task that creates go.mod, and never add a toolchain line',
    '- every test gate writes JUnit to junitPath and each test name carries its criterion. Node.js: node --test or vitest, `[AC-001]` in the name. Go: gotestsum --junitfile, `t.Run("[AC-001] ...")`. Python: pytest --junitxml, `def test_ac_001_...`. Rust: cargo nextest with JUnit enabled in .config/nextest.toml, `fn ac_001_...`. Install the JUnit tool in commands.install into .tools/bin (for example `GOBIN=$PWD/.tools/bin go install gotest.tools/gotestsum@<version>`)',
    '- the JUnit file at junitPath is gate output and is never committed (the orchestrator excludes it), so no task creates, commits or lists it in affectedPaths',
    `- ${SMOKE_CONTRACT}`,
    '- commands.smoke and commands.e2e print one result line per test, named with its criterion, or write JUnit to junitPath: TAP (node --test), go test -v, cargo test, pytest -v or python -m unittest -v; a runner that prints only dots or a summary gives no evidence and fails the deploy',
    requireDelivery
      ? '- delivery is required: {dockerfile, compose, ciWorkflow, releaseWorkflow, e2eSuite} are repository-relative file paths the project must ship (e.g. Dockerfile, docker-compose.yml, .github/workflows/ci.yml, .github/workflows/release.yml, e2e/) and readmeSections lists the README headings that must exist (e.g. Run, Test, Environment, Architecture, Pipeline); Phase 4 fails if a listed file is missing on main, so assign each one to a task'
      : '- delivery is optional; when present it must list dockerfile, compose, ciWorkflow, releaseWorkflow, e2eSuite (file paths) and readmeSections (non-empty); Phase 4 fails if a listed file is missing on main',
    requireDelivery
      ? '- lockfilePath is required: the repository-relative path of whatever lockfile the stack\'s own package manager produces (package-lock.json, poetry.lock, go.sum, Cargo.lock, ... - name the real one, there is no fixed list); Phase 4 fails if it is missing on main. Every FROM line in the Dockerfile must carry a @sha256 digest or an explicit non-latest tag (never a bare image or image:latest); Phase 4 fails on an unpinned base image'
      : '- when delivery.dockerfile is present, every FROM line must carry a @sha256 digest or an explicit non-latest tag (never a bare image or image:latest)',
  ];
  if (requireSecurityTooling) lines.push(securityToolingRules());
  if (requireE2e) lines.push(`- ${E2E_CONTRACT}`);
  if (requireCoverage) lines.push(`- ${COVERAGE_CONTRACT}`);
  // A services plan states its scaffolds per service (servicesPlanRules).
  if (firstSpec === true) {
    lines.push(
      `- first spec of the project: a task with id ${SCAFFOLD_TASK_ID} (owner dev, no dependsOn) creates the project skeleton, build, test and gate configuration; every other task depends on it directly or indirectly`,
      '- first spec of the project: one deploy-infrastructure task owned by devops (Dockerfile, manifests, deployment.json)',
    );
  } else if (firstSpec === false) {
    lines.push(`- ${SCAFFOLD_TASK_ID} is only allowed on the first spec of a project`);
  }
  return lines.join('\n');
}

export interface ServicesPack { names: readonly string[]; newServices: ReadonlySet<string>; ports: Readonly<Record<string, number | null>>; platform: readonly PlatformService[] }

/** What a services plan adds to the plan rules (R12.6): one repository and one port per service, a scaffold per new service. */
export function servicesPlanRules(opts: ServicesPack): string {
  const fresh = opts.names.filter((s) => opts.newServices.has(s));
  const existing = opts.names.filter((s) => !opts.newServices.has(s));
  return [
    `Services plan (project.json splits the system into services, one repository each: ${opts.names.join(', ')}):`,
    '- return specId, specHash, adrRefs and e2eExemptions at the top, `tasks` with each task naming its `service`, and `services`: a map from each service this spec changes to its settings (stack, commands, gateImage, junitPath, gates, frozenPaths, deploy, delivery, lockfilePath and the coverage fields), which follow every plan rule above as services.<name>.<field>; list only the services this spec changes, each with at least one task',
    "- a task changes only its own service's repository; dependsOn may name a task of another service; a service's smoke and e2e suites prove only the criteria its own tasks reference",
    fresh.length > 0 ? `- new services (their main holds no code yet): ${fresh.join(', ')}. Each gets a task with id T0-scaffold-<service> (owner dev, no dependsOn) that creates its skeleton, build, test and gate configuration, every other task of that service depends on it, and one deploy-infrastructure task owned by devops (Dockerfile, docker-compose.yml)` : '',
    existing.length > 0 ? `- existing services: ${existing.join(', ')}. Their code is on main: never give them a scaffold task` : '',
    ...opts.names.flatMap((s) => (opts.ports[s] ? [`- services.${s}.deploy.port is exactly ${opts.ports[s]}: the orchestrator assigned it so no two services share a host port; the service listens on PORT=${opts.ports[s]} and its docker-compose publishes "${opts.ports[s]}:${opts.ports[s]}"`] : [])),
    "- each service runs in its own compose project; teams-ai joins its main container (the compose service named exactly like the service) to the project's shared network under the service's name, so services call each other at http://<service>:<port>; a suite reads its own address from SERVICE_URL and each other service's from SERVICE_URL_<SERVICE> (upper case, dashes as underscores)",
    opts.platform.length > 0 ? `- platform containers teams-ai starts before the services, from project.json: ${opts.platform.map((p) => `${p.name} (${p.image})`).join(', ')}. Never plan, build or declare them in a compose file; services reach them by name on the shared network` : '- the project declares no platform containers',
    '- teams-ai starts the platform first, then the services one by one in name order, each healthy before the next: a service must start and pass its healthcheck without the other services (retry a call to another service instead of failing at start)',
  ].filter((l) => l !== '').join('\n');
}

export function planPack(
  base: PackBase,
  opts: { techSpecText: string; preplan?: Preplan | null; godNodes: ReadonlyArray<{ label: string; edges: number }>; feedback: string | null; firstSpec?: boolean; requireDelivery?: boolean; requireSecurityTooling?: boolean; requireE2e?: boolean; requireCoverage?: boolean; deployPort?: number | null; services?: ServicesPack },
): ContextPackInput {
  const human = (base.spec.tasks ?? []).map((t) => `- ${t.title}: ${t.description}`);
  const nodes = opts.godNodes.map((n) => `- ${n.label} (${n.edges} edges)`);
  const parts = [
    planRules(opts.services ? 'services' : opts.firstSpec ?? false, opts.requireDelivery ?? false, opts.requireSecurityTooling ?? false, opts.requireE2e ?? false, opts.requireCoverage ?? false),
    opts.services ? servicesPlanRules(opts.services) : '',
    !opts.services && opts.deployPort ? `deploy.port is exactly ${opts.deployPort}: the orchestrator assigned it so no two projects share a host port; the service listens on PORT=${opts.deployPort} and docker-compose publishes "${opts.deployPort}:${opts.deployPort}"` : '',
    opts.preplan ? `Pre-plan reviewed at refinement time (context only: follow the real repository, not this; cover at least its acceptance criteria):\n${JSON.stringify(opts.preplan, null, 2)}` : '',
    human.length > 0 ? `Human-defined tasks (derive dependencies, keep them):\n${human.join('\n')}` : '',
    nodes.length > 0 ? `Central modules of the current code (graph god-nodes):\n${nodes.join('\n')}` : '',
    opts.feedback ?? '',
  ].filter((s) => s !== '');
  return {
    ...common(base, opts.services ? 'services-plan' : 'plan', 'sm'),
    criteria: base.spec.acceptanceCriteria,
    objectives: [...base.spec.objectives, ...base.project.constraints.map((c) => `constraint: ${c}`)],
    techSpecExcerpt: opts.techSpecText,
    feedback: parts.length > 0 ? parts.join('\n\n') : undefined,
  };
}

export function specGapPack(base: PackBase, task: PlanTask, opts: { question: string }): ContextPackInput {
  return { ...common(base, 'spec-gap', 'sm'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), feedback: `Dev question (spec gap):\n${opts.question}` };
}

/** The scaffold task is what makes the plan's gates runnable; split up, none of its pieces can pass them. */
export const SCAFFOLD_REPLAN_RULE =
  'This is the scaffold task: every gate in the plan (npm run, go test, pytest, cargo test ...) runs against each task on its own, so the toolchain (the manifest such as package.json, go.mod, pyproject.toml or Cargo.toml, the lockfile, configs, gate scripts) must land in ONE task. Replan it as exactly one replacement task, never several.';

export function replanPack(base: PackBase, task: PlanTask, opts: { history: readonly string[]; boundaries: readonly string[]; atomic?: boolean }): ContextPackInput {
  const constraint = opts.atomic ? `\n\nConstraint:\n- ${SCAFFOLD_REPLAN_RULE}` : '';
  const feedback = `Attempt history:\n${opts.history.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\nModule boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}${constraint}`;
  return { ...common(base, 'replan', 'sm'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), feedback };
}

const EVIDENCE_RULE =
  '- integrated verification counts a criterion as covered only from the JUnit of the plan test gates run on main; a test behind a build tag, marker or path those gate commands do not run (smoke, e2e, image) never counts, so a criterion with smoke: false keeps its test in code the test gate runs (a check that needs docker reads the Dockerfile or manifests instead, since gates have no docker)';

const OWNER_RULE =
  '- owner is dev, devops or front: use front only when every affectedPaths entry is UI code (e.g. web/src/**); use devops only for Dockerfile, deploy manifests, CI/release workflows and docker-compose; everything else is dev';

export function fixTasksPack(base: PackBase, opts: { failedTests: readonly string[]; tails: string; uncoveredAcs: readonly string[]; plan: Pick<Plan, 'tasks' | 'gates'>; services?: readonly string[]; boundaries: readonly string[]; feedback: string | null }): ContextPackInput {
  const feedback = [
    'Integrated verification on main failed. Plan 1 to 3 fix tasks. Ids are assigned by the orchestrator.',
    `Failed tests:\n${opts.failedTests.map((t) => `- ${t}`).join('\n') || '- none'}`,
    `Criteria without passed evidence:\n${opts.uncoveredAcs.map((a) => `- ${a}`).join('\n') || '- none'}`,
    `Gate output (tail):\n${opts.tails}`,
    `Existing tasks:\n${opts.plan.tasks.map((t) => `- ${t.id}: ${t.title} [${t.criteriaRefs.join(', ')}]`).join('\n')}`,
    `Test gates run on main:\n${opts.plan.gates.filter((g) => g.name.includes('test')).map((g) => `- ${g.name}: ${g.command}`).join('\n') || '- none'}`,
    `Module boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}`,
    OWNER_RULE,
    opts.services ? `Each task names its service, one of: ${opts.services.join(', ')}. A task changes only that service's repository.` : '',
    opts.feedback ? `Previous answer was rejected:\n${opts.feedback}` : '',
  ].filter(Boolean).join('\n\n');
  return { ...common(base, 'fix-tasks', 'sm'), criteria: base.spec.acceptanceCriteria, feedback };
}

export const DOCS_STRUCTURE = [
  'Documentation is a gate; the orchestrator rejects the step unless all three documents pass:',
  '- `readme` (docs/README.md): headings for run, test, env (environment variables), architecture and pipeline (CI/CD), each with real content (English or Portuguese names).',
  '- `runbook` (docs/RUNBOOK.md): headings for start, stop, logs and rollback, each with real content.',
  '- `apiDocs` (docs/API.md): every endpoint named in the spec features, written with its exact path (only needed when the features name endpoints).',
].join('\n');

/** The plan's delivery sections the README must carry; the validator checks them the same way. */
const plannedSections = (sections: readonly string[] | undefined): string[] =>
  sections?.length ? [`docs/README.md also needs a heading naming each section the plan lists: ${sections.join(', ')}.`] : [];

export function readmePack(base: PackBase, opts: { tasks: readonly string[]; existing: string | null; docsErrors?: readonly string[]; readmeSections?: readonly string[] }): ContextPackInput {
  return { ...common(base, 'readme', 'sm'), criteria: base.spec.acceptanceCriteria, feedback: [
    'Write docs/README.md for this project: the Markdown overview a newcomer reads first. Read the repository (package.json, go.mod, pyproject.toml or Cargo.toml, entry points, tests, Dockerfile) with Read, Grep and Glob; state only what the files confirm.',
    DOCS_STRUCTURE,
    ...plannedSections(opts.readmeSections),
    ...(opts.docsErrors?.length ? [`Your previous documents were rejected, fix every point:\n${opts.docsErrors.map((e) => `- ${e}`).join('\n')}`] : []),
    `Delivered tasks:\n${opts.tasks.join('\n') || '- none'}`,
    opts.existing ? `Current docs/README.md (rewrite it, keep what is still true):\n${opts.existing}` : 'There is no docs/README.md yet.',
  ].join('\n\n') };
}

export function reportPack(base: PackBase, opts: { delivered: readonly string[]; blocked: ReadonlyArray<{ taskId: string; reason: string }>; evidence: string; assumptions: readonly string[]; deploy: string; hostUrl: string | null; tokens: string; security: string; docsErrors?: readonly string[]; readmeSections?: readonly string[] }): ContextPackInput {
  return { ...common(base, 'report', 'sm'), criteria: base.spec.acceptanceCriteria, feedback: [
    'Write the final report for the human validator. Give concrete exploratory steps for every acceptance criterion.',
    'Write `summary`, `assumptions`, `blocked[].reason` and `exploratoryScript` entirely in Brazilian Portuguese (pt-BR), in plain words a non-developer can follow; no English sentences. Each exploratory step says what to do and what should happen, in one short sentence (for example: "Abra /health no endereço do serviço. Deve aparecer {"ok":true}."). Keep commands, URLs, status codes and JSON between backticks, untranslated.',
    'Also return `readme`: the Markdown for docs/README.md, a short overview of the project (what it is, how to run and test it, the endpoints or commands it exposes, the acceptance criteria it satisfies). Use only facts from the context pack.',
    DOCS_STRUCTURE,
    ...plannedSections(opts.readmeSections),
    ...(opts.docsErrors?.length ? [`Your previous documents were rejected, fix every point:\n${opts.docsErrors.map((e) => `- ${e}`).join('\n')}`] : []),
    `Delivered tasks: ${opts.delivered.join(', ') || 'none'}`,
    `Blocked tasks:\n${opts.blocked.map((b) => `- ${b.taskId}: ${b.reason}`).join('\n') || '- none'}`,
    `Evidence matrix:\n${opts.evidence}`,
    `Assumptions:\n${opts.assumptions.join('\n') || '- none'}`,
    `Security findings left by the sec review (mention residual risks in the summary):
${opts.security || '- none'}`,
    `Deploy outcome: ${opts.deploy}`,
    opts.hostUrl ? `The human opens the service at ${opts.hostUrl}; the deploy url is internal to the platform and never appears in what you write: use ${opts.hostUrl} in the summary, README, runbook and exploratory steps.` : 'The human cannot open the service from a browser; the deploy url is internal to the platform and never appears in what you write.',
    `Token usage: ${opts.tokens}`,
  ].join('\n\n') };
}

export interface AgentStepRequest<K extends StepKind> {
  kind: K;
  role: Role;
  pack: ContextPackInput;
  cwd: string;
  phase: string;
  taskId: string | null;
  attempt: number;
  refContext?: RefContext | (() => Promise<RefContext>);
  refs?: StepRequest['refs'];
  semantic?: StepRequest['semantic'];
  extraAllow?: readonly string[];
  /** Spec 10A.5 decisions 10/11: per-step model and effort; absent means the role profile. */
  model?: string;
  effort?: Effort;
  /** Env entries the orchestrator provisioned for this one step (e.g. an ephemeral test database's DATABASE_URL). */
  extraEnv?: Readonly<Record<string, string>>;
  /**
   * R11.13 slice 7: keeps the step's CLI session under `id`. When the task's store already holds it (an earlier attempt, same
   * cwd), the step resumes it and sends only `resumePrompt` instead of the pack: the context comes from the prompt cache.
   */
  session?: { id: string; resumePrompt: string };
}

export interface AgentStepDeps {
  runStep: typeof runStepFn;
  stepDeps: StepDeps;
  agents: Record<Role, AgentDefinition>;
  profile: (role: Role) => RoleProfile;
  governor: Governor;
  breaker: QuotaBreaker;
  journal: Pick<Journal, 'allocStepSeq' | 'fact'>;
  stepDir: (seq: number) => string;
  /** Where a task's session transcript is kept; `AgentStepRequest.session` has no effect without it. */
  sessionDir?: (taskId: string) => string;
  /** A model for every step of one kind, ahead of the role profile (config `routing.stepModels`); `attempt` is the refinement cycle there. */
  stepModel?: (kind: StepKind, attempt: number) => string | undefined;
  secretValues: () => readonly string[];
  specHash: string;
}

/**
 * One agent step: journaled, governed, breaker-observed, redacted, with prompt and output kept under
 * runs/<runId>/steps/. Accounting is done by runStep itself (Plan 3).
 */
export async function runAgentStep<K extends StepKind>(req: AgentStepRequest<K>, deps: AgentStepDeps): Promise<StepOutcome<OutputOf<K>>> {
  const seq = deps.journal.allocStepSeq();
  const id = stepId(seq);
  const sessionStore = req.session && req.taskId && deps.sessionDir ? deps.sessionDir(req.taskId) : undefined;
  const resume = req.session !== undefined && sessionStore !== undefined && (await hasSession(sessionStore, req.session.id, req.cwd));
  const pack = resume ? resumedPack(req.session!.resumePrompt) : buildContextPack(req.pack);
  const dir = deps.stepDir(seq);
  await fs.mkdir(dir, { recursive: true });
  const profile = deps.profile(req.role);
  const model = req.model ?? deps.stepModel?.(req.kind, req.attempt) ?? profile.model;
  await deps.journal.fact(OrchEvent.StepStarted, {
    stepId: id,
    kind: req.kind,
    role: req.role,
    model,
    taskId: req.taskId,
    phase: req.phase,
    attempt: req.attempt,
    tokens: pack.tokens,
    dropped: pack.dropped,
  });
  await fs.writeFile(path.join(dir, 'prompt.md'), pack.text);
  const clean = (s: string) => redactSecrets(s, deps.secretValues());
  const release = await deps.governor.acquire();
  let outcome: StepOutcome<OutputOf<K>>;
  try {
    outcome = await deps.runStep<K>(
      {
        kind: req.kind,
        role: req.role,
        agent: deps.agents[req.role],
        profile,
        model,
        effort: req.effort,
        cwd: req.cwd,
        prompt: pack.text,
        expectedSpecHash: deps.specHash,
        refContext: req.refContext,
        refs: req.refs,
        semantic: req.semantic,
        phase: req.phase,
        taskId: req.taskId,
        attempt: req.attempt,
        extraAllow: req.extraAllow,
        extraEnv: req.extraEnv,
        ...(sessionStore ? { sessionId: req.session!.id, resume, sessionStore } : {}),
      },
      deps.stepDeps,
    );
  } finally {
    release();
  }
  deps.breaker.observe(outcome.summary.rateLimit);
  if (!outcome.ok && outcome.failure === 'quota') deps.breaker.onQuotaFailure(outcome.summary.rateLimit);
  // Everything the agent produced is redacted once, here, so no caller journals a raw value.
  const result: StepOutcome<OutputOf<K>> = outcome.ok
    ? { ...outcome, value: JSON.parse(clean(JSON.stringify(outcome.value))) as OutputOf<K> }
    : { ...outcome, errors: outcome.errors.map(clean) };
  const record = result.ok ? { ok: true, value: result.value as unknown } : { ok: false, failure: result.failure, errors: result.errors };
  await fs.writeFile(path.join(dir, 'output.json'), JSON.stringify(record, null, 2));
  await deps.journal.fact(OrchEvent.StepFinished, {
    stepId: id,
    kind: req.kind,
    taskId: req.taskId,
    attempt: req.attempt,
    ok: outcome.ok,
    failure: outcome.ok ? null : outcome.failure,
    usage: outcome.summary.usage,
    costUsd: outcome.summary.costUsd,
    durationMs: outcome.summary.durationMs,
    numTurns: outcome.summary.numTurns,
    ...(outcome.summary.profile ? { profile: outcome.summary.profile } : {}),
  });
  return result;
}
