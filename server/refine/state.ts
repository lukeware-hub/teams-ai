import type { Backlog, BacklogItem } from '../contracts/backlog.js';
import type { Preplan } from '../contracts/preplan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { ChecklistItem } from './checklist.js';
import { coverageGaps } from './coverage.js';
import { RefineEvent, type Question } from './events.js';
import { approvalKey } from './sections.js';
import type { DocFile } from './draft.js';
import type { PendingPatch } from './patches.js';
import { DOC_STAGES } from './doc-stages.js';
import type { DocScore, Readiness } from './readiness.js';
import { stepKey } from './speckit-steps.js';

export type RefineStatus = 'drafting' | 'evaluating' | 'answering' | 'ready' | 'error' | 'started';
export interface QuestionRow extends Question {
  status: 'pending' | 'answered' | 'skipped';
  answer: string | null;
  /** The role that answered it from the docs (R11.5.7); null when the human did. */
  answeredBy?: 'po' | 'sm' | null;
}
export interface PatchRow extends PendingPatch {
  cycle: number;
  status: 'pending' | 'accepted' | 'rejected' | 'dropped';
  decision: string | null;
}
/** A finding one role reported on a document it does not own; kept only when its quote is in that document. */
export interface FindingRow {
  cycle: number;
  role: 'po' | 'sm' | 'front';
  doc: DocFile;
  severity: 'blocking' | 'advice';
  quote: string;
  text: string;
  fix: string;
}
/** A move applied at once: the text cut from one document and added to another, with what undo needs to put both back. */
export interface MoveRow {
  moveId: string;
  role: 'po' | 'sm' | 'front';
  cycle: number;
  from: DocFile;
  to: DocFile;
  reason: string;
  /** The whole lines cut from `from`. */
  quote: string;
  /** The text added to `to`. */
  text: string;
  removedAt: number;
  removed: string;
  insertAt: number;
  inserted: string;
  /** Hashes of both documents as the move left them: undo runs only while both still match. */
  fromHash: string;
  toHash: string;
  status: 'applied' | 'undone';
  /** The owner closed this move's notice; it stays hidden. */
  closed?: boolean;
}
/** A stage document rewritten in its template's shape; undo puts back the text kept on disk, while the document is unchanged. */
export interface ReshapeRow {
  reshapeId: string;
  file: DocFile;
  cycle: number;
  role: 'po' | 'sm' | 'front';
  afterHash: string;
  status: 'applied' | 'undone';
  /** The owner closed this reshape's notice; it stays hidden. */
  closed?: boolean;
}
/** One backlog item's derived spec; `spec` is null when the last attempt failed (`issues` says why). */
export interface SpecRow {
  inputHash: string;
  specId: string;
  /** The spec's hash: a pre-plan is current only for this revision. */
  rev: string | null;
  spec: Spec | null;
  issues: string[];
  cycle: number;
}
/** One backlog item's pre-plan; `preplan` is null when the last attempt failed. */
export interface PreplanRow {
  inputHash: string;
  specRev: string;
  preplan: Preplan | null;
  issues: string[];
  cycle: number;
}

/** Backlog mode: the docs broken into epics and ranked items (browser-safe, shared with the web reducer). */
export interface BacklogState {
  enabled: boolean;
  project: Project | null;
  epics: Backlog['epics'];
  items: Array<BacklogItem & { rank: number }>;
  cycle: number;
  /** Detailing is part of each evaluation: every changed item gets its spec and pre-plan. Kept on journals from before it was always on. */
  detail?: boolean;
  /** The flow.md sections the outline had to cover, as of its last derivation. */
  flowHeadings?: string[];
  /** The docs' hash the outline was derived from. */
  draftHash?: string;
  specs?: Record<string, SpecRow>;
  preplans?: Record<string, PreplanRow>;
  /** The highest acceptance criterion number ever allocated, so a removed number is never reused. */
  acHighWater?: number;
  /** Roadmap R11.12: item specs are named by their key alone (see `specIdOf`); absent on older drafts. */
  keyIds?: boolean;
  /** The SM's conflict map of the current pre-plans; absent until made, and then the program runs one spec at a time. */
  conflicts?: ConflictMap;
}

