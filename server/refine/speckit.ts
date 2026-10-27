import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SpeckitOutput } from '../agents/outputs.js';
import { sha256 } from '../contracts/hash.js';
import { OwnerError } from '../core/owner-error.js';
import type { Decider } from '../decide/decider.js';
import { duplicatePairs } from '../decide/decisions/gate1.js';
import type { Exec } from '../exec/command.js';
import { absoluteRule } from '../runner/role-settings.js';
import type { StepOutcome } from '../runner/step.js';
import { ownerFailure, retryOnSchema, TRY_AGAIN, withNote } from './agent-failure.js';
import { isConfidential, MAX_DEDUP_PAIRS, recorded, type CycleJournal, type RunAgent } from './cycle.js';
import { CONSTITUTION, readDoc, speckitBaseDir, type Draft } from './draft.js';
import { RefineEvent } from './events.js';
import { fitPackBudget } from './fit-pack.js';
import { SPECKIT_INPUTS, speckitFeatureDir, speckitPack, type SpeckitCommand, type SpeckitInput, type SpeckitItem } from './speckit-pack.js';
import { itemSteps, speckitItems, speckitSteps, stepKey, type Step } from './speckit-steps.js';
import { renderSpecMd } from './spec-md.js';
import { renderSpecsMd } from './specs-md.js';
import { loadEvents } from '../store/event-store.js';
import { reduceRefineEvents, type QuestionRow, type RefineState } from './state.js';
import type { Question } from './events.js';
import { decisionsOf } from './decisions.js';
import { answererOf, makeAnswerer, type Answerer } from './speckit-answers.js';
import { stepBasis } from './speckit-basis.js';

