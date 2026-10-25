import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SpeckitOutput } from '../agents/outputs.js';
import { sha256 } from '../contracts/hash.js';
import { OwnerError } from '../core/owner-error.js';
import type { Exec } from '../exec/command.js';
import { absoluteRule } from '../runner/role-settings.js';
import type { StepOutcome } from '../runner/step.js';
import { ownerFailure, TRY_AGAIN } from './agent-failure.js';
import type { CycleJournal, RunAgent } from './cycle.js';
import { readDoc, type Draft } from './draft.js';
import { RefineEvent } from './events.js';
import { fitPackBudget } from './fit-pack.js';
import { SPECKIT_INPUTS, speckitPack, type SpeckitCommand, type SpeckitInput, type SpeckitItem } from './speckit-pack.js';
import { renderSpecsMd } from './specs-md.js';
import { buildSpecsIndex, specIdOf } from './specs-index.js';
import { loadEvents } from '../store/event-store.js';
import { reduceRefineEvents, type BacklogState, type RefineState } from './state.js';
import type { Question } from './events.js';

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
  signal?: AbortSignal;
}

type Step = { command: SpeckitCommand; item?: SpeckitItem };

/** Spec Kit's own flow: the constitution once, then specify, clarify, plan and tasks for each item in rank order (1 + 4N steps). */
export function speckitSteps(items: readonly SpeckitItem[]): Step[] {
  return [{ command: 'constitution' }, ...items.flatMap((item) => (['specify', 'clarify', 'plan', 'tasks'] as const).map((command) => ({ command, item })))];
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

/** Writes the six Markdown inputs into a fresh input folder and answers the hash of their text. */
async function writeInputs(draft: Draft, backlog: BacklogState): Promise<string> {
  const texts: Record<SpeckitInput, string> = {
    'project.md': await readDoc(draft, 'project.md'),
    'flow.md': await readDoc(draft, 'flow.md'),
    'briefing.md': await readDoc(draft, 'briefing.md'),
    'stack.md': await readDoc(draft, 'stack.md'),
    'design.md': await readDoc(draft, 'design.md'),
    'specs.md': renderSpecsMd(draft.specId, backlog),
  };
  const dir = speckitInputDir(draft);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(SPECKIT_INPUTS.map((file) => fs.writeFile(path.posix.join(dir, file), texts[file])));
  return sha256(SPECKIT_INPUTS.map((file) => texts[file]).join('\n'));
}

const sameText = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** The questions of one step as refine questions, leaving out any already asked or answered, so a re-run never asks again. */
function newQuestions(state: Pick<RefineState, 'questions' | 'cycle'>, asked: SpeckitOutput['questions'], itemKey: string | undefined): Question[] {
  const seen = new Set(state.questions.map((q) => sameText(q.text)));
  return asked.flatMap((q) => {
    const key = sameText(q.text);
    if (seen.has(key)) return [];
    seen.add(key);
    const about = q.itemKey ?? itemKey;
    return [{ questionId: `speckit-${sha256(key).slice(7, 19)}`, role: 'po' as const, text: q.text.trim(), blocking: q.blocking, relatedAcIds: [], cycle: state.cycle, origin: 'speckit' as const, ...(about ? { itemKey: about } : {}), ...(q.options?.length ? { options: q.options } : {}) }];
  });
}

async function initSpeckit(exec: Exec, cwd: string): Promise<void> {
  const r = await exec({ bin: 'specify', args: INIT_ARGS, cwd, timeoutMs: INIT_TIMEOUT_MS }).catch((err: Error) => {
    throw /ENOENT/.test(err.message) ? new OwnerError(SPECKIT_NOT_INSTALLED, err.message) : err;
  });
  if (r.exitCode !== 0) throw new OwnerError(`O Spec Kit não conseguiu preparar a pasta do projeto. ${TRY_AGAIN}`, (r.stderr || r.stdout).slice(-1000));
}

/** One command as an agent step; the files it wrote, or the owner's reason it stopped. */
const stepName = (step: Step): string => `/speckit-${step.command}${step.item ? ` de ${step.item.key}` : ''}`;

async function runCommand(deps: SpeckitDeps, step: Step, hash: string): Promise<SpeckitOutput> {
  const specHash = sha256(`speckit\n${step.command}\n${step.item?.key ?? ''}\n${hash}`);
  const inputDir = speckitInputDir(deps.draft);
  const pack = fitPackBudget(speckitPack({ command: step.command, specHash, inputDir, item: step.item }));
  const extraAllow = [...SPECKIT_BASH, `Read(${absoluteRule(inputDir)}/**)`];
  const out = (await deps.runAgent<'speckit'>(
    { kind: 'speckit', role: 'dev', pack, cwd: speckitDir(deps.draft), phase: 'refine', taskId: null, attempt: 1, extraAllow },
    { journal: deps.journal, stepDir: deps.draft.steps, specHash, signal: deps.signal },
  )) as StepOutcome<SpeckitOutput>;
  if (!out.ok) throw ownerFailure(`${SPECKIT_STAGE} (${stepName(step)})`, out.failure, out.errors, TRY_AGAIN);
  return out.value;
}

/** Runs Spec Kit in a fresh staging folder over the detailed backlog; answers the hash of the inputs it read. */
export async function prepareSpeckit(deps: SpeckitDeps, backlog: BacklogState): Promise<string> {
  const dir = speckitDir(deps.draft);
  const hash = await writeInputs(deps.draft, backlog);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await initSpeckit(deps.exec, dir);
  for (const step of speckitSteps(buildSpecsIndex(deps.draft.specId, backlog).specs)) {
    if (deps.signal?.aborted) throw new OwnerError(`${SPECKIT_STAGE} foi interrompida.`, 'aborted');
    await deps.journal.fact(RefineEvent.SpeckitStepStarted, { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}) });
    const result = await runCommand(deps, step, hash);
    const asked = newQuestions(deps.journal.state, result.questions, step.item?.key);
    const featureDir = step.command === 'specify' ? await featureDirOf(dir, result.files) : undefined;
    await deps.journal.fact(RefineEvent.SpeckitStepDone, { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}), files: result.files, ...(featureDir ? { featureDir } : {}), ...(asked.length > 0 ? { questions: asked } : {}) });
    // The questions of a blocked step are on record before it stops, so the owner can answer them.
    if (result.status === 'blocked') throw new OwnerError(`O Spec Kit parou em ${stepName(step)}: ${result.reason}`, result.summary);
  }
  return hash;
}
