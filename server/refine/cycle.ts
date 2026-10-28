import type { AnswerOutput, BacklogOutput, DeriveOutput, DocMoveProposal, OutputOf, RefineOutput, StepKind } from '../agents/outputs.js';
import type { z } from 'zod';
import { Project } from '../contracts/project.js';
import type { AcceptanceCriterion, Spec } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Journal } from '../orchestrator/events.js';
import type { Decider } from '../decide/decider.js';
import type { DecisionRecord } from '../decide/types.js';
import { contradictedChunks, duplicatePairs, duplicatePatches, notReadyCriteria } from '../decide/decisions/gate1.js';
import { routeQuestion } from '../decide/decisions/question-routing.js';
import type { AgentStepRequest } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import { adjustmentsDue, approvalPatch, approvedAdjustments, isAdjustment, type DueAdjustment } from './adjustments.js';
import { failureMessage, internalErrorMessage, retryOnSchema, withNote } from './agent-failure.js';
import { mergeChecklist, type ChecklistItem } from './checklist.js';
import { verifyContradictions } from './contradictions.js';
import { norm, parseDecisions } from './decisions.js';
import { derivePack, postProcessDerived } from './derive.js';
import { answerPack } from './answer.js';
import { heldForOwner } from './auto-floor.js';
import { backlogPack, postProcessBacklog, renderBacklogMd, type BacklogCheck } from './backlog.js';
import { fitPackBudget, PackTooLargeError } from './fit-pack.js';
import { sha256 } from '../contracts/hash.js';
import { flowHeadings } from '../validators/backlog.js';
import { flowIsMermaid } from './sections.js';
import { uniqueHeadingFixes } from './heading-fixes.js';
import { detailBacklog, maxCriterionInDraft, retireDropped } from './detail-cycle.js';
import { isStarted } from './coverage.js';
import { DOC_REL, draftHash, flowTemplate, keepBaseProject, readBase, readDerived, readDoc, readMainSpec, stackTemplate, writeBacklogMd, writeDerived, writeDoc, writeProject, writeSpecsIndex, type DocFile, type Draft } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import { plainOutlineQuestion } from './question-choices.js';
import { questionPairs } from './question-pairs.js';
import { checkRepeats, droppedOf, ROUND_REPEAT_OVERLAP } from './question-guard.js';
import { buildSpecsIndex, outlineOfIndex, specIdOf, type SpecsIndex } from './specs-index.js';
import type { JevValidationResult, ValidationDocs } from './jev-validation.js';
import { PATCH_FILES, patchOwners, reorganizeGroups, reorganizePack, refinePack } from './packs.js';
import { reshapeAll } from './reshape.js';
import { applyPatch, checkPatch, COVERED_REASON, patchId, unifiedDiff } from './patches.js';
import { patchChangesScope } from './scope-guard.js';
import { planMove } from './moves.js';
import { applyRefineEvent, nextStuck, STUCK_ROUNDS, type BacklogState, type RefineState } from './state.js';
import { scoresDocs, UNSCORED, type DocsScoreRecord } from './readiness.js';

export type RunAgent = <K extends StepKind>(
  req: AgentStepRequest<K>,
  ctx: { journal: Pick<Journal, 'allocStepSeq' | 'fact'>; stepDir: (seq: number) => string; specHash: string; signal?: AbortSignal; /** Answer at once when the quota is paused instead of waiting for it (a person is at the screen). */ noQuotaWait?: boolean; /** The project whose agent settings apply to the step. */ projectId?: string },
) => Promise<StepOutcome<OutputOf<K>>>;

export interface CycleJournal extends Pick<Journal, 'allocStepSeq' | 'fact'> {
  readonly state: RefineState;
}

export interface CycleDeps {
  draft: Draft;
  journal: CycleJournal;
  runAgent: RunAgent;
  frontAgent?: RunAgent;
  principles: () => readonly string[];
  retrieval: (query: string) => readonly Hit[];
  validateDocs?: (docs: ValidationDocs, stage?: string) => Promise<JevValidationResult>;
  /** Spec 10A.5 decisions 2–4; absent (or the layer off) leaves the cycle as it was. */
  decider?: Pick<Decider, 'decide'>;
  /** Aborting kills the agent steps this cycle has running. */
  signal?: AbortSignal;
  /** R11.5.7: the measured confidence floor for answering a question routed `auto` from the docs; unset leaves every question with the human. */
  autoAnswerFloor?: number;
  /** The Jev's score of the five documents, journaled once per cycle of a new project or a backlog. */
  scoreDocs?: (docs: Record<DocFile, string>, files?: readonly DocFile[]) => Promise<DocsScoreRecord>;
}

/** Main's outline, from its specs.json in the base copy, for a new draft's first outline; the draft's own state when main has none. */
async function mainOutline(draft: Draft, before: BacklogState | null): Promise<BacklogState | null> {
  try {
    const index = JSON.parse((await readBase(draft, 'specs.json')) ?? 'null') as SpecsIndex | null;
    if (!index?.specs?.length) return before;
    // A file of the target repository whose keys become paths in the draft: one that is not a slug leaves main's outline out.
    if (!index.specs.every((s) => [s.specId, s.key, ...s.dependsOn].every((v) => typeof v === 'string' && ID_PATTERNS.SLUG.test(v)))) return before;
    return { ...(before ?? { enabled: true, project: null, cycle: 0 }), ...outlineOfIndex(index) } as BacklogState;
  } catch {
    return before;
  }
}

const MAX_HISTORY_CHUNKS = 5;

