import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SuggestOutput } from '../agents/outputs.js';
import { sha256 } from '../contracts/hash.js';
import type { StepOutcome } from '../runner/step.js';
import { retryOnSchema, withNote } from './agent-failure.js';
import { dropCoveredPatches, type CycleJournal, type RunAgent } from './cycle.js';
import { readDoc, writeDoc, type Draft, type DocFile } from './draft.js';
import { RefineEvent } from './events.js';
import { fitPackBudget } from './fit-pack.js';
import type { ReshapeRow } from './state.js';
import { reshapePack, SUGGEST_ROLE, TEMPLATE, type SuggestFile } from './suggest.js';
import { isUntouched, shapeProblem } from './template-shape.js';

/** The text a reshape replaced, kept on disk until the reshape is undone. */
export const reshapeBackup = (draft: Draft, reshapeId: string): string => path.posix.join(draft.root, 'reshaped', `${reshapeId}.md`);

export interface ReshapeDeps {
  draft: Draft;
  journal: CycleJournal;
  runAgent: RunAgent;
  signal?: AbortSignal;
}

/** Whether the owner undid a reshape of `file` and the text is still the one that undo put back. */
async function undoneLayout(draft: Draft, reshapes: ReadonlyArray<ReshapeRow>, file: DocFile, text: string): Promise<boolean> {
  for (const row of reshapes) {
    if (row.file === file && row.status === 'undone' && (await fs.readFile(reshapeBackup(draft, row.reshapeId), 'utf8')) === text) return true;
  }
  return false;
}

/** Rewrites a stage document in its template's shape before the review reads it; a refused reshape leaves the document as it was and says why. */
export async function reshapeStage(deps: ReshapeDeps, cycle: number, file: DocFile, docs: Record<DocFile, string>, discarded: Array<{ role: string; file: string; reason: string }>): Promise<void> {
  if (file === 'flow.md') return;
  const { draft, journal } = deps;
  const before = docs[file];
  // Still the template itself, or already in its shape: nothing to rewrite.
  if (isUntouched(file, before, draft.projectId) || shapeProblem(file, before, before, draft.projectId) === null) return;
  // The owner undid this layout: the text stays as the owner left it until the owner changes it.
  if (await undoneLayout(draft, journal.state.reshapes, file, before)) return;
  const role = SUGGEST_ROLE[file];
  const refuse = (reason: string) => {
    discarded.push({ role, file, reason: `Não reorganizei ${file} no modelo: ${reason}.` });
  };
  const specHash = sha256(`reshape\n${before}`);
  const pack = fitPackBudget(reshapePack({ file, projectId: draft.projectId, specHash, current: before }));
  const ask = (note: string | null) => retryOnSchema(async (schema) => (await deps.runAgent<'suggest'>(
    { kind: 'suggest', role, pack: withNote(pack, [note, schema].filter(Boolean).join('\n\n') || null), cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle },
    { journal, stepDir: draft.steps, specHash, signal: deps.signal },
  )) as StepOutcome<SuggestOutput>);
  let out: StepOutcome<SuggestOutput>;
  try {
    out = await ask(null);
    const first = out.ok ? shapeProblem(file, out.value.text, before, draft.projectId) : null;
    if (first) out = await ask(`The text you wrote before was refused: ${first}. Write the complete docs/${file} again, in the template's shape.`);
  } catch {
    refuse('o agente parou antes de responder');
    return;
  }
  if (!out.ok) {
    refuse('o agente não devolveu o texto em formato válido');
    return;
  }
  const problem = shapeProblem(file, out.value.text, before, draft.projectId);
  if (problem) {
    refuse(problem);
    return;
  }
  // A person may type while the agent works: a document that changed since the reshape began is left as it is.
  const now = await readDoc(draft, file);
  if (now !== before) {
    docs[file] = now;
    refuse('o texto mudou durante a reorganização');
    return;
  }
  // The id names the document, so each reshape of a cycle keeps its own backup.
  const reshapeId = `reshape-c${cycle}-${path.posix.parse(file).name}`;
  await fs.mkdir(path.posix.dirname(reshapeBackup(draft, reshapeId)), { recursive: true });
  await fs.writeFile(reshapeBackup(draft, reshapeId), before);
  await writeDoc(draft, file, out.value.text);
  docs[file] = await readDoc(draft, file);
  const afterHash = sha256(docs[file]);
  await journal.fact(RefineEvent.DocEdited, { file, hash: afterHash, source: 'reshape' });
  await journal.fact(RefineEvent.DocReshaped, { reshapeId, file, cycle, role, afterHash });
  await dropCoveredPatches(journal, docs, [file]);
}

/** Puts every document in its template's layout on every cycle, so a document moved out of place comes back. */
export async function reshapeAll(deps: ReshapeDeps, cycle: number, docs: Record<DocFile, string>, discarded: Array<{ role: string; file: string; reason: string }>): Promise<void> {
  for (const file of Object.keys(TEMPLATE) as SuggestFile[]) await reshapeStage(deps, cycle, file, docs, discarded);
}
