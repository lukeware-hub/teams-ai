import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import type { Governor } from '../budget/governor.js';
import type { QuotaBreaker } from '../budget/quota-breaker.js';
import type { ProviderProfile, Role } from '../config/config.js';
import type { PlanTask } from '../contracts/plan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { stepId } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import { buildContextPack, type CodeContext, type ContextPackInput, type HandoffSummary } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { runStep as runStepFn, StepDeps, StepOutcome, StepRequest } from '../runner/step.js';
import type { RefContext } from '../validators/references.js';
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
  opts: { diffStat: string; changedFiles: readonly string[]; code: CodeContext },
): ContextPackInput {
  const feedback = `Changed files:\n${opts.changedFiles.join('\n')}\n\nDiff stat:\n${opts.diffStat}`;
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

export function planPack(
  base: PackBase,
  opts: { techSpecText: string; godNodes: ReadonlyArray<{ label: string; edges: number }>; feedback: string | null },
): ContextPackInput {
  const human = (base.spec.tasks ?? []).map((t) => `- ${t.title}: ${t.description}`);
  const nodes = opts.godNodes.map((n) => `- ${n.label} (${n.edges} edges)`);
  const parts = [
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

export function replanPack(base: PackBase, task: PlanTask, opts: { history: readonly string[]; boundaries: readonly string[] }): ContextPackInput {
  const feedback = `Attempt history:\n${opts.history.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\nModule boundaries:\n${opts.boundaries.map((b) => `- ${b}`).join('\n')}`;
  return { ...common(base, 'replan', 'sm'), task, criteria: criteriaOf(base.spec, task.criteriaRefs), feedback };
}

export interface AgentStepRequest<K extends StepKind> {
  kind: K;
  role: Role;
  pack: ContextPackInput;
  cwd: string;
  phase: string;
  taskId: string | null;
  attempt: number;
  refContext?: RefContext;
  refs?: StepRequest['refs'];
  semantic?: StepRequest['semantic'];
  extraAllow?: readonly string[];
}

export interface AgentStepDeps {
  runStep: typeof runStepFn;
  stepDeps: StepDeps;
  agents: Record<Role, AgentDefinition>;
  profile: (role: Role) => ProviderProfile;
  omniroute?: StepRequest['omniroute'];
  governor: Governor;
  breaker: QuotaBreaker;
  journal: Journal;
  stepDir: (seq: number) => string;
  secretValues: () => readonly string[];
  specHash: string;
}

/**
 * One agent step: journaled, governed, breaker-observed, redacted, with prompt and output kept under
 * runs/<runId>/steps/. Accounting is done by runStep itself (Plan 3).
 */
export async function runAgentStep<K extends StepKind>(req: AgentStepRequest<K>, deps: AgentStepDeps): Promise<StepOutcome<OutputOf<K>>> {
  const seq = deps.journal.nextStepSeq();
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
        model: profile.model,
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
  const result: StepOutcome<OutputOf<K>> = outcome.ok ? outcome : { ...outcome, errors: outcome.errors.map(clean) };
  const record = outcome.ok
    ? { ok: true, value: JSON.parse(clean(JSON.stringify(outcome.value))) as unknown }
    : { ok: false, failure: outcome.failure, errors: result.ok ? [] : result.errors };
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