/** Journals every decision the wrapped decider makes as DECISION_MADE (spec 10A.4): the full record when the decider gives one, so the attempts, usage and low-confidence answers of a call stay. */
export function recorded(decider: Pick<Decider, 'decide'>, journal: Pick<Journal, 'fact'>, cycle: number): Pick<Decider, 'decide'> {
  return {
    decide: async (id, state, questions, ctx) => {
      const started = Date.now();
      const captured: { record?: DecisionRecord } = {};
      const outcome = await decider.decide(id, state, questions, { ...ctx, onRecord: (record) => (captured.record = record) });
      const base = captured.record ?? (outcome.answered
        ? { decisionId: id, backend: outcome.backend, escalated: outcome.escalated, answers: outcome.answers, durationMs: Date.now() - started }
        : { decisionId: id, backend: null, escalated: false, answers: null, durationMs: Date.now() - started, ...(outcome.reason === 'error' ? { error: outcome.message } : {}) });
      await journal.fact(RefineEvent.DecisionMade, { cycle, record: outcome.answered ? base : { ...base, unanswered: outcome.reason } });
      return outcome;
    },
  };
}

/** What `recordScore` needs: the draft to read, the journal to write, and the Jev's scorer. */
export interface ScoreDeps {
  draft: Draft;
  journal: CycleJournal;
  scoreDocs: NonNullable<CycleDeps['scoreDocs']>;
}

/** A confidential project's documents never leave for the OpenRouter; the owner's answer or its records decide. */
export async function isConfidential(draft: Draft, state: RefineState): Promise<boolean> {
  if (state.confidential === true) return true;
  // A stage session stays confidential until the owner answers, so no document goes to the Jev unasked.
  if (state.stages === true && state.confidential === undefined) return true;
  const base = Project.safeParse(JSON.parse((await readBase(draft, 'project.json')) ?? 'null')).data?.confidential === true;
  return base || state.backlog?.project?.confidential === true || (await readDerived(draft))?.project.confidential === true;
}

/** Journals the Jev's score of the documents asked for (all five by default) as they stand now; a current score is kept, and a confidential project is never sent. */
export async function recordScore(deps: ScoreDeps, cycle: number, confidential: boolean, files: readonly DocFile[] = REORGANIZED_FILES): Promise<void> {
  const { readiness: current, outdatedDocs = [] } = deps.journal.state;
  const covered = files.every((file) => current?.docs?.[file] !== undefined && !outdatedDocs.includes(file));
  if (current && (current.skipped ? confidential && !current.outdated : covered)) return;
  if (confidential) {
    await deps.journal.fact(RefineEvent.DocsScored, { ...UNSCORED, cycle, skipped: 'confidential' });
    return;
  }
  const docs = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readDoc(deps.draft, file)]))) as Record<DocFile, string>;
  const scored = await deps.scoreDocs(docs, files).catch(() => UNSCORED);
  await deps.journal.fact(RefineEvent.DocsScored, { cycle, files, ...scored });
}

const BLANK_FILES = ['stack.md', 'flow.md'] as const;
const BLANK_TEMPLATE: Record<(typeof BLANK_FILES)[number], () => string> = { 'stack.md': stackTemplate, 'flow.md': flowTemplate };

/** The SM fills a blank template only with text that keeps its shape: a Mermaid diagram for flow.md, the template's headings for stack.md. */
function fillsTemplate(file: (typeof BLANK_FILES)[number], text: string): boolean {
  const template = BLANK_TEMPLATE[file]();
  if (text.trim() === '' || text.trim() === template.trim()) return false;
  if (file === 'flow.md') return flowIsMermaid(text);
  return template.split('\n').filter((line) => line.startsWith('## ')).every((heading) => text.includes(heading));
}

/** A role may move at most this many pieces of content in one cycle; the rest are discarded with the reason. */
const MAX_MOVES_PER_ROLE = 3;
/** The reorganization pass is the whole job of its call, so it may move more than a review. */
const REORGANIZE_MAX_MOVES = 20;
const REORGANIZED_FILES: readonly DocFile[] = ['project.md', 'briefing.md', 'stack.md', 'flow.md', 'design.md'];

