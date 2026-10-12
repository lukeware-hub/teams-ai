import { z } from 'zod';
import { HASH_PATTERN } from '../contracts/hash.js';
import { ADR_ID, Plan, PlanTask, ServicesPlan } from '../contracts/plan.js';
import { Backlog } from '../contracts/backlog.js';
import { Preplan } from '../contracts/preplan.js';
import { AC_ID, AcceptanceCriterion, BugDetails, ExternalDependency, SpecType } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';
import { Project, ServiceName } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';

export const STEP_KINDS = ['refine', 'derive', 'tech-spec', 'coverage', 'plan', 'services-plan', 'dev', 'review', 'security', 'deployment', 'report', 'readme', 'decide', 'spec-gap', 'replan', 'fix-tasks', 'backlog', 'spec', 'preplan', 'name', 'suggest'] as const;
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

/** Spec (refinement) §3.2 step 1: Markdown → project.json + spec.json; the orchestrator re-validates and forces status/hash/version. */
export const DeriveOutput = z.object({ specHash, project: Project, spec: Spec });
export type DeriveOutput = z.infer<typeof DeriveOutput>;

/** Backlog mode: the docs broken into epics and prioritized items; the orchestrator validates it and ranks the items. */
export const BacklogOutput = z.object({ specHash, project: Project, backlog: Backlog });
export type BacklogOutput = z.infer<typeof BacklogOutput>;

/** Backlog detailing (PO): the spec of up to three backlog items per call; the orchestrator owns ids, status and provenance. */
export const ItemSpec = z.object({
  key: z.string().regex(ID_PATTERNS.SLUG),
  type: SpecType.default('feature'),
  bug: BugDetails.optional(),
  objectives: z.array(z.string().min(1)).min(1),
  features: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  outOfScope: z.array(z.string().min(1)),
  externalDependencies: z.array(ExternalDependency),
});
export type ItemSpec = z.infer<typeof ItemSpec>;
export const SpecDetailOutput = z.object({ specHash, specs: z.array(ItemSpec).min(1).max(3) });
export type SpecDetailOutput = z.infer<typeof SpecDetailOutput>;

/** Backlog detailing (SM): the pre-plan of up to three specs per call; the orchestrator adds specId, specRev and inputHash. */
export const ItemPreplan = Preplan.pick({ modules: true, tasks: true, risks: true }).extend({ key: z.string().regex(ID_PATTERNS.SLUG) });
export type ItemPreplan = z.infer<typeof ItemPreplan>;
export const PreplanOutput = z.object({ specHash, preplans: z.array(ItemPreplan).min(1).max(3) });
export type PreplanOutput = z.infer<typeof PreplanOutput>;

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

/** Roadmap R11.12: a new plan's task ids carry a readable slug (`T1-create-endpoint`); stored plans keep the loose `TASK_ID`. */
const NAMED_TASK_ID = /^T\d+(?:-[a-z0-9]+)+$/;
const NamedPlan = Plan.extend({ tasks: z.array(PlanTask.extend({ id: z.string().regex(NAMED_TASK_ID) })).min(1) });

/** Spec 10A.5 decision 12: the SM may add up to two full alternative plans; System 1 ranks them, Phase 2 keeps one. */
export const PlanOutput = NamedPlan.extend({ alternatives: z.array(NamedPlan).max(2).optional() });

/** R12.6: a project split into services gets a services plan; every task names its service. No alternatives: the ranking reads one stack. */
export const ServicesPlanOutput = ServicesPlan.extend({ tasks: z.array(PlanTask.extend({ id: z.string().regex(NAMED_TASK_ID), service: ServiceName })).min(1) });

const devCommon = {
  specHash,
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  scopeJustification: z.string().optional(),
};

/** A discriminated union so the generated JSON Schema tells the model which fields each status requires. */
export const DevOutput = z.discriminatedUnion('status', [
  /** Deleted paths the Dev's own sandbox has no tool to remove (Bash's rm/git rm are denied); the orchestrator deletes them before committing. */
  z.object({ ...devCommon, status: z.literal('done'), commitMessage: z.string().min(1), deletedFiles: z.array(z.string().min(1)).optional() }),
  z.object({ ...devCommon, status: z.literal('spec-gap'), question: z.string().min(1) }),
  /** The task cannot proceed for a reason outside its paths (deploy environment, missing access): no SM round, no attempt consumed. */
  z.object({ ...devCommon, status: z.literal('blocked'), reason: z.string().min(1) }),
]);

