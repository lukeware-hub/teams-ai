import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SuggestOutput } from '../agents/outputs.js';
import { sha256 } from '../contracts/hash.js';
import type { StepOutcome } from '../runner/step.js';
import { retryOnSchema, withNote } from './agent-failure.js';
import { dropCoveredPatches, type CycleJournal, type RunAgent } from './cycle.js';
import { readDoc, writeDoc, type Draft, type DocFile } from './draft.js';
import { RefineEvent } from './events.js';
import { estimateTokens } from '../knowledge/context-pack.js';
import { fitPackBudget } from './fit-pack.js';
import { isNotApplicable } from './not-applicable.js';
import type { ReshapeRow } from './state.js';
import { reshapePack, SUGGEST_ROLE, TEMPLATE, type SuggestFile } from './suggest.js';
import { isUntouched, shapeProblem } from './template-shape.js';
import { formatByTemplate } from './template-layout.js';

/** A document longer than this is not rewritten by the agent in one answer: only the algorithm may lay it out. */
const MAX_RESHAPE_TOKENS = 20_000;

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

/** Writes a reshaped document, or returns why it did not: a person who typed while the reshape ran keeps the text they wrote. */
async function commitReshape(deps: { draft: Draft; journal: CycleJournal }, cycle: number, file: DocFile, role: string, before: string, after: string): Promise<string | null> {
  const { draft, journal } = deps;
  if ((await readDoc(draft, file)) !== before) return 'o texto mudou durante a reorganização';
  // The id names the document, so each reshape of a cycle keeps its own backup.
  const reshapeId = `reshape-c${cycle}-${path.posix.parse(file).name}`;
  await fs.mkdir(path.posix.dirname(reshapeBackup(draft, reshapeId)), { recursive: true });
  await fs.writeFile(reshapeBackup(draft, reshapeId), before);
  await writeDoc(draft, file, after);
  const afterHash = sha256(await readDoc(draft, file));
  await journal.fact(RefineEvent.DocEdited, { file, hash: afterHash, source: 'reshape' });
  await journal.fact(RefineEvent.DocReshaped, { reshapeId, file, cycle, role, afterHash });
  return null;
}

/** The "Sugerir" path: the document takes its template's layout before the agent writes from it. The layout is a reshape, so the text before it stays on disk. */
export async function formatStageDocument(deps: { draft: Draft; journal: CycleJournal }, cycle: number, file: SuggestFile): Promise<void> {
  const { draft, journal } = deps;
  const before = await readDoc(draft, file);
  if (isNotApplicable(file, before) || isUntouched(file, before, draft.projectId) || shapeProblem(file, before, before, draft.projectId) === null) return;
  if (await undoneLayout(draft, journal.state.reshapes, file, before)) return;
  const layout = formatByTemplate(file, before, draft.projectId);
  if (layout.ok) await commitReshape(deps, cycle, file, SUGGEST_ROLE[file], before, layout.text);
}

/** Lays a stage document out by its template before the review reads it: the algorithm first, and the agent only for a short document the algorithm cannot lay out. A refused reshape leaves the document as it was and says why. */
export async function reshapeStage(deps: ReshapeDeps, cycle: number, file: DocFile, docs: Record<DocFile, string>, discarded: Array<{ role: string; file: string; reason: string }>): Promise<void> {
  if (file === 'flow.md') return;
  const { draft, journal } = deps;
  const before = docs[file];
  // Marked not applicable: the agents improve the mark's text, and it keeps its own shape.
  if (isNotApplicable(file, before)) return;
  // Still the template itself, or already in its shape: nothing to rewrite.
  if (isUntouched(file, before, draft.projectId) || shapeProblem(file, before, before, draft.projectId) === null) return;
  // The owner undid this layout: the text stays as the owner left it until the owner changes it.
  if (await undoneLayout(draft, journal.state.reshapes, file, before)) return;
  const role = SUGGEST_ROLE[file];
  const refuse = (reason: string) => {
    discarded.push({ role, file, reason: `Não reorganizei ${file} no modelo: ${reason}.` });
  };
  // The algorithm goes first: each section moves under the template heading its title fills, and no text is rewritten.
  const layout = formatByTemplate(file, before, draft.projectId);
  if (layout.ok) {
    const refusal = await commitReshape({ draft, journal }, cycle, file, role, before, layout.text);
    docs[file] = await readDoc(draft, file);
    if (refusal !== null) refuse(refusal);
    else await dropCoveredPatches(journal, docs, [file]);
    return;
  }
  // The agent rewrites a short document the algorithm cannot lay out; a long one has no such path, so the algorithm's reason is kept.
  if (estimateTokens(before) > MAX_RESHAPE_TOKENS) {
    refuse(layout.reason);
    return;
  }
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
  const refusal = await commitReshape({ draft, journal }, cycle, file, role, before, out.value.text);
  docs[file] = await readDoc(draft, file);
  if (refusal !== null) {
    refuse(refusal);
    return;
  }
  await dropCoveredPatches(journal, docs, [file]);
}

/** Puts every document in its template's layout on every cycle, so a document moved out of place comes back. */
export async function reshapeAll(deps: ReshapeDeps, cycle: number, docs: Record<DocFile, string>, discarded: Array<{ role: string; file: string; reason: string }>): Promise<void> {
  for (const file of Object.keys(TEMPLATE) as SuggestFile[]) await reshapeStage(deps, cycle, file, docs, discarded);
}
