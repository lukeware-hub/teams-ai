import { promises as fs } from 'node:fs';
import path from 'node:path';
import { charterRulesFor } from '../agents/document-charter.js';
import { toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import type { Governor } from '../budget/governor.js';
import type { QuotaBreaker } from '../budget/quota-breaker.js';
import type { AgentSetting, AutomaticRow, EffortCaps, RoleProfile, Role, SettingKey } from '../config/config.js';
import { SCAFFOLD_TASK_ID, type Plan, type PlanTask } from '../contracts/plan.js';
import type { Preplan } from '../contracts/preplan.js';
import type { PlatformService, Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { Effort } from '../decide/decisions/model-tier.js';
import type { ReviewProfile } from '../decide/decisions/pr-risk.js';
import { repoName, stepId } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import { buildContextPack, estimateTokens, type CodeContext, type GraphAccess, type ContextPack, type ContextPackInput, type HandoffSummary } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import { effortFor } from '../runner/model-policy.js';
import { hasSession } from '../runner/session-store.js';
import { isLean, limitMsOf, type runStep as runStepFn, type StepDeps, type StepOutcome, type StepRequest } from '../runner/step.js';
import type { TestResult } from '../evidence/junit.js';
import type { RefContext } from '../validators/references.js';
import { REQUIRED_BLOCKING_GATES } from '../validators/plan.js';
import { securityToolingRules } from '../validators/security-tooling.js';
import { skillsForRole } from '../skills/catalog.js';
import { absoluteRule } from '../runner/role-settings.js';
import { FIVE_DOCS } from '../docs/layout.js';
import { APP_KINDS, DOCS_TREE, type AppKind } from '../docs/tree.js';
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
  /** Set when the step works in a service's repository, which holds none of the project's docs. */
  service?: ServiceContext;
  /** The implementation plan of this spec in the repository, when the refinement published one. */
  planFile?: string;
  /** The spec's task list in the repository, when its refinement wrote one. */
  taskFile?: string;
  /** The pinned snapshot folder a documentation-repository project reads its documents from; absent for the legacy layout. */
  docsRoot?: string;
}

/** What a step in a service's repository needs from the project and cannot read there (R12.6). */
export interface ServiceContext {
  name: string;
  /** The service's own view of the plan. */
  plan: Plan;
  /** Every other service's address on the project's shared network, by service. */
  addresses: Readonly<Record<string, string>>;
  /** The project's docs/design.md, which a front task follows. */
  design: string | null;
}

export function outputContract(kind: StepKind): string {
  return `Return exactly one JSON object matching this schema:\n${JSON.stringify(toJsonSchema(kind))}`;
}

function criteriaOf(spec: Spec, ids: readonly string[]) {
  return spec.acceptanceCriteria.filter((c) => ids.includes(c.id));
}

/** What the spec ships, leaves out and depends on, for the builder and its reviewer. */
function scopeOf(spec: Spec): string[] {
  return [
    ...spec.features.map((f) => `feature: ${f}`),
    ...spec.outOfScope.map((o) => `out of scope: ${o}`),
    ...spec.externalDependencies.map((d) => `external dependency: ${d.name}: ${d.purpose} (secrets: ${d.secretNames.join(', ') || 'none'})`),
  ];
}

/** Longest gate-result list a review pack carries; the rest is a count. */
const REVIEW_JUNIT_LINES = 200;
const REVIEW_PRIOR_LINES = 10;

type Common = Pick<
  ContextPackInput,
  'kind' | 'role' | 'specHash' | 'principles' | 'outputContract' | 'assumptions' | 'adrs' | 'retrieval' | 'budgetTokens' | 'techSpecExcerpt'
>;

function common(base: PackBase, kind: StepKind, role: Role): Common {
  return {
    kind,
    role,
    specHash: base.specHash,
    principles: base.service ? [...base.project.principles, serviceRule(base.service, base.project.platform ?? [], role)] : base.project.principles,
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
  `When you write or change the e2e suite (${suite}): it runs black-box over HTTP against process.env.SERVICE_URL after the deploy, one test per acceptance criterion with its id in the name (for example "[AC-001] POST /todos creates a todo"), no mocks of the service under test, and it never starts, builds or restarts containers. The deployed service keeps the data of earlier runs and specs: never assume an empty store or a fixed count; create the data each test needs with unique values and assert only on that data, and prove a behavior that needs no data with a request no stored record can match (for example a filter or page no record reaches). Never skip a test: a skipped test counts as a criterion without an e2e test and fails the deploy. In a services plan the suite also reads SERVICE_URL_<SERVICE> for every other service (upper case, dashes as underscores) and reaches the platform containers by name.`;

/** The task touches the suite itself or a file of its folder. */
function writesE2eSuite(task: PlanTask, suite: string): boolean {
  const dir = suite.endsWith('/') ? suite : `${path.posix.dirname(suite)}/`;
  return task.affectedPaths.some((p) => p === suite || (dir !== './' && p.startsWith(dir)));
}

/** A service's repository holds that service's code; the legacy layout also copies the docs into it, so the pack carries the settings its rules name, the other services' addresses and the front design. */
function serviceRule(ctx: ServiceContext, platform: readonly PlatformService[], role: Role): string {
  const { tasks: _tasks, ...settings } = ctx.plan;
  const others = Object.entries(ctx.addresses).map(([s, url]) => `${s} at ${url}`);
  return [
    `This task changes the service ${ctx.name}: its repository holds only that service's code, not the project's docs, so every plan setting your rules name (plan.delivery, plan.deploy, plan.commands, plan.junitPath, plan.e2eExemptions) is this one, never a docs/specs file: ${JSON.stringify(settings)}.`,
    `On the project's shared network the other services answer at their addresses (${others.join(', ') || 'none yet'})${platform.length > 0 ? ` and the platform containers by name (${platform.map((p) => p.name).join(', ')})` : ''}; the service reads each address from an environment variable its docker-compose.yml sets, and starts and passes its healthcheck without them: a call to another service retries instead of failing at start.`,
    ...(role === 'front' && ctx.design ? [`The project's docs/design.md is not in this repository; it is the visual contract this task follows:\n${ctx.design}`] : []),
  ].join(' ');
}

/**
 * The implementation plan the refinement published to the repository. The pack names it and the agent reads it: a plan is long, so
 * pasting it in would push the pack over its budget.
 */
export const planRule = (planFile?: string): string =>
  planFile ? `This spec's implementation plan is ${planFile}: read it, then follow its tasks, their files and their test steps. The plan derives from the five main documents: when it disagrees with one of them, the document wins and the departure goes in deviations.` :'This spec has no implementation plan in the repository, so there is no plan to follow for this task.';

/** The read-only grant of a documentation snapshot: its folder and everything below it, and no write. */
export const snapshotGrant = (root: string | undefined): string[] => (root === undefined ? [] : [`Read(${absoluteRule(root)})`, `Read(${absoluteRule(root)}/**)`]);

/** A path of the pack as the agent sees it: under the snapshot for a documentation repository. */
const shown = (base: PackBase, file: string | undefined): string | undefined => (file === undefined || base.docsRoot === undefined ? file : `${base.docsRoot}/${file}`);

/** The five documents of a documentation repository, read from its pinned snapshot; the legacy rule names the worktree instead. */
export const docsRepoRule = (root: string): string =>
  `The project's documents are in the pinned snapshot ${root}: read ${root}/docs/project.md, ${root}/docs/stack.md, ${root}/docs/flow.md, ${root}/docs/design.md and ${root}/docs/briefing.md before you change any file: they are the owner's only source of truth, and a document wins over the code, the plan and the tech spec when they disagree. The plan derives from these documents and never overrides them. The snapshot is read only: never write to it.`;

/** The project's five documents in the repository's docs folder, and where the ADRs and tech spec the budget drops live; a service repository holds none of them, so the rule does not apply there. */
export const sourceDocsRule = (specId: string): string =>
  `When the repository has docs/project.md, read docs/project.md, docs/stack.md, docs/flow.md, docs/design.md and the briefing when present (docs/specs/${specId}/briefing.md, or docs/briefing.md when the spec has none) before you change any file: they are the owner's only source of truth, and a document wins over the code, the plan and the tech spec when they disagree. The plan, the tech spec and the ADRs derive from these documents and never override them. When this pack's note says adrs or tech-spec were dropped for budget, read the ADRs in docs/adr/ or the technical spec docs/specs/${specId}/tech-spec.md in their place.`;

/** What every task that builds or judges code reads first: the implementation plan and the five documents. */
/** The task list of a spec whose draft has a repository: a builder reads the entry of each task it builds. */
export const taskListRule = (taskFile?: string): string =>
  taskFile ? `This spec's task list is ${taskFile}: before you change a file of a task, read that task's entry, its criteria and its scenarios, and make the tests prove them.` : '';

const sourceRules = (base: PackBase): string[] => [
  planRule(shown(base, base.planFile)),
  ...(base.taskFile ? [taskListRule(shown(base, base.taskFile))] : []),
  base.docsRoot === undefined ? sourceDocsRule(base.spec.specId) : docsRepoRule(base.docsRoot),
  ...charterRulesFor(base.docsRoot !== undefined),
];

/** A builder lists what it read, so the orchestrator can check it against the files the source rules name. */
export const FILES_READ_RULE = 'On a done result, list in filesRead, as repository paths, every file the rules above told you to read; a done result that leaves out one this repository holds is sent back.';

/** A departure from the task or from its implementation plan is listed, so a contradiction never passes silently. */
export const TOOL_INSTALL_RULE = 'Your sandbox has no network. When a tool the gates need is missing or does not build, ask the platform to install it with toolInstall (one command, for example `GOBIN=$PWD/.tools/bin go install gotest.tools/gotestsum@v1.13.0`); it runs in the gate container with network, and its result comes back as your next feedback.';
export const DEVIATIONS_RULE ='On a done result, list in deviations, one sentence each, every departure from the task or from its implementation plan; leave it empty when you followed both.';

const fileExists = (dir: string, file: string): Promise<boolean> => fs.access(path.join(dir, file)).then(() => true, () => false);

/** The snapshot's files a documentation-repository builder reads: each must be there, or the step fails naming it. */
async function requiredSourceFiles(root: string, planFile: string | undefined, taskFile: string | undefined): Promise<string[]> {
  const files = [...(planFile ? [planFile] : []), ...(taskFile ? [taskFile] : []), ...FIVE_DOCS.map((doc) => `docs/${doc}`)];
  const held = await Promise.all(files.map((file) => fileExists(root, file)));
  const missing = files.filter((_, i) => !held[i]);
  if (missing.length > 0) throw new Error(`the documentation snapshot has no ${missing.join(', ')}`);
  return files;
}

/** The source files a builder reads that the worktree at `dir` holds, each rule only when its first file is there; a documentation repository (`required`) reads them all or fails. */
export async function sourceFiles(dir: string, planFile: string | undefined, specId: string, taskFile?: string, required = false): Promise<string[]> {
  if (required) return requiredSourceFiles(dir, planFile, taskFile);
  const has = (file: string) => fileExists(dir, file);
  const ownBriefing = `docs/specs/${specId}/briefing.md`;
  const rules = [
    planFile ? [planFile] : [],
    taskFile ? [taskFile] : [],
    ['docs/project.md', 'docs/stack.md', 'docs/flow.md', 'docs/design.md', (await has(ownBriefing)) ? ownBriefing : 'docs/briefing.md'],
  ];
  const named: string[] = [];
  for (const files of rules) if (files.length > 0 && (await has(files[0]!))) named.push(...files);
  const held = await Promise.all(named.map(has));
  return named.filter((_, i) => held[i]);
}

/** The plan tasks a dev task builds, and the implementation plan whose blocks they are. */
export interface PlanTasks {
  file: string;
  ids: readonly string[];
}

/** A dev task builds the plan tasks it names, test-first; the orchestrator, not the Dev, marks the plan's progress. */
export const taskRule = (file: string, ids: readonly string[]): string =>
  `This task builds the plan task${ids.length > 1 ? 's' : ''} ${ids.join(', ')} of ${file}: write each of its tests first, run the verifications the plan gives and read their output, and build only these tasks within this task's affected paths. Never change the plan file or .claude/, never ask a question in the chat (take the most reasonable choice and name it in the summary), and skip every git step: the orchestrator commits.`;

/** The blocking gates run on every change and a failure costs a whole attempt, so the Dev learns them before writing, not from the rejection. */
export const gateRules = (gates: ReadonlyArray<{ name: string; command: string; blocking: boolean }>): string =>
  `These blocking gates run on your change and each failure costs an attempt: ${gates.filter((g) => g.blocking).map((g) => `${g.name} (${g.command})`).join('; ')}. Run the ones this sandbox allows before you finish. A test for a failure case must assert that failure and never accept the success status.`;

export function devPack(
  base: PackBase,
  task: PlanTask,
  opts: { code: CodeContext; handoffs: readonly HandoffSummary[]; feedback: string | null; e2eSuite?: string; plan?: PlanTasks; gates?: ReadonlyArray<{ name: string; command: string; blocking: boolean }> },
  role: Role = 'dev',
): ContextPackInput {
  const shared = common(base, 'dev', role);
  return {
    ...shared,
    principles: [...shared.principles, ...sourceRules(base), FILES_READ_RULE, DEVIATIONS_RULE, TOOL_INSTALL_RULE, ...(opts.plan ? [taskRule(shown(base, opts.plan.file)!, opts.plan.ids)] : []), ...(opts.e2eSuite && writesE2eSuite(task, opts.e2eSuite) ? [e2eSuiteRules(opts.e2eSuite)] : []), ...(opts.gates?.some((g) => g.blocking) ? [gateRules(opts.gates)] : [])],
    task,
    criteria: criteriaOf(base.spec, task.criteriaRefs),
    decisions: base.spec.decisions,
    objectives: scopeOf(base.spec),
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
  opts: { diffStat: string; changedFiles: readonly string[]; diff: string; junit: readonly TestResult[]; code: CodeContext; profile: ReviewProfile; priorFindings?: ReadonlyArray<{ file: string; line: number | null; problem: string }>; languageCheck?: string; answers?: ReadonlyArray<{ question: string; answer: string }>; deviations?: readonly string[] },
): ContextPackInput {
  const prior = (opts.priorFindings ?? []).slice(0, REVIEW_PRIOR_LINES).map((f) => `- ${f.file}${f.line === null ? '' : `:${f.line}`} ${f.problem}`);
  if ((opts.priorFindings?.length ?? 0) > REVIEW_PRIOR_LINES) prior.push(`- ... ${(opts.priorFindings?.length ?? 0) - REVIEW_PRIOR_LINES} more`);
  const history = prior.length > 0 ? `\n\nYour earlier findings on this task (the Dev applied them; do not reverse one without saying which and why):\n${prior.join('\n')}` : '';
  const answered = (opts.answers ?? []).map((a) => `Q: ${a.question}\nA: ${a.answer}`);
  const answers = answered.length > 0 ? `\n\nThe SM answered these questions on this task; they bind the change, so never ask for what they rule out:\n${answered.join('\n\n')}` : '';
  const declared = (opts.deviations ?? []).map((d) => `- ${d}`);
  const deviations = declared.length > 0 ? `\n\nThe Dev declared these departures from the plan; they count as recorded, so never ask to record them in the plan or in any file under docs/, which the Dev cannot edit:\n${declared.join('\n')}` : '';
  const feedback = `Review profile: ${opts.profile}\n\nA finding that the change contradicts the implementation plan of its spec gets category "plan"; every other finding gets category "code".${history}${answers}${deviations}`;
  const results = opts.junit.slice(0, REVIEW_JUNIT_LINES).map((t) => `- ${t.id} [${t.status}]${t.acIds.length > 0 ? ` ${t.acIds.join(', ')}` : ''}`);
  if (opts.junit.length > REVIEW_JUNIT_LINES) results.push(`- ... ${opts.junit.length - REVIEW_JUNIT_LINES} more`);
  // The merge gates already ran the suite on this exact diff: the reviewer reads their result instead of re-running it (R11.13 slice 2).
  const changeSet = `Changed files:\n${opts.changedFiles.join('\n')}\n\nDiff stat:\n${opts.diffStat}\n\nThe JUnit report (reports/junit.xml) is gate output the orchestrator never commits: do not ask for it.\n\nThe compose service healthcheck and its "image: \${TEAMS_AI_IMAGE:-...}" line are the orchestrator's deploy contract (it tags, verifies and rolls back the image through them): never ask to remove them.\n\nGate test results (the merge gates already ran the suite on this diff; do not re-run it):\n${results.join('\n') || '- none reported'}\n\nEvery blocking gate, coverage included, passed on this diff. A task description may open with the failure of the task it replaces (a gate number, for example): that is history, not a current failure, so judge only the diff.\n\n${opts.languageCheck ? `${opts.languageCheck}\n\n` : ''}Diff against origin/main:\n${opts.diff}`;
  const shared = common(base, 'review', 'test');
  return { ...shared, principles: [...shared.principles, ...sourceRules(base)], task, criteria: criteriaOf(base.spec, task.criteriaRefs), decisions: base.spec.decisions, objectives: scopeOf(base.spec), code: opts.code, feedback, changeSet };
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
  const shared = common(base, 'security', 'sec');
  return { ...shared, principles: [...shared.principles, ...sourceRules(base)], task, criteria: criteriaOf(base.spec, task.criteriaRefs), code: opts.code, changeSet };
}

export function techSpecPack(base: PackBase, opts: { feedback: string | null }): ContextPackInput {
  return {
    ...common(base, 'tech-spec', 'dev'),
    criteria: base.spec.acceptanceCriteria,
    decisions: base.spec.decisions,
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
  'commands.smoke runs inside gateImage against a service the orchestrator has ALREADY deployed: the tests read the base URL from process.env.SERVICE_URL, never start, build or restart containers (docker is not available there), and each acceptance criterion with smoke: true needs at least one test whose name carries its id, e.g. "[AC-001] GET /health answers 200"; in a services plan the suite of each service also reads SERVICE_URL_<SERVICE> for every other service (upper case, dashes as underscores) and reaches the platform containers by name';

/** How Phase 5 runs commands.e2e (roadmap R8.4); the Test agent writing the suite and the SM planning it must know it. */
export const E2E_CONTRACT =
  'commands.e2e is required and is NOT commands.smoke: it runs the suite at delivery.e2eSuite (the command must reference that path) inside gateImage after the compose stack is deployed and smoke has passed, black-box over HTTP against process.env.SERVICE_URL, no mocks of the service under test, never starting containers; the gate has no root, no apt and no network; for a plan with deploy.kind "api" the suite uses only HTTP (for example fetch with node:test, checking page HTML as text) and never a browser; for a plan with deploy.kind "front" the gate image carries Chromium at /usr/bin/chromium, so the suite may drive the page with Playwright (@playwright/test, a devDependency pinned in the project): commands.e2e is `npx playwright test <suite>`, its playwright config sets use.launchOptions to executablePath /usr/bin/chromium with the args --no-sandbox and --disable-dev-shm-usage, and its junit reporter writes to plan.junitPath; never Cypress or Puppeteer; a criterion that a front task delivers (a screen) is never exempt, and a front task belongs to a service with deploy.kind "front", never to an api service; every acceptance criterion needs one test whose name carries its id, e.g. "[AC-001] POST /todos creates a todo", EXCEPT criteria with no testable observable behavior over the service interface (devops-only, build, docs or style rules): list those in plan.e2eExemptions as {acId, reason} (reason of at least 10 characters, at least one criterion stays covered) and they get no e2e test; plan one task owned by dev that creates the suite and depends on the service tasks; a failing e2e blocks the run; in a services plan the suite of each service also reads SERVICE_URL_<SERVICE> for every other service (upper case, dashes as underscores) and reaches the platform containers by name';

/** The coverage gate is stack-agnostic by contract, never by prescribed tool (roadmap R10.2): whatever the stack's
 * own coverage tool is, the gate's command must end by writing coveragePath as one line of JSON, {"linesPct": N};
 * the orchestrator reads only that number, never the tool's own report format, and fails the gate below 90 even
 * when the command's own exit code is 0. coverageExemptions lists paths the tool's own ignore mechanism already
 * excluded from the denominator, each with a reason of at least 10 characters. */
export const COVERAGE_CONTRACT =
  'gate "coverage" (blocking) runs the test suite with whatever coverage tool the stack has, then writes plan.coveragePath as one line of JSON {"linesPct": <number>}; when the tool measures no code lines at all (no source file yet), it writes {"linesPct": null}, which is not applicable and passes; the orchestrator fails the gate when linesPct is a number below 90, or the file is missing or malformed, regardless of the command\'s own exit code; a path the tool\'s own config already excludes from coverage goes in plan.coverageExemptions as {path, reason} (reason of at least 10 characters)';

export function planRules(firstSpec: boolean | 'services', requireDelivery = false, requireSecurityTooling = false, requireE2e = false, requireCoverage = false): string {
  const lines = [
    'Plan rules (the orchestrator rejects a plan that breaks any of them):',
    '- deploy.kind is "api" or "front" (what the service is); an api sets deploy.docsPath only when the spec asks for a Swagger/OpenAPI documentation page and one of its tasks builds that page (for example /docs), because the deploy checks that the path answers; a spec that asks for no documentation page has no deploy.docsPath; deploy.port must be inside 20000-20099, the range the platform publishes to the host so the human can open the service; deploy.image, deploy.port and deploy.healthcheckPath (starting with /) are required unless deploy.kind is mobile',
    firstSpec === 'services'
      ? "- a datastore only one service uses publishes no host port: it stays on that service's private compose network, so two services' databases never collide on the host; a datastore several services share is a platform container in project.json, never a compose service"
      : '- a database or other datastore service in docker-compose (Postgres, MySQL, Redis, ...) publishes its own port to the host too, on a port outside 20000-20099; an integration test against a real database needs a route to it exactly like the app has for deploy.port, and one that only the compose-internal network can reach has none',
    `- gates must include these blocking gates: ${REQUIRED_BLOCKING_GATES.join(', ')} (plus a blocking typecheck gate when commands.typecheck exists)`,
    '- every acceptance criterion is covered by at least one task (criteriaRefs); every task has at least one criterion or is infrastructure',
    '- every task id is T<n>-<slug>: a number plus 1 to 4 English kebab-case words saying what the task does (T1-create-endpoint, T2-add-login-form); never a bare T1',
    '- dependsOn forms a DAG; affectedPaths are repository-relative paths or globs; a task delivers one whole capability (its logic, its tests and its interface across the layers it touches), never one task per file, layer or function; plan tasks of one capability join one task through planTasks',
    '- dependsOn names only a real dependency: the task needs code, an interface or a file that the other task creates. Writing the tasks in order is not a dependency; tasks that touch different files run in parallel, and a chain of dependsOn that is not needed makes the run sequential',
    OWNER_RULE,
    EVIDENCE_RULE,
    '- gateImage is a glibc-based image with the stack toolchain plus sh, python3, curl and jq, never an Alpine/musl one and never a -slim variant without those tools: node:22-bookworm, golang:1.26-bookworm, python:3.12-bookworm or rust:1-bookworm. Dependencies are installed by the Dev on a Debian host and native optional packages (rollup, esbuild, swc) will not load under musl',
    '- the gates run offline in another container, so everything install fetches must land in the worktree. Go: golang image of the same minor as the host Go (1.26); Cargo, Go and pip caches already point to .tools. Python: python:3.11-bookworm (the minor of the Debian host that runs install) and commands.install is `python3 -m venv .tools/venv && .tools/venv/bin/pip install --target .tools/py -r requirements.txt`; gates run `python -m pytest` (PYTHONPATH already exposes .tools/py)',
    '- coverage tool per stack: Go `go test -coverprofile` then `go tool cover -func`; Rust cargo-tarpaulin 0.37 or newer with --engine llvm; Python coverage.py; Node.js vitest --coverage or c8. Pin every tool at its current release: an old release may not read the data of the toolchain in the gate image',
    '- a tool the gates run (test runner, linter, formatter, scanner) must build with the toolchain of the gateImage: pin a release that compiles on that toolchain. An install that cannot build blocks every task, and no Dev can fix it from the worktree',
    '- the deploy contract is fixed and no ADR may forbid it: docker-compose.yml keeps a healthcheck on deploy.healthcheckPath and `image: ${TEAMS_AI_IMAGE:-<image>:latest}`, through which the orchestrator tags, verifies and rolls back each deploy',
    '- Rust: the gates build with the Rust of the gate image, offline, and ignore rust-toolchain.toml; never write code that needs a Rust newer than that image',
    '- Flutter (Android): gateImage is node:22-bookworm; the platform adds the JDK, the Android SDK (platform 36, build-tools 36.0.0, NDK 28.2.13676358) and Flutter 3.47.8 to it. commands.install is `flutter pub get && flutter build apk --debug`, run in that image with network before each attempt: the build is what downloads the Gradle distribution and every Android dependency into .tools, and the gates run offline in the same image: `flutter analyze`, `mkdir -p reports; flutter test --machine > reports/flutter.json; s=$?; dart pub global run junitreport:tojunit --input reports/flutter.json --output reports/junit.xml; exit $s` and `flutter build apk --debug`. The debug APK is the delivery artifact. Caches live in .tools (PUB_CACHE, GRADLE_USER_HOME). The test command writes its JUnit report to reports/junit.xml, which is the plan junitPath',
    '- Expo (Android): the stack text names Expo first, so it is not read as node. gateImage is node:22-bookworm; the platform adds the JDK and the Android SDK (platform 36, build-tools 36.0.0, NDK 28.2.13676358) to it, and no Flutter. commands.install is `npm ci && npx expo prebuild --platform android`, run in that image with network before each attempt: npm and Gradle downloads land in node_modules and .tools, and the gates run offline in the same image. commands.build is `cd android && ./gradlew assembleDebug`, and the debug APK at android/app/build/outputs/apk/debug/app-debug.apk is the delivery artifact (deploy.kind mobile). The android/ and ios/ folders are generated by prebuild, so the scaffold task lists them in .gitignore. Gradle keeps its cache in .tools (GRADLE_USER_HOME). Tests use jest: pin jest-junit exactly (`npm install --save-dev --save-exact jest-junit@17.0.0`), add it to jest.config as `reporters: [\'default\', [\'jest-junit\', { outputDirectory: \'reports\', outputName: \'junit.xml\' }]]`, and run commands.test as `npx jest --ci`; junitPath is reports/junit.xml',
    '- Go: the go.mod `go` line carries the full patch version of the Go in the gate image (for example `go 1.26.9`, never `go 1.26`): osv-scanner reads `go 1.26` as 1.26.0 and fails dependency-scan on every standard library vulnerability fixed later. Write that patch version in the task that creates go.mod, and never add a toolchain line',
    '- every test gate writes JUnit to junitPath and each test name carries its criterion. Node.js: node --test or vitest, `[AC-001]` in the name. Go: gotestsum --junitfile, `t.Run("[AC-001] ...")`. Python: pytest --junitxml, `def test_ac_001_...`. Rust: cargo nextest with JUnit enabled in .config/nextest.toml, `fn ac_001_...`. Install the JUnit tool in commands.install into .tools/bin (for example `GOBIN=$PWD/.tools/bin go install gotest.tools/gotestsum@<version>`). Pick a release that builds with the Go of the gateImage (an old gotestsum does not build with a newer Go: v1.12.0 fails on Go 1.27) and reuse the release the other specs of the project already pin when one exists',
    '- the JUnit file at junitPath is gate output and is never committed (the orchestrator excludes it), so no task creates, commits or lists it in affectedPaths',
    '- no task lists a path covered by frozenPaths in affectedPaths (only the first spec\'s scaffold task may): a frozen file is rejected at merge, so such a task can never finish; generated code the Dev cannot produce belongs outside frozenPaths',
    `- ${SMOKE_CONTRACT}`,
    '- commands.smoke and commands.e2e print one result line per test, named with its criterion, or write JUnit to junitPath: TAP (node --test), go test -v, cargo test, pytest -v or python -m unittest -v; a runner that prints only dots or a summary gives no evidence and fails the deploy',
    requireDelivery
      ? '- delivery is required: {dockerfile, compose, ciWorkflow, releaseWorkflow, e2eSuite} are repository-relative file paths the project must ship (e.g. Dockerfile, docker-compose.yml, .github/workflows/ci.yml, .github/workflows/release.yml, e2e/) and readmeSections lists the README headings that must exist (e.g. Run, Test, Environment, Architecture, Pipeline); Phase 4 fails if a listed file is missing on main, so assign each one to a task'
      : '- delivery is optional; when present it must list dockerfile, compose, ciWorkflow, releaseWorkflow, e2eSuite (file paths) and readmeSections (non-empty); Phase 4 fails if a listed file is missing on main',
    requireDelivery
      ? '- lockfilePath is required: the repository-relative path of whatever lockfile the stack\'s own package manager produces (package-lock.json, poetry.lock, go.sum, Cargo.lock, ... - name the real one, there is no fixed list); Phase 4 fails if it is missing on main. Every FROM line in the Dockerfile must carry a @sha256 digest or an explicit non-latest tag (never a bare image or image:latest); Phase 4 fails on an unpinned base image'
      : '- when delivery.dockerfile is present, every FROM line must carry a @sha256 digest or an explicit non-latest tag (never a bare image or image:latest)',
    '- no step can look up an image digest (steps have no network and no docker): a task asks for a @sha256 digest only when the docs or the repository already give its value, and otherwise pins the version tag the docs name; a task that needs a digest looked up can never finish',
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

export interface ServicesPack {
  names: readonly string[];
  newServices: ReadonlySet<string>;
  ports: Readonly<Record<string, number | null>>;
  platform: readonly PlatformService[];
  /** Files on main of each existing service: the plan step works in the project repository and cannot see them. */
  files?: Readonly<Record<string, readonly string[]>>;
}

/** Longest file list a services plan pack shows per existing service; the rest is a count. */
const SERVICE_FILES = 200;

const filesLine = (service: string, files: readonly string[]): string =>
  `- files on main of ${service}${files.length > SERVICE_FILES ? ` (first ${SERVICE_FILES} of ${files.length})` : ''}: ${files.slice(0, SERVICE_FILES).join(', ') || 'none'}`;

/** What a services plan adds to the plan rules (R12.6): one repository and one port per service, a scaffold per new service. */
export function servicesPlanRules(opts: ServicesPack): string {
  const fresh = opts.names.filter((s) => opts.newServices.has(s));
  const existing = opts.names.filter((s) => !opts.newServices.has(s));
  return [
    `Services plan (project.json splits the system into services, one repository each: ${opts.names.join(', ')}):`,
    '- return specId, specHash, adrRefs and e2eExemptions at the top, `tasks` with each task naming its `service`, and `services`: a map from each service this spec changes to its settings (stack, commands, gateImage, junitPath, gates, frozenPaths, deploy, delivery, lockfilePath and the coverage fields), which follow every plan rule above as services.<name>.<field>; list only the services this spec changes, each with at least one task',
    "- a task changes only its own service's repository; dependsOn may name a task of another service; a service's smoke and e2e suites prove only the criteria its own tasks reference",
    fresh.length > 0 ? `- new services (their main holds no code yet): ${fresh.join(', ')}. Each gets a task with id T0-scaffold-<service> (owner dev, no dependsOn) that creates its skeleton, build, test and gate configuration, every other task of that service depends on it, and one deploy-infrastructure task owned by devops (Dockerfile, docker-compose.yml)` : '',
    existing.length > 0 ? `- existing services: ${existing.join(', ')}. Their code is on main: never give them a scaffold task; each keeps the settings it already has (services.<service> of an earlier docs/specs/*/plan.json, which you can read) unless this spec needs a change, and its tasks use the paths of its files below` : '',
    ...existing.map((s) => filesLine(s, opts.files?.[s] ?? [])),
    ...opts.names.flatMap((s) => (opts.ports[s] ? [`- services.${s}.deploy.port is exactly ${opts.ports[s]}: the orchestrator assigned it so no two services share a host port; the service listens on PORT=${opts.ports[s]} and its docker-compose publishes "${opts.ports[s]}:${opts.ports[s]}"`] : [])),
    "- each service runs in its own compose project; teams-ai joins its main container (the compose service named exactly like the service) to the project's shared network under the service's name, so services call each other at http://<service>:<port>; a suite reads its own address from SERVICE_URL and each other service's from SERVICE_URL_<SERVICE> (upper case, dashes as underscores)",
    opts.platform.length > 0 ? `- platform containers teams-ai starts before the services, from project.json: ${opts.platform.map((p) => `${p.name} (${p.image})`).join(', ')}. Never plan, build or declare them in a compose file; services reach them by name on the shared network` : '- the project declares no platform containers',
    '- teams-ai starts the platform first, then the services one by one in no fixed order, each healthy before the next: a service must start and pass its healthcheck without the other services (retry a call to another service instead of failing at start)',
  ].filter((l) => l !== '').join('\n');
}

export function planPack(
  base: PackBase,
  opts: { techSpecText: string; docsRepo?: boolean; preplan?: Preplan | null; godNodes: ReadonlyArray<{ label: string; edges: number }>; feedback: string | null; firstSpec?: boolean; requireDelivery?: boolean; requireSecurityTooling?: boolean; requireE2e?: boolean; requireCoverage?: boolean; deployPort?: number | null; services?: ServicesPack; plan?: { file: string; outline: string } },
): ContextPackInput {
  const human = (base.spec.tasks ?? []).map((t) => `- ${t.title}: ${t.description}`);
  const nodes = opts.godNodes.map((n) => `- ${n.label} (${n.edges} edges)`);
  const parts = [
    planRules(opts.services ? 'services' : opts.firstSpec ?? false, opts.requireDelivery ?? false, opts.requireSecurityTooling ?? false, opts.requireE2e ?? false, opts.requireCoverage ?? false),
    opts.services ? servicesPlanRules(opts.services) : '',
    !opts.services && opts.deployPort ? `deploy.port is exactly ${opts.deployPort}: the orchestrator assigned it so no two projects share a host port; the service listens on PORT=${opts.deployPort} and docker-compose publishes "${opts.deployPort}:${opts.deployPort}"` : '',
    opts.docsRepo ? `stack: ${base.project.stack ?? ''}` : '',
    opts.preplan ? `Pre-plan reviewed at refinement time (context only: follow the real repository, not this; cover at least its acceptance criteria):\n${JSON.stringify(opts.preplan, null, 2)}` : '',
    opts.plan ? `The implementation plan of this spec is ${opts.plan.file}. Its ### Task blocks, with their files and criteria, are listed here: give every block a plan task that lists its number (T1, T2, ...) in planTasks; a block that no plan task lists fails the plan.\n\n${opts.plan.outline}` : '',
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

/** A technical conflict (a version, a library, a flag) is the agents' to settle; a build task never edits docs/, so no answer may depend on it. */
const TECHNICAL_CONFLICT_RULE = 'When a technical detail of stack.md (a pinned version with a known vulnerability, an incompatible library, a removed flag) fails, settle it yourself; the product, the flow, the requirements and the chosen technologies in the documents never change. Research the official documentation, the release notes and the code before you answer, and pick the choice that passes the gates. The code follows that choice; never tell the Dev to edit a file under docs/, because build tasks cannot change it. Name the document line that now differs in the assumption.';

export function specGapPack(base: PackBase, task: PlanTask, opts: { question: string; overrule?: boolean; frozenPaths: readonly string[]; gates?: ReadonlyArray<{ name: string; command: string }> }): ContextPackInput {
  // The commands the gates run now, after every gateFix already applied: a fix that repeats one of them changes nothing.
  const gates = opts.gates && opts.gates.length > 0 ? `\n\nGate commands the orchestrator runs now (a gateFix equal to one of them is already applied):\n${opts.gates.map((g) => `- ${g.name}: ${g.command}`).join('\n')}` : '';
  const overrule = opts.overrule ? `\n\nThe owner lets the agents decide. When an owner decision cannot be met in this environment, overrule it: name that decision and the reason in the assumption.\n\n${TECHNICAL_CONFLICT_RULE}` : '';
  const frozen = opts.frozenPaths.length > 0 ? `\n\nPaths in frozenPaths (${opts.frozenPaths.join(', ')}) are rejected by the orchestrator in every task after the scaffold; never tell the Dev to change one, and never overrule this.` : '';
  const gateFix = '\n\nWhen the question shows that a blocking gate command in the plan is wrong (the code is right, the command cannot pass, for example a sed that leaves a number empty), answer with gateFix: the gate name and the whole corrected command on one line, keeping the same check. The orchestrator applies it, journaled, and the Dev runs again with it. Leave gateFix out of every other answer, and never write a gate result file by hand.';
  const imageFix = opts.overrule ? '\n\nWhen your answer moves the toolchain to a newer version (a patched Go that a dependency scan asks for), also answer with imageFix: the whole new gate image reference, same repository and flavour, for example golang:1.27.2-bookworm to golang:1.27.3-bookworm. The orchestrator then runs the install and the gates in it; without it the Dev\'s new version cannot run there. In the answer, name the files the Dev moves to the same version.' : '';
  return { ...common(base, 'spec-gap', 'sm'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), decisions: base.spec.decisions, feedback: `Dev question (spec gap):\n${opts.question}${overrule}${frozen}${gateFix}${gates}${imageFix}` };
}

/** The owner's question for a block the agents cannot finish: one question and 2 to 4 choices the repository can carry out. */
export function blockOptionsPack(base: PackBase, task: PlanTask, opts: { reason: string; autonomous?: boolean }): ContextPackInput {
  const docs = opts.autonomous ? ' Because the agents take the recommended choice, no choice may need a file under docs/ to change: the Dev cannot edit it.' : '';
  return {
    ...common(base, 'block-options', 'sm'),
    task,
    criteria: criteriaOf(base.spec, task.criteriaRefs),
    decisions: base.spec.decisions,
    feedback: `The Dev cannot finish this task as written:\n${opts.reason}\n\nWrite one question for the owner in Brazilian Portuguese (pt-BR), in plain words, and 2 to 4 choices the agents can carry out inside this repository. Each choice has a short label, a detail in one sentence with its cost or risk, and at most one is recommended. Never ask for a credential or a value only the owner has.${docs}`,
  };
}

export function skillSelectPack(base: PackBase, task: PlanTask, opts: { role: Role; capability: string; reason: string; draft?: { id: string; whenToUse: string; rules: readonly string[] } }): ContextPackInput {
  const pinned = skillsForRole(opts.role).map((s) => `- ${s.id} (${s.repository}@${s.commit}): ${s.purpose}`).join('\n');
  const draft = opts.draft ? `\nA draft was proposed (do not install it yourself):\nid: ${opts.draft.id}\nwhen: ${opts.draft.whenToUse}\nrules:\n${opts.draft.rules.map((r) => `- ${r}`).join('\n')}` : '';
  return {
    ...common(base, 'skill-select', 'sm'),
    task,
    criteria: criteriaOf(base.spec, task.criteriaRefs),
    feedback: `The ${opts.role} agent needs a capability before it can continue.\nCapability: ${opts.capability}\nReason: ${opts.reason}${draft}\nPinned skills already available for this role:\n${pinned || '- none'}\nUse the mounted find-skills skill. Prefer a pinned, reputable existing skill with a compatible license and no forbidden tools. Create the smallest private skill only when no suitable skill exists. Reject requests already covered by the role or task.`,
  };
}

export function uiCheckPack(base: PackBase, fronts: readonly PlanTask[], opts: { serviceUrl: string }): ContextPackInput {
  const shared = common(base, 'ui-check', 'test');
  const screens = fronts.map((t) => `- ${t.id} ${t.title}: ${t.description} (paths: ${t.affectedPaths.join(', ')}; criteria: ${t.criteriaRefs.join(', ') || 'none'})`);
  return {
    ...shared,
    principles: [...shared.principles, ...sourceRules(base)],
    criteria: criteriaOf(base.spec, fronts.flatMap((t) => t.criteriaRefs)),
    feedback: `The service is already deployed at ${opts.serviceUrl}. Set SERVICE_URL to that address. This is a browser check of front-owned screens, not the HTTP e2e suite: check the screens of every front task below against its acceptance criteria and docs/design.md when the repository has it. Use Playwright when the binary is available; otherwise fetch the HTML at SERVICE_URL and judge layout, contrast, focus and touch targets. Never start, build or restart containers. Return decision "changes" only for a defect you observed.\n\nFront tasks:\n${screens.join('\n')}`,
  };
}

/** A replan takes its cause from the attempt history, never from a guess: a wrong cause sends the next attempt the wrong way. */
export const REPLAN_CAUSE_RULE =
  'Open each replacement description with the cause exactly as the attempt history states it, in its own words. Never name a different cause, and when the history states none, write "cause not recorded" instead of guessing.';

/** The scaffold task is what makes the plan's gates runnable; split up, none of its pieces can pass them. */
export const SCAFFOLD_REPLAN_RULE =
  'This is the scaffold task: every gate in the plan (npm run, go test, pytest, cargo test ...) runs against each task on its own, so the toolchain (the manifest such as package.json, go.mod, pyproject.toml or Cargo.toml, the lockfile, configs, gate scripts) must land in ONE task. Replan it as exactly one replacement task, never several.';

export function replanPack(base: PackBase, task: PlanTask, opts: { history: readonly string[]; boundaries: readonly string[]; atomic?: boolean }): ContextPackInput {
  const constraint = `\n\nConstraint:\n${[REPLAN_CAUSE_RULE, ...(opts.atomic ? [SCAFFOLD_REPLAN_RULE] : [])].map((rule) => `- ${rule}`).join('\n')}`;
  const feedback = `Attempt history:\n${opts.history.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\nModule boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}${constraint}`;
  return { ...common(base, 'replan', 'sm'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), feedback };
}

const EVIDENCE_RULE =
  '- integrated verification counts a criterion as covered only from the JUnit of the plan test gates run on main; a test behind a build tag, marker or path those gate commands do not run (smoke, e2e, image) never counts, so a criterion with smoke: false keeps its test in code the test gate runs (a check that needs docker reads the Dockerfile or manifests instead, since gates have no docker)';

const OWNER_RULE =
  '- owner is dev, devops or front: use front only when every affectedPaths entry is UI code (e.g. web/src/**); use devops only for Dockerfile, deploy manifests, CI/release workflows and docker-compose; everything else is dev';

/** `environment`: the variables the local test needs that nothing provides yet, with where each is read; the agent answers a recipe per variable. */
export function environmentPack(base: PackBase, opts: { unknown: Readonly<Record<string, readonly string[]>>; existing: readonly string[]; services: readonly string[]; failure: string | null }): ContextPackInput {
  const unknown = Object.entries(opts.unknown).map(([name, files]) => `- ${name}: read in ${files.join(', ') || 'a file of the repository'}`);
  return { ...common(base, 'environment', 'env'), criteria: base.spec.acceptanceCriteria, feedback: [
    'The deploy of this spec is a local Docker test of what was built, so every credential it needs is made up by the platform and nobody types one. Decide how the platform creates each variable below, with one recipe per variable (random, fake, from-service or mint, as your rules say).',
    `Unknown variables (name and where it is read):\n${unknown.join('\n') || '- none'}`,
    `Variables that already exist (names only, never list them in your answer):\n${opts.existing.map((n) => `- ${n}`).join('\n') || '- none'}`,
    `Services of this project (the names a from-service or mint recipe may use):\n${opts.services.map((s) => `- ${s}`).join('\n') || '- the project has a single service, named like the project'}`,
    opts.failure ? `The deploy or its suite just failed with this output; add a recipe for any variable it names that is not in the lists above:\n${opts.failure.slice(0, 3_000)}` : '',
    'Read the compose file, `.env.example`, the smoke and e2e suites and the docs of the services you point at, to write each reason and each mint request from what the code does.',
  ].filter((p) => p !== '').join('\n\n') };
}

/** The convergence after the build: a read-only review of the merged code against the implementation plan, which reports only the gaps it finds. */
export function convergePack(base: PackBase, opts: { plan: string }): ContextPackInput {
  const feedback = [
    `Review the code of this repository against the implementation plan ${opts.plan}: load the requesting-code-review skill of Superpowers with the Skill tool and follow its review lens.`,
    'Read only: never change a file, never run a git command that writes, and never commit.',
    'Check that every plan task the code should build is built, and that every acceptance criterion the plan names is met by the code. Report only the gaps: a plan task or a criterion the code does not meet yet.',
    'Never stop to ask a question in the chat; take the most reasonable choice.',
    'Describe each gap in Brazilian Portuguese, in one sentence, naming the plan task and the file that should hold it.',
    'Answer status converged when nothing is missing. Answer status gaps with `gaps` listing the gaps when some were found.',
  ].join('\n\n');
  const shared = common(base, 'converge', 'dev');
  return { ...shared, principles: [...shared.principles, ...sourceRules(base)], criteria: base.spec.acceptanceCriteria, feedback };
}

export function fixTasksPack(base: PackBase, opts: { failedTests: readonly string[]; tails: string; uncoveredAcs: readonly string[]; blocked: ReadonlyArray<{ taskId: string; reason: string; service?: string }>; plan: Pick<Plan, 'tasks' | 'gates'>; services?: readonly string[]; boundaries: readonly string[]; feedback: string | null; convergence?: string }): ContextPackInput {
  const feedback = [
    'Integrated verification on main failed. Plan 1 to 3 fix tasks. Ids are assigned by the orchestrator.',
    `Failed tests:\n${opts.failedTests.map((t) => `- ${t}`).join('\n') || '- none'}`,
    `Criteria without passed evidence:\n${opts.uncoveredAcs.map((a) => `- ${a}`).join('\n') || '- none'}`,
    `Blocked tasks (their work never reached main; a fix task redoes what a criterion still needs and never depends on them):\n${opts.blocked.map((b) => `- ${b.taskId}${b.service ? ` (${b.service})` : ''}: ${b.reason}`).join('\n') || '- none'}`,
    `Gate output (tail):\n${opts.tails}`,
    `Existing tasks:\n${opts.plan.tasks.map((t) => `- ${t.id}${t.service ? ` (${t.service})` : ''}: ${t.title} [${t.criteriaRefs.join(', ')}]`).join('\n')}`,
    `Test gates run on main:\n${opts.plan.gates.filter((g) => g.name.includes('test')).map((g) => `- ${g.name}: ${g.command}`).join('\n') || '- none'}`,
    `Module boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}`,
    OWNER_RULE,
    opts.services ? `Each task names its service, one of: ${opts.services.join(', ')}. A task changes only that service's repository.` : '',
    opts.convergence ? `The review of the code against the implementation plan found these gaps, which the code does not meet yet. Each fix task builds the gaps it names:\n${opts.convergence}` : '',
    opts.feedback ? `Previous answer was rejected:\n${opts.feedback}` : '',
  ].filter(Boolean).join('\n\n');
  return { ...common(base, 'fix-tasks', 'sm'), criteria: base.spec.acceptanceCriteria, feedback };
}

/** The pack of the docs step: the numbered tree of the project's repository, written from the code it delivered. */
export function docsPack(base: PackBase, opts: { tasks: readonly string[]; kinds: readonly AppKind[]; features: readonly string[]; readmeSections?: readonly string[]; docsErrors?: readonly string[] }): ContextPackInput {
  const absent = APP_KINDS.filter((kind) => !opts.kinds.includes(kind));
  return { ...common(base, 'docs', 'docs'), criteria: base.spec.acceptanceCriteria, feedback: [
    'Document the code this spec delivered, in docs/ of your working directory: the project\'s own repository, checked out on main with the delivered code. Read the code with Read, Grep and Glob, and write only the files of the tree below.',
    `The tree, every path relative to your working directory:\n${DOCS_TREE.map((p) => `- ${p}`).join('\n')}`,
    `This repository holds these kinds of application: ${opts.kinds.join(', ') || 'none'}. Every file of ${absent.join(', ') || 'no other kind'} says only "Não se aplica: <reason>".`,
    opts.features.length > 0 ? `The spec features; each endpoint they name appears in docs/03-api/ with its exact path, written as \`METHOD /path\` (for example \`### GET /orders/{id}\`):\n${opts.features.map((f) => `- ${f}`).join('\n')}` : 'The spec features name no endpoint.',
    `Delivered tasks; each one is named in the covers of at least one file that documents it:\n${opts.tasks.join('\n') || '- none'}`,
    opts.readmeSections?.length ? `The plan requires a heading for each of these sections, in some file: ${opts.readmeSections.join(', ')}.` : '',
    ...(opts.docsErrors?.length ? [`Your previous documents were rejected, fix every point:\n${opts.docsErrors.map((e) => `- ${e}`).join('\n')}`] : []),
    'Earlier specs wrote the docs already in docs/ of your working directory: read them first, keep what is still true, and change only what this spec changed.',
  ].filter(Boolean).join('\n\n') };
}

export function reportPack(base: PackBase, opts: { delivered: readonly string[]; blocked: ReadonlyArray<{ taskId: string; reason: string }>; evidence: string; assumptions: readonly string[]; deploy: string; hostUrl: string | null; tokens: string; security: string; }): ContextPackInput {
  return { ...common(base, 'report', 'sm'), criteria: base.spec.acceptanceCriteria, feedback: [
    'Write the final report for the human validator. Give concrete exploratory steps for every acceptance criterion.',
    'Write `summary`, `assumptions`, `blocked[].reason` and `exploratoryScript` entirely in Brazilian Portuguese (pt-BR), in plain words a non-developer can follow; no English sentences. Each exploratory step says what to do and what should happen, in one short sentence (for example: "Abra /health no endereço do serviço. Deve aparecer {"ok":true}."). Keep commands, URLs, status codes and JSON between backticks, untranslated.',
    `Delivered tasks: ${opts.delivered.join(', ') || 'none'}`,
    `Blocked tasks:\n${opts.blocked.map((b) => `- ${b.taskId}: ${b.reason}`).join('\n') || '- none'}`,
    `Evidence matrix:\n${opts.evidence}`,
    `Assumptions:\n${opts.assumptions.join('\n') || '- none'}`,
    `Security findings left by the sec review (mention residual risks in the summary):
${opts.security || '- none'}`,
    `Deploy outcome: ${opts.deploy}`,
    opts.hostUrl ? `The human opens the service at ${opts.hostUrl}; the deploy url is internal to the platform and never appears in what you write: use ${opts.hostUrl} in the summary and the exploratory steps.` : 'The human cannot open the service from a browser; the deploy url is internal to the platform and never appears in what you write.',
    `Token usage: ${opts.tokens}`,
  ].join('\n\n'), };
}

/** The doc sections a spec cites, each judged against the code on main. */
export function gapsPack(base: PackBase, opts: { sections: ReadonlyArray<{ doc: string; heading: string }> }): ContextPackInput {
  const docsDir = base.docsRoot === undefined ? 'docs/' : `${base.docsRoot}/docs/`;
  return { ...common(base, 'gaps', 'test'), criteria: base.spec.acceptanceCriteria, feedback: [
    'Judge each doc section below against the code on main. Read the section in ' + docsDir + ' (the file before the arrow, the heading after it) and the code it asks for, with Read, Grep and Glob. This step only reads: never edit or write a file.',
    'Return one item per section. `status`: delivered when the code does all the section asks, partial when it does some of it, missing when it does none. `evidence`: the files and lines that prove what is built, for example `server/api/routes.ts:42`. `missing`: what the section asks that the code lacks, empty when delivered. `acIds`: the acceptance criteria that cover the section, only ids from the criteria list.',
    'Write `missing` in Brazilian Portuguese (pt-BR), in plain words a non-developer can follow. Keep file paths and identifiers between backticks, untranslated.',
    `Sections:\n${opts.sections.map((s) => `- ${s.doc} › ${s.heading}`).join('\n')}`,
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
  /** The step may search the web (see StepRequest.webSearch). */
  webSearch?: boolean;
  /** Directories the step must not write (a read-only step on a checkout). */
  protectedDirs?: readonly string[];
  /** Directories the step must not read (the chat's project data). */
  denyRead?: readonly string[];
  /** Added to the agent's prompt for this step; see `StepRequest.systemExtra`. */
  systemExtra?: string;
  /** Spec 10A.5 decisions 10/11: per-step model and effort; absent means the role profile. A requested effort keeps the model-policy limit. */
  model?: string;
  effort?: Effort;
  /** An effort the automatic choice set for this step (config `routing.efforts`): it runs as set, without the model-policy limit. */
  routedEffort?: Effort;
  /** Env entries the orchestrator provisioned for this one step (e.g. an ephemeral test database's DATABASE_URL). */
  extraEnv?: Readonly<Record<string, string>>;
  /** A stage review: no tools, no graph, and its own time limit (see StepRequest.review). */
  review?: true;
  /** The part of a document this review reads, when the document is too big for one review. */
  part?: { index: number; total: number };
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
  /** The automatic model and effort of every step of one kind, ahead of the role profile (config `routing`); `attempt` is the refinement cycle there. */
  stepSetting?: (kind: StepKind, attempt: number) => AutomaticRow | undefined;
  /** The most effort each model family takes on the automatic path, from Settings; absent keeps the model-policy defaults. */
  effortCaps?: EffortCaps;
  /** The effort an automatic step takes when it asks for none and has no line of its own, from Settings. */
  defaultEffort: Effort;
  /** A model and effort the user fixed for this role or slot in this project; they win over the request and the routing. */
  agentSetting?: (key: SettingKey) => AgentSetting | undefined | Promise<AgentSetting | undefined>;
  secretValues: () => readonly string[];
  /** The pinned snapshot a documentation-repository project reads; every step gets a read-only grant of it. */
  docsRoot?: string;
  /** Whether the owner lets the agents decide; a step that does not judge then gets full access (shell and web). */
  agentsDecide?: () => Promise<boolean>;
  /** The graphs the agent may query; added to the pack of every step unless the request brings its own. */
  graphAccess?: GraphAccess;
  /** Step kinds not offered the graph, set per project to compare their cost with the steps that are. */
  graphOff?: readonly string[];
  /** What the graph's relations say about the spec of the run, added to the pack of every step the graph is offered to. */
  specBrief?: () => Promise<string>;
  specHash: string;
}

/** The steps that judge a change or a document; they never get the shell and web the owner lets the other steps have. */
const JUDGING_KINDS: readonly StepKind[] = ['review', 'security', 'ui-check', 'gaps'];

/**
 * One agent step: journaled, governed, breaker-observed, redacted, with prompt and output kept under
 * runs/<runId>/steps/. Accounting is done by runStep itself (Plan 3).
 */
export async function runAgentStep<K extends StepKind>(req: AgentStepRequest<K>, deps: AgentStepDeps): Promise<StepOutcome<OutputOf<K>>> {
  const seq = deps.journal.allocStepSeq();
  const id = stepId(seq);
  const sessionStore = req.session && req.taskId && deps.sessionDir ? deps.sessionDir(req.taskId) : undefined;
  const resume = req.session !== undefined && sessionStore !== undefined && (await hasSession(sessionStore, req.session.id, req.cwd));
  // A lean step reads only the context in its prompt: the graph is not offered to it.
  // A step the project turned the graph off for gets neither the graphs nor the brief of its spec, so the two groups compare cleanly.
  const offered = !isLean(req) && !deps.graphOff?.includes(req.kind);
  const brief = !resume && offered && !req.pack.specBrief ? await deps.specBrief?.().catch(() => '') : '';
  const pack = resume
    ? resumedPack(req.session!.resumePrompt)
    : buildContextPack({ ...req.pack, ...(deps.graphAccess && !req.pack.graphAccess && offered ? { graphAccess: deps.graphAccess } : {}), ...(brief ? { specBrief: brief } : offered ? {} : { specBrief: undefined }) });
  const dir = deps.stepDir(seq);
  await fs.mkdir(dir, { recursive: true });
  const profile = deps.profile(req.role);
  // Every step follows its setting in the Settings screen: the chat has its own slot, every other step its role's.
  const manual = await deps.agentSetting?.(req.kind === 'chat' ? 'chat' : req.role);
  const auto = manual || req.model !== undefined ? undefined : deps.stepSetting?.(req.kind, req.attempt);
  const model = manual?.model ?? req.model ?? auto?.model ?? profile.model;
  // The effort the CLI runs at, for the model the step actually runs on; journaled so the run page can show it. A manual or automatic effort runs as set.
  const effortOf = (m: string): Effort => manual?.effort ?? req.routedEffort ?? (auto && m === auto.model ? auto.effort : effortFor(m, req.effort, deps.defaultEffort, deps.effortCaps));
  await deps.journal.fact(OrchEvent.StepStarted, {
    stepId: id,
    kind: req.kind,
    role: req.role,
    model,
    effort: effortOf(model),
    taskId: req.taskId,
    phase: req.phase,
    attempt: req.attempt,
    tokens: pack.tokens,
    dropped: pack.dropped,
    part: req.part ?? null,
    limitMs: limitMsOf(deps.stepDeps.caps, req.review === true),
  });
  await fs.writeFile(path.join(dir, 'prompt.md'), pack.text);
  const clean = (s: string) => redactSecrets(s, deps.secretValues());
  // The owner lets the agents decide: a step that does not judge gets full access (shell and web).
  const fullAccess = !JUDGING_KINDS.includes(req.kind) && (await deps.agentsDecide?.()) === true;
  const release = await deps.governor.acquire();
  let outcome: StepOutcome<OutputOf<K>>;
  const attempt = (m: string) =>
    deps.runStep<K>(
      {
        kind: req.kind,
        role: req.role,
        agent: deps.agents[req.role],
        profile,
        model: m,
        effort: effortOf(m),
        cwd: req.cwd,
        prompt: pack.text,
        expectedSpecHash: deps.specHash,
        refContext: req.refContext,
        refs: req.refs,
        semantic: req.semantic,
        phase: req.phase,
        taskId: req.taskId,
        attempt: req.attempt,
        docsRepo: deps.docsRoot !== undefined,
        extraAllow: [...(req.extraAllow ?? []), ...snapshotGrant(deps.docsRoot)],
        webSearch: req.webSearch,
        protectedDirs: req.protectedDirs,
        denyRead: req.denyRead,
        systemExtra: req.systemExtra,
        extraEnv: req.extraEnv,
        fullAccess,
        review: req.review,
        ...(sessionStore ? { sessionId: req.session!.id, resume, sessionStore } : {}),
      },
      deps.stepDeps,
    );
  try {
    outcome = await attempt(model);
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
    model,
    effort: effortOf(model),
    failure: outcome.ok ? null : outcome.failure,
    usage: outcome.summary.usage,
    costUsd: outcome.summary.costUsd,
    durationMs: outcome.summary.durationMs,
    numTurns: outcome.summary.numTurns,
    ...(outcome.summary.profile ? { profile: outcome.summary.profile } : {}),
  });
  return result;
}