export const ReviewOutput = z.object({
  specHash,
  decision: z.enum(['approve', 'changes']),
  /** Empty for tasks without acceptance criteria (scaffold, infrastructure): the review judges the diff alone. */
  criteria: z.array(z.object({ id: acId, status: z.enum(['passed', 'failed', 'not-covered']), evidence: z.array(z.string()) })),
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

/** Security review of one task diff. The severities decide: critical/high findings block the merge, medium/low are recorded only. */
export const SecurityOutput = z.object({
  specHash,
  /** The reviewer's own summary of its findings: `changes` exactly when one is critical or high. The orchestrator blocks on `blockingFindings`, never on this label. */
  decision: z.enum(['approve', 'changes']),
  findings: z.array(
    z.object({
      file: z.string().min(1),
      line: z.number().int().nonnegative().nullable(),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      category: z.string().min(1),
      problem: z.string().min(1),
      fix: z.string().min(1),
    }),
  ),
});
export type SecurityOutput = z.infer<typeof SecurityOutput>;

/** The one blocking rule of a security review, restated in .claude/agents/sec.md: only critical and high findings go back to Dev. */
export function blockingFindings(review: Pick<SecurityOutput, 'findings'>): SecurityOutput['findings'] {
  return review.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
}

export const DeploymentOutput = z.object({
  specHash,
  target: z.enum(['docker-local']),
  image: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  healthcheckPath: z.string().startsWith('/'),
  manifests: z.array(z.string().min(1)),
  secretNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  notes: z.string(),
});

/** `spec readme`: the SM alone writes docs/README.md for a spec that already has code on main. */
export const ReadmeOutput = z.object({ specHash, readme: z.string().min(1), runbook: z.string().optional(), apiDocs: z.string().optional() });

export const ReportOutput = z.object({
  specHash,
  delivered: z.array(taskId),
  blocked: z.array(z.object({ taskId, reason: z.string().min(1) })),
  assumptions: z.array(z.string()),
  exploratoryScript: z.array(z.object({ acId, steps: z.array(z.string().min(1)).min(1) })),
  summary: z.string().min(1),
  /** Markdown for docs/README.md: a project overview the orchestrator commits with the report. */
  readme: z.string().min(1),
  /** Markdown for docs/RUNBOOK.md (start, stop, logs, rollback); validated by the docs gate. */
  runbook: z.string().optional(),
  /** Markdown for docs/API.md listing every endpoint the spec features name. */
  apiDocs: z.string().optional(),
});

/** Spec 10A.3: a System 2 answer to typed questions; no probabilities, the value only. */
export const DecideOutput = z.object({
  specHash,
  answers: z.record(
    z.string(),
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('choice'), value: z.string().min(1) }),
      z.object({ type: z.literal('score'), value: z.number().min(0) }),
      z.object({ type: z.literal('noul'), value: z.number().min(0).max(1) }),
    ]),
  ),
});
export type DecideOutput = z.infer<typeof DecideOutput>;

/** Spec (orchestrator) §4.5: SM answers a Dev's spec-gap; the assumption is the one-line log entry. */
export const SpecGapOutput = z.object({ specHash, answer: z.string().min(1), assumption: z.string().min(1) });
export type SpecGapOutput = z.infer<typeof SpecGapOutput>;

/** Spec (orchestrator) §4.6: SM splits or changes a task that spent its attempts. */
export const ReplanOutput = z.object({ specHash, replacements: z.array(PlanTask).min(1).max(3) });
export type ReplanOutput = z.infer<typeof ReplanOutput>;

/** Spec (phases 4-6) §3: SM plans one round of fix tasks from failed tests and uncovered criteria. */
export const FixTasksOutput = z.object({ specHash, tasks: z.array(PlanTask).min(1).max(3) });
export type FixTasksOutput = z.infer<typeof FixTasksOutput>;

/** Roadmap R11.12: PO proposes a readable English id for a new project or spec (and the project's first spec). */
const nameId = z.string().regex(ID_PATTERNS.SLUG).max(40);
export const NameOutput = z.object({ specHash, id: nameId, firstSpecId: nameId.optional() });
export type NameOutput = z.infer<typeof NameOutput>;

/** Refinement "Sugerir": one document written in full from flow.md; the human reviews it in the editor before saving. */
export const SuggestOutput = z.object({ specHash, text: z.string().min(1) });
export type SuggestOutput = z.infer<typeof SuggestOutput>;

export const OUTPUT_SCHEMAS: Record<StepKind, z.ZodType<{ specHash: string }>> = {
  refine: RefineOutput,
  derive: DeriveOutput,
  'tech-spec': TechSpecOutput,
  coverage: CoverageOutput,
  plan: PlanOutput,
  'services-plan': ServicesPlanOutput,
  dev: DevOutput,
  review: ReviewOutput,
  security: SecurityOutput,
  deployment: DeploymentOutput,
  report: ReportOutput,
  readme: ReadmeOutput,
  decide: DecideOutput,
  'spec-gap': SpecGapOutput,
  replan: ReplanOutput,
  'fix-tasks': FixTasksOutput,
  backlog: BacklogOutput,
  spec: SpecDetailOutput,
  preplan: PreplanOutput,
  name: NameOutput,
  suggest: SuggestOutput,
};

export type OutputOf<K extends StepKind> = z.infer<(typeof OUTPUT_SCHEMAS)[K]>;

/** Draft-07 JSON Schema for `claude --json-schema`, generated from the same zod contract the validator uses. */
export function toJsonSchema(kind: StepKind): object {
  return z.toJSONSchema(OUTPUT_SCHEMAS[kind], { target: 'draft-07', io: 'input', reused: 'inline' });
}
