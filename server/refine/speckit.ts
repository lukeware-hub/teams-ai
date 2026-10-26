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
import { readDoc, type Draft } from './draft.js';
import { RefineEvent } from './events.js';
import { fitPackBudget } from './fit-pack.js';
import { SPECKIT_INPUTS, speckitPack, type SpeckitCommand, type SpeckitInput } from './speckit-pack.js';
import { speckitSteps, stepKey, type Step } from './speckit-steps.js';
import { renderSpecsMd } from './specs-md.js';
import { buildSpecsIndex, specIdOf } from './specs-index.js';
import { loadEvents } from '../store/event-store.js';
import { reduceRefineEvents, type BacklogState, type QuestionRow, type RefineState } from './state.js';
import type { Question } from './events.js';
import { decisionsOf } from './decisions.js';
import { answererOf, makeAnswerer, type Answerer } from './speckit-answers.js';

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
}

/** The feature folder a specify step made: the spec.md it reports, or else the one Spec Kit recorded in .specify/feature.json. */
async function featureDirOf(staging: string, files: readonly string[]): Promise<string | undefined> {
  const folder = (file: string, pattern: RegExp) => pattern.exec(file.replace(/\\/g, '/'))?.[1];
  const reported = files.map((f) => folder(f, /(?:^|\/)(specs\/[^/]+)\/spec\.md$/)).find(Boolean);
  if (reported) return reported;
  const recorded = await fs.readFile(path.posix.join(staging, '.specify', 'feature.json'), 'utf8').then((t) => (JSON.parse(t) as { feature_directory?: string }).feature_directory, () => undefined);
  return recorded ? folder(recorded, /(?:^|\/)(specs\/[^/]+)\/?$/) : undefined;
}

/** The Spec Kit feature folder of one spec of a draft, when its preparation made one; read by a run of that spec. */
export async function speckitFeatureOf(draftRoot: string, specId: string): Promise<string | undefined> {
  const events = await loadEvents(path.join(draftRoot, 'events.ndjson')).catch(() => []);
  const state = reduceRefineEvents(events);
  const key = state.backlog?.items.find((i) => specIdOf(path.basename(draftRoot), i.key, state.backlog?.keyIds) === specId)?.key;
  return key ? state.speckit?.features?.[key] : undefined;
}

/** The answerer of a preparation: the six inputs as read now, the item titles, and the staging folder the answering agent may not read. */
function answererFor(deps: Pick<SpeckitDeps, 'draft' | 'journal' | 'runAgent' | 'signal'>, texts: Record<SpeckitInput, string>, backlog: BacklogState): Answerer {
  const titles = new Map(buildSpecsIndex(deps.draft.specId, backlog).specs.map((i): [string, string] => [i.key, i.title]));
  return makeAnswerer({ draft: deps.draft, journal: deps.journal, runAgent: deps.runAgent, texts, hash: hashOf(texts), titles, stagingDir: speckitDir(deps.draft), signal: deps.signal });
}

/** The Spec Kit questions nobody has read yet: pending, and without the card the PO or the SM writes. */
const untriaged = (questions: readonly QuestionRow[]): QuestionRow[] => questions.filter((q) => q.origin === 'speckit' && q.status === 'pending' && q.context === undefined);

/** "Pedir ao PO e ao SM": the PO and the SM read the questions nobody has read yet; returns how many they answered. */
export async function answerUntriaged(deps: Pick<SpeckitDeps, 'draft' | 'journal' | 'runAgent' | 'signal'>, backlog: BacklogState): Promise<number> {
  const texts = await inputTexts(deps.draft, backlog);
  return answererFor(deps, texts, backlog).triage(untriaged(deps.journal.state.questions));
}

/** The text of the six Markdown inputs, as Spec Kit reads them. */
async function inputTexts(draft: Draft, backlog: BacklogState): Promise<Record<SpeckitInput, string>> {
  return {
    'project.md': await readDoc(draft, 'project.md'),
    'flow.md': await readDoc(draft, 'flow.md'),
    'briefing.md': await readDoc(draft, 'briefing.md'),
    'stack.md': await readDoc(draft, 'stack.md'),
    'design.md': await readDoc(draft, 'design.md'),
    'specs.md': renderSpecsMd(draft.specId, backlog),
  };
}

const hashOf = (texts: Record<SpeckitInput, string>): string => sha256(SPECKIT_INPUTS.map((file) => texts[file]).join('\n'));

