import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SpeckitOutput } from '../agents/outputs.js';
import { sha256 } from '../contracts/hash.js';
import { OwnerError } from '../core/owner-error.js';
import { absoluteRule } from '../runner/role-settings.js';
import type { StepOutcome } from '../runner/step.js';
import { TRY_AGAIN } from './agent-failure.js';
import type { CycleJournal, RunAgent } from './cycle.js';
import { decisionsOf } from './decisions.js';
import type { Draft } from './draft.js';
import { RefineEvent } from './events.js';
import { criteriaOf, PREPARATION_STAGE, planInputDir, planInputsHash, planInputTexts, planStagingDir, PreparationFailed, type PlanInput, writePlanInputs } from './plan-inputs.js';
import { planItems, type PlanItem, type PlanSource } from './plan-items.js';
import { planFileOf, specSectionOf } from './plan-file.js';
import { planShapeIssues } from './plan-shape.js';
import { type PlanStepResult, runPlanStep } from './plan-step.js';
import { repositoryContextOf } from './architecture-step.js';
import { taskShapeIssues } from './task-shape.js';
import { taskPack } from './superpowers-pack.js';
import { taskFileOf } from './plan-file.js';
import type { SpeckitStepFailure } from './state.js';
import { planPack } from './superpowers-pack.js';

/** The model and effort of the plan step: the setting the pilot measured for it (plan 107). The role's pin, which sets the builders, does not apply to it. */
export const PLAN_STEP = { model: 'claude-sonnet-5-5', effort: 'low' } as const;

export interface PlanDeps {
  draft: Draft;
  journal: Pick<CycleJournal, 'allocStepSeq' | 'fact' | 'state'>;
  runAgent: RunAgent;
  signal?: AbortSignal;
  /** How many plans are written at once; one when absent. */
  agents?: number;
  /** The part of the document graph in `outDir` that answers a question, for the packs; empty when the graph has nothing. */
  docGraphContext?: (outDir: string, question: string, budgetTokens: number) => Promise<string>;
}

/** What the plan and task packs ask the graph for: the spec's own part of the system. */
const PLAN_GRAPH_QUESTION = 'the repositories, modules and integrations that the spec changes';
const PLAN_GRAPH_TOKENS = 3_000;

interface Run {
  deps: PlanDeps;
  source: PlanSource;
  texts: Record<PlanInput, string>;
  staging: string;
  /** The graph context the packs carry; empty when the graph has nothing about the spec. */
  graph: string;
  /** The steps the earlier preparation finished, read before this one clears them. */
  earlier: ReadonlyArray<{ command: string; itemKey?: string; basis?: string }>;
}

/** What a plan reads: its own section of specs.md and the five documents, so an edit re-runs only the plans it changes. */
export const planBasis = (texts: Record<PlanInput, string>, key: string): string =>
  sha256([specSectionOf(texts['specs.md'], key), texts['project.md'], texts['flow.md'], texts['briefing.md'], texts['stack.md'], texts['design.md']].join('\n'));

const criteriaIds = (source: PlanSource, key: string): string[] => criteriaOf(source, key).map((criterion) => criterion.id);

const interrupted = (): OwnerError => new OwnerError(`${PREPARATION_STAGE} foi interrompida.`, 'aborted');

/** The implementation plan of a spec of a draft, when its preparation wrote one: its path in the repository, else undefined. */
export async function planFileFor(draftRoot: string, specId: string): Promise<string | undefined> {
  const file = planFileOf(specId);
  return fs.access(path.join(draftRoot, file)).then(() => file, () => undefined);
}

/** The task list of a spec of a draft, when its preparation wrote one: its path in the repository, else undefined. */
export async function taskFileFor(draftRoot: string, specId: string): Promise<string | undefined> {
  const file = taskFileOf(specId);
  return fs.access(path.join(draftRoot, file)).then(() => file, () => undefined);
}

/** Copies a valid plan from the staging folder into the draft's docs, where the docs publish reads it. */
async function publish(draft: Draft, staging: string, file: string): Promise<void> {
  const target = path.join(draft.docs, path.posix.relative('docs', file));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(staging, file), target);
}

/** What a task list reads: its plan, so a change to the plan re-writes the tasks it has. */
const taskBasis = (texts: Record<PlanInput, string>, key: string, plan: string): string => sha256(`${planBasis(texts, key)}\n${plan}`);

/** Drops the plans of specs no longer in the backlog, so no later step or publish reads them. */
async function pruneSpecs(staging: string, items: readonly PlanItem[]): Promise<void> {
  const current = new Set(items.map((item) => item.specId));
  const dir = path.join(staging, 'docs', 'specs');
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => !current.has(name)).map((name) => fs.rm(path.join(dir, name), { recursive: true, force: true })));
}