export const SPECKIT_NOT_INSTALLED = 'O Spec Kit não está instalado neste ambiente.';
export const SPECKIT_STAGE = 'A preparação do Spec Kit';
/** Spec Kit v1.2.3: scaffolds .specify/ and the Claude skills offline, with the bash scripts, and never prompts. */
const INIT_ARGS = ['init', '--here', '--force', '--non-interactive', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools'];
const INIT_TIMEOUT_MS = 120_000;
/** What the Spec Kit skills run: their bash scripts, and a copy of a template. */
const SPECKIT_BASH = ['Bash(bash:*)', 'Bash(.specify/scripts/bash/*:*)', 'Bash(cp:*)'];

/** The staging folder Spec Kit works in; Phase 0 publishes it to the repository. */
export const speckitDir = (draft: Pick<Draft, 'root'>): string => path.posix.join(draft.root, 'speckit');
/** Where the Markdown inputs go: beside the staging folder, so they are never published. */
export const speckitInputDir = (draft: Pick<Draft, 'root'>): string => path.posix.join(draft.root, 'speckit-input');

export interface SpeckitDeps {
  draft: Draft;
  journal: Pick<CycleJournal, 'allocStepSeq' | 'fact' | 'state'>;
  runAgent: RunAgent;
  exec: Exec;
  decider?: Pick<Decider, 'decide'>;
  signal?: AbortSignal;
  /** How many backlog items prepare at once; one when absent. */
  agents?: number;
  /** The owner's setting: a question the documents leave open may get one web search suggestion, never for a confidential project. */
  research?: boolean;
}

/** Whether a file or folder exists. */
const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

/** How many rounds a step runs when the answers to its questions come in: a round that gets answers runs again with them. */
const MAX_STEP_ROUNDS = 3;

/** The part of the session a preparation reads: the detailed backlog, or the single spec it derived. */
export type SpeckitSource = Pick<RefineState, 'backlog' | 'derived' | 'featureKey'>;

/** The Spec Kit feature folder of one spec of a draft, when its preparation made one; read by a run of that spec. */
export async function speckitFeatureOf(draftRoot: string, specId: string): Promise<string | undefined> {
  const events = await loadEvents(path.join(draftRoot, 'events.ndjson')).catch(() => []);
  const state = reduceRefineEvents(events);
  const key = speckitItems(path.basename(draftRoot), state).find((i) => i.specId === specId)?.key;
  return key ? state.speckit?.features?.[key] : undefined;
}

/** The answerer of a preparation: the six inputs as read now, the item titles, and the staging folder the answering agent may not read. */
function answererFor(deps: Pick<SpeckitDeps, 'draft' | 'journal' | 'runAgent' | 'signal'>, texts: Record<SpeckitInput, string>, items: readonly SpeckitItem[], research: boolean): Answerer {
  const titles = new Map(items.map((i): [string, string] => [i.key, i.title]));
  return makeAnswerer({ draft: deps.draft, journal: deps.journal, runAgent: deps.runAgent, texts, hash: hashOf(texts), titles, stagingDir: speckitDir(deps.draft), signal: deps.signal, research });
}

/** The Spec Kit questions nobody has read yet: pending, and without the card the PO or the SM writes. */
const untriaged = (questions: readonly QuestionRow[]): QuestionRow[] => questions.filter((q) => q.origin === 'speckit' && q.status === 'pending' && q.context === undefined);

/** "Pedir ao PO e ao SM": the PO and the SM read the questions nobody has read yet; returns how many they answered. */
export async function answerUntriaged(deps: Pick<SpeckitDeps, 'draft' | 'journal' | 'runAgent' | 'signal' | 'research'>, source: SpeckitSource): Promise<number> {
  const texts = await inputTexts(deps.draft, source);
  const research = await researchAllowed(deps);
  return answererFor(deps, texts, speckitItems(deps.draft.specId, source), research).triage(untriaged(deps.journal.state.questions));
}

/** The pending questions that have a card but no choices; their answers are never applied when choices are asked for. */
const withoutOptions = (questions: readonly QuestionRow[]): QuestionRow[] => questions.filter((q) => q.origin === 'speckit' && q.status === 'pending' && q.context !== undefined && (q.options ?? []).length === 0);

/** "Gerar opções": the PO and the SM give choices to the open questions that have none; returns how many got choices. */
export async function optionsForOpen(deps: Pick<SpeckitDeps, 'draft' | 'journal' | 'runAgent' | 'signal'>, source: SpeckitSource): Promise<number> {
  const texts = await inputTexts(deps.draft, source);
  return answererFor(deps, texts, speckitItems(deps.draft.specId, source), false).options(withoutOptions(deps.journal.state.questions));
}

/** The web search is allowed only when the owner turned it on and the project is not confidential. */
const researchAllowed = async (deps: Pick<SpeckitDeps, 'draft' | 'journal' | 'research'>): Promise<boolean> => deps.research === true && !(await isConfidential(deps.draft, deps.journal.state));

/** specs.md: the backlog's items, or the single spec as the section of its one item, with the spec's own headings one level down. */
function specsMdOf(draftId: string, source: SpeckitSource): string {
  if (source.backlog?.enabled) return renderSpecsMd(draftId, source.backlog);
  const [item] = speckitItems(draftId, source);
  const body = renderSpecMd(source.derived!.spec).split('\n').slice(1).map((line) => (line.startsWith('#') ? `#${line}` : line));
  return ['# Specs', '', `## ${item!.key}: ${item!.title}`, ...body].join('\n');
}

/** The acceptance criteria an item's files keep: its backlog spec's, or the single spec's. */
const criteriaOf = (source: SpeckitSource, key: string) => (source.backlog?.enabled ? source.backlog.specs?.[key]?.spec : source.derived?.spec)?.acceptanceCriteria ?? [];

/** The text of the six Markdown inputs, as Spec Kit reads them. */
async function inputTexts(draft: Draft, source: SpeckitSource): Promise<Record<SpeckitInput, string>> {
  return {
    'project.md': await readDoc(draft, 'project.md'),
    'flow.md': await readDoc(draft, 'flow.md'),
    'briefing.md': await readDoc(draft, 'briefing.md'),
    'stack.md': await readDoc(draft, 'stack.md'),
    'design.md': await readDoc(draft, 'design.md'),
    'specs.md': specsMdOf(draft.specId, source),
  };
}

const hashOf = (texts: Record<SpeckitInput, string>): string => sha256(SPECKIT_INPUTS.map((file) => texts[file]).join('\n'));

/** The hash of the six inputs as they are now, which the start compares with the one the last preparation read. */
export async function speckitInputHash(draft: Draft, source: SpeckitSource): Promise<string> {
  return hashOf(await inputTexts(draft, source));
}

/** Writes the six Markdown inputs into a fresh input folder. */
async function writeInputs(draft: Draft, texts: Record<SpeckitInput, string>): Promise<void> {
  const dir = speckitInputDir(draft);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(SPECKIT_INPUTS.map((file) => fs.writeFile(path.posix.join(dir, file), texts[file])));
}

const sameText = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** The questions of one step as refine questions, leaving out any already asked or answered, so a re-run never asks again. */
function newQuestions(state: Pick<RefineState, 'questions' | 'cycle'>, asked: SpeckitOutput['questions'], step: Step, role: 'po' | 'sm'): Question[] {
  const seen = new Set(state.questions.map((q) => sameText(q.text)));
  const ids = new Set(state.questions.map((q) => q.questionId));
  return asked.flatMap((q) => {
    const key = sameText(q.text);
    const questionId = `speckit-${sha256(key).slice(7, 19)}`;
    // An id is kept even when the owner's card rewords the question, so the same question is never asked twice.
    if (seen.has(key) || ids.has(questionId)) return [];
    seen.add(key);
    const about = q.itemKey ?? step.item?.key;
    return [{ questionId, role, text: q.text.trim(), blocking: q.blocking, relatedAcIds: [], cycle: state.cycle, origin: 'speckit' as const, command: step.command, ...(about ? { itemKey: about } : {}), ...(q.options?.length ? { options: q.options } : {}) }];
  });
}

type Earlier = Pick<Question, 'text' | 'blocking'> & { status?: string };

/** Drops a new question the Jev calls a repeat of an earlier one; a blocking one is kept against a pending non-blocking one. */
async function dropRepeats(fresh: Question[], earlier: readonly Earlier[], decider: Pick<Decider, 'decide'>, confidential: boolean): Promise<Question[]> {
  const pairs = fresh
    .flatMap((q, i) => {
      const before: Earlier[] = [...earlier, ...fresh.slice(0, i)];
      return before.filter((e) => !(q.blocking && !e.blocking && (e.status ?? 'pending') === 'pending')).map((e) => ({ a: e.text, b: q.text, drop: q }));
    })
    .slice(0, MAX_DEDUP_PAIRS);
  const dup = await duplicatePairs(pairs, decider, { confidential });
  const dropped = new Set(dup ? pairs.filter((_, i) => dup[i]).map((p) => p.drop) : []);
  return fresh.filter((q) => !dropped.has(q));
}

async function initSpeckit(exec: Exec, cwd: string): Promise<void> {
  const r = await exec({ bin: 'specify', args: INIT_ARGS, cwd, timeoutMs: INIT_TIMEOUT_MS }).catch((err: Error) => {
    throw /ENOENT/.test(err.message) ? new OwnerError(SPECKIT_NOT_INSTALLED, err.message) : err;
  });
  if (r.exitCode !== 0) throw new OwnerError(`O Spec Kit não conseguiu preparar a pasta do projeto. ${TRY_AGAIN}`, (r.stderr || r.stdout).slice(-1000));
}

/** One command as an agent step; the files it wrote, or the owner's reason it stopped. */
const stepName = (step: Step): string => `/speckit-${step.command}${step.item ? ` de ${step.item.key}` : ''}`;

/** A finished step counts as done only when every file it reports is in the staging folder, and a specify step has its feature folder. */
async function checkOnDisk(staging: string, step: Step, files: readonly string[]): Promise<void> {
  const found = await Promise.all(files.map((file) => fs.access(path.resolve(staging, file)).then(() => true, () => false)));
  const missing = files.filter((_, i) => !found[i]);
  if (missing.length > 0) throw new OwnerError(`O Spec Kit não gravou os arquivos que ${stepName(step)} informou. ${TRY_AGAIN}`, missing.join(', '));
  const spec = `${speckitFeatureDir(step.item?.key ?? '')}/spec.md`;
  if (step.command === 'specify' && !(await exists(path.resolve(staging, spec)))) throw new OwnerError(`O Spec Kit não criou a pasta da feature em ${stepName(step)}. ${TRY_AGAIN}`, `no ${spec}`);
}

/** The reported files that still hold a Spec Kit marker of an open point; a folder reads as empty. */
async function openMarkers(staging: string, files: readonly string[]): Promise<string[]> {
  const texts = await Promise.all(files.map((file) => fs.readFile(path.resolve(staging, file), 'utf8').catch(() => '')));
  return files.filter((_, i) => texts[i]!.includes('[NEEDS CLARIFICATION:'));
}

/** The file each item command leaves in its feature folder, which must keep every acceptance criterion id of the item's spec. */
const CRITERIA_FILE: Partial<Record<SpeckitCommand, string>> = { specify: 'spec.md', clarify: 'spec.md', plan: 'plan.md', tasks: 'tasks.md' };

/** The item step's own file and the criterion ids it leaves out, as "<file>: <ids>"; undefined when it keeps them all. */
async function droppedCriteria(staging: string, step: Step, source: SpeckitSource): Promise<string | undefined> {
  const name = CRITERIA_FILE[step.command];
  if (!name) return undefined;
  const file = `${speckitFeatureDir(step.item!.key)}/${name}`;
  const text = await fs.readFile(path.posix.join(staging, file), 'utf8').catch(() => '');
  // A whole-word match, so AC-100 never counts as kept by AC-1000.
  const dropped = criteriaOf(source, step.item!.key).map((c) => c.id).filter((id) => !new RegExp(`\\b${id}\\b`).test(text));
  return dropped.length > 0 ? `${file}: ${dropped.join(', ')}` : undefined;
}

async function runCommand(deps: SpeckitDeps, step: Step, hash: string, adjust: boolean): Promise<SpeckitOutput> {
  const specHash = sha256(`speckit\n${step.command}\n${step.item?.key ?? ''}\n${hash}`);
  const inputDir = speckitInputDir(deps.draft);
  // A backlog writes the owner's answers into briefing.md; a single spec keeps every answer in the journal, as its freeze reads them.
  const single = !deps.journal.state.backlog?.enabled;
  const decisions = decisionsOf(deps.journal.state.questions.filter((q) => single || (q.origin === 'speckit' && q.answeredBy)));
  const pack = fitPackBudget(speckitPack({ command: step.command, specHash, inputDir, item: step.item, decisions, adjust }));
  const extraAllow = [...SPECKIT_BASH, `Read(${absoluteRule(inputDir)}/**)`];
  // An item step works in its own feature folder, which the environment names, and never persists the feature pointer.
  const extraEnv = step.item ? { SPECIFY_FEATURE_DIRECTORY: speckitFeatureDir(step.item.key), SPECIFY_FEATURE_NO_PERSIST: '1' } : undefined;
  const out = (await retryOnSchema((note) =>
    deps.runAgent<'speckit'>(
      { kind: 'speckit', role: 'dev', pack: withNote(pack, note), cwd: speckitDir(deps.draft), phase: 'refine', taskId: null, attempt: 1, extraAllow, extraEnv },
      { journal: deps.journal, stepDir: deps.draft.steps, specHash, signal: deps.signal },
    ),
  )) as StepOutcome<SpeckitOutput>;
  if (!out.ok) throw ownerFailure(`${SPECKIT_STAGE} (${stepName(step)})`, out.failure, out.errors, TRY_AGAIN);
  return out.value;
}

/** What every step of one preparation shares. */
interface RunContext {
  deps: SpeckitDeps;
  hash: string;
  texts: Record<SpeckitInput, string>;
  source: SpeckitSource;
  decider: Pick<Decider, 'decide'> | undefined;
  answerer: Answerer;
  /** The keys of the steps an earlier preparation finished whose files are still in the folder: they run no more. */
  reused: ReadonlySet<string>;
  /** The keys of the steps an earlier preparation finished, which run again on the files they left. */
  adjust: ReadonlySet<string>;
}

/** The file an item command leaves in its feature folder; the constitution has none to check, since init scaffolds its memory file. */
const outputOf = (step: Step): string | undefined => (step.item ? `${speckitFeatureDir(step.item.key)}/${CRITERIA_FILE[step.command]}` : undefined);

/** The keys of the steps an earlier preparation finished whose file is still in the folder, so a new preparation continues after them. */
async function reusedSteps(dir: string, earlier: readonly { command: string; itemKey?: string }[], plan: readonly Step[]): Promise<Set<string>> {
  const candidates = plan.flatMap((step) => {
    const key = stepKey(step.command, step.item?.key);
    return earlier.some((s) => stepKey(s.command, s.itemKey) === key) ? [{ key, file: outputOf(step) }] : [];
  });
  const present = await Promise.all(candidates.map(({ file }) => (file === undefined ? true : exists(path.resolve(dir, file)))));
  return new Set(candidates.filter((_, i) => present[i]).map(({ key }) => key));
}

/** Drops the feature folders of the items no longer in the backlog, so Phase 0 never publishes them. */
async function pruneFeatures(staging: string, items: readonly { key: string }[]): Promise<void> {
  const current = new Set(items.map((item) => item.key));
  const names = await fs.readdir(path.posix.join(staging, 'specs')).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => !current.has(name)).map((name) => fs.rm(path.posix.join(staging, 'specs', name), { recursive: true, force: true })));
}

