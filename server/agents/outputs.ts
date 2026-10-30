import { z } from 'zod';
import { HASH_PATTERN } from '../contracts/hash.js';
import { ADR_ID, Plan, PlanTask, ServicesPlan } from '../contracts/plan.js';
import { Backlog, BACKLOG_DOCS } from '../contracts/backlog.js';
import { Preplan } from '../contracts/preplan.js';
import { AC_ID, AcceptanceCriterion, BugDetails, ExternalDependency, SpecType } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';
import { Project, ServiceName } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';

export const STEP_KINDS = ['refine', 'derive', 'tech-spec', 'coverage', 'plan', 'services-plan', 'dev', 'review', 'security', 'ui-check', 'deployment', 'environment', 'report', 'gaps', 'readme', 'decide', 'spec-gap', 'replan', 'fix-tasks', 'backlog', 'spec', 'preplan', 'conflicts', 'name', 'suggest', 'answer', 'chat', 'skill-select', 'speckit', 'converge', 'block-options'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const specHash = z.string().regex(HASH_PATTERN);
const acId = z.string().regex(AC_ID);
const taskId = z.string().regex(ID_PATTERNS.TASK_ID);
const skillId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

export const SkillRequest = z.object({ capability: z.string().min(3).max(200), reason: z.string().min(3).max(500) });
export const SkillDraft = z.object({ id: skillId, whenToUse: z.string().min(3).max(500), rules: z.array(z.string().min(1)).min(1).max(30) });
const skillFields = { skillRequest: SkillRequest.optional(), skillDraft: SkillDraft.optional() };

export const DocPatch = z.object({
  file: z.string().min(1),
  find: z.string(),
  replace: z.string(),
  reason: z.string().min(1),
});

/** A contradiction the PO found: two quotes from two documents that disagree on one fact. The orchestrator checks the quotes. */
export const Contradiction = z.object({
  fact: z.string().min(1),
  a: z.object({ file: z.string().min(1), quote: z.string().min(1) }),
  b: z.object({ file: z.string().min(1), quote: z.string().min(1) }),
  fix: z.string(),
});
export type Contradiction = z.infer<typeof Contradiction>;

/** A finding on one shared doc, reported by any role: the orchestrator routes it to the doc's owner. */
export const DocFinding = z.object({
  doc: z.enum(['project.md', 'briefing.md', 'stack.md', 'flow.md', 'design.md']),
  severity: z.enum(['blocking', 'advice']),
  quote: z.string().min(1),
  text: z.string().min(1),
  fix: z.string(),
});
export type DocFinding = z.infer<typeof DocFinding>;

/** Content in the wrong document: the whole lines `quote` cut from `from`, and `text` written into `to` below the line `after` (or at the end). The orchestrator checks it and applies it at once. */
export const DocMove = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  quote: z.string().min(1),
  text: z.string().min(1),
  after: z.string().optional().catch(undefined),
  reason: z.string().min(1),
});
export type DocMoveProposal = z.infer<typeof DocMove>;

/** Keeps the valid items of a list: a malformed one is dropped on its own, so it never fails the whole output. */
const keepValid = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => item.safeParse(x).success) : []), z.array(item));

/** A choice the owner can pick as the answer; `recommended` marks the one the agent suggests. A bad choice is dropped alone. */
const QuestionChoice = z.object({ label: z.string().min(1), detail: z.string().min(1), recommended: z.boolean().optional().catch(undefined) });

export const RefineOutput = z.object({
  specHash,
  checklist: z.array(z.object({ id: z.string().min(1), passed: z.boolean(), detail: z.string() })),
  questions: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      blocking: z.boolean(),
      relatedAcIds: z.array(acId).default([]),
      // The choices the owner picks from; an open question has none.
      options: keepValid(QuestionChoice),
      // A bad subject is dropped alone; the question still reaches the owner.
      subject: z.string().optional().catch(undefined),
      // The decided questions this one repeats, each with the real difference the agent names; a bad entry is dropped alone.
      distinctFrom: keepValid(z.object({ questionId: z.string().min(1), difference: z.string().min(1) })).nullish(),
    }),
  ),
  docPatch: keepValid(DocPatch),
  contradictions: keepValid(Contradiction).optional(),
  findings: keepValid(DocFinding).optional(),
  moves: keepValid(DocMove).optional(),
});