/** A plan an earlier preparation wrote is kept while its basis is unchanged and its file still passes the shape check. */
async function reusable(run: Run, item: PlanItem): Promise<boolean> {
  const earlier = run.earlier.find((step) => step.command === 'plan' && step.itemKey === item.key);
  if (earlier?.basis !== planBasis(run.texts, item.key)) return false;
  const text = await fs.readFile(path.join(run.staging, planFileOf(item.specId)), 'utf8').catch(() => null);
  return text !== null && planShapeIssues(text, criteriaIds(run.source, item.key), item.repository).length === 0;
}

/** Why a plan that did not come out valid stopped its item, in plain words for the owner. */
function failureOf(command: 'plan' | 'tasks', item: PlanItem, result: PlanStepResult): SpeckitStepFailure {
  const detail = result.issues.join('; ').slice(0, 1000);
  const what = command === 'plan' ? `o plano de ${item.key}` : `as tarefas de ${item.key}`;
  const What = what.charAt(0).toUpperCase() + what.slice(1);
  if (result.status === 'blocked') return { command, itemKey: item.key, kind: 'blocked', reason: `${What} não ${command === 'plan' ? 'foi escrito' : 'foram escritas'}: ${result.issues[0]}. ${TRY_AGAIN}`, detail };
  if (result.repairs === 0) return { command, itemKey: item.key, kind: 'agent', reason: `O agente não conseguiu escrever ${what}. ${TRY_AGAIN}`, detail };
  return { command, itemKey: item.key, kind: 'plan-shape', reason: `${What} não passou na checagem de forma. ${TRY_AGAIN}`, detail };
}

/** A task list an earlier preparation wrote is kept while its basis (the plan included) is unchanged and its file still passes the check. */
async function reusableTasks(run: Run, item: PlanItem, plan: string): Promise<boolean> {
  const earlier = run.earlier.find((step) => step.command === 'tasks' && step.itemKey === item.key);
  if (earlier?.basis !== taskBasis(run.texts, item.key, plan)) return false;
  const text = await fs.readFile(path.join(run.staging, taskFileOf(item.specId)), 'utf8').catch(() => null);
  return text !== null && taskShapeIssues(text, plan, criteriaIds(run.source, item.key), item.repository).length === 0;
}

/** The task list of one item of a stamped draft: written from its valid plan, checked, and published into the draft's docs. */
async function writeTasks(run: Run, item: PlanItem, plan: string): Promise<SpeckitStepFailure | undefined> {
  const { deps, source, texts, staging } = run;
  const basis = taskBasis(texts, item.key, plan);
  const criteria = criteriaIds(source, item.key);
  const specHash = sha256(`tasks\n${item.specId}\n${basis}`);
  const step = { command: 'tasks', itemKey: item.key };
  await deps.journal.fact(RefineEvent.SpeckitStepStarted, step);
  const repository = repositoryContextOf(source, item.repository);
  const result = await runPlanStep({
    staging,
    specId: item.specId,
    criteria,
    file: taskFileOf(item.specId),
    check: (text) => taskShapeIssues(text, plan, criteria, item.repository),
    pack: (repair) => taskPack({ specHash, inputDir: planInputDir(deps.draft), specId: item.specId, key: item.key, title: item.title, criteria, repository, repair, graphContext: run.graph }),
    run: async (pack) =>
      (await deps.runAgent<'speckit'>(
        { kind: 'speckit', role: 'test', pack, cwd: staging, phase: 'refine', taskId: null, attempt: 1, model: PLAN_STEP.model, effort: PLAN_STEP.effort, extraAllow: [`Read(${absoluteRule(planInputDir(deps.draft))}/**)`] },
        { journal: deps.journal, stepDir: deps.draft.steps, specHash, signal: deps.signal },
      )) as StepOutcome<SpeckitOutput>,
  });
  const file = taskFileOf(item.specId);
  if (result.status === 'valid') {
    await publish(deps.draft, staging, file);
    if (result.repairs > 0) await deps.journal.fact(RefineEvent.SpeckitStepRepaired, { ...step, file, repair: result.repairs });
    await deps.journal.fact(RefineEvent.SpeckitStepDone, { ...step, files: [file], basis });
    return undefined;
  }
  await deps.journal.fact(RefineEvent.SpeckitStepDone, { ...step, files: [], blocked: true });
  return failureOf('tasks', item, result);
}

/** One item's steps: its plan unless an earlier run kept it, then, in a stamped draft, its task list unless that was kept too. */
async function writeItem(run: Run, item: PlanItem, planKept: boolean): Promise<SpeckitStepFailure | undefined> {
  if (!planKept) {
    const failure = await writePlan(run, item);
    if (failure) return failure;
  }
  if (run.source.repositories !== true) return undefined;
  const plan = await fs.readFile(path.join(run.staging, planFileOf(item.specId)), 'utf8');
  if (await reusableTasks(run, item, plan)) {
    // A kept task list is journaled as done again: the new run starts with no steps, and the closing check reads them.
    await run.deps.journal.fact(RefineEvent.SpeckitStepDone, { command: 'tasks', itemKey: item.key, files: [], basis: taskBasis(run.texts, item.key, plan) });
    return undefined;
  }
  return writeTasks(run, item, plan);
}