/** The titles a question quotes in double quotes, normalized: the section a pending question is about. */
export const titlesOf = (texts: readonly string[]) => texts.flatMap((t) => [...t.matchAll(/"([^"]{4,})"/g)].map((m) => norm(m[1]!)));

/** Texts of the questions waiting for the owner, the ones of this cycle's reorganization included. */
const askedTexts = (s: RefineState, pending: ReadonlyArray<{ text: string }>) => [...s.questions.filter((q) => q.status === 'pending').map((q) => q.text), ...pending.map((q) => q.text)];

/** A pending suggestion whose quoted text no longer stands in its document leaves the list now, as after an accepted patch. */
export async function dropCoveredPatches(journal: CycleJournal, docs: Record<DocFile, string>, files: readonly DocFile[]): Promise<void> {
  for (const p of journal.state.patches) {
    if (p.status === 'pending' && files.includes(p.file) && applyPatch(docs[p.file], p) === null) {
      await journal.fact(RefineEvent.PatchDropped, { patchId: p.patchId, reason: COVERED_REASON });
    }
  }
}

/** Applies the moves role by role (Front, PO, SM), each against the documents as the earlier ones left them; a refused move is discarded with its reason. */
export async function applyMoves(
  journal: CycleJournal,
  draft: Draft,
  cycle: number,
  docs: Record<DocFile, string>,
  scope: { specId: string; projectBriefing: boolean; asked: readonly string[] },
  proposals: ReadonlyArray<{ role: 'front' | 'po' | 'sm'; moves: readonly DocMoveProposal[]; limit: number }>,
  discarded: Array<{ role: string; file: string; reason: string }>,
): Promise<void> {
  const blank = new Set(BLANK_FILES.filter((f) => docs[f] === BLANK_TEMPLATE[f]()));
  for (const { role, moves, limit } of proposals) {
    // Counted from the journal, so a move id of this cycle never repeats one an earlier pass gave the same role.
    let index = journal.state.moves.filter((m) => m.cycle === cycle && m.role === role).length;
    for (const [n, move] of moves.entries()) {
      if (n >= limit) {
        discarded.push({ role, file: move.from, reason: `mais de ${limit} movimentos em um ciclo` });
        continue;
      }
      // A section a question still waits on is the owner's to decide: no role moves it before the answer.
      const cited = scope.asked.find((title) => norm(move.quote).includes(title));
      if (cited) {
        discarded.push({ role, file: move.from, reason: `a pergunta pendente cita este trecho: "${cited}"` });
        continue;
      }
      const plan = planMove(move, {
        ...scope,
        docs,
        blank,
        applied: journal.state.moves.filter((m) => m.status === 'applied'),
        undone: journal.state.moves.filter((m) => m.status === 'undone'),
      });
      if (!plan.ok) {
        discarded.push({ role, file: move.from, reason: plan.reason });
        continue;
      }
      const { from, to, cut, put } = plan;
      await writeDoc(draft, from, cut.next);
      await writeDoc(draft, to, put.next);
      // The texts as they are on disk: writeDoc adds a final line break, and undo compares hashes of these texts.
      docs[from] = await readDoc(draft, from);
      docs[to] = await readDoc(draft, to);
      const fromHash = sha256(docs[from]);
      const toHash = sha256(docs[to]);
      await journal.fact(RefineEvent.DocEdited, { file: from, hash: fromHash, source: 'move' });
      await journal.fact(RefineEvent.DocEdited, { file: to, hash: toHash, source: 'move' });
      await journal.fact(RefineEvent.DocMoved, {
        moveId: `move-${role}-c${cycle}-${index++}`, role, cycle, from, to, reason: move.reason, quote: move.quote, text: move.text.trim(),
        removedAt: cut.removedAt, removed: cut.removed, insertAt: put.insertAt, inserted: put.inserted, fromHash, toHash,
      });
      await dropCoveredPatches(journal, docs, [from, to]);
    }
  }
}

/** Spec (refinement) §3.2: derive → Front → PO ∥ SM → merge questions → check patches → checklist. */
/** A spec or pre-plan that failed to generate is a gap only the human closes: one blocking question per item, unless one already asks about it. */
export function failedGapQuestions(backlog: BacklogState | null, cycle: number, asked: readonly string[]): Question[] {
  const detailed = backlog?.detail === true ? backlog : null;
  const out: Question[] = [];
  for (const item of detailed?.items ?? []) {
    if (asked.some((text) => text.includes(item.key)) || out.some((q) => q.text.includes(item.key))) continue;
    const failed = [['po', detailed?.specs?.[item.key]], ['sm', detailed?.preplans?.[item.key]]] as const;
    const [role, row] = failed.find(([, r]) => r?.issues?.length) ?? [];
    const issue = row?.issues?.[0];
    if (!role || !issue) continue;
    const what = role === 'po' ? 'a spec' : 'o pré-plano';
    out.push({
      questionId: `gap-c${cycle}-${out.length}`,
      role,
      text: `O item ${item.key} (${item.title}) não conseguiu gerar ${what}: "${issue}". Como o backlog deve tratar isso?`,
      blocking: true,
      relatedAcIds: [],
      cycle,
      options: [
        { label: 'Dividir o item em menores', detail: 'O item vira dois ou mais itens, cada um com escopo menor.', recommended: true },
        { label: 'Reduzir o escopo do item', detail: 'Escreva na resposta o que o item deixa de fazer.' },
        { label: 'Manter e detalhar nos documentos', detail: 'Escreva na resposta a decisão que falta nos documentos.' },
      ],
    });
  }
  return out;
}

/** The checks that failed the same rounds in a row, as one blocking question for the human: fix the named document, then evaluate again. */
export function stuckQuestion(failing: readonly ChecklistItem[], cycle: number): Question {
  const ids = failing.map((i) => i.id).join(', ');
  const details = failing.map((i) => `${i.id}: ${i.detail}`).join(' ');
  return {
    questionId: `stuck-c${cycle}`,
    role: failing[0]!.role,
    text: `Os critérios ${ids} continuam reprovados após ${STUCK_ROUNDS} rodadas seguidas. ${details} Corrija o documento indicado e reavalie.`,
    blocking: true,
    relatedAcIds: [],
    cycle,
    rule: `stuck:${failing.map((i) => i.id).sort().join(',')}`,
  };
}

/** The rules a backlog outline breaks, each as a blocking question for the owner; a pending question that already names a rule is not asked again. */
export function outlineQuestions(issues: readonly string[], cycle: number, asked: readonly string[]): Question[] {
  return issues.filter((issue) => !asked.some((text) => text.includes(issue))).map((issue, n) => ({
    questionId: `outline-c${cycle}-${n}`,
    role: 'po' as const,
    ...plainOutlineQuestion(issue),
    blocking: true,
    relatedAcIds: [],
    cycle,
    rule: issue,
  }));
}

export async function runCycle(deps: CycleDeps, cycle: number): Promise<void> {
  try {
    await runCycleSteps(deps, cycle);
  } catch (err) {
    // Any error fails the cycle, so the session never stays in `evaluating`; documents beyond the pack cap are an expected failure.
    await deps.journal.fact(RefineEvent.CycleFailed, { cycle, ...internalErrorMessage('A avaliação', err) });
    if (!(err instanceof PackTooLargeError)) throw err;
  }
}

async function runCycleSteps(deps: CycleDeps, cycle: number): Promise<void> {
  const { draft, journal } = deps;
  const decider = deps.decider ? recorded(deps.decider, journal, cycle) : undefined;
  const hash = await draftHash(draft);
  await journal.fact(RefineEvent.CycleStarted, { cycle, draftHash: hash });
  const ctx = { journal, stepDir: draft.steps, specHash: hash, signal: deps.signal };
  const docs: Record<DocFile, string> = {
    'project.md': await readDoc(draft, 'project.md'),
    'briefing.md': await readDoc(draft, 'briefing.md'),
    'stack.md': await readDoc(draft, 'stack.md'),
    'flow.md': await readDoc(draft, 'flow.md'),
    'design.md': await readDoc(draft, 'design.md'),
  };
  // The five docs by the names backlog items cite them with.
  const backlogDocs = docs;
  const previous = await readDerived(draft);
  const fail = (reason: string, detail?: string, kind?: FailureKind) => journal.fact(RefineEvent.CycleFailed, { cycle, reason, ...(detail ? { detail } : {}), ...(kind ? { kind } : {}) });
  const failAgent = (stage: string, out: Extract<StepOutcome<unknown>, { ok: false }>) => {
    const { reason, detail, kind } = failureMessage(stage, out.failure, out.errors);
    return fail(reason, detail, kind);
  };
  let jevValidation: JevValidationResult | undefined;
  // A confidential project never sends its docs to the OpenRouter: Jev is skipped and the agents run without its findings.
  const confidential = await isConfidential(draft, journal.state);
  if (deps.validateDocs && confidential) {
    jevValidation = { available: true, confidence: null, model: null, checks: {}, stateTruncated: false };
    await journal.fact(RefineEvent.DocsValidated, { cycle, backend: 'jev', ...jevValidation, skipped: 'confidential' });
  } else if (deps.validateDocs) {
    jevValidation = await deps.validateDocs({ project: docs['project.md'], briefing: docs['briefing.md'], stack: docs['stack.md'], flow: docs['flow.md'], design: docs['design.md'] }).catch(() => ({ available: false, confidence: null, model: null, checks: {}, stateTruncated: false }));
    const validation = jevValidation;
    await journal.fact(RefineEvent.DocsValidated, { cycle, backend: 'jev', ...validation });
    // Jev findings are advisory: an outage does not stop the cycle. DOCS_VALIDATED keeps it, so its decisions can be reviewed.
  }

  const backlogMode = journal.state.backlog?.enabled === true;
  let derived: { project: Project; spec: Spec | null };
  let backlog: BacklogState | null = null;
  let criteria: readonly AcceptanceCriterion[] = [];
  let objectives: readonly string[] = [];
  let due: DueAdjustment[] = [];
  if (backlogMode) {
    const before = journal.state.backlog;
    if (before?.project && before.items.length > 0 && before.draftHash === hash) {
      // The docs did not change since the outline was derived: asking again would only reword it.
      backlog = before;
    } else {
      // Backlog mode: the PO breaks the five docs into prioritized items instead of deriving one spec. One retry carries the rejection.
      // R11.7.3: a new draft's first outline starts from main's, so the PO keeps its keys and wording and unchanged items are reused.
      const last = before?.items.length ? before : await mainOutline(draft, before);
      // R11.7.4: adjustments are the orchestrator's: the PO never sees one, and each comes back from its approval in briefing.md.
      const previous = last && { ...last, items: last.items.filter((i) => !isAdjustment(i.key)) };
      const idOf = (key: string) => before?.specs?.[key]?.specId ?? specIdOf(draft.specId, key, before?.keyIds);
      // R11.7.5: an item of the last outline whose spec started on main stays even when the PO drops it.
      const started = (await Promise.all((last?.items ?? []).map(async (i) => (isStarted((await readMainSpec(draft, idOf(i.key)))?.status) ? [i] : [])))).flat();
      let rejection: string[] | undefined;
      let accepted: Extract<BacklogCheck, { ok: true }> | null = null;
      for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
        const out = await deps.runAgent<'backlog'>(
          {
            kind: 'backlog',
            role: 'po',
            pack: fitPackBudget(backlogPack({ specHash: hash, principles: deps.principles(), projectMd: docs['project.md'], briefMd: docs['briefing.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'], previous, jevValidation, rejection, started: started.map((i) => i.key) })),
            cwd: draft.root,
            phase: 'refine',
            taskId: null,
            attempt: cycle,
          },
          ctx,
        );
        if (!out.ok) {
          await failAgent('O backlog', out);
          return;
        }
        const checked = postProcessBacklog(out.value as BacklogOutput, previous, backlogDocs, approvedAdjustments(docs['briefing.md']), started);
        if (checked.ok) accepted = checked;
        else rejection = checked.issues;
      }
      if (!accepted) {
        // Each rule the outline breaks is a question for the owner: the refinement answers it, and the next evaluation derives again.
        const asked = journal.state.questions.filter((q) => q.status === 'pending').map((q) => q.rule ?? q.text);
        await journal.fact(RefineEvent.Evaluated, { cycle, checklist: journal.state.checklist, questions: outlineQuestions(rejection!, cycle, asked), discardedPatches: [], questionRouting: {}, autoAnswerFloor: null, unverifiedContradictions: [] });
        return;
      }
      const { backlog: ranked } = accepted.value;
      const project = await keepBaseProject(draft, accepted.value.project);
      await writeProject(draft, project);
      await writeBacklogMd(draft, renderBacklogMd(ranked));
      await writeSpecsIndex(draft, buildSpecsIndex(draft.specId, { ...ranked, keyIds: before?.keyIds }));
      const outline = { cycle, project, epics: ranked.epics, items: ranked.items, flowHeadings: flowHeadings(docs['flow.md']), draftHash: hash };
      // Remove first: the outline event drops the rows that name the retired items' directories.
      const keys = new Set(ranked.items.map((i) => i.key));
      await retireDropped(draft, [...new Set([...Object.keys(before?.specs ?? {}), ...(last?.items ?? []).map((i) => i.key)])].filter((k) => !keys.has(k)).map(idOf));
      await journal.fact(RefineEvent.BacklogDerived, outline);
      // The same merge the reducer makes: the detail of items that still exist carries over.
      const merged = { ...journal.state, backlog: before };
      applyRefineEvent(merged, { type: RefineEvent.BacklogDerived, data: outline });
      backlog = merged.backlog!;
    }
    if (backlog.detail) {
      // The recorded decider journals the Jev's checks of the detailing (R11.5a item 3).
      const detailed = await detailBacklog({ ...deps, decider }, { cycle, hash, docs: backlogDocs, backlog, ctx });
      if (!detailed.ok) {
        await fail(detailed.reason, detailed.detail, detailed.kind);
        return;
      }
      backlog = detailed.backlog;
      // R11.7.4: a started spec whose cited sections changed gets an adjustment for the owner to approve.
      due = adjustmentsDue(backlog, backlogDocs, journal.state.patches);
    }
    derived = { project: backlog.project!, spec: null };
    objectives = backlog.epics.map((e) => e.title);
  } else {
    const d = await deps.runAgent<'derive'>(
      {
        kind: 'derive',
        role: 'po',
        pack: fitPackBudget(derivePack({ specHash: hash, principles: deps.principles(), projectMd: docs['project.md'], briefMd: docs['briefing.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'], previous, specId: draft.specId, jevValidation })),
        cwd: draft.root,
        phase: 'refine',
        taskId: null,
        attempt: cycle,
      },
      ctx,
    );
    if (!d.ok) {
      await failAgent('A derivação dos documentos', d);
      return;
    }
    // A sibling spec of the same project (copied into the draft from main) may already use higher ids (R11.8).
    const floor = await maxCriterionInDraft(draft);
    const checked = postProcessDerived(d.value as DeriveOutput, previous?.spec ?? null, draft.specId, floor, parseDecisions(docs['briefing.md']));
    if (!checked.ok) {
      await fail('A derivação dos documentos não passou na validação. Clique em Reavaliar.', checked.issues.join('; '));
      return;
    }
    checked.value.project = await keepBaseProject(draft, checked.value.project);
    await writeDerived(draft, checked.value);
    await journal.fact(RefineEvent.Derived, { cycle, ...checked.value });
    derived = checked.value;
    criteria = checked.value.spec.acceptanceCriteria;
    objectives = checked.value.spec.objectives;
  }
  const dctx = { confidential: confidential || derived.project.confidential === true };
  const notReady = !backlogMode && deps.decider ? await notReadyCriteria(criteria, decider!, dctx) : null;

  const discardedPatches: Array<{ role: string; file: string; reason: string }> = [];
  // Every document takes its template's layout first, so the reorganization pass reads the layout the documents must keep.
  await reshapeAll({ draft, journal, runAgent: deps.runAgent, signal: deps.signal }, cycle, docs, discardedPatches);
  // The reorganization pass reads every changed document in full against the charter and moves what is misplaced, before any review reads them.
  // A document whose hash is the one the last pass left is skipped; the first pass reads all five.
  const changed = REORGANIZED_FILES.filter((f) => sha256(docs[f]) !== journal.state.reorganized[f]);
  const reorgQuestions: z.infer<typeof RefineOutput>['questions'] = [];
  if (changed.length > 0) {
    for (const group of reorganizeGroups(changed, docs)) {
      const out = (await deps.runAgent<'refine'>(
        {
          kind: 'refine',
          role: 'po',
          pack: fitPackBudget(reorganizePack({ specHash: hash, principles: deps.principles(), specId: draft.specId, projectMd: docs['project.md'], briefMd: docs['briefing.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'], changed: group, projectBriefing: backlogMode })),
          cwd: draft.root,
          phase: 'refine',
          taskId: null,
          attempt: cycle,
        },
        ctx,
      )) as StepOutcome<z.infer<typeof RefineOutput>>;
      if (!out.ok) {
        await failAgent('A reorganização dos documentos', out);
        return;
      }
      await applyMoves(journal, draft, cycle, docs, { specId: draft.specId, projectBriefing: backlogMode, asked: titlesOf(askedTexts(journal.state, reorgQuestions)) }, [{ role: 'po', moves: out.value.moves ?? [], limit: REORGANIZE_MAX_MOVES }], discardedPatches);
      reorgQuestions.push(...out.value.questions);
    }
    await journal.fact(RefineEvent.DocsReorganized, { cycle, hashes: Object.fromEntries(REORGANIZED_FILES.map((f) => [f, sha256(docs[f])])) });
  }
  // Front's review waits for the moves: its patches are checked after them.
  let frontReview: z.infer<typeof RefineOutput> | null = null;
  if (deps.frontAgent) {
    const askFront = (note: string | null) => deps.frontAgent!({ kind: 'refine', role: 'front',
      pack: withNote(fitPackBudget(refinePack({ role: 'front', specHash: hash, principles: deps.principles(), specId: draft.specId,
        projectMd: docs['project.md'], briefMd: docs['briefing.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'],
        derived, backlog, retrieval: [], history: journal.state.questions,
        rejected: journal.state.patches.filter((p) => p.status === 'rejected'), pending: journal.state.patches.filter((p) => p.status === 'pending'), findings: journal.state.findings, undoneMoves: journal.state.moves.filter((m) => m.status === 'undone'), jevValidation, projectBriefing: backlogMode, cycle })), note),
      cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx);
    // The model now and then drops a required field of one suggestion. The suggestions are advice, so one more try, and then the cycle goes on without them instead of failing.
    const review = await retryOnSchema((note) => askFront(note));
    if (!review.ok && review.failure !== 'schema') { await failAgent('A revisão do Front', review); return; }
    if (!review.ok) discardedPatches.push({ role: 'front', file: 'design.md', reason: 'O agente Front respondeu fora do formato duas vezes, então as sugestões visuais deste ciclo foram puladas. Use Reavaliar para tentar de novo.' });
    frontReview = review.ok ? (review.value as z.infer<typeof RefineOutput>) : null;
  }

  const state = journal.state;
  const retrieval = backlogMode ? [] : deps.retrieval(objectives.join(' '));
  const step = (role: 'po' | 'sm') =>
    deps.runAgent<'refine'>(
      {
        kind: 'refine',
        role,
        pack: fitPackBudget(refinePack({
          role,
          specHash: hash,
          principles: deps.principles(),
          specId: draft.specId,
          projectMd: docs['project.md'],
          briefMd: docs['briefing.md'],
          stackMd: docs['stack.md'],
          flowMd: docs['flow.md'],
          designMd: docs['design.md'],
          derived,
          backlog,
          retrieval,
          history: state.questions,
          rejected: state.patches.filter((p) => p.status === 'rejected'),
          pending: state.patches.filter((p) => p.status === 'pending'),
          findings: state.findings,
          undoneMoves: state.moves.filter((m) => m.status === 'undone'),
          jevValidation,
          notReady,
          projectBriefing: backlogMode,
          cycle,
        })),
        cwd: draft.root,
        phase: 'refine',
        taskId: null,
        attempt: cycle,
      },
      ctx,
    );
  const [po, sm] = (await Promise.all([step('po'), step('sm')])) as [StepOutcome<z.infer<typeof RefineOutput>>, StepOutcome<z.infer<typeof RefineOutput>>];
  if (!po.ok) {
    await failAgent('A revisão do PO', po);
    return;
  }
  if (!sm.ok) {
    await failAgent('A revisão do SM', sm);
    return;
  }
  // The reviewers read these documents, so the quotes they copy are checked against them, even when a move below takes that text away.
  const reviewed = { ...docs };
  // Content in the wrong document moves first: every patch is checked against the documents as the moves leave them.
  await applyMoves(journal, draft, cycle, docs, { specId: draft.specId, projectBriefing: backlogMode, asked: titlesOf(askedTexts(journal.state, reorgQuestions)) }, [
    { role: 'front', moves: frontReview?.moves ?? [], limit: MAX_MOVES_PER_ROLE },
    { role: 'po', moves: po.value.moves ?? [], limit: MAX_MOVES_PER_ROLE },
    { role: 'sm', moves: sm.value.moves ?? [], limit: MAX_MOVES_PER_ROLE },
  ], discardedPatches);
  // A finding stands only when its quote is in the document it names: a claim the documents do not show is not routed to the owner.
  const reported = [
    ...(frontReview?.findings ?? []).map((f) => ({ ...f, role: 'front' as const })),
    ...(po.value.findings ?? []).map((f) => ({ ...f, role: 'po' as const })),
    ...(sm.value.findings ?? []).map((f) => ({ ...f, role: 'sm' as const })),
  ];
  const kept = reported.filter((f) => docs[f.doc].includes(f.quote)).map(({ role, doc, severity, quote, text, fix }) => ({ cycle, role, doc, severity, quote, text, fix }));
  await journal.fact(RefineEvent.FindingsReported, { cycle, findings: kept });
  let frontIndex = 0;
  for (const p of frontReview?.docPatch ?? []) {
    const c = checkPatch(p, draft.specId, docs, backlogMode);
    if (!c.ok) {
      discardedPatches.push({ role: 'front', file: p.file, reason: c.reason });
      continue;
    }
    if (c.file !== 'design.md') {
      discardedPatches.push({ role: 'front', file: p.file, reason: 'Front só pode alterar design.md' });
      continue;
    }
    const after = applyPatch(docs[c.file], p)!;
    await journal.fact(RefineEvent.PatchProposed, {
      patchId: patchId('front', cycle, frontIndex++), role: 'front', file: c.file, find: p.find, replace: p.replace, scopeChange: patchChangesScope(p.find, p.replace),
      reason: p.reason, diff: unifiedDiff(c.file, docs[c.file], after), cycle,
    });
  }

  // A repeated design.md heading makes a backlog item cite an ambiguous section: the human gets unique headings to accept, none one already pending or rejected.
  let fixIndex = journal.state.patches.filter((p) => p.cycle === cycle && p.role === 'front').length;
  for (const fix of uniqueHeadingFixes(docs['design.md'])) {
    if (journal.state.patches.some((p) => p.file === 'design.md' && p.find === fix.find && p.replace === fix.replace && (p.status === 'pending' || p.status === 'rejected'))) continue;
    await journal.fact(RefineEvent.PatchProposed, {
      patchId: patchId('front', cycle, fixIndex++), role: 'front', file: 'design.md', ...fix, scopeChange: patchChangesScope(fix.find, fix.replace),
      diff: unifiedDiff('design.md', docs['design.md'], applyPatch(docs['design.md'], fix)!), cycle,
    });
  }

  // Spec §3.2 step 3: dedup by normalized text, blocking first, PO before SM within a class; a decision counts as decided (R11.7.1).
  // A question still pending from an earlier cycle is not asked again.
  const decided = new Set([...state.questions.map((q) => q.text), ...(derived.spec?.decisions ?? []).map((d) => d.question)].map(norm));
  // A subject is a decision heading, so it is used once: a repeat, or one that equals a heading already taken, falls back to the question text.
  const taken = new Set([...decided, ...state.questions.flatMap((q) => (q.subject ? [norm(q.subject)] : []))]);
  const seen = new Set<string>();
  const pendingTitles = new Set(titlesOf(state.questions.filter((q) => q.status === 'pending').map((q) => q.text)));
  const merged: Question[] = [];
  const counters = { po: 0, sm: 0 };
  for (const blocking of [true, false]) {
    for (const [role, out] of [['po', { questions: [...reorgQuestions, ...po.value.questions] }], ['sm', sm.value]] as const) {
      for (const q of out.questions.filter((x) => x.blocking === blocking)) {
        const key = norm(q.text);
        // A reworded question about a section a pending one already asks is the same question.
        if (seen.has(key) || decided.has(key) || titlesOf([q.text]).some((t) => pendingTitles.has(t))) continue;
        seen.add(key);
        const subject = q.subject && q.subject.length <= 80 && !taken.has(norm(q.subject)) ? q.subject : undefined;
        taken.add(norm(subject ?? q.text));
        merged.push({ questionId: `${role}-c${cycle}-${counters[role]++}`, role, text: q.text, blocking: q.blocking, relatedAcIds: q.relatedAcIds, cycle, ...(subject ? { subject } : {}), ...(q.options?.length ? { options: q.options } : {}), ...(q.distinctFrom ? { distinctFrom: q.distinctFrom } : {}) });
      }
    }
  }
  // The questions only the human can decide, which no role answers from the docs.
  const forHuman = new Set<string>();
  // A spec or pre-plan that failed to generate is a gap only the human can close: asked once, never auto-answered.
  for (const q of failedGapQuestions(backlog, cycle, [...state.questions, ...merged].map((x) => x.text))) {
    forHuman.add(q.questionId);
    merged.push(q);
  }
  if (deps.decider) {
    // Decision 3: a new question that asks what one of its most similar earlier ones (pending, decided, or new before it) already asks.
    const pairs = questionPairs(merged, (_, i) => [...state.questions, ...merged.slice(0, i)]);
    const dup = await duplicatePairs(pairs, decider!, dctx);
    const dropped = new Set(dup ? pairs.filter((_, i) => dup[i]).map((p) => p.drop) : []);
    for (let i = merged.length - 1; i >= 0; i--) if (dropped.has(merged[i]!)) merged.splice(i, 1);
    // Decision 4: history that the new spec contradicts becomes a blocking question for the human.
    const hits = retrieval.slice(0, MAX_HISTORY_CHUNKS);
    for (const i of await contradictedChunks(criteria, objectives, hits.map((h) => h.text), decider!, dctx)) {
      const h = hits[i]!;
      const id = `po-c${cycle}-${counters.po++}`;
      forHuman.add(id);
      merged.push({
        questionId: id,
        role: 'po',
        text: `A spec nova parece contradizer o histórico do projeto (${h.title}${h.heading ? ` › ${h.heading}` : ''}): "${h.snippet}". Qual dos dois vale?`,
        blocking: true,
        relatedAcIds: [],
        cycle,
        options: [
          { label: 'Vale o histórico', detail: 'A spec nova segue o que o histórico registra.' },
          { label: 'Vale a spec nova', detail: 'O histórico fica como registro antigo e a spec nova segue.' },
        ],
      });
    }
  }
  // Plan 103: a question that repeats a decided one is dropped unless its distinctFrom names a real difference. The round does not
  // run again, and the drops come before the checklist counts the blocking questions, so no dropped question holds the round.
  const guarded = checkRepeats(merged, state.questions, ROUND_REPEAT_OVERLAP);
  for (const { question, matches } of guarded.unresolved) await journal.fact(RefineEvent.QuestionDropped, droppedOf(question, matches[0]!));
  merged.splice(0, merged.length, ...guarded.kept);
  // R11.5.7: the route of each blocking question, journaled for the eval; it answers only at the floor the config fixes or the labels prove.
  const questionRouting: Record<string, { route: string; confidence: number | null; source: string }> = {};
  if (deps.decider) {
    // A question only the human decides is never answered on its own, so routing it would only spend a Jev call.
    const blocking = merged.filter((q) => q.blocking && !forHuman.has(q.questionId));
    const routed = await Promise.all(blocking.map((q) => routeQuestion(criteria, q.text, decider!, dctx)));
    blocking.forEach((q, i) => { const r = routed[i]; if (r) questionRouting[q.questionId] = { route: r.route, confidence: r.confidence, source: r.source }; });
  }

  // R11.10: PO and SM reading the same docs often propose the identical edit; accepting both would duplicate the
  // text. The first role to propose it (po, by iteration order) wins; a byte-identical later one is dropped.
  const proposedPatches = new Set<string>();
  const patchKey = (file: string, p: { find: string; replace: string }) => `${file}\u0000${p.find.trim()}\u0000${p.replace.trim()}`;
  // Earlier cycles' suggestions still wait for the owner: proposing one again would only pile up copies of it.
  const stillPending = new Set(state.patches.filter((p) => p.status === 'pending').map((p) => patchKey(p.file, p)));
  // R11.5a item 2: a paraphrase of an already-accepted patch on the same file (same resulting content, different
  // wording), which the byte-identical check above cannot catch. One per file, so the comparison set stays small.
  const acceptedByFile = new Map<string, Array<{ find: string; replace: string }>>();
  for (const [role, out] of [['po', po.value], ['sm', sm.value]] as const) {
    let i = 0;
    for (const p of out.docPatch) {
      // A stack.md or flow.md that is still the blank template is filled by the SM straight away: nobody has anything
      // to review in a placeholder, and asking the human what to put there is the friction this avoids.
      const blank = role === 'sm' ? BLANK_FILES.find((f) => DOC_REL[f](draft.specId) === p.file && docs[f] === BLANK_TEMPLATE[f]()) : undefined;
      if (blank && fillsTemplate(blank, p.replace)) {
        await writeDoc(draft, blank, p.replace);
        docs[blank] = await readDoc(draft, blank);
        await journal.fact(RefineEvent.DocEdited, { file: blank, hash: sha256(docs[blank]), source: 'autofill' });
        continue;
      }
      const c = checkPatch(p, draft.specId, docs, backlogMode);
      if (c.ok && c.file === 'design.md') {
        discardedPatches.push({ role, file: p.file, reason: 'design.md is reviewable only by front' });
        continue;
      }
      if (c.ok && !PATCH_FILES[role].includes(c.file)) {
        discardedPatches.push({ role, file: p.file, reason: `${c.file} is patched only by ${patchOwners(c.file)}` });
        continue;
      }
      if (!c.ok) {
        discardedPatches.push({ role, file: p.file, reason: c.reason });
        continue;
      }
      const key = patchKey(c.file, p);
      if (proposedPatches.has(key)) {
        discardedPatches.push({ role, file: p.file, reason: 'the same change was already proposed this cycle' });
        continue;
      }
      if (stillPending.has(key)) {
        discardedPatches.push({ role, file: p.file, reason: 'the same change is already waiting for the owner' });
        continue;
      }
      const priorOnFile = acceptedByFile.get(c.file) ?? [];
      if (deps.decider && priorOnFile.length > 0) {
        const dup = await duplicatePatches(priorOnFile.map((a) => ({ a, b: p })), decider!, dctx);
        if (dup?.some((v) => v)) {
          discardedPatches.push({ role, file: p.file, reason: 'a near-duplicate of a patch already proposed this cycle (same change in substance)' });
          continue;
        }
      }
      proposedPatches.add(key);
      acceptedByFile.set(c.file, [...priorOnFile, { find: p.find, replace: p.replace }]);
      const after = applyPatch(docs[c.file], p)!;
      await journal.fact(RefineEvent.PatchProposed, {
        patchId: patchId(role, cycle, i++),
        role,
        file: c.file,
        find: p.find,
        replace: p.replace,
        scopeChange: patchChangesScope(p.find, p.replace),
        reason: p.reason,
        diff: unifiedDiff(c.file, docs[c.file], after),
        cycle,
      });
    }
  }

  // R11.7.4: accepting the patch approves the adjustment; rejecting it keeps the started spec as it is.
  let next = state.patches.filter((p) => p.cycle === cycle && p.role === 'po').length;
  for (const a of due) {
    const p = approvalPatch(a);
    await journal.fact(RefineEvent.PatchProposed, { patchId: patchId('po', cycle, next++), role: 'po', file: 'briefing.md', ...p, scopeChange: patchChangesScope(p.find, p.replace), diff: unifiedDiff('briefing.md', docs['briefing.md'], applyPatch(docs['briefing.md'], p)!), cycle });
  }

  const checklist: ChecklistItem[] = mergeChecklist(po.value.checklist, sm.value.checklist);
  const pendingBlocking = state.questions.filter((q) => q.status === 'pending' && q.blocking).length + merged.filter((q) => q.blocking).length;
  const openItem = checklist.find((i) => i.id === 'sm.no-open-questions')!;
  openItem.passed = pendingBlocking === 0;
  openItem.detail = pendingBlocking === 0 ? 'no blocking question open' : `${pendingBlocking} blocking question(s) open`;
  // R11.11: flow.md must be a mermaid diagram (the template already is); deterministic, not left to the SM's own say-so.
  const flowItem = checklist.find((i) => i.id === 'sm.flow-is-mermaid')!;
  flowItem.passed = flowIsMermaid(docs['flow.md']);
  flowItem.detail = flowItem.passed ? 'flow.md has a mermaid diagram' : 'flow.md has no ```mermaid block; it must be a diagram, not markdown headings';
  // A divergence counts only when the documents hold both quotes; one the PO describes without them fails the id.
  const contradictionItem = checklist.find((i) => i.id === 'po.no-contradictions')!;
  const { verified, dropped } = verifyContradictions(reviewed, po.value.contradictions ?? []);
  const poReported = po.value.checklist.some((r) => r.id === 'po.no-contradictions');
  if (verified.length > 0) {
    contradictionItem.passed = false;
    contradictionItem.detail = `${verified.length} divergência(s) comprovada(s) nos documentos.`;
    contradictionItem.divergences = verified;
  } else if (dropped.length > 0 || (poReported && !contradictionItem.passed)) {
    contradictionItem.passed = false;
    contradictionItem.detail = `${contradictionItem.detail} Afirmação sem trecho comprovado nos documentos: cite os dois trechos ou retire a afirmação.`;
  }
  // The Jev only warns: its doubt goes into the item's detail, and the PO's verdict stands.
  const consistent = jevValidation?.checks.documents_consistent;
  if (consistent !== undefined && consistent < 0.5) {
    contradictionItem.detail = `${contradictionItem.detail} Aviso do Jev (automático, pode errar, não bloqueia): duvidou da consistência (${consistent.toFixed(2).replace('.', ',')}).`;
  }
  // R11.5.7: a blocking question routed `auto` at the floor or above is answered by its owner role from the docs, before the
  // evaluation is journaled, so the page shows the cycle running until the answers land with it.
  const floor = deps.autoAnswerFloor;
  const eligible = floor === undefined ? [] : merged.filter((q) => {
    const r = questionRouting[q.questionId];
    return q.blocking && !forHuman.has(q.questionId) && !heldForOwner(q.questionId) && r?.route === 'auto' && r.source === 'jev' && r.confidence !== null && r.confidence >= floor;
  });
  const answers = await Promise.all(eligible.map(async (q) => {
    if (deps.signal?.aborted) return null;
    const pack = fittedAnswerPack({ specHash: hash, role: q.role, question: q.text, docs: { projectMd: docs['project.md'], briefMd: docs['briefing.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'] } });
    if (!pack) return null;
    const out = (await deps.runAgent<'answer'>({ kind: 'answer', role: q.role, pack, cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx)) as StepOutcome<AnswerOutput>;
    return out.ok && out.value.answer ? { questionId: q.questionId, text: out.value.answer, by: q.role } : null;
  }));
  // The same checks failing for several rounds in a row: the human decides, instead of another round spending the same calls.
  const stuck = nextStuck(journal.state.stuck, checklist);
  const ask = stuck.ask ? stuckQuestion(stuck.failing, cycle) : null;
  if (ask && !journal.state.questions.some((q) => q.status === 'pending' && q.rule === ask.rule)) merged.push(ask);
  if (deps.scoreDocs && scoresDocs(journal.state.mode)) await recordScore({ draft, journal, scoreDocs: deps.scoreDocs }, cycle, await isConfidential(draft, journal.state));
  await journal.fact(RefineEvent.Evaluated, { cycle, checklist, questions: merged, discardedPatches, questionRouting, autoAnswerFloor: floor ?? null, unverifiedContradictions: dropped });
  for (const a of answers) if (a) await journal.fact(RefineEvent.QuestionAnswered, a);
}

/** The answer pack with its budget raised to the docs, so the question never drops out; null when the docs are past the cap. */
function fittedAnswerPack(input: Parameters<typeof answerPack>[0]): ReturnType<typeof answerPack> | null {
  try {
    return fitPackBudget(answerPack(input));
  } catch (err) {
    if (err instanceof PackTooLargeError) return null;
    throw err;
  }
}
