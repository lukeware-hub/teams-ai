import type { z } from 'zod';
import type { DocMoveProposal, RefineOutput } from '../agents/outputs.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { sha256 } from '../contracts/hash.js';
import { outputContract } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import { failureMessage, internalErrorMessage, retryOnSchema, withNote } from './agent-failure.js';
import { applyMoves, isConfidential, titlesOf, type CycleJournal, type RunAgent } from './cycle.js';
import { DIGEST_NOTE, docDigest } from './docs-view.js';
import { DOC_STAGES, earlierDocs } from './doc-stages.js';
import { draftHash, readDoc, type Draft, type DocFile } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import { fitPackBudget } from './fit-pack.js';
import { jevHint, unavailable, type JevValidationResult, type ValidationDocs } from './jev-validation.js';
import { historyBlocks, reorganizePack } from './packs.js';
import { checkRepeats, droppedOf, STAGE_REPEAT_OVERLAP } from './question-guard.js';
import type { PatchRow, QuestionRow } from './state.js';
import { reshapeAll } from './reshape.js';
import { applyPatch, checkPatch, docOf, patchId, unifiedDiff } from './patches.js';
import { patchChangesScope } from './scope-guard.js';
import { SCORE_CHECKS, type DocScore, type ScoreCheck, type ScoreDoubt } from './readiness.js';

/** The role that reviews a stage's document: the one that owns it. */
const OWNER: Record<DocFile, 'po' | 'sm' | 'front'> = { 'project.md': 'po', 'briefing.md': 'po', 'stack.md': 'sm', 'flow.md': 'po', 'design.md': 'front' };

/** The key of each document in the Jev's validation input. */
const VALIDATION_KEY: Record<DocFile, keyof ValidationDocs> = { 'project.md': 'project', 'briefing.md': 'briefing', 'stack.md': 'stack', 'flow.md': 'flow', 'design.md': 'design' };

/** How much of each earlier document the review reads: every heading, with the start of its section. */
const STAGE_DIGEST_CHARS = 2000;

/** The most passages one stage moves; a stage moves a few lines forward, never whole sections. */
const STAGE_MAX_MOVES = 3;

export interface StageCycleDeps {
  draft: Draft;
  journal: CycleJournal;
  runAgent: RunAgent;
  frontAgent?: RunAgent;
  validateDocs?: (docs: ValidationDocs, stage?: string) => Promise<JevValidationResult>;
  principles: () => readonly string[];
  signal?: AbortSignal;
}

/** The stage document and the documents before it: the only ones a review compares, and the only ones it may move text into. */
const scopeOf = (file: DocFile): DocFile[] => [file, ...earlierDocs(file)];