/** Spec (refinement) §3.2 step 1: Markdown → project.json + spec.json; the orchestrator re-validates and forces status/hash/version. */
// The orchestrator owns the decisions (R11.7.1): one the agent echoes, even malformed, is dropped instead of failing the cycle.
// The criterion ids are checked by postProcessDerived, which renumbers a malformed one; this step check keeps any string id.
const DeriveSpec = z.object({ acceptanceCriteria: z.array(AcceptanceCriterion.extend({ id: z.string() })) }).passthrough();
export const DeriveOutput = z.object({ specHash, project: Project, spec: z.preprocess((s) => (s !== null && typeof s === 'object' ? { ...s, decisions: undefined } : s), DeriveSpec) });
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
/** The SM's conflict map: pairs of backlog items that change the same code, so they never run at the same time. */
export const ConflictsOutput = z.object({ specHash, pairs: z.array(z.object({ a: z.string().regex(ID_PATTERNS.SLUG), b: z.string().regex(ID_PATTERNS.SLUG), reason: z.string().min(1) })).max(200) });
export type ConflictsOutput = z.infer<typeof ConflictsOutput>;

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
  ...skillFields,
};

/** A discriminated union so the generated JSON Schema tells the model which fields each status requires. */
export const DevOutput = z.discriminatedUnion('status', [
  /** Deleted paths the Dev's own sandbox has no tool to remove (Bash's rm/git rm are denied); the orchestrator deletes them before committing. */
  /** `filesRead`: the source files the rules told the builder to read; the orchestrator checks it against the worktree. */
  /** `deviations`: each departure from the task or from the implementation plan of its spec, one sentence each; empty when the builder followed both. */
  z.object({ ...devCommon, status: z.literal('done'), commitMessage: z.string().min(1), deletedFiles: z.array(z.string().min(1)).optional(), filesRead: z.array(z.string().min(1)).default([]), deviations: z.array(z.string().min(1)).default([]) }),
  z.object({ ...devCommon, status: z.literal('spec-gap'), question: z.string().min(1) }),
  /** The task cannot proceed for a reason outside its paths (deploy environment, missing access): no SM round, no attempt consumed. */
  z.object({ ...devCommon, status: z.literal('blocked'), reason: z.string().min(1) }),
]);

export const ReviewOutput = z.object({
  specHash,
  ...skillFields,
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
      /** `plan`: the change contradicts the implementation plan of its spec, not only the code. */
      category: z.enum(['code', 'plan']).default('code'),
    }),
  ),
});

