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
import { jevVerdict, type DocScore, type Readiness } from './readiness.js';

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
  /** The hash of each document as the last reorganization pass left it; a document whose hash differs is read again. */
  reorganized: Partial<Record<DocFile, string>>;
  /** The findings of the last cycle whose quotes the documents show, replaced every cycle. */
  findings: FindingRow[];
  discarded: Array<{ cycle: number; role: string; file: string; reason: string }>;
  error: string | null;
  runId: string | null;
  backlog: BacklogState | null;
  /** How the session was created; null on drafts from before it was kept. */
  mode: 'new-project' | 'new-spec' | 'continue' | 'backlog' | null;
  /** The checks failing in the last rounds in a row, and how many rounds they have failed together. */
  stuck?: StuckRun;
  /** The Jev's latest score of the documents; a document change marks it outdated until the next score. */
  readiness?: Readiness;
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

/** Rounds after which Executar opens with checks still failing, and the rounds after which Reavaliar stops (TEAMS_AI_REFINE_*). */
export interface RefineLimits {
  release: number;
  max: number;
}

/** Past the release round, a spec with no pending human decision may start even while a check still fails. */
/** The part of the state the release reads; the page's state shape carries the same fields. */
export interface ReleaseInput {
  status: RefineStatus;
  stale: boolean;
  cycle: number;
  derived: unknown;
  questions: ReadonlyArray<{ status: string; blocking: boolean }>;
  patches: ReadonlyArray<{ status: string; replace: string }>;
  backlog?: { enabled: boolean; detail?: boolean | null } | null;
  readiness?: Readiness | null;
}

/** Nothing waits for the owner: a derived, current list with no blocking question or approval pending. */
function clear(s: ReleaseInput): boolean {
  if (s.status === 'evaluating' || s.status === 'started' || s.status === 'error') return false;
  if (s.stale || !s.derived) return false;
  if (s.questions.some((q) => q.status === 'pending' && q.blocking)) return false;
  if (s.patches.some((p) => p.status === 'pending' && isApproval(p))) return false;
  return !s.backlog?.enabled || s.backlog.detail === true;
}

export function released(s: ReleaseInput, limits: RefineLimits): boolean {
  return s.cycle >= limits.release && clear(s);
}

/** The Jev at the goal opens the start the same way the release round does: the score never blocks by itself. */
export function jevOpens(s: ReleaseInput): boolean {
  return jevVerdict(s.readiness ?? undefined) === 'ready' && clear(s);
}

/** Something was derived from the docs (one spec or a backlog), so editing the docs makes it stale. */
const hasDerivation = (s: RefineState): boolean => s.derived !== null || (s.backlog?.items.length ?? 0) > 0;

const keep = <T>(rows: Record<string, T> | undefined, keys: ReadonlySet<string>): Record<string, T> | undefined =>
  rows && Object.fromEntries(Object.entries(rows).filter(([k]) => keys.has(k)));

/** Journals written before the rename name the briefing brief.md; replay reads that name as briefing.md. */
const docName = (file: unknown): DocFile => (file === 'brief.md' ? 'briefing.md' : file) as DocFile;
const docNames = <T>(rows: Record<string, T> | null | undefined): Record<DocFile, T> | null =>
  rows ? (Object.fromEntries(Object.entries(rows).filter(([k]) => !(k === 'brief.md' && 'briefing.md' in rows)).map(([k, v]) => [docName(k), v])) as Record<DocFile, T>) : null;

export function applyRefineEvent(s: RefineState, e: { type: string; data: Record<string, unknown> }): void {
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
    case RefineEvent.CycleFailed:
      s.error = String(d.reason);
      s.status = 'error';
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
    case RefineEvent.FindingsReported:
      s.findings = (d.findings as FindingRow[] | undefined) ?? [];
      break;
    case RefineEvent.DocMoveUndone: {
      const m = s.moves.find((x) => x.moveId === String(d.moveId));
      if (m) m.status = 'undone';
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
      break;
    case RefineEvent.DocEdited:
      if (s.status === 'evaluating') s.editedInCycle = true;
      if (hasDerivation(s)) s.stale = true;
      if (s.readiness) s.readiness.outdated = true;
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
      break;
    case RefineEvent.PreplanDerived:
      if (s.backlog) {
        const row: PreplanRow = { inputHash: String(d.inputHash), specRev: String(d.specRev), preplan: (d.preplan as Preplan | null) ?? null, issues: (d.issues as string[]) ?? [], cycle: Number(d.cycle) };
        s.backlog = { ...s.backlog, preplans: { ...s.backlog.preplans, [String(d.key)]: row } };
      }
      break;
    case RefineEvent.ConflictsDerived:
      if (s.backlog) s.backlog = { ...s.backlog, conflicts: { inputHash: String(d.inputHash), pairs: d.pairs as ConflictMap['pairs'] } };
      break;
    case RefineEvent.DocsScored:
      s.readiness = { ...(d as unknown as Omit<Readiness, 'outdated' | 'docs'>), docs: docNames(d.docs as Record<string, DocScore> | null), outdated: false };
      break;
    case RefineEvent.StartedRun:
      s.status = 'started';
      s.runId = String(d.runId);
      break;
    default:
      break;
  }
}

export function reduceRefineEvents(events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): RefineState {
  const s = emptyRefineState();
  for (const e of events) applyRefineEvent(s, e);
  return s;
}
