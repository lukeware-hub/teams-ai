import type { z } from 'zod';
import type { RefineOutput } from '../agents/outputs.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import { isConfidential, recordScore, type CycleJournal, type RunAgent, type ScoreDeps } from './cycle.js';
import { DOC_STAGES, earlierDocs } from './doc-stages.js';
import { draftHash, readDoc, type Draft, type DocFile } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import { fitPackBudget } from './fit-pack.js';
import { applyPatch, checkPatch, patchId, unifiedDiff } from './patches.js';

/** The role that reviews a stage's document: the one that owns it. */
const OWNER: Record<DocFile, 'po' | 'sm' | 'front'> = { 'project.md': 'po', 'briefing.md': 'po', 'stack.md': 'sm', 'flow.md': 'po', 'design.md': 'front' };

export interface StageCycleDeps {
  draft: Draft;
  journal: CycleJournal;
  runAgent: RunAgent;
  frontAgent?: RunAgent;
  scoreDocs?: ScoreDeps['scoreDocs'];
  principles: () => readonly string[];
  signal?: AbortSignal;
}

/** The review of one stage's document: the owner reads it against the charter; the documents before it are context only. */
export function stageReviewPack(input: { role: 'po' | 'sm' | 'front'; specHash: string; principles: readonly string[]; file: DocFile; docs: Record<DocFile, string> }): ContextPackInput {
  const earlier = earlierDocs(input.file);
  const context = earlier.length > 0 ? earlier.map((f) => `### ${f} (context only)\n${input.docs[f]}`).join('\n\n') : '(no document before this stage)';
  const feedback = [
    `You review only docs/${input.file}, the document of this stage. Read it line by line against the document charter in your instructions.`,
    '- Propose changes to this document only, as docPatch entries. Move nothing and touch no other document.',
    '- Return an empty checklist and empty findings: this stage does not evaluate the checklist.',
    '- Ask a question only when the document cannot be completed without the owner; mark it blocking only when the stage cannot continue without the answer.',
    '- Write everything in Brazilian Portuguese. Do not edit any file.',
    context,
    `### ${input.file} (this stage)\n${input.docs[input.file]}`,
  ].join('\n\n');
  return { kind: 'refine', role: input.role, specHash: input.specHash, principles: [...input.principles], outputContract: outputContract('refine'), criteria: [], feedback, budgetTokens: 60_000 };
}

/** One review of a stage's document: the owner proposes changes to that document only and asks what the owner must decide, then the document's score is taken. No derivation and no checklist. */
export async function runStageCycle(deps: StageCycleDeps, cycle: number, file: DocFile): Promise<void> {
  const { draft, journal } = deps;
  const hash = await draftHash(draft);
  await journal.fact(RefineEvent.CycleStarted, { cycle, draftHash: hash });
  try {
    const docs = Object.fromEntries(await Promise.all(DOC_STAGES.map(async (f) => [f, await readDoc(draft, f)]))) as Record<DocFile, string>;
    const role = OWNER[file];
    const run = role === 'front' && deps.frontAgent ? deps.frontAgent : deps.runAgent;
    const pack = fitPackBudget(stageReviewPack({ role, specHash: hash, principles: deps.principles(), file, docs }));
    const out = (await run({ kind: 'refine', role, pack, cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, { journal, stepDir: draft.steps, specHash: hash, signal: deps.signal })) as StepOutcome<z.infer<typeof RefineOutput>>;
    if (!out.ok) {
      await journal.fact(RefineEvent.CycleFailed, { cycle, reason: `stage review failed: ${out.failure}: ${out.errors.join('; ')}` });
      return;
    }
    let n = 0;
    for (const p of out.value.docPatch) {
      const check = checkPatch(p, draft.specId, docs);
      if (!check.ok || check.file !== file) continue;
      await journal.fact(RefineEvent.PatchProposed, { patchId: patchId(role, cycle, n++), role, file, find: p.find, replace: p.replace, reason: p.reason, diff: unifiedDiff(file, docs[file], applyPatch(docs[file], p)!), cycle });
    }
    // Front asks no questions: only the PO and the SM put one to the owner.
    const questions: Question[] = role === 'front' ? [] : out.value.questions.map((q, i) => ({
      questionId: `${role}-s${cycle}-${i}`,
      role,
      text: q.text,
      blocking: q.blocking,
      relatedAcIds: q.relatedAcIds,
      ...(q.options.length ? { options: q.options } : {}),
      ...(q.subject ? { subject: q.subject } : {}),
      cycle,
    }));
    await journal.fact(RefineEvent.StageReviewed, { cycle, questions });
    if (deps.scoreDocs) await recordScore({ draft, journal, scoreDocs: deps.scoreDocs }, cycle, await isConfidential(draft, journal.state), [file]);
  } catch (err) {
    await journal.fact(RefineEvent.CycleFailed, { cycle, reason: err instanceof Error ? err.message : String(err) });
  }
}