/** One plan: the step runs with its own setting, its file is checked, and a valid one is copied into the draft's docs. */
async function writePlan(run: Run, item: PlanItem): Promise<SpeckitStepFailure | undefined> {
  const { deps, source, texts, staging } = run;
  const basis = planBasis(texts, item.key);
  const criteria = criteriaIds(source, item.key);
  const specHash = sha256(`plan\n${item.specId}\n${basis}`);
  const step = { command: 'plan', itemKey: item.key };
  await deps.journal.fact(RefineEvent.SpeckitStepStarted, step);
  const single = !deps.journal.state.backlog?.enabled;
  const decisions = decisionsOf(deps.journal.state.questions.filter((q) => single || (q.origin === 'speckit' && q.answeredBy)));
  const history = deps.journal.state.questions.filter((q) => q.itemKey === item.key);
  const result = await runPlanStep({
    staging,
    specId: item.specId,
    criteria,
    file: planFileOf(item.specId),
    check: (text) => planShapeIssues(text, criteria, item.repository),
    pack: (repair) => planPack({ specHash, inputDir: planInputDir(deps.draft), specId: item.specId, key: item.key, title: item.title, criteria, decisions, history, repair, repository: repositoryContextOf(source, item.repository), graphContext: run.graph }),
    run: async (pack) =>
      (await deps.runAgent<'speckit'>(
        { kind: 'speckit', role: 'dev', pack, cwd: staging, phase: 'refine', taskId: null, attempt: 1, model: PLAN_STEP.model, effort: PLAN_STEP.effort, extraAllow: [`Read(${absoluteRule(planInputDir(deps.draft))}/**)`] },
        { journal: deps.journal, stepDir: deps.draft.steps, specHash, signal: deps.signal },
      )) as StepOutcome<SpeckitOutput>,
  });
  const file = planFileOf(item.specId);
  if (result.status === 'valid') {
    await publish(deps.draft, staging, planFileOf(item.specId));
    if (result.repairs > 0) await deps.journal.fact(RefineEvent.SpeckitStepRepaired, { ...step, file, repair: result.repairs });
    await deps.journal.fact(RefineEvent.SpeckitStepDone, { ...step, files: [file], basis });
    return undefined;
  }
  await deps.journal.fact(RefineEvent.SpeckitStepDone, { ...step, files: [], blocked: true });
  return failureOf('plan', item, result);
}

/**
 * The implementation plan of every item of the detailed backlog, or of the single spec, with the hash of the inputs they read (plan 107).
 * A plan an earlier preparation wrote is kept while its basis and its file hold; the others are written, a few at once, and a plan that
 * fails stops only its own item. The preparation ends with every failure listed, or with no failure at all.
 */
export async function preparePlans(deps: PlanDeps, source: PlanSource): Promise<string> {
  const texts = await planInputTexts(deps.draft, source);
  const hash = planInputsHash(texts);
  const items = planItems(deps.draft.specId, source);
  const staging = planStagingDir(deps.draft);
  const graph = deps.docGraphContext ? await deps.docGraphContext(path.posix.join(deps.draft.root, 'doc-graph'), PLAN_GRAPH_QUESTION, PLAN_GRAPH_TOKENS) : '';
  const run: Run = { deps, source, texts, staging, earlier: deps.journal.state.speckit?.steps ?? [], graph };
  await writePlanInputs(deps.draft, texts);
  await fs.mkdir(staging, { recursive: true });
  await pruneSpecs(staging, items);
  const kept = new Set<string>();
  for (const item of items) if (await reusable(run, item)) kept.add(item.key);
  // A stamped draft runs two steps per item: the plan, then its task list.
  await deps.journal.fact(RefineEvent.SpeckitStarted, { total: items.length * (source.repositories === true ? 2 : 1), inputHash: hash });
  if (kept.size > 0) await deps.journal.fact(RefineEvent.SpeckitReused, { steps: items.filter((item) => kept.has(item.key)).map((item) => ({ command: 'plan', itemKey: item.key, basis: planBasis(texts, item.key) })) });
  const failures: SpeckitStepFailure[] = [];
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      if (deps.signal?.aborted) return;
      const failure = await writeItem(run, item, kept.has(item.key));
      if (failure) failures.push(failure);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.agents ?? 1, queue.length)) }, worker));
  if (deps.signal?.aborted) throw interrupted();
  if (failures.length > 0) throw new PreparationFailed(failures);
  return hash;
}
