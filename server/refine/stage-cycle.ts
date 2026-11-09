import type { z } from 'zod';
import { RefineOutput, type DocMoveProposal } from '../agents/outputs.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { sha256 } from '../contracts/hash.js';
import { outputContract } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import { failureMessage, internalErrorMessage, PROCESS_AGAIN, retryOnSchema, withNote } from './agent-failure.js';
import { isConfidential, type CycleJournal, type RunAgent } from './cycle.js';
import { docSections } from './sections.js';
import { DOC_STAGES, earlierDocs } from './doc-stages.js';
import { draftHash, readDoc, type Draft, type DocFile } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import { fitPackBudget, PackTooLargeError } from './fit-pack.js';
import { historyBlocks, PATCH_WORTH } from './packs.js';
import { checkRepeats, droppedOf, STAGE_REPEAT_OVERLAP } from './question-guard.js';
import type { PatchRow, QuestionRow } from './state.js';
import { reshapeStage } from './reshape.js';
import { applyPatch, checkPatch, docOf, patchId, unifiedDiff, type PendingPatch } from './patches.js';
import { planMove } from './moves.js';
import { patchChangesScope } from './scope-guard.js';
import { MAX_STAGE_PARTS, PART_TOKENS, stageParts } from './stage-parts.js';

/** The times one part is asked when it runs past its time limit, before the round ends. */
const PART_TRIES = 3;
import { consultDocs, fileGraphDir, type GraphNotes } from './stage-consult.js';
import { SCORE_CHECKS, type DocScore, type ScoreCheck, type ScoreDoubt } from './readiness.js';

/** The role that reviews a stage's document: the one that owns it. */
const OWNER: Record<DocFile, 'po' | 'sm' | 'front'> = { 'project.md': 'po', 'briefing.md': 'po', 'stack.md': 'sm', 'flow.md': 'po', 'design.md': 'front' };

/** What the owner's review returns for one part of a document. */
type RefineReview = z.infer<typeof RefineOutput>;

/** The results of every part of one review as one: a patch that two parts both propose is kept once. */
function mergeReviews(outcomes: readonly RefineReview[]) {
  const docPatch = [...new Map(outcomes.flatMap((o) => o.docPatch).map((p) => [`${p.find}\u0000${p.replace}`, p] as const)).values()];
  return {
    docPatch,
    moves: outcomes.flatMap((o) => o.moves ?? []),
    questions: outcomes.flatMap((o) => o.questions),
    findings: outcomes.flatMap((o) => o.findings ?? []),
    contradictions: outcomes.flatMap((o) => o.contradictions ?? []),
  };
}

export interface StageCycleDeps {
  draft: Draft;
  journal: CycleJournal;
  runAgent: RunAgent;
  frontAgent?: RunAgent;
  principles: () => readonly string[];
  signal?: AbortSignal;
  /** The key of the document's last finished review: an identical review is not asked of the agent again. */
  lastReviewKey?: (file: DocFile) => string | undefined;
  /** Graph notes of a document's graph folder; without it the review consults by search alone. */
  graphNotes?: GraphNotes;
}