export interface ConflictMap {
  inputHash: string;
  pairs: Array<{ a: string; b: string; reason: string }>;
}

export interface RefineState {
  status: RefineStatus;
  stale: boolean;
  /** A doc changed after the running cycle started, so its evaluation is stale on arrival. */
  editedInCycle?: boolean;
  cycle: number;
  derived: { project: Project; spec: Spec } | null;
  checklist: ChecklistItem[];
  questions: QuestionRow[];
  patches: PatchRow[];
  moves: MoveRow[];
  reshapes: ReshapeRow[];
  /** The hash of each document as the last reorganization pass left it; a document whose hash differs is read again. */
  reorganized: Partial<Record<DocFile, string>>;
  /** The findings whose quotes the documents show: a full round replaces them all, a stage review only those of the documents it covers. */
  findings: FindingRow[];
  discarded: Array<{ cycle: number; role: string; file: string; reason: string }>;
  error: string | null;
  runId: string | null;
  backlog: BacklogState | null;
  /** How the session was created; null on drafts from before it was kept. */
  mode: 'new-project' | 'new-spec' | 'continue' | 'backlog' | null;
  /** Created with the document stages: its confidentiality is unknown, so no document goes to the Jev, until the owner answers. */
  stages?: boolean;
  /** The owner's answer on confidentiality; undefined until it comes. */
  confidential?: boolean;
  /** The checks failing in the last rounds in a row, and how many rounds they have failed together. */
  stuck?: StuckRun;
  /** The Jev's latest score of the documents; a document change marks it outdated until the next score. */
  readiness?: Readiness;
  /** The documents edited since their score was taken: each one's score is outdated until it is scored again. */
  outdatedDocs?: DocFile[];
  /** The documents the owner moved on from, in order. */
  doneStages?: DocFile[];
  /** The documents whose passed text is kept, so a stage can be reprocessed from it. */
  passedStages?: DocFile[];
  /** The owner moved on from the final review to the backlog, so the review shows as done. */
  reviewClosed?: boolean;
  /** The round the current stage began at; its rounds count from here. */
  stageStartCycle?: number;
  /** What the last stage review of each document found against the documents before it; an empty list is aligned. */
  stageAlignment?: Partial<Record<DocFile, string[]>>;
  /** A stage the owner moved on from, whose earlier document changed after it: that document's name, until the stage is reviewed again. */
  staleBy?: Partial<Record<DocFile, DocFile>>;
  /** When the latest evaluation started and ended (ISO times); `endedAt` stays null while it runs. */
  evaluation?: { startedAt: string; endedAt: string | null };
  /** The Spec Kit preparation of a detailed backlog; stale once a document or the backlog changes after it. */
  speckit?: { status: 'running' | 'done' | 'failed'; startedAt?: string; current?: { command: string; itemKey?: string; startedAt?: string }; steps: Array<{ command: string; itemKey?: string; startedAt?: string; endedAt?: string }>; total?: number; error?: string; stale: boolean; features?: Record<string, string>; inputHash?: string };
}

export interface StuckRun {
  key: string;
  count: number;
}

/** Rounds in a row with the same checks failing before the human is asked about them. */
export const STUCK_ROUNDS = 3;

/** Counts the rounds the same checks fail; `ask` when they reach the limit, and the count then starts over. */
export function nextStuck(prev: StuckRun | undefined, checklist: ChecklistItem[]): { run: StuckRun; ask: boolean; failing: ChecklistItem[] } {
  const failing = checklist.filter((i) => !i.passed);
  const key = failing.map((i) => i.id).sort().join(',');
  if (key === '') return { run: { key: '', count: 0 }, ask: false, failing };
  const count = prev?.key === key ? prev.count + 1 : 1;
  const ask = count >= STUCK_ROUNDS;
  return { run: { key, count: ask ? 0 : count }, ask, failing };
}