/** The document a proposal names: its path, its bare name, or a bare name written under `docs/`. */
const namedDoc = (name: string, specId: string): DocFile | undefined => docOf(name, specId) ?? docOf(name.replace(/^docs\//, ''), specId);

/** Whether a proposal names a document of the scope. */
const inScope = (name: string, specId: string, scope: readonly DocFile[]): boolean => {
  const file = namedDoc(name, specId);
  return file !== undefined && scope.includes(file);
};

/** Moves of a stage go forward only: out of its own document and into a later one. */
const forwardMoves = (file: DocFile, specId: string, moves: readonly DocMoveProposal[]): DocMoveProposal[] =>
  moves.filter((m) => {
    const to = namedDoc(m.to, specId);
    return namedDoc(m.from, specId) === file && to !== undefined && DOC_STAGES.indexOf(to) > DOC_STAGES.indexOf(file);
  });

/** What the review looks for in each place the Jev doubts, one sentence per check. */
const LOOK_FOR: Record<ScoreCheck, string> = {
  complete: 'compare the document with the parts its purpose requires; add a missing part, or write that it does not apply',
  concrete: 'replace vague words, placeholders and open questions with exact values, names, limits or observable behavior',
  consistent: 'find two statements that disagree, or something the text says it declares or lists that it does not declare',
  scoped: 'find content the charter gives to another document; if an earlier document lacks it, ask the owner where it goes, and never delete content that no other document holds',
};

/** The place a doubt names in its document: the whole document, or the part with the headings that bound it. */
const placeOf = (doubt: ScoreDoubt): string => {
  if (!doubt.part) return 'the whole document';
  const { index, of, from, to } = doubt.part;
  return `part ${index} of ${of}${from ? `, from "${from}"` : ''}${to ? `, up to "${to}"` : ''}`;
};

/** The Jev's scores of a document for the review, with one line per place it doubts; information only, never a goal. */
function jevIndex(file: DocFile, score: DocScore): string[] {
  const checks = SCORE_CHECKS.map((id) => `${id} ${score.checks[id].toFixed(2)}`).join(', ');
  const doubts = (score.doubts ?? []).map((d) => `- ${d.check} ${d.value.toFixed(2)} in ${placeOf(d)}: ${LOOK_FOR[d.check]}.`);
  return [
    '### Jev index of this document (information only)',
    `Scores of ${file}, probability of yes: ${checks}. They show where the Jev doubts the document; they are not a goal, a minimum or a verdict, and they can be wrong. Do not change the document only to raise a number.`,
    ...(doubts.length ? [`### Where the Jev doubts this document (information only)\nRead these places first. The Jev can be wrong: change only what you can quote as wrong.\n${doubts.join('\n')}`] : []),
  ];
}

/** The review of one stage's document: the owner reads it against the charter, the documents before it as digests, and the Jev's hints as context. */
export function stageReviewPack(input: { role: 'po' | 'sm' | 'front'; specHash: string; principles: readonly string[]; file: DocFile; docs: Record<DocFile, string>; jev?: string; score?: DocScore; specId: string; history: readonly QuestionRow[]; rejected: readonly PatchRow[] }): ContextPackInput {
  const earlier = earlierDocs(input.file);
  const context = earlier.length > 0
    ? [DIGEST_NOTE, ...earlier.map((f) => `### ${f} (context only, a digest)\n${docDigest(input.docs[f], STAGE_DIGEST_CHARS)}`)].join('\n\n')
    : '(no document before this stage)';
  const feedback = [
    `You review only ${input.file}, the document of this stage. Read it line by line against the document charter in your instructions.`,
    '- Propose changes to this document only, as docPatch entries. Touch no other document.',
    '- Return an empty checklist: this stage does not evaluate the checklist.',
    '- List in findings only the problems between this document and the documents before it, each quoting one of them; list in contradictions only the disagreements between them, quoting both sides.',
    '- Ask a question only when the document cannot be completed without the owner; mark it blocking only when the stage cannot continue without the answer.',
    '- Write everything in Brazilian Portuguese. Do not edit any file.',
    ...(input.jev ? [input.jev] : []),
    ...(input.score ? jevIndex(input.file, input.score) : []),
    context,
    `### ${input.file} (this stage)\n${input.docs[input.file]}`,
    ...historyBlocks({ specId: input.specId, decisions: [], history: input.history, rejected: input.rejected }),
  ].join('\n\n');
  return { kind: 'refine', role: input.role, specHash: input.specHash, principles: [...input.principles], outputContract: outputContract('refine'), criteria: [], feedback, budgetTokens: 60_000 };
}

/** One review of a stage's document, in two passes: the reorganization of that document (its moves go forward only), then the owner's review, which asks what the owner must decide and lists findings and contradictions against the documents before it. Then the document's score is taken. */
export async function runStageCycle(deps: StageCycleDeps, cycle: number, file: DocFile): Promise<void> {
  const { draft, journal } = deps;
  const hash = await draftHash(draft);
  await journal.fact(RefineEvent.CycleStarted, { cycle, draftHash: hash });
  try {
    const docs = Object.fromEntries(await Promise.all(DOC_STAGES.map(async (f) => [f, await readDoc(draft, f)]))) as Record<DocFile, string>;
    const scope = scopeOf(file);
    // The stage's own key: a change to a later document leaves the review's key as it was.
    const specHash = sha256(JSON.stringify(scope.map((f) => [f, docs[f]])));
    const role = OWNER[file];
    const run = role === 'front' && deps.frontAgent ? deps.frontAgent : deps.runAgent;
    const call = async (pack: ContextPackInput) => (await run({ kind: 'refine', role, pack, cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, { journal, stepDir: draft.steps, specHash, signal: deps.signal })) as StepOutcome<z.infer<typeof RefineOutput>>;
    // The Jev reads the stage with the documents before it; the first stage has none to compare with, so it is not asked.
    let jev: JevValidationResult | undefined;
    const confidential = await isConfidential(draft, journal.state);
    if (deps.validateDocs && earlierDocs(file).length > 0 && !confidential) {
      const partial = Object.fromEntries(DOC_STAGES.map((f) => [VALIDATION_KEY[f], scope.includes(f) ? docs[f] : ''])) as unknown as ValidationDocs;
      jev = await deps.validateDocs(partial, file).catch(() => unavailable());
      await journal.fact(RefineEvent.DocsValidated, { cycle, backend: 'jev', stage: file, ...jev });
    }
    // The model now and then gives an answer the schema rejects: one more try, told what was wrong, before the stage gives up.
    const askOnce = (pack: ContextPackInput) => retryOnSchema((note) => call(withNote(pack, note)));
    const reorganized = await askOnce(fitPackBudget({ ...reorganizePack({ specHash, principles: deps.principles(), specId: draft.specId, projectMd: docs['project.md'], briefMd: docs['briefing.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'], changed: [file] }), role }));
    if (!reorganized.ok) {
      await journal.fact(RefineEvent.CycleFailed, { cycle, ...failureMessage(`A reorganização de ${file}`, reorganized.failure, reorganized.errors) });
      return;
    }
    const discardedPatches: Array<{ role: string; file: string; reason: string }> = [];
    await applyMoves(journal, draft, cycle, docs, { specId: draft.specId, projectBriefing: false, asked: titlesOf(journal.state.questions.filter((q) => q.status === 'pending').map((q) => q.text)) }, [{ role, moves: forwardMoves(file, draft.specId, reorganized.value.moves ?? []), limit: STAGE_MAX_MOVES }], discardedPatches);
    // Every document takes its template's layout before the review, so the review and its patches read that text.
    await reshapeAll({ draft, journal, runAgent: deps.runAgent, signal: deps.signal }, cycle, docs, discardedPatches);
    let n = 0;
    // Every patch is checked against the documents as the moves and the reshape left them, and only the stage document may change.
    const propose = async (patches: ReadonlyArray<{ file: string; find: string; replace: string; reason: string }>) => {
      for (const p of patches) {
        const check = checkPatch(p, draft.specId, docs);
        if (!check.ok || check.file !== file) continue;
        await journal.fact(RefineEvent.PatchProposed, { patchId: patchId(role, cycle, n++), role, file, find: p.find, replace: p.replace, scopeChange: patchChangesScope(p.find, p.replace), reason: p.reason, diff: unifiedDiff(file, docs[file], applyPatch(docs[file], p)!), cycle });
      }
    };
    await propose(reorganized.value.docPatch);
    // The document's last Jev scores, while they are current and the document has text, go to the review as an index; they set no goal.
    // A confidential project gets no Jev finding, and a blank document's zeros were never answered by the Jev.
    const score = journal.state.readiness?.docs?.[file];
    const indexed = score !== undefined && !confidential && docs[file].trim() !== '' && !(journal.state.outdatedDocs ?? []).includes(file);
    const review = await askOnce(fitPackBudget(stageReviewPack({ role, specHash, principles: deps.principles(), file, docs, jev: jev ? jevHint(jev) : undefined, score: indexed ? score : undefined, specId: draft.specId, history: journal.state.questions, rejected: journal.state.patches.filter((p) => p.status === 'rejected') })));
    if (!review.ok) {
      await journal.fact(RefineEvent.CycleFailed, { cycle, ...failureMessage(`A revisão de ${file}`, review.failure, review.errors) });
      return;
    }
    await propose(review.value.docPatch);
    // Front asks no questions: only the PO and the SM put one to the owner.
    const questions: Question[] = role === 'front' ? [] : [...reorganized.value.questions, ...review.value.questions].map((q, i) => ({
      questionId: `${role}-s${cycle}-${i}`,
      role,
      text: q.text,
      blocking: q.blocking,
      relatedAcIds: q.relatedAcIds,
      ...(q.options.length ? { options: q.options } : {}),
      ...(q.subject ? { subject: q.subject } : {}),
      ...(q.distinctFrom ? { distinctFrom: q.distinctFrom } : {}),
      cycle,
    }));
    // A finding keeps the document it names, as the stage knows it, and stands only when its quote is in that document.
    const findings = (review.value.findings ?? []).flatMap(({ doc, severity, quote, text, fix }) => {
      const named = namedDoc(doc, draft.specId);
      return named !== undefined && scope.includes(named) && docs[named].includes(quote) ? [{ cycle, role, doc: named, severity, quote, text, fix }] : [];
    });
    await journal.fact(RefineEvent.FindingsReported, { cycle, files: scope, findings });
    const divergences = (review.value.contradictions ?? []).filter((c) => inScope(c.a.file, draft.specId, scope) && inScope(c.b.file, draft.specId, scope)).map((c) => c.fact);
    // Plan 103: a question that repeats a decided one is dropped unless its distinctFrom names a real difference. Nothing re-runs:
    // the patches above are already on record, so a second pass would propose them twice.
    const guarded = checkRepeats(questions, journal.state.questions, STAGE_REPEAT_OVERLAP);
    for (const { question, matches } of guarded.unresolved) await journal.fact(RefineEvent.QuestionDropped, droppedOf(question, matches[0]!, file));
    await journal.fact(RefineEvent.StageReviewed, { cycle, file, questions: guarded.kept, divergences, discardedPatches });
  } catch (err) {
    await journal.fact(RefineEvent.CycleFailed, { cycle, ...internalErrorMessage(`A revisão de ${file}`, err) });
  }
}