/** The key of the last finished review of a document in the journal's events. */
export function lastReviewKeyOf(events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>, file: DocFile): string | undefined {
  const last = [...events].reverse().find((e) => e.type === RefineEvent.StageReviewed && e.data.file === file);
  return typeof last?.data.inputKey === 'string' ? last.data.inputKey : undefined;
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

/** What the review looks for in each place the Jev doubts, one sentence per check. */
const LOOK_FOR: Record<ScoreCheck, string> = {
  complete: 'compare the document with the parts its purpose requires; add a missing part, or write that it does not apply',
  concrete: 'replace a vague word or placeholder with the exact value, name, limit or behavior the documents already give; when they do not give it, record it as an assumption and change no text; never reword a question mark, a label or a comment',
  consistent: 'find two statements that disagree, or something the text says it declares or lists that it does not declare',
  scoped: 'find content the charter gives to another document; if an earlier document already holds it, remove it here; if not, propose a move to the earlier document that should hold it; content of a later document stays here',
};

/** A move the review proposes, as one suggestion: it takes the quote out of the stage document and adds the text to an earlier one, and nothing changes until the owner accepts it. */
export function moveSuggestion(move: DocMoveProposal, file: DocFile, docs: Record<DocFile, string>, specId: string): { ok: true; patch: Omit<PendingPatch, 'patchId' | 'role'> } | { ok: false; reason: string } {
  const plan = planMove(move, { specId, projectBriefing: false, docs, blank: new Set(), applied: [], undone: [] });
  if (!plan.ok) return plan;
  if (plan.from !== file || !earlierDocs(file).includes(plan.to)) return { ok: false, reason: `Esta etapa só move trechos de ${file} para um documento anterior.` };
  const keep = move.keep?.trim();
  const cut = keep ? { find: move.quote, replace: keep } : { find: plan.cut.removed, replace: '' };
  // The text already in the earlier document needs no second edit; the move then only takes the quote out.
  const add = plan.put.inserted === '' ? undefined : move.after ? { find: move.after, replace: move.after + plan.put.inserted } : { find: '', replace: move.text.trim() };
  const diff = unifiedDiff(file, docs[file], applyPatch(docs[file], cut)!) + (add ? unifiedDiff(plan.to, docs[plan.to], applyPatch(docs[plan.to], add)!) : '');
  return { ok: true, patch: { file, ...cut, reason: `Move para ${plan.to}: ${move.reason}`, diff, scopeChange: patchChangesScope(cut.find, cut.replace), ...(add ? { also: { file: plan.to, ...add } } : {}) } };
}

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
    `Scores of ${file}, probability of yes: ${checks}. They show where the Jev doubts the document; they are not a verdict and they can be wrong; a low score only means read the doubts below with care. Do not change the document only to raise a number.`,
    ...(doubts.length ? [`### Where the Jev doubts this document (information only)\nRead these places first. The Jev can be wrong: change only what you can quote as wrong.\n${doubts.join('\n')}`] : []),
  ];
}

/** One part of a stage document too big for one review: its text, and its place among the parts. */
export interface ReviewPart {
  index: number;
  total: number;
  text: string;
}

/** The review of one stage's document: the owner reads this part against the charter, the Jev's hints as context, and the other documents only as the consult shows them. */
export function stageReviewPack(input: { role: 'po' | 'sm' | 'front'; specHash: string; principles: readonly string[]; file: DocFile; docs: Record<DocFile, string>; score?: DocScore; specId: string; history: readonly QuestionRow[]; rejected: readonly PatchRow[]; part?: ReviewPart; consult?: string }): ContextPackInput {
  const part = input.part;
  // The other documents are sources of truth too: the review reads them only as the consult shows them, never whole.
  const context = `### Consulted: the other documents, which are sources of truth too (search and graph; none is read in full)\n${input.consult ?? 'Nothing was consulted for this part.'}`;
  // With parts, the outline lists every heading of the whole document, so a part can say where the rest of it is.
  const outline = part ? docSections(input.docs[input.file]).map((s) => `- ${s.heading} (line ${s.line + 1})`) : [];
  const feedback = [
    part
      ? `You review only ${input.file}, the document of this stage, part ${part.index} of ${part.total}. Read the part below against the document charter in your instructions. Quote only text that is in this part; the outline lists the headings of the whole document.`
      : `You review only ${input.file}, the document of this stage. Read it whole against the document charter in your instructions: look for what is missing, wrong or contradicted, not for wording.`,
    '- Propose changes to this document only, as docPatch entries. Touch no other document.',
    `- Content of this document that the charter gives to a document before it (${earlierDocs(input.file).join(', ') || 'none'}) is a move, not a patch. When that document already holds it, remove it here with a docPatch instead. Each move is one entry in moves: from is this document; to is the earlier document that should hold it; quote is the whole lines to take out, copied character for character and found once; text is the same content written for that document, keeping every number and name; after is an exact existing line of that document to place the text below, or absent to append it at the end; keep is what stays here in place of the quote, such as how the screen shows the rule, or absent to cut it; reason says why it belongs there. Never move to a document after this stage. The owner accepts or rejects each move; nothing changes before.`,
    '- Return an empty checklist: this stage does not evaluate the checklist.',
    '- List in findings only the problems between this document and the documents before it, each quoting one of them; list in contradictions only the disagreements between them, quoting both sides. A document after this stage is reference only: raise nothing against it.',
    '- Ask a question only under question rule 5 (a scope change nothing that exists settles); decide everything else yourself and record it as an assumption. Mark a question blocking only when the stage cannot continue without the answer.',
    '- You have no tools: this part, its outline and the consult of the other documents are in this message. Do not look for other files; what the consult does not show, you do not know.',
    '- Write everything in Brazilian Portuguese. Do not edit any file.',
    PATCH_WORTH,
    ...(input.score ? jevIndex(input.file, input.score) : []),
    context,
    `### ${input.file} (this stage${part ? `, part ${part.index} of ${part.total}` : ''})\n${part ? part.text : input.docs[input.file]}`,
    ...(part ? [`### ${input.file} outline (the whole document)\n${outline.join('\n')}`] : []),
    ...historyBlocks({ specId: input.specId, decisions: [], history: input.history, rejected: input.rejected }),
  ].join('\n\n');
  return { kind: 'refine', role: input.role, specHash: input.specHash, principles: [...input.principles], outputContract: outputContract('refine'), criteria: [], feedback, budgetTokens: 60_000 };
}

