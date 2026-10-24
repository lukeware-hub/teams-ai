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
import { itemPreplanPath, itemSpecPath, speckitPack, type SpeckitCommand, type SpeckitItem } from './speckit-pack.js';
import { DOC_FILES } from './suggest.js';

export const SPECKIT_NOT_INSTALLED = 'O Spec Kit não está instalado neste ambiente.';
export const SPECKIT_STAGE = 'A preparação do Spec Kit';
/** Spec Kit v1.2.3: scaffolds .specify/ and the Claude skills offline, with the bash scripts, and never prompts. */
const INIT_ARGS = ['init', '--here', '--force', '--non-interactive', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools'];
const INIT_TIMEOUT_MS = 120_000;
/** What the Spec Kit skills run: their bash scripts, and a copy of a template. */
const SPECKIT_BASH = ['Bash(bash:*)', 'Bash(.specify/scripts/bash/*:*)', 'Bash(cp:*)'];

/** The staging folder Spec Kit works in; Phase 0 publishes it to the repository. */
export const speckitDir = (draft: Pick<Draft, 'root'>): string => path.posix.join(draft.root, 'speckit');

export interface SpeckitDeps {
  draft: Draft;
  journal: Pick<CycleJournal, 'allocStepSeq' | 'fact'>;
  runAgent: RunAgent;
  exec: Exec;
  signal?: AbortSignal;
}

type Step = { command: SpeckitCommand; item?: SpeckitItem };

/** The constitution once, then specify, plan and tasks for each item in rank order. */
export function speckitSteps(items: readonly SpeckitItem[]): Step[] {
  return [{ command: 'constitution' }, ...items.flatMap((item) => (['specify', 'plan', 'tasks'] as const).map((command) => ({ command, item })))];
}

/** The hash of what the preparation reads: the five documents and each item's spec and pre-plan. */
async function inputHash(draft: Draft, items: readonly SpeckitItem[]): Promise<string> {
  const docs = await Promise.all(DOC_FILES.map((file) => readDoc(draft, file)));
  const files = items.flatMap((i) => [itemSpecPath(draft.docs, i.specId), itemPreplanPath(draft.docs, i.specId)]);
  const specs = await Promise.all(files.map((file) => fs.readFile(file, 'utf8').catch(() => '')));
  return sha256([...docs, ...specs].join('\n'));
}

async function initSpeckit(exec: Exec, cwd: string): Promise<void> {
  const r = await exec({ bin: 'specify', args: INIT_ARGS, cwd, timeoutMs: INIT_TIMEOUT_MS }).catch((err: Error) => {
    throw /ENOENT/.test(err.message) ? new OwnerError(SPECKIT_NOT_INSTALLED, err.message) : err;
  });
  if (r.exitCode !== 0) throw new OwnerError(`O Spec Kit não conseguiu preparar a pasta do projeto. ${TRY_AGAIN}`, (r.stderr || r.stdout).slice(-1000));
}

/** One command as an agent step; the files it wrote, or the owner's reason it stopped. */
async function runCommand(deps: SpeckitDeps, step: Step, hash: string): Promise<string[]> {
  const specHash = sha256(`speckit\n${step.command}\n${step.item?.key ?? ''}\n${hash}`);
  const pack = fitPackBudget(speckitPack({ command: step.command, specHash, docsDir: deps.draft.docs, item: step.item }));
  const extraAllow = [...SPECKIT_BASH, `Read(${absoluteRule(deps.draft.docs)}/**)`];
  const out = (await deps.runAgent<'speckit'>(
    { kind: 'speckit', role: 'dev', pack, cwd: speckitDir(deps.draft), phase: 'refine', taskId: null, attempt: 1, extraAllow },
    { journal: deps.journal, stepDir: deps.draft.steps, specHash, signal: deps.signal },
  )) as StepOutcome<SpeckitOutput>;
  const name = `/speckit-${step.command}${step.item ? ` de ${step.item.key}` : ''}`;
  if (!out.ok) throw ownerFailure(`${SPECKIT_STAGE} (${name})`, out.failure, out.errors, TRY_AGAIN);
  if (out.value.status === 'blocked') throw new OwnerError(`O Spec Kit parou em ${name}: ${out.value.reason}`, out.value.summary);
  return out.value.files;
}

/** Runs Spec Kit in a fresh staging folder over the detailed backlog; answers the hash of what it read. */
export async function prepareSpeckit(deps: SpeckitDeps, items: readonly SpeckitItem[]): Promise<string> {
  const dir = speckitDir(deps.draft);
  const hash = await inputHash(deps.draft, items);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await initSpeckit(deps.exec, dir);
  for (const step of speckitSteps(items)) {
    if (deps.signal?.aborted) throw new OwnerError(`${SPECKIT_STAGE} foi interrompida.`, 'aborted');
    const files = await runCommand(deps, step, hash);
    await deps.journal.fact(RefineEvent.SpeckitStepDone, { command: step.command, ...(step.item ? { itemKey: step.item.key } : {}), files });
  }
  return hash;
}