export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** Security review of one task diff. The severities decide: critical/high findings block the merge, medium/low are recorded only. */
export const SecurityOutput = z.object({
  specHash,
  ...skillFields,
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

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const envBase = { name: envName, scope: z.enum(['compose', 'suites', 'both']), reason: z.string().min(1) };
/** How the platform makes one variable exist for a local test: the agent names the recipe, the orchestrator creates the value (an agent never sees a secret). */
export const EnvironmentVariable = z.discriminatedUnion('strategy', [
  /** An internal credential: random, kept once per project so every service of the project reads the same value. */
  z.object({ ...envBase, strategy: z.literal('random'), format: z.enum(['hex', 'base64url', 'alnum']).optional(), minLength: z.number().int().min(16).max(128).optional() }),
  /** A third party's key in a local test: a made-up value shaped like the real one (prefix and length), the code under test talks to a double. */
  z.object({ ...envBase, strategy: z.literal('fake'), prefix: z.string().max(24).regex(/^[A-Za-z0-9_.-]*$/).optional(), minLength: z.number().int().min(16).max(128).optional() }),
  /** The value a service that is already deployed runs with (an admin token that one service accepts and another sends). */
  z.object({ ...envBase, strategy: z.literal('from-service'), service: z.string().min(1), variable: envName }),
  /** A value got by calling a deployed service after the deploy (a session header minted with the admin token). `${NAME}` in headers and body is another variable. */
  z.object({
    ...envBase,
    strategy: z.literal('mint'),
    service: z.string().min(1),
    request: z.object({ method: z.enum(['GET', 'POST', 'PUT']), path: z.string().startsWith('/'), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional() }),
    extract: z.object({ from: z.enum(['json', 'header']), path: z.string().min(1) }),
    /** The value's shape around the extracted text, `{value}` marking it: `Bearer {value}`. */
    template: z.string().optional(),
  }),
]);
export type EnvironmentVariable = z.infer<typeof EnvironmentVariable>;

/** `environment`: what a local deploy and its smoke and e2e suites need that does not exist yet, as a recipe per variable. */
export const EnvironmentOutput = z.object({ specHash, variables: z.array(EnvironmentVariable), notes: z.string() });
export type EnvironmentAnswer = z.infer<typeof EnvironmentOutput>;

/** A change to one of the shared docs on main: `find` is a verbatim excerpt that occurs exactly once (empty appends); cheaper than returning the whole file. */
export const DocsPatch = z.object({ file: z.enum(['docs/README.md', 'docs/RUNBOOK.md', 'docs/API.md']), find: z.string(), replace: z.string() });

/** The three docs the orchestrator commits: each as a whole file, or as `docPatches` over the current file on main. */
const docsFields = {
  /** Markdown for docs/README.md: a project overview the orchestrator commits with the report; omitted when `docPatches` change the current one. */
  readme: z.string().optional(),
  /** Markdown for docs/RUNBOOK.md (start, stop, logs, rollback); validated by the docs gate. */
  runbook: z.string().optional(),
  /** Markdown for docs/API.md listing every endpoint the spec features name. */
  apiDocs: z.string().optional(),
  docPatches: z.array(DocsPatch).optional(),
};

/** `spec readme`: the SM alone writes docs/README.md for a spec that already has code on main. */
export const ReadmeOutput = z.object({ specHash, ...docsFields });

export const ReportOutput = z.object({
  specHash,
  delivered: z.array(taskId),
  blocked: z.array(z.object({ taskId, reason: z.string().min(1) })),
  assumptions: z.array(z.string()),
  exploratoryScript: z.array(z.object({ acId, steps: z.array(z.string().min(1)).min(1) })),
  summary: z.string().min(1),
  ...docsFields,
});

/** One cited doc section, judged against the code on main: `acIds` are the criteria that cover it. */
export const GapsOutput = z.object({
  specHash,
  items: z.array(
    z.object({
      doc: z.enum(BACKLOG_DOCS),
      heading: z.string().min(1),
      status: z.enum(['delivered', 'partial', 'missing']),
      evidence: z.array(z.string().min(1)),
      missing: z.string(),
      acIds: z.array(acId),
    }),
  ),
});
export type GapsOutput = z.infer<typeof GapsOutput>;

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

/** Spec (orchestrator) §4.5: SM answers a Dev's spec-gap; the assumption is the one-line log entry. A gateFix corrects a blocking gate command the plan has wrong. */
export const SpecGapOutput = z.object({
  specHash,
  answer: z.string().min(1),
  assumption: z.string().min(1),
  gateFix: z.object({ gate: z.string().regex(ID_PATTERNS.SLUG), command: z.string().min(1) }).optional(),
});
export type SpecGapOutput = z.infer<typeof SpecGapOutput>;

/** A block the agents do not decide: the SM's question for the owner and the choices the repository can carry out. */
export const BlockOptionsOutput = z.object({ specHash, question: z.string().min(1), options: z.array(QuestionChoice).min(2).max(4) });
export type BlockOptionsOutput = z.infer<typeof BlockOptionsOutput>;

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

/** R11.5.7: the owner role's answer to a refinement question from the docs, or null when they do not settle it. */
export const AnswerOutput = z.object({ specHash, answer: z.string().min(1).nullable() });
export type AnswerOutput = z.infer<typeof AnswerOutput>;

/** A point plan left open for the owner, as the [NEEDS CLARIFICATION] markers and clarify questions; a bad one fails the step, so a blocking one is never lost. */
const SpeckitQuestion = z.object({ text: z.string().min(1), blocking: z.boolean(), itemKey: z.string().nullish(), options: keepValid(QuestionChoice.extend({ detail: z.string().default('') })).optional(), distinctFrom: z.array(z.object({ questionId: z.string().min(1), difference: z.string().min(1) })).max(3).nullish() });
const speckitCommon = { specHash, summary: z.string().min(1), files: z.array(z.string().min(1)), questions: z.array(SpeckitQuestion).default([]) };

/** One plan command run in the staging folder: the files it wrote and the questions it left open, or why it could not finish. */
export const SpeckitOutput = z.discriminatedUnion('status', [
  z.object({ ...speckitCommon, status: z.literal('done') }),
  z.object({ ...speckitCommon, status: z.literal('blocked'), reason: z.string().min(1) }),
]);
export type SpeckitOutput = z.infer<typeof SpeckitOutput>;

/** The review of the merged code against the implementation plan: `gaps` lists what the code does not meet yet, one sentence each. */
export const ConvergeOutput = z.discriminatedUnion('status', [
  z.object({ specHash, status: z.literal('converged'), summary: z.string().min(1) }),
  z.object({ specHash, status: z.literal('gaps'), gaps: z.array(z.string().min(1)).min(1).max(30), summary: z.string().min(1) }),
]);
export type ConvergeOutput = z.infer<typeof ConvergeOutput>;

export const SkillSelectionOutput = z.discriminatedUnion('action', [
  z.object({ specHash, action: z.literal('reuse'), skill: z.object({ id: skillId, repository: z.string().url(), commit: z.string().regex(/^[a-f0-9]{40}$/), license: z.string().min(1), sourcePath: z.string().optional() }), reason: z.string().min(1) }),
  z.object({ specHash, action: z.literal('create'), draft: SkillDraft, reason: z.string().min(1) }),
  z.object({ specHash, action: z.literal('reject'), reason: z.string().min(1) }),
]);
export type SkillSelectionOutput = z.infer<typeof SkillSelectionOutput>;

/** Chat screen: a plain answer, plus a correction when what is being built goes against its spec. */
export const ChatOutput = z.object({
  specHash,
  answer: z.string().min(1),
  correction: z.object({ title: z.string().min(1).max(120), whatHappens: z.string().min(1), whatShouldHappen: z.string().min(1) }).nullable(),
});
export type ChatOutput = z.infer<typeof ChatOutput>;

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
  'ui-check': ReviewOutput,
  deployment: DeploymentOutput,
  environment: EnvironmentOutput,
  report: ReportOutput,
  gaps: GapsOutput,
  readme: ReadmeOutput,
  decide: DecideOutput,
  'spec-gap': SpecGapOutput,
  'block-options': BlockOptionsOutput,
  replan: ReplanOutput,
  'fix-tasks': FixTasksOutput,
  backlog: BacklogOutput,
  spec: SpecDetailOutput,
  preplan: PreplanOutput,
  conflicts: ConflictsOutput,
  name: NameOutput,
  suggest: SuggestOutput,
  answer: AnswerOutput,
  chat: ChatOutput,
  'skill-select': SkillSelectionOutput,
  speckit: SpeckitOutput,
  converge: ConvergeOutput,
};

export type OutputOf<K extends StepKind> = z.infer<(typeof OUTPUT_SCHEMAS)[K]>;

/** Draft-07 JSON Schema for `claude --json-schema`, generated from the same zod contract the validator uses. */
export function toJsonSchema(kind: StepKind): object {
  return z.toJSONSchema(OUTPUT_SCHEMAS[kind], { target: 'draft-07', io: 'input', reused: 'inline' });
}