/** One step of the preparation: refused once it is aborted, skipped when an earlier preparation still holds it, run otherwise. */
async function runOne(run: RunContext, step: Step): Promise<void> {
  if (run.deps.signal?.aborted) throw new OwnerError(`${SPECKIT_STAGE} foi interrompida.`, 'aborted');
  const key = stepKey(step.command, step.item?.key);
  if (run.reused.has(key)) return;
  await runStep(run.deps, { step, hash: run.hash, texts: run.texts, source: run.source, decider: run.decider, answerer: run.answerer, adjust: run.adjust.has(key) });
}

/**
 * Runs Spec Kit over the detailed backlog, or the single spec as one item, and answers the hash of the inputs it read. A step an
 * earlier preparation finished is kept as it is while its file is in the folder; the others run, on the files they have from that
 * preparation or from main when they have any. The constitution runs alone, unless the project keeps main's, then each item runs its
 * four commands in order, and up to `agents` items run at once.
 */
export async function prepareSpeckit(deps: SpeckitDeps, source: SpeckitSource): Promise<string> {
  const dir = speckitDir(deps.draft);
  const texts = await inputTexts(deps.draft, source);
  const hash = hashOf(texts);
  await writeInputs(deps.draft, texts);
  const items = speckitItems(deps.draft.specId, source);
  const decider = deps.decider && recorded(deps.decider, deps.journal, deps.journal.state.cycle);
  const answerer = answererFor(deps, texts, items, await researchAllowed(deps));
  // The steps an earlier preparation left are read before this one clears them.
  const earlier = deps.journal.state.speckit?.steps ?? [];
  const plan = speckitSteps(items);
  await deps.journal.fact(RefineEvent.SpeckitStarted, { total: plan.length, inputHash: hash });
  // Questions an earlier preparation left unanswered are tried first, so the steps that run read their answers.
  await answerer.triage(untriaged(deps.journal.state.questions));
  const keep = earlier.length > 0 && (await exists(dir));
  const reused = keep ? await reusedSteps(dir, earlier, plan) : new Set<string>();
  const adjust = new Set(keep ? earlier.filter((s) => s.basis !== undefined).map((s) => stepKey(s.command, s.itemKey)) : []);
  if (keep) await pruneFeatures(dir, items);
  else {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await initSpeckit(deps.exec, dir);
  }
  const carried = earlier.filter((s) => reused.has(stepKey(s.command, s.itemKey)));
  const base = speckitBaseDir(deps.draft);
  if (await exists(path.posix.join(base, CONSTITUTION))) {
    // Main's constitution and feature folders go over a fresh scaffold, or back beside the files an earlier preparation left.
    await fs.cp(base, dir, { recursive: true, force: !keep });
    // Main's constitution counts as done, once, so the constitution step never writes over it.
    if (!reused.has(stepKey('constitution'))) {
      reused.add(stepKey('constitution'));
      carried.unshift({ command: 'constitution' });
    }
    // An item whose file main holds, as a continued spec's, updates that file in the same feature folder instead of writing it anew.
    for (const step of plan) if (step.item && (await exists(path.resolve(dir, outputOf(step)!)))) adjust.add(stepKey(step.command, step.item.key));
  }
  if (carried.length > 0) await deps.journal.fact(RefineEvent.SpeckitReused, { steps: carried });
  const run: RunContext = { deps, hash, texts, source, decider, answerer, reused, adjust };
  await runOne(run, { command: 'constitution' });
  const lanes = items.map(itemSteps);
  const halt: { failed: boolean; error?: unknown } = { failed: false };
  const worker = async (): Promise<void> => {
    for (let lane = lanes.shift(); lane !== undefined; lane = lanes.shift()) {
      for (const step of lane) {
        if (halt.failed) return;
        try {
          await runOne(run, step);
        } catch (error) {
          // The first failure is the one reported: a later one, of a step that was already running, does not replace it.
          if (!halt.failed) {
            halt.failed = true;
            halt.error = error;
          }
          return;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.agents ?? 1, lanes.length)) }, worker));
  if (halt.failed) throw halt.error;
  return hash;
}

