import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import type { Governor } from '../budget/governor.js';
import type { QuotaBreaker } from '../budget/quota-breaker.js';
import type { ProviderProfile, Role } from '../config/config.js';
import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { Effort } from '../decide/decisions/model-tier.js';
import type { ReviewProfile } from '../decide/decisions/pr-risk.js';
import { stepId } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import { buildContextPack, type CodeContext, type ContextPackInput, type HandoffSummary } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { runStep as runStepFn, StepDeps, StepOutcome, StepRequest } from '../runner/step.js';
import type { RefContext } from '../validators/references.js';
import { REQUIRED_BLOCKING_GATES, SCAFFOLD_TASK_ID } from '../validators/plan.js';
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
): ContextPackInput {
  return {
    ...common(base, 'dev', 'dev'),
    task,
    criteria: criteriaOf(base.spec, task.criteriaRefs),
    handoffs: opts.handoffs,
    code: opts.code,
    feedback: opts.feedback ?? undefined,
  };
}

export function reviewPack(
  base: PackBase,
  task: PlanTask,
  opts: { diffStat: string; changedFiles: readonly string[]; code: CodeContext; profile: ReviewProfile },
): ContextPackInput {
  const feedback = `Review profile: ${opts.profile}

Changed files:\n${opts.changedFiles.join('\n')}\n\nDiff stat:\n${opts.diffStat}`;
  return { ...common(base, 'review', 'test'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), code: opts.code, feedback };
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
export function planRules(firstSpec: boolean): string {
  const lines = [
    'Plan rules (the orchestrator rejects a plan that breaks any of them):',
    `- gates must include these blocking gates: ${REQUIRED_BLOCKING_GATES.join(', ')} (plus a blocking typecheck gate when commands.typecheck exists)`,
    '- every acceptance criterion is covered by at least one task (criteriaRefs); every task has at least one criterion or is infrastructure',
    '- dependsOn forms a DAG; affectedPaths are repository-relative paths or globs; tasks small enough for one agent step',
  ];
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
  opts: { techSpecText: string; godNodes: ReadonlyArray<{ label: string; edges: number }>; feedback: string | null; firstSpec?: boolean },
): ContextPackInput {
  const human = (base.spec.tasks ?? []).map((t) => `- ${t.title}: ${t.description}`);
  const nodes = opts.godNodes.map((n) => `- ${n.label} (${n.edges} edges)`);
  const parts = [
    planRules(opts.firstSpec ?? false),
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

export function reportPack(base: PackBase, opts: { delivered: readonly string[]; blocked: ReadonlyArray<{ taskId: string; reason: string }>; evidence: string; assumptions: readonly string[]; deploy: string; tokens: string }): ContextPackInput {
  return { ...common(base, 'report', 'sm'), criteria: base.spec.acceptanceCriteria, feedback: [
    'Write the final report for the human validator. Give concrete exploratory steps for every acceptance criterion.',
    `Delivered tasks: ${opts.delivered.join(', ') || 'none'}`,
    `Blocked tasks:\n${opts.blocked.map((b) => `- ${b.taskId}: ${b.reason}`).join('\n') || '- none'}`,
    `Evidence matrix:\n${opts.evidence}`,
    `Assumptions:\n${opts.assumptions.join('\n') || '- none'}`,
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
}

export interface AgentStepDeps {
  runStep: typeof runStepFn;
  stepDeps: StepDeps;
  agents: Record<Role, AgentDefinition>;
  profile: (role: Role) => ProviderProfile;
  omniroute?: StepRequest['omniroute'];
  governor: Governor;
  breaker: QuotaBreaker;
  journal: Pick<Journal, 'allocStepSeq' | 'fact'>;
  stepDir: (seq: number) => string;
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
  const pack = buildContextPack(req.pack);
  const dir = deps.stepDir(seq);
  await fs.mkdir(dir, { recursive: true });
  await deps.journal.fact(OrchEvent.StepStarted, {
    stepId: id,
    kind: req.kind,
    role: req.role,
    taskId: req.taskId,
    attempt: req.attempt,
    tokens: pack.tokens,
    dropped: pack.dropped,
  });
  await fs.writeFile(path.join(dir, 'prompt.md'), pack.text);
  const clean = (s: string) => redactSecrets(s, deps.secretValues());
  const profile = deps.profile(req.role);
  const release = await deps.governor.acquire();
  let outcome: StepOutcome<OutputOf<K>>;
  try {
    outcome = await deps.runStep<K>(
      {
        kind: req.kind,
        role: req.role,
        agent: deps.agents[req.role],
        profile,
        model: req.model ?? profile.model,
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
        omniroute: profile.provider === 'omniroute' ? deps.omniroute : undefined,
        extraAllow: req.extraAllow,
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
  });
  return result;
}