/** One review of a stage's document, in one pass: the owner's review, which asks what the owner must decide and lists findings and contradictions against the documents before it. Then the document's score is taken. Only the stage document changes. */
export async function runStageCycle(deps: StageCycleDeps, cycle: number, file: DocFile): Promise<void> {
  const { draft, journal } = deps;
  const hash = await draftHash(draft);
  await journal.fact(RefineEvent.CycleStarted, { cycle, draftHash: hash, file });
  try {
    const docs = Object.fromEntries(await Promise.all(DOC_STAGES.map(async (f) => [f, await readDoc(draft, f)]))) as Record<DocFile, string>;
    const scope = scopeOf(file);
    // The stage's own key: a change to a later document leaves the review's key as it was.
    const specHash = sha256(JSON.stringify(scope.map((f) => [f, docs[f]])));
    // What the review reads: the documents, the answers and the decisions on suggestions. The same input gives the same review.
    const inputKey = sha256(JSON.stringify([specHash, deps.principles(), journal.state.questions.map((q) => [q.questionId, q.status, q.answer ?? null]), journal.state.patches.map((p) => [p.patchId, p.status]), journal.state.readiness?.docs?.[file] ?? null]));
    if (deps.lastReviewKey?.(file) === inputKey) {
      await journal.fact(RefineEvent.StageReviewed, { cycle, file, questions: [], divergences: journal.state.stageAlignment?.[file] ?? [], discardedPatches: [], inputKey, replayed: true });
      return;
    }
    const role = OWNER[file];
    const run = role === 'front' && deps.frontAgent ? deps.frontAgent : deps.runAgent;
    const call = async (pack: ContextPackInput, part?: { index: number; total: number }) => (await run({ kind: 'refine', role, pack, cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle, review: true, part }, { journal, stepDir: draft.steps, specHash, signal: deps.signal })) as StepOutcome<z.infer<typeof RefineOutput>>;
    // The stage document takes its template's layout first, so the Jev, the review and its patches all read that text.
    const discardedPatches: Array<{ role: string; file: string; reason: string }> = [];
    await reshapeStage({ draft, journal, runAgent: deps.runAgent, signal: deps.signal }, cycle, file, docs, discardedPatches);
    const confidential = await isConfidential(draft, journal.state);
    // The model now and then gives an answer the schema rejects: one more try, told what was wrong, before the stage gives up.
    const askOnce = (pack: ContextPackInput, part?: { index: number; total: number }) => retryOnSchema((note) => call(withNote(pack, note), part), RefineOutput);
    // A part that runs past its time limit is asked again: the parts already read are kept, so one slow part does not end the round.
    const askPart = async (pack: ContextPackInput, part?: { index: number; total: number }) => {
      let review = await askOnce(pack, part);
      for (let tries = 1; !review.ok && review.failure === 'timeout' && tries < PART_TRIES && !deps.signal?.aborted; tries += 1) review = await askOnce(pack, part);
      return review;
    };
    let n = 0;
    // Every patch is checked against the documents as the reshape left them, and only the stage document may change.
    const propose = async (patches: ReadonlyArray<{ file: string; find: string; replace: string; reason: string }>) => {
      for (const p of patches) {
        const check = checkPatch(p, draft.specId, docs);
        if (!check.ok) continue;
        if (check.file !== file) {
          discardedPatches.push({ role, file: check.file, reason: `Esta etapa só altera ${file}: o ajuste a ${check.file} foi descartado.` });
          continue;
        }
        await journal.fact(RefineEvent.PatchProposed, { patchId: patchId(role, cycle, n++), role, file, find: p.find, replace: p.replace, scopeChange: patchChangesScope(p.find, p.replace), reason: p.reason, diff: unifiedDiff(file, docs[file], applyPatch(docs[file], p)!), cycle });
      }
    };
    // The document's last Jev scores, while they are current and the document has text, go to the review as an index; they set no goal.
    // A confidential project gets no Jev finding, and a blank document's zeros were never answered by the Jev.
    const score = journal.state.readiness?.docs?.[file];
    const indexed = score !== undefined && !confidential && docs[file].trim() !== '' && !(journal.state.outdatedDocs ?? []).includes(file);
    // A document too big for one review is read in parts, one review each; the parts' results are then reviewed as one.
    const parts = stageParts(docs[file], PART_TOKENS);
    if (parts.length > MAX_STAGE_PARTS) throw new PackTooLargeError(`O documento ${file} tem ${parts.length} partes; o limite é ${MAX_STAGE_PARTS}. Reduza ou divida o documento.`);
    const outcomes: RefineReview[] = [];
    for (const [i, text] of parts.entries()) {
      const part = parts.length > 1 ? { index: i + 1, total: parts.length, text } : undefined;
      // The other documents are consulted for this part, by search and by graph; none is read whole.
      const consult = await consultDocs({ docs, consulted: DOC_STAGES.filter((f) => f !== file), part: text, graphDirOf: (doc) => fileGraphDir(draft.root, doc), graphNotes: deps.graphNotes });
      const review = await askPart(fitPackBudget(stageReviewPack({ role, specHash, principles: deps.principles(), file, docs, score: indexed ? score : undefined, specId: draft.specId, history: journal.state.questions, rejected: journal.state.patches.filter((p) => p.status === 'rejected'), part, consult })), part ? { index: part.index, total: part.total } : undefined);
      if (!review.ok) {
        const label = part ? `A revisão da parte ${part.index} de ${part.total} de ${file}` : `A revisão de ${file}`;
        await journal.fact(RefineEvent.CycleFailed, { cycle, ...failureMessage(label, review.failure, review.errors, PROCESS_AGAIN) });
        return;
      }
      outcomes.push(review.value);
    }
    const merged = mergeReviews(outcomes);
    await propose(merged.docPatch);
    for (const move of merged.moves) {
      const made = moveSuggestion(move, file, docs, draft.specId);
      if (!made.ok) discardedPatches.push({ role, file, reason: `Movimento descartado: ${made.reason}` });
      else await journal.fact(RefineEvent.PatchProposed, { patchId: patchId(role, cycle, n++), role, ...made.patch, cycle });
    }
    // A visual scope gap Front finds goes to the owner through the PO, so it is never lost.
    const asker = role === 'front' ? 'po' : role;
    const questions: Question[] = merged.questions.map((q, i) => ({
      questionId: `${role}-s${cycle}-${i}`,
      role: asker,
      text: q.text,
      blocking: q.blocking,
      relatedAcIds: q.relatedAcIds,
      ...(q.options.length ? { options: q.options } : {}),
      ...(q.subject ? { subject: q.subject } : {}),
      ...(q.distinctFrom ? { distinctFrom: q.distinctFrom } : {}),
      cycle,
    }));
    // A finding keeps the document it names, as the stage knows it, and stands only when its quote is in that document.
    const findings = merged.findings.flatMap(({ doc, severity, quote, text, fix }) => {
      const named = namedDoc(doc, draft.specId);
      return named !== undefined && scope.includes(named) && docs[named].includes(quote) ? [{ cycle, role, doc: named, severity, quote, text, fix }] : [];
    });
    await journal.fact(RefineEvent.FindingsReported, { cycle, files: scope, findings });
    const divergences = merged.contradictions.filter((c) => inScope(c.a.file, draft.specId, scope) && inScope(c.b.file, draft.specId, scope)).map((c) => c.fact);
    // Plan 103: a question that repeats a decided one is dropped unless its distinctFrom names a real difference. Nothing re-runs:
    // the patches above are already on record, so a second pass would propose them twice.
    const guarded = checkRepeats(questions, journal.state.questions, STAGE_REPEAT_OVERLAP);
    for (const { question, matches } of guarded.unresolved) await journal.fact(RefineEvent.QuestionDropped, droppedOf(question, matches[0]!, file));
    await journal.fact(RefineEvent.StageReviewed, { cycle, file, questions: guarded.kept, divergences, discardedPatches, inputKey });
  } catch (err) {
    await journal.fact(RefineEvent.CycleFailed, { cycle, ...internalErrorMessage(`A revisão de ${file}`, err, PROCESS_AGAIN) });
  }
}