/**
 * One Spec Kit command, then the answers to the questions it left. An answer changes the files of its step, so a step other than
 * a specify runs again with it, up to MAX_STEP_ROUNDS rounds; an answer still unresolved after that, or a stop, leaves the preparation stale.
 */
async function runStep(deps: SpeckitDeps, run: { step: Step; hash: string; texts: Record<SpeckitInput, string>; source: SpeckitSource; decider: Pick<Decider, 'decide'> | undefined; answerer: Answerer; adjust: boolean }): Promise<void> {
  const { step, hash, texts, source, decider, answerer, adjust } = run;
  const dir = speckitDir(deps.draft);
  // A specify step makes a new feature folder on every run, so its answers reach the steps after it instead.
  const rework = step.command === 'specify' ? undefined : { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}) };
  let answered = 0;
  for (let round = 1; ; round++) {
    await deps.journal.fact(RefineEvent.SpeckitStepStarted, { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}) });
    let result: SpeckitOutput;
    try {
      result = await runCommand(deps, step, hash, adjust);
      if (result.status === 'done') await checkOnDisk(dir, step, result.files);
    } catch (err) {
      // A step that fails before it is recorded leaves the running list now, not when the whole preparation stops.
      await deps.journal.fact(RefineEvent.SpeckitStepDone, { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}), files: [], blocked: true });
      throw err;
    }
    const open = result.status === 'done' ? await openMarkers(dir, result.files) : [];
    const dropped = result.status === 'done' ? await droppedCriteria(dir, step, source) : undefined;
    const fresh = newQuestions(deps.journal.state, result.questions, step, answererOf(step.command));
    const asked = decider ? await dropRepeats(fresh, deps.journal.state.questions, decider, await isConfidential(deps.draft, deps.journal.state)) : fresh;
    // The basis is the one this round's files were written from, with the questions it asks counted as pending, as they are on record.
    const pending = asked.filter((q) => !deps.journal.state.questions.some((x) => x.questionId === q.questionId)).map((q) => ({ ...q, status: 'pending', answer: null, answeredBy: null }));
    await deps.journal.fact(RefineEvent.SpeckitStepDone, { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}), files: result.files, ...(step.command === 'specify' && result.status === 'done' ? { featureDir: speckitFeatureDir(step.item!.key) } : {}), ...(asked.length > 0 ? { questions: asked } : {}), ...(result.status === 'blocked' || open.length > 0 || dropped ? { blocked: true } : {}), basis: stepBasis(step, texts, [...deps.journal.state.questions, ...pending]) });
    // The questions of a step are on record and answered before the step stops, so the owner sees what is left.
    const count = await answerer.triage(asked, rework);
    answered += count;
    if (count > 0 && rework && round < MAX_STEP_ROUNDS) continue;
    const stopped = result.status === 'blocked' || open.length > 0 || Boolean(dropped);
    if ((count > 0 && rework) || (stopped && answered > 0)) await deps.journal.fact(RefineEvent.SpeckitStale, {});
    if (result.status === 'blocked') throw new OwnerError(`O Spec Kit parou em ${stepName(step)}: ${result.reason}`, result.summary);
    if (open.length > 0) throw new OwnerError(`O Spec Kit deixou pontos em aberto ([NEEDS CLARIFICATION]) em ${stepName(step)}. Responda às perguntas dele ou tente de novo.`, open.join(', '));
    if (dropped) throw new OwnerError(`O Spec Kit deixou critérios de aceite de fora em ${stepName(step)}. ${TRY_AGAIN}`, dropped);
    return;
  }
}