/** The hash of the six inputs as they are now. A failed preparation on the same hash resumes; any other starts over. */
export async function speckitInputHash(draft: Draft, backlog: BacklogState): Promise<string> {
  return hashOf(await inputTexts(draft, backlog));
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
function newQuestions(state: Pick<RefineState, 'questions' | 'cycle'>, asked: SpeckitOutput['questions'], itemKey: string | undefined, role: 'po' | 'sm'): Question[] {
  const seen = new Set(state.questions.map((q) => sameText(q.text)));
  const ids = new Set(state.questions.map((q) => q.questionId));
  return asked.flatMap((q) => {
    const key = sameText(q.text);
    const questionId = `speckit-${sha256(key).slice(7, 19)}`;
    // An id is kept even when the owner's card rewords the question, so the same question is never asked twice.
    if (seen.has(key) || ids.has(questionId)) return [];
    seen.add(key);
    const about = q.itemKey ?? itemKey;
    return [{ questionId, role, text: q.text.trim(), blocking: q.blocking, relatedAcIds: [], cycle: state.cycle, origin: 'speckit' as const, ...(about ? { itemKey: about } : {}), ...(q.options?.length ? { options: q.options } : {}) }];
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

const onDisk = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

/** A finished step counts as done only when every file it reports is in the staging folder, and a specify step has its feature folder there. */
async function checkOnDisk(staging: string, step: Step, files: readonly string[], featureDir: string | undefined): Promise<void> {
  const found = await Promise.all(files.map((file) => onDisk(path.resolve(staging, file))));
  const missing = files.filter((_, i) => !found[i]);
  if (missing.length > 0) throw new OwnerError(`O Spec Kit não gravou os arquivos que ${stepName(step)} informou. ${TRY_AGAIN}`, missing.join(', '));
  if (step.command === 'specify' && !(featureDir && (await onDisk(path.resolve(staging, featureDir))))) {
    throw new OwnerError(`O Spec Kit não criou a pasta da feature em ${stepName(step)}. ${TRY_AGAIN}`, featureDir ? `${featureDir} is not in the staging folder` : 'no specs/<feature>/spec.md reported and no .specify/feature.json');
  }
}

/** The reported files that still hold a Spec Kit marker of an open point; a folder reads as empty. */
async function openMarkers(staging: string, files: readonly string[]): Promise<string[]> {
  const texts = await Promise.all(files.map((file) => fs.readFile(path.resolve(staging, file), 'utf8').catch(() => '')));
  return files.filter((_, i) => texts[i]!.includes('[NEEDS CLARIFICATION:'));
}

/** The file each item command leaves in its feature folder, which must keep every acceptance criterion id of the item's spec. */
const CRITERIA_FILE: Partial<Record<SpeckitCommand, string>> = { specify: 'spec.md', clarify: 'spec.md', plan: 'plan.md', tasks: 'tasks.md' };

/** The item step's own file and the criterion ids it leaves out, as "<file>: <ids>"; undefined when it keeps them all. */
async function droppedCriteria(staging: string, step: Step, featureDir: string | undefined, backlog: BacklogState): Promise<string | undefined> {
  const name = CRITERIA_FILE[step.command];
  if (!name) return undefined;
  const file = `${featureDir}/${name}`;
  const text = featureDir ? await fs.readFile(path.posix.join(staging, file), 'utf8').catch(() => '') : '';
  // A whole-word match, so AC-100 never counts as kept by AC-1000.
  const dropped = (backlog.specs?.[step.item!.key]?.spec?.acceptanceCriteria ?? []).map((c) => c.id).filter((id) => !new RegExp(`\\b${id}\\b`).test(text));
  return dropped.length > 0 ? `${file}: ${dropped.join(', ')}` : undefined;
}

async function runCommand(deps: SpeckitDeps, step: Step, hash: string): Promise<SpeckitOutput> {
  const specHash = sha256(`speckit\n${step.command}\n${step.item?.key ?? ''}\n${hash}`);
  const inputDir = speckitInputDir(deps.draft);
  const decisions = decisionsOf(deps.journal.state.questions.filter((q) => q.origin === 'speckit' && q.answeredBy));
  const pack = fitPackBudget(speckitPack({ command: step.command, specHash, inputDir, item: step.item, decisions }));
  const extraAllow = [...SPECKIT_BASH, `Read(${absoluteRule(inputDir)}/**)`];
  const out = (await retryOnSchema((note) =>
    deps.runAgent<'speckit'>(
      { kind: 'speckit', role: 'dev', pack: withNote(pack, note), cwd: speckitDir(deps.draft), phase: 'refine', taskId: null, attempt: 1, extraAllow },
      { journal: deps.journal, stepDir: deps.draft.steps, specHash, signal: deps.signal },
    ),
  )) as StepOutcome<SpeckitOutput>;
  if (!out.ok) throw ownerFailure(`${SPECKIT_STAGE} (${stepName(step)})`, out.failure, out.errors, TRY_AGAIN);
  return out.value;
}

/**
 * Runs Spec Kit over the detailed backlog and answers the hash of the inputs it read. `finished` holds the steps of an earlier
 * preparation of the same inputs that stopped: they run no more, and their files stay in the staging folder.
 */
export async function prepareSpeckit(deps: SpeckitDeps, backlog: BacklogState, finished: ReadonlySet<string> = new Set()): Promise<string> {
  const dir = speckitDir(deps.draft);
  const texts = await inputTexts(deps.draft, backlog);
  const hash = hashOf(texts);
  await writeInputs(deps.draft, texts);
  const resume = finished.size > 0 && (await onDisk(dir));
  if (!resume) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await initSpeckit(deps.exec, dir);
  }
  const decider = deps.decider && recorded(deps.decider, deps.journal, deps.journal.state.cycle);
  const items = buildSpecsIndex(deps.draft.specId, backlog).specs;
  const answerer = answererFor(deps, texts, backlog);
  // Questions an earlier preparation left unanswered are tried first. An answer to a finished step's question leaves that step stale.
  const swept = await answerer.triage(untriaged(deps.journal.state.questions));
  if (swept > 0 && resume) await deps.journal.fact(RefineEvent.SpeckitStale, {});
  for (const step of speckitSteps(items)) {
    if (deps.signal?.aborted) throw new OwnerError(`${SPECKIT_STAGE} foi interrompida.`, 'aborted');
    if (resume && finished.has(stepKey(step.command, step.item?.key))) continue;
    await runStep(deps, { step, hash, backlog, decider, answerer });
  }
  return hash;
}

/**
 * One Spec Kit command, then the answers to the questions it left. An answer changes the files of its step, so a step other than
 * a specify runs once more with it; an answer that comes after that, or with a stop, leaves the preparation stale.
 */
async function runStep(deps: SpeckitDeps, run: { step: Step; hash: string; backlog: BacklogState; decider: Pick<Decider, 'decide'> | undefined; answerer: Answerer }): Promise<void> {
  const { step, hash, backlog, decider, answerer } = run;
  const dir = speckitDir(deps.draft);
  // A specify step makes a new feature folder on every run, so its answers reach the steps after it instead.
  const rework = step.command === 'specify' ? undefined : { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}) };
  let answered = 0;
  for (let round = 1; ; round++) {
    await deps.journal.fact(RefineEvent.SpeckitStepStarted, { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}) });
    const result = await runCommand(deps, step, hash);
    const featureDir = step.command === 'specify' ? await featureDirOf(dir, result.files) : undefined;
    if (result.status === 'done') await checkOnDisk(dir, step, result.files, featureDir);
    const open = result.status === 'done' ? await openMarkers(dir, result.files) : [];
    const dropped = result.status === 'done' ? await droppedCriteria(dir, step, featureDir ?? (step.item && deps.journal.state.speckit?.features?.[step.item.key]), backlog) : undefined;
    const fresh = newQuestions(deps.journal.state, result.questions, step.item?.key, answererOf(step.command));
    const asked = decider ? await dropRepeats(fresh, deps.journal.state.questions, decider, await isConfidential(deps.draft, deps.journal.state)) : fresh;
    await deps.journal.fact(RefineEvent.SpeckitStepDone, { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}), files: result.files, ...(featureDir ? { featureDir } : {}), ...(asked.length > 0 ? { questions: asked } : {}), ...(result.status === 'blocked' || open.length > 0 || dropped ? { blocked: true } : {}) });
    // The questions of a step are on record and answered before the step stops, so the owner sees what is left.
    const count = await answerer.triage(asked, round === 1 ? rework : undefined);
    answered += count;
    if (count > 0 && round === 1 && rework) continue;
    const stopped = result.status === 'blocked' || open.length > 0 || Boolean(dropped);
    if ((count > 0 && round > 1) || (stopped && answered > 0)) await deps.journal.fact(RefineEvent.SpeckitStale, {});
    if (result.status === 'blocked') throw new OwnerError(`O Spec Kit parou em ${stepName(step)}: ${result.reason}`, result.summary);
    if (open.length > 0) throw new OwnerError(`O Spec Kit deixou pontos em aberto ([NEEDS CLARIFICATION]) em ${stepName(step)}. Responda às perguntas dele ou tente de novo.`, open.join(', '));
    if (dropped) throw new OwnerError(`O Spec Kit deixou critérios de aceite de fora em ${stepName(step)}. ${TRY_AGAIN}`, dropped);
    return;
  }
}