export const emptyRefineState = (): RefineState => ({
  status: 'drafting',
  stale: false,
  cycle: 0,
  derived: null,
  checklist: [],
  questions: [],
  patches: [],
  moves: [],
  reshapes: [],
  reorganized: {},
  findings: [],
  discarded: [],
  error: null,
  runId: null,
  backlog: null,
  mode: null,
});

const STICKY: ReadonlySet<RefineStatus> = new Set(['evaluating', 'error', 'started']);

/** An adjustment's approval (R11.7.4) is the owner's decision, never a reviewer's suggestion. */
export const isApproval = (p: Pick<PatchRow, 'replace'>) => approvalKey(p.replace.split('\n', 1)[0]!.replace(/^#+\s*/, '')) !== null;

/** Every checklist item passed, with at least one item reported. */
export const allGreen = (checklist: ReadonlyArray<{ passed: boolean }>) => checklist.length > 0 && checklist.every((i) => i.passed);

/** Spec (refinement) §3.1: ready = all green, no pending blocking question and no pending approval; a reviewer's pending patch is then a suggestion (R11.10). */
export function computeStatus(s: RefineState): RefineStatus {
  if (STICKY.has(s.status)) return s.status;
  const pendingBlocking = s.questions.some((q) => q.status === 'pending' && q.blocking);
  const pendingPatch = s.patches.some((p) => p.status === 'pending');
  const pendingApproval = s.patches.some((p) => p.status === 'pending' && isApproval(p));
  const green = allGreen(s.checklist);
  // Once every item is green, a suggestion is nothing the owner owes.
  const pendingAny = (green ? pendingApproval : pendingPatch) || s.questions.some((q) => q.status === 'pending');
  // A detailed backlog is ready only when every section, spec, criterion and task is accounted for.
  // The coverage scan is costly, so it runs last: only when nothing else already blocks `ready`.
  if (green && !pendingBlocking && !pendingApproval && (!s.backlog?.detail || coverageGaps(s.backlog).length === 0)) return 'ready';
  return pendingAny ? 'answering' : 'drafting';
}

/** The round after which Reavaliar stops (TEAMS_AI_REFINE_MAX_ROUNDS). */
export interface RefineLimits {
  max: number;
}

/** The part of the state the start reads; the page's state shape carries the same fields. */
export interface StartInput {
  status: RefineStatus;
  mode?: string | null;
  derived: unknown;
  backlog?: { enabled: boolean; detail?: boolean | null; items?: unknown[] } | null;
  stages?: boolean;
  speckit?: { status: string; stale: boolean; inputHash?: string } | null;
  questions?: ReadonlyArray<{ status: string; blocking: boolean; origin?: string }>;
}

/** A blocking question Spec Kit left open that the owner has not answered yet. */
const speckitAsks = (s: StartInput): boolean => (s.questions ?? []).some((q) => q.origin === 'speckit' && q.blocking && q.status === 'pending');

/** The inputs' hash as they are now differs from the one the preparation recorded at its start, which catches a document written without its journal entry. */
const speckitInputsChanged = (s: StartInput, inputHash: string | undefined): boolean => inputHash !== undefined && s.speckit?.inputHash !== undefined && s.speckit.inputHash !== inputHash;

/** A new project built in the wizard starts only from a current Spec Kit preparation with its blocking questions answered; other sessions need none. */
export const speckitPending = (s: StartInput, inputHash?: string): boolean => s.stages === true && s.mode === 'new-project' && (!(s.speckit?.status === 'done' && !s.speckit.stale) || speckitInputsChanged(s, inputHash) || speckitAsks(s));

/** The start is open unless the agents evaluate or a run started: checks, questions and the Jev only advise. */
export function canStart(s: StartInput): boolean {
  if (s.status === 'evaluating' || s.status === 'started') return false;
  if (s.backlog?.enabled) return s.backlog.detail === true && (s.backlog.items?.length ?? 0) > 0 && !speckitPending(s);
  return s.mode !== 'new-project' && Boolean(s.derived);
}

/** A document or the backlog changed, so the Spec Kit preparation no longer matches them. */
function markSpeckitStale(s: RefineState): void {
  if (s.speckit) s.speckit.stale = true;
}

/** Something was derived from the docs (one spec or a backlog), so editing the docs makes it stale. */
const hasDerivation = (s: RefineState): boolean => s.derived !== null || (s.backlog?.items.length ?? 0) > 0;

const keep = <T>(rows: Record<string, T> | undefined, keys: ReadonlySet<string>): Record<string, T> | undefined =>
  rows && Object.fromEntries(Object.entries(rows).filter(([k]) => keys.has(k)));

/** Journals written before the rename name the briefing brief.md; replay reads that name as briefing.md. */
const docName = (file: unknown): DocFile => (file === 'brief.md' ? 'briefing.md' : file) as DocFile;
const docNames = <T>(rows: Record<string, T> | null | undefined): Record<DocFile, T> | null =>
  rows ? (Object.fromEntries(Object.entries(rows).filter(([k]) => !(k === 'brief.md' && 'briefing.md' in rows)).map(([k, v]) => [docName(k), v])) as Record<DocFile, T>) : null;

/** Marks each stage the owner moved on from after an edited document, until that stage is reviewed again. */
function markStaleStages(s: RefineState, edited: DocFile): void {
  const index = DOC_STAGES.indexOf(edited);
  if (index < 0) return;
  const later = DOC_STAGES.slice(index + 1).filter((doc) => (s.doneStages ?? []).includes(doc));
  if (later.length > 0) s.staleBy = { ...(s.staleBy ?? {}), ...Object.fromEntries(later.map((doc) => [doc, edited])) };
}

/** The steps a preparation of the same inputs finished before it failed; a new run skips them and keeps their files. */
export function finishedSteps(speckit: RefineState['speckit'], inputHash: string): Set<string> {
  if (speckit?.status !== 'failed' || speckit.stale) return new Set();
  // A preparation started before its inputs were recorded has no hash: a document edit would have marked it stale, so it still matches.
  if (speckit.inputHash !== undefined && speckit.inputHash !== inputHash) return new Set();
  return new Set(speckit.steps.map((step) => stepKey(step.command, step.itemKey)));
}

export function applyRefineEvent(s: RefineState, e: { type: string; at?: string; data: Record<string, unknown> }): void {
  const d = e.data;
  switch (e.type) {
    case RefineEvent.CycleStarted:
      s.cycle = Number(d.cycle);
      s.status = 'evaluating';
      s.error = null;
      s.editedInCycle = false;
      break;
    case RefineEvent.Derived:
      s.derived = { project: d.project as Project, spec: d.spec as Spec };
      break;
    case RefineEvent.PatchProposed:
      s.patches.push({ ...(d as unknown as PendingPatch & { cycle: number }), file: docName(d.file), status: 'pending', decision: null });
      break;
    case RefineEvent.Evaluated: {
      const v = d as unknown as { cycle: number; checklist: ChecklistItem[]; questions: Question[]; discardedPatches: Array<{ role: string; file: string; reason: string }> };
      s.checklist = v.checklist;
      s.stuck = nextStuck(s.stuck, v.checklist).run;
      s.questions.push(...v.questions.map((q) => ({ ...q, status: 'pending' as const, answer: null })));
      s.discarded.push(...v.discardedPatches.map((x) => ({ cycle: v.cycle, ...x, file: docName(x.file) })));
      s.stale = s.editedInCycle === true;
      s.status = 'drafting';
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.StageReviewed: {
      // A stage review asks questions only; the checklist and the stuck count stay as the last full round left them.
      const v = d as unknown as { cycle: number; file: DocFile; questions: Question[]; divergences: string[]; discardedPatches: Array<{ role: string; file: string; reason: string }> };
      s.questions.push(...v.questions.map((q) => ({ ...q, file: docName(v.file), status: 'pending' as const, answer: null })));
      s.stageAlignment = { ...(s.stageAlignment ?? {}), [v.file]: v.divergences };
      if (s.staleBy) delete s.staleBy[v.file];
      s.discarded.push(...v.discardedPatches.map((x) => ({ cycle: v.cycle, ...x, file: docName(x.file) })));
      s.status = 'drafting';
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.CycleFailed:
      s.error = String(d.reason);
      s.status = 'error';
      break;
    case RefineEvent.EvaluationStarted:
      s.evaluation = { startedAt: e.at ?? '', endedAt: null };
      break;
    case RefineEvent.EvaluationEnded:
      if (d.interrupted === true) delete s.evaluation;
      else if (s.evaluation) s.evaluation.endedAt = e.at ?? '';
      break;
    case RefineEvent.PatchAccepted:
    case RefineEvent.PatchRejected:
    case RefineEvent.PatchDropped: {
      const p = s.patches.find((x) => x.patchId === String(d.patchId));
      if (p) {
        p.status = e.type === RefineEvent.PatchAccepted ? 'accepted' : e.type === RefineEvent.PatchRejected ? 'rejected' : 'dropped';
        p.decision = (d.reason as string | null | undefined) ?? null;
      }
      if (e.type === RefineEvent.PatchAccepted && hasDerivation(s)) s.stale = true;
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.DocMoved:
      s.moves.push({ ...(d as unknown as Omit<MoveRow, 'status' | 'from' | 'to'>), from: docName(d.from), to: docName(d.to), status: 'applied' });
      break;
    case RefineEvent.DocsReorganized:
      s.reorganized = docNames(d.hashes as Record<string, string> | undefined) ?? {};
      break;
    case RefineEvent.FindingsReported: {
      const findings = (d.findings as FindingRow[] | undefined) ?? [];
      // A stage review names the documents it covers: the findings of the others stay until a review covers them.
      const covered = d.files as DocFile[] | undefined;
      s.findings = covered ? [...s.findings.filter((f) => !covered.includes(f.doc)), ...findings] : findings;
      break;
    }
    case RefineEvent.DocMoveUndone: {
      const m = s.moves.find((x) => x.moveId === String(d.moveId));
      if (m) m.status = 'undone';
      break;
    }
    case RefineEvent.DocReshaped:
      s.reshapes.push({ ...(d as unknown as Omit<ReshapeRow, 'status'>), status: 'applied' });
      break;
    case RefineEvent.DocReshapeUndone: {
      const r = s.reshapes.find((x) => x.reshapeId === String(d.reshapeId));
      if (r) r.status = 'undone';
      break;
    }
    case RefineEvent.NoticeClosed: {
      const id = String(d.noticeId);
      const row = s.moves.find((x) => x.moveId === id) ?? s.reshapes.find((x) => x.reshapeId === id);
      if (row) row.closed = true;
      break;
    }
    case RefineEvent.QuestionAnswered:
    case RefineEvent.QuestionSkipped: {
      const q = s.questions.find((x) => x.questionId === String(d.questionId));
      if (q) {
        q.status = e.type === RefineEvent.QuestionAnswered ? 'answered' : 'skipped';
        q.answer = (d.text as string | undefined) ?? null;
        q.answeredBy = (d.by as 'po' | 'sm' | undefined) ?? null;
      }
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.Created:
      s.mode = (d.mode as RefineState['mode']) ?? null;
      s.stages = d.stages === true;
      break;
    case RefineEvent.ConfidentialityAnswered:
      s.confidential = d.confidential === true;
      break;
    case RefineEvent.StageAdvanced:
      s.doneStages = [...new Set([...(s.doneStages ?? []), docName(d.doc)])];
      s.stageStartCycle = Number(d.cycle);
      break;
    case RefineEvent.StagePassed:
      s.passedStages = [...new Set([...(s.passedStages ?? []), docName(d.file)])];
      break;
    case RefineEvent.ReviewClosed:
      s.reviewClosed = true;
      break;
    case RefineEvent.DocEdited:
      if (s.status === 'evaluating') s.editedInCycle = true;
      if (hasDerivation(s)) s.stale = true;
      if (s.readiness) s.readiness.outdated = true;
      s.outdatedDocs = [...new Set([...(s.outdatedDocs ?? []), docName(d.file)])];
      markStaleStages(s, docName(d.file));
      markSpeckitStale(s);
      break;
    case RefineEvent.BacklogEnabled: {
      // `acFloor`: the highest criterion id in the draft before the briefing move removed this draft's own spec.json.
      const floor = Number(d.acFloor ?? 0);
      s.backlog = s.backlog ? { ...s.backlog, enabled: true } : { enabled: true, project: null, epics: [], items: [], cycle: 0, ...(d.keyIds === true ? { keyIds: true } : {}) };
      if (floor > 0) s.backlog = { ...s.backlog, acHighWater: Math.max(s.backlog.acHighWater ?? 0, floor) };
      if (s.derived || s.checklist.length > 0) s.stale = true;
      break;
    }
    case RefineEvent.BacklogDerived: {
      // Merge: the detail of items that still exist survives a new outline; removed items take their rows with them.
      const prev = s.backlog;
      const items = d.items as BacklogState['items'];
      const keys = new Set(items.map((i) => i.key));
      s.backlog = {
        ...prev,
        enabled: true,
        project: d.project as Project,
        epics: d.epics as BacklogState['epics'],
        items,
        cycle: Number(d.cycle),
        flowHeadings: (d.flowHeadings as string[] | undefined) ?? prev?.flowHeadings,
        draftHash: (d.draftHash as string | undefined) ?? prev?.draftHash,
        specs: keep(prev?.specs, keys),
        preplans: keep(prev?.preplans, keys),
      };
      markSpeckitStale(s);
      break;
    }
    case RefineEvent.BacklogDetailEnabled:
      if (s.backlog) s.backlog = { ...s.backlog, detail: true };
      s.status = computeStatus(s);
      break;
    case RefineEvent.SpecDerived:
      if (s.backlog) {
        const row: SpecRow = { inputHash: String(d.inputHash), specId: String(d.specId), rev: (d.rev as string | null) ?? null, spec: (d.spec as Spec | null) ?? null, issues: (d.issues as string[]) ?? [], cycle: Number(d.cycle) };
        s.backlog = { ...s.backlog, specs: { ...s.backlog.specs, [String(d.key)]: row }, acHighWater: Math.max(s.backlog.acHighWater ?? 0, Number(d.highWater ?? 0)) };
      }
      markSpeckitStale(s);
      break;
    case RefineEvent.PreplanDerived:
      if (s.backlog) {
        const row: PreplanRow = { inputHash: String(d.inputHash), specRev: String(d.specRev), preplan: (d.preplan as Preplan | null) ?? null, issues: (d.issues as string[]) ?? [], cycle: Number(d.cycle) };
        s.backlog = { ...s.backlog, preplans: { ...s.backlog.preplans, [String(d.key)]: row } };
      }
      markSpeckitStale(s);
      break;
    case RefineEvent.ConflictsDerived:
      if (s.backlog) s.backlog = { ...s.backlog, conflicts: { inputHash: String(d.inputHash), pairs: d.pairs as ConflictMap['pairs'] } };
      break;
    case RefineEvent.DocsScored: {
      // A score without a file list is a full one, as journals from before the per-document score wrote it.
      const files = (d.files as DocFile[] | undefined) ?? DOC_STAGES;
      const scored = docNames(d.docs as Record<string, DocScore> | null);
      // A failed score keeps the scores held and the outdated marks, so the next score still asks for the documents it missed.
      if (!scored && d.available === false && d.skipped === undefined) {
        s.readiness = { ...(d as unknown as Omit<Readiness, 'outdated' | 'docs'>), docs: s.readiness?.docs ?? null, outdated: (s.outdatedDocs ?? []).length > 0 };
        break;
      }
      const docs = scored && { ...(s.readiness?.docs ?? {}), ...scored };
      const held = Object.values(docs ?? {}).map((doc) => doc!.score);
      const average = docs ? held.reduce((sum, v) => sum + v, 0) / held.length : (d.average as number | null);
      s.outdatedDocs = (s.outdatedDocs ?? []).filter((file) => !files.includes(file));
      s.readiness = { ...(d as unknown as Omit<Readiness, 'outdated' | 'docs' | 'average'>), docs, average, outdated: s.outdatedDocs.length > 0 };
      break;
    }
    case RefineEvent.SpeckitStarted: {
      // A failed preparation of the same inputs keeps the steps it finished: the run that follows skips them (finishedSteps).
      const resumed = finishedSteps(s.speckit, String(d.inputHash)).size > 0;
      s.speckit = {
        status: 'running',
        steps: resumed ? s.speckit!.steps : [],
        ...(resumed && s.speckit?.features ? { features: s.speckit.features } : {}),
        ...(d.inputHash === undefined ? {} : { inputHash: String(d.inputHash) }),
        ...(d.total === undefined ? {} : { total: Number(d.total) }),
        ...(e.at === undefined ? {} : { startedAt: e.at }),
        stale: false,
      };
      break;
    }
    case RefineEvent.SpeckitStepStarted:
      if (s.speckit) s.speckit.current = { command: String(d.command), ...(d.itemKey === undefined ? {} : { itemKey: String(d.itemKey) }), ...(e.at === undefined ? {} : { startedAt: e.at }) };
      break;
    case RefineEvent.SpeckitStepDone: {
      // A finished step keeps its start and end, so the owner sees how long each command took.
      const began = s.speckit?.current?.startedAt;
      // A blocked step is not finished: its questions are on record, and the run that follows runs it again.
      if (d.blocked !== true) s.speckit?.steps.push({ command: String(d.command), ...(d.itemKey === undefined ? {} : { itemKey: String(d.itemKey) }), ...(began === undefined ? {} : { startedAt: began }), ...(e.at === undefined ? {} : { endedAt: e.at }) });
      if (s.speckit) delete s.speckit.current;
      // The feature folder Spec Kit numbered for the item, which the dev agents of that spec follow.
      if (s.speckit && d.featureDir !== undefined) s.speckit.features = { ...s.speckit.features, [String(d.itemKey)]: String(d.featureDir) };
      const asked = (d.questions as Question[] | undefined) ?? [];
      s.questions.push(...asked.map((q) => ({ ...q, status: 'pending' as const, answer: null })));
      if (asked.length > 0) s.status = computeStatus(s);
      break;
    }
    case RefineEvent.SpeckitDone:
      if (s.speckit) s.speckit.status = 'done';
      break;
    case RefineEvent.SpeckitFailed:
      if (s.speckit) s.speckit = { ...s.speckit, status: 'failed', error: String(d.reason) };
      break;
    case RefineEvent.StartedRun:
      s.status = 'started';
      s.runId = String(d.runId);
      break;
    default:
      break;
  }
}

export function reduceRefineEvents(events: ReadonlyArray<{ type: string; at?: string; data: Record<string, unknown> }>): RefineState {
  const s = emptyRefineState();
  for (const e of events) applyRefineEvent(s, e);
  return s;
}
