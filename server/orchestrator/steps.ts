import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import type { Governor } from '../budget/governor.js';
import type { QuotaBreaker } from '../budget/quota-breaker.js';
import type { RoleProfile, Role } from '../config/config.js';
import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Preplan } from '../contracts/preplan.js';
import type { Project } from '../contracts/project.js';
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
import { REQUIRED_BLOCKING_GATES, SCAFFOLD_TASK_ID } from '../validators/plan.js';
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

export function devPack(
  base: PackBase,
  task: PlanTask,
  opts: { code: CodeContext; handoffs: readonly HandoffSummary[]; feedback: string | null },
  role: Role = 'dev',
): ContextPackInput {
  return {
    ...common(base, 'dev', role),
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
  const changeSet = `Changed files:\n${opts.changedFiles.join('\n')}\n\nDiff stat:\n${opts.diffStat}\n\nGate test results (the merge gates already ran the suite on this diff; do not re-run it):\n${results.join('\n') || '- none reported'}\n\nDiff against origin/main:\n${opts.diff}`;
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
  'commands.e2e is required and is NOT commands.smoke: it runs the suite at delivery.e2eSuite (the command must reference that path) inside gateImage after the compose stack is deployed and smoke has passed, black-box over HTTP against process.env.SERVICE_URL, no mocks of the service under test, never starting containers; every acceptance criterion needs one test whose name carries its id, e.g. "[AC-001] POST /todos creates a todo", EXCEPT criteria with no testable observable behavior over the service interface (devops-only, build, docs or style rules): list those in plan.e2eExemptions as {acId, reason} (reason of at least 10 characters, at least one criterion stays covered) and they get no e2e test; plan one task owned by dev that creates the suite and depends on the service tasks; a failing e2e blocks the run';

/** The coverage gate is stack-agnostic by contract, never by prescribed tool (roadmap R10.2): whatever the stack's
 * own coverage tool is, the gate's command must end by writing coveragePath as one line of JSON, {"linesPct": N};
 * the orchestrator reads only that number, never the tool's own report format, and fails the gate below 80 even
 * when the command's own exit code is 0. coverageExemptions lists paths the tool's own ignore mechanism already
 * excluded from the denominator, each with a reason of at least 10 characters. */
export const COVERAGE_CONTRACT =
  'gate "coverage" (blocking) runs the test suite with whatever coverage tool the stack has, then writes plan.coveragePath as one line of JSON {"linesPct": <number>}; the orchestrator fails the gate when linesPct is below 80, or the file is missing or malformed, regardless of the command\'s own exit code; a path the tool\'s own config already excludes from coverage goes in plan.coverageExemptions as {path, reason} (reason of at least 10 characters)';

export function planRules(firstSpec: boolean, requireDelivery = false, requireSecurityTooling = false, requireE2e = false, requireCoverage = false): string {
  const lines = [
    'Plan rules (the orchestrator rejects a plan that breaks any of them):',
    '- deploy.kind is "api" or "front" (what the service is); an api sets deploy.docsPath to the path that serves its Swagger/OpenAPI page (for example /docs); deploy.port must be inside 3000-3019, the range the platform publishes to the host so the human can open the service',
    '- a database or other datastore service in docker-compose (Postgres, MySQL, Redis, ...) publishes its own port to the host too, on a port outside 3000-3019; an integration test against a real database needs a route to it exactly like the app has for deploy.port, and one that only the compose-internal network can reach has none',
    `- gates must include these blocking gates: ${REQUIRED_BLOCKING_GATES.join(', ')} (plus a blocking typecheck gate when commands.typecheck exists)`,
    '- every acceptance criterion is covered by at least one task (criteriaRefs); every task has at least one criterion or is infrastructure',
    '- every task id is T<n>-<slug>: a number plus 1 to 4 English kebab-case words saying what the task does (T1-create-endpoint, T2-add-login-form); never a bare T1',
    '- dependsOn forms a DAG; affectedPaths are repository-relative paths or globs; tasks small enough for one agent step',
    '- dependsOn names only a real dependency: the task needs code, an interface or a file that the other task creates. Writing the tasks in order is not a dependency; tasks that touch different files run in parallel, and a chain of dependsOn that is not needed makes the run sequential',
    '- owner is dev, devops or front: use front only when every affectedPaths entry is UI code (e.g. web/src/**); use devops only for Dockerfile, deploy manifests, CI/release workflows and docker-compose; everything else is dev',
    '- gateImage is a glibc-based image (e.g. node:22-bookworm-slim), never an Alpine/musl one: dependencies are installed by the Dev on a Debian host and native optional packages (rollup, esbuild, swc) will not load under musl',
    `- ${SMOKE_CONTRACT}`,
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
  if (firstSpec) {
    lines.push(
      `- first spec of the project: a task with id ${SCAFFOLD_TASK_ID} (owner dev, no dependsOn) creates the project skeleton, build, test and gate configuration; every other task depends on it directly or indirectly`,
      '- first spec of the project: one deploy-infrastructure task owned by devops (Dockerfile, manifests, deployment.json)',
    );
  } else {
    lines.push(`- ${SCAFFOLD_TASK_ID} is only allowed on the first spec of a project`);
  }
  return lines.join('\n');
}

export function planPack(
  base: PackBase,
  opts: { techSpecText: string; preplan?: Preplan | null; godNodes: ReadonlyArray<{ label: string; edges: number }>; feedback: string | null; firstSpec?: boolean; requireDelivery?: boolean; requireSecurityTooling?: boolean; requireE2e?: boolean; requireCoverage?: boolean },
): ContextPackInput {
  const human = (base.spec.tasks ?? []).map((t) => `- ${t.title}: ${t.description}`);
  const nodes = opts.godNodes.map((n) => `- ${n.label} (${n.edges} edges)`);
  const parts = [
    planRules(opts.firstSpec ?? false, opts.requireDelivery ?? false, opts.requireSecurityTooling ?? false, opts.requireE2e ?? false, opts.requireCoverage ?? false),
    opts.preplan ? `Pre-plan reviewed at refinement time (context only: follow the real repository, not this; cover at least its acceptance criteria):\n${JSON.stringify(opts.preplan, null, 2)}` : '',
    human.length > 0 ? `Human-defined tasks (derive dependencies, keep them):\n${human.join('\n')}` : '',
    nodes.length > 0 ? `Central modules of the current code (graph god-nodes):\n${nodes.join('\n')}` : '',
    opts.feedback ?? '',
  ].filter((s) => s !== '');
  return {
    ...common(base, 'plan', 'sm'),
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
  'This is the scaffold task: every gate in the plan (npm run ...) runs against each task on its own, so the toolchain (package.json, lockfile, configs, gate scripts) must land in ONE task. Replan it as exactly one replacement task, never several.';

export function replanPack(base: PackBase, task: PlanTask, opts: { history: readonly string[]; boundaries: readonly string[]; atomic?: boolean }): ContextPackInput {
  const constraint = opts.atomic ? `\n\nConstraint:\n- ${SCAFFOLD_REPLAN_RULE}` : '';
  const feedback = `Attempt history:\n${opts.history.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\nModule boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}${constraint}`;
  return { ...common(base, 'replan', 'sm'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), feedback };
}

export function fixTasksPack(base: PackBase, opts: { failedTests: readonly string[]; tails: string; uncoveredAcs: readonly string[]; plan: Plan; boundaries: readonly string[]; feedback: string | null }): ContextPackInput {
  const feedback = [
    'Integrated verification on main failed. Plan 1 to 3 fix tasks. Ids are assigned by the orchestrator.',
    `Failed tests:\n${opts.failedTests.map((t) => `- ${t}`).join('\n') || '- none'}`,
    `Criteria without passed evidence:\n${opts.uncoveredAcs.map((a) => `- ${a}`).join('\n') || '- none'}`,
    `Gate output (tail):\n${opts.tails}`,
    `Existing tasks:\n${opts.plan.tasks.map((t) => `- ${t.id}: ${t.title} [${t.criteriaRefs.join(', ')}]`).join('\n')}`,
    `Module boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}`,
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

export function readmePack(base: PackBase, opts: { tasks: readonly string[]; existing: string | null; docsErrors?: readonly string[] }): ContextPackInput {
  return { ...common(base, 'readme', 'sm'), criteria: base.spec.acceptanceCriteria, feedback: [
    'Write docs/README.md for this project: the Markdown overview a newcomer reads first. Read the repository (package.json, entry points, tests, Dockerfile) with Read, Grep and Glob; state only what the files confirm.',
    DOCS_STRUCTURE,
    ...(opts.docsErrors?.length ? [`Your previous documents were rejected, fix every point:\n${opts.docsErrors.map((e) => `- ${e}`).join('\n')}`] : []),
    `Delivered tasks:\n${opts.tasks.join('\n') || '- none'}`,
    opts.existing ? `Current docs/README.md (rewrite it, keep what is still true):\n${opts.existing}` : 'There is no docs/README.md yet.',
  ].join('\n\n') };
}

export function reportPack(base: PackBase, opts: { delivered: readonly string[]; blocked: ReadonlyArray<{ taskId: string; reason: string }>; evidence: string; assumptions: readonly string[]; deploy: string; tokens: string; security: string; docsErrors?: readonly string[] }): ContextPackInput {
  return { ...common(base, 'report', 'sm'), criteria: base.spec.acceptanceCriteria, feedback: [
    'Write the final report for the human validator. Give concrete exploratory steps for every acceptance criterion.',
    'Write `summary`, `assumptions`, `blocked[].reason` and `exploratoryScript` entirely in Brazilian Portuguese (pt-BR), in plain words a non-developer can follow; no English sentences. Each exploratory step says what to do and what should happen, in one short sentence (for example: "Abra http://localhost:3000/health no navegador. Deve aparecer {"ok":true}."). Keep commands, URLs, status codes and JSON between backticks, untranslated.',
    'Also return `readme`: the Markdown for docs/README.md, a short overview of the project (what it is, how to run and test it, the endpoints or commands it exposes, the acceptance criteria it satisfies). Use only facts from the context pack.',
    DOCS_STRUCTURE,
    ...(opts.docsErrors?.length ? [`Your previous documents were rejected, fix every point:\n${opts.docsErrors.map((e) => `- ${e}`).join('\n')}`] : []),
    `Delivered tasks: ${opts.delivered.join(', ') || 'none'}`,
    `Blocked tasks:\n${opts.blocked.map((b) => `- ${b.taskId}: ${b.reason}`).join('\n') || '- none'}`,
    `Evidence matrix:\n${opts.evidence}`,
    `Assumptions:\n${opts.assumptions.join('\n') || '- none'}`,
    `Security findings left by the sec review (mention residual risks in the summary):
${opts.security || '- none'}`,
    `Deploy outcome: ${opts.deploy}`,
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
  /** A model for every step of one kind, ahead of the role profile (config `routing.stepModels`). */
  stepModel?: (kind: StepKind) => string | undefined;
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
  const model = req.model ?? deps.stepModel?.(req.kind) ?? profile.model;
  await deps.journal.fact(OrchEvent.StepStarted, {
    stepId: id,
    kind: req.kind,
    role: req.role,
    model,
    taskId: req.taskId,
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
