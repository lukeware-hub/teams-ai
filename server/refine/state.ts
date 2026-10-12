import type { Backlog, BacklogItem } from '../contracts/backlog.js';
import type { Preplan } from '../contracts/preplan.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { ChecklistItem } from './checklist.js';
import { coverageGaps } from './coverage.js';
import { RefineEvent, type Question } from './events.js';
import { approvalKey } from './sections.js';
import type { PendingPatch } from './patches.js';

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
  /** Detailing asked for ("Detalhar specs"): each cycle derives the spec and pre-plan of every changed item. */
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
  cycle: number;
  derived: { project: Project; spec: Spec } | null;
  checklist: ChecklistItem[];
  questions: QuestionRow[];
  patches: PatchRow[];
  discarded: Array<{ cycle: number; role: string; file: string; reason: string }>;
  error: string | null;
  runId: string | null;
  backlog: BacklogState | null;
  /** How the session was created; null on drafts from before it was kept. */
  mode: 'new-project' | 'new-spec' | 'continue' | null;
  /** Why the program did not start by itself, and in which cycle; a new cycle tries again. */
  autoStartFailure?: { cycle: number; reason: string };
}

export const emptyRefineState = (): RefineState => ({
  status: 'drafting',
  stale: false,
  cycle: 0,
  derived: null,
  checklist: [],
  questions: [],
  patches: [],
  discarded: [],
  error: null,
  runId: null,
  backlog: null,
  mode: null,
});

const STICKY: ReadonlySet<RefineStatus> = new Set(['evaluating', 'error', 'started']);

/** An adjustment's approval (R11.7.4) is the owner's decision, never a reviewer's suggestion. */
const isApproval = (p: Pick<PatchRow, 'replace'>) => approvalKey(p.replace.split('\n', 1)[0]!.replace(/^#+\s*/, '')) !== null;

/** Spec (refinement) §3.1: ready = all green, no pending blocking question and no pending approval; a reviewer's pending patch is then a suggestion (R11.10). */
export function computeStatus(s: RefineState): RefineStatus {
  if (STICKY.has(s.status)) return s.status;
  const pendingBlocking = s.questions.some((q) => q.status === 'pending' && q.blocking);
  const pendingPatch = s.patches.some((p) => p.status === 'pending');
  const pendingApproval = s.patches.some((p) => p.status === 'pending' && isApproval(p));
  const pendingAny = pendingPatch || s.questions.some((q) => q.status === 'pending');
  const green = s.checklist.length > 0 && s.checklist.every((i) => i.passed);
  // A detailed backlog is ready only when every section, spec, criterion and task is accounted for.
  const covered = !s.backlog?.detail || coverageGaps(s.backlog).length === 0;
  if (green && covered && !pendingBlocking && !pendingApproval) return 'ready';
  return pendingAny ? 'answering' : 'drafting';
}

/** Something was derived from the docs (one spec or a backlog), so editing the docs makes it stale. */
const hasDerivation = (s: RefineState): boolean => s.derived !== null || (s.backlog?.items.length ?? 0) > 0;

const keep = <T>(rows: Record<string, T> | undefined, keys: ReadonlySet<string>): Record<string, T> | undefined =>
  rows && Object.fromEntries(Object.entries(rows).filter(([k]) => keys.has(k)));

export function applyRefineEvent(s: RefineState, e: { type: string; data: Record<string, unknown> }): void {
  const d = e.data;
  switch (e.type) {
    case RefineEvent.CycleStarted:
      s.cycle = Number(d.cycle);
      s.status = 'evaluating';
      s.error = null;
      break;
    case RefineEvent.Derived:
      s.derived = { project: d.project as Project, spec: d.spec as Spec };
      break;
    case RefineEvent.PatchProposed:
      s.patches.push({ ...(d as unknown as PendingPatch & { cycle: number }), status: 'pending', decision: null });
      break;
    case RefineEvent.Evaluated: {
      const v = d as unknown as { cycle: number; checklist: ChecklistItem[]; questions: Question[]; discardedPatches: Array<{ role: string; file: string; reason: string }> };
      s.checklist = v.checklist;
      s.questions.push(...v.questions.map((q) => ({ ...q, status: 'pending' as const, answer: null })));
      s.discarded.push(...v.discardedPatches.map((x) => ({ cycle: v.cycle, ...x })));
      s.stale = false;
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
    case RefineEvent.SecretWritten:
      if (hasDerivation(s)) s.stale = true;
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
    case RefineEvent.AutoStartFailed:
      s.autoStartFailure = { cycle: Number(d.cycle), reason: String(d.reason) };
      break;
    case RefineEvent.ConflictsDerived:
      if (s.backlog) s.backlog = { ...s.backlog, conflicts: { inputHash: String(d.inputHash), pairs: d.pairs as ConflictMap['pairs'] } };
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
